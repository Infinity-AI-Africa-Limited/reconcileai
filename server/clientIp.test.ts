/**
 * The client's address, when the client gets a say in what the header contains.
 *
 * `X-Forwarded-For` is appended to by each proxy, so its FIRST entry is whatever
 * the caller sent. Six places read that entry: two rate limiters (magic-link
 * login, reviewer-access links) and four audit writers (magic-link login, SSO
 * login, the storage proxy, and `getClientInfo`, which supplies the address for
 * 70+ tRPC procedures). A caller rotating the header therefore earned a fresh
 * rate-limit allowance per value and wrote an address of its choosing into the
 * audit trail.
 *
 * These tests are written against the shape of a real request rather than the
 * parser's internals: a production chain is three hops of header, and the
 * question each test asks is the one the call site asks — "which of these is the
 * client?".
 */
import { describe, expect, it, vi } from "vitest";

// The effective hop count is read once, at import. Pin it to the production
// topology (Cloudflare → Railway → app) so these tests describe production and
// not whatever NODE_ENV the runner happens to use.
vi.hoisted(() => {
  process.env.TRUSTED_PROXY_HOPS = "2";
});

import {
  CLOUD_TRUSTED_PROXY_HOPS,
  MAX_TRUSTED_PROXY_HOPS,
  ON_PREMISE_TRUSTED_PROXY_HOPS,
  TRUSTED_PROXY_HOPS,
  clientIp,
  clientIpFrom,
  clientIpOrUnknown,
  normalizeIp,
  resolveTrustedProxyHops,
} from "./_core/clientIp";
import { createRateLimiter } from "./rateLimiter";
import { getClientInfo } from "./routers/shared";

/** The client's real address, as Cloudflare observed it. */
const CLIENT = "203.0.113.9";
/** Cloudflare's egress address, as the Railway edge observed it. */
const CLOUDFLARE_EGRESS = "198.51.100.7";
/** The Railway router — the app's own TCP peer. */
const SOCKET = "10.0.0.5";

/**
 * A request as the app receives it in production.
 *
 * `clientSent` is whatever the caller put in the header before Cloudflare saw
 * it. Cloudflare then appends the caller's address, and the Railway edge
 * appends Cloudflare's — so the caller's own entries always end up on the LEFT.
 */
function productionRequest(clientSent: string[] = []) {
  return {
    headers: { "x-forwarded-for": [...clientSent, CLIENT, CLOUDFLARE_EGRESS].join(", ") },
    socket: { remoteAddress: SOCKET },
  };
}

describe("when a caller forges X-Forwarded-For through the production chain", () => {
  it("should resolve the same client address whatever the caller prepends", () => {
    const forgeries = [
      [],
      ["1.1.1.1"],
      ["8.8.8.8", "9.9.9.9"],
      ["not-an-ip"],
      ["203.0.113.9"], // the victim's own address, to look plausible
      ["::1", "127.0.0.1", "10.0.0.5"],
    ];

    for (const forged of forgeries) {
      expect(clientIp(productionRequest(forged)), forged.join("|")).toBe(CLIENT);
    }
  });

  it("should keep a rotating caller inside ONE rate-limit bucket", () => {
    // The magic-login limiter's real configuration.
    const limiter = createRateLimiter({ windowMs: 15 * 60_000, max: 20 });
    const attempt = (n: number) =>
      limiter.check(`ip:${clientIpOrUnknown(productionRequest([`192.0.2.${n}`]))}`);

    // 20 attempts, each with a different forged first entry.
    for (let n = 1; n <= 20; n += 1) {
      expect(attempt(n).allowed, `attempt ${n}`).toBe(true);
    }
    // The 21st is refused — the rotation bought nothing.
    expect(attempt(21).allowed).toBe(false);
  });

  it("should write the proxy-appended address to the audit trail, not the caller's", () => {
    const forged = productionRequest(["1.1.1.1"]);
    expect(getClientInfo({ req: forged }).ip).toBe(CLIENT);
    expect(getClientInfo({ req: forged }).ip).not.toBe("1.1.1.1");
  });

  it("should never return a caller-supplied entry, however many are sent", () => {
    const flood = Array.from({ length: 200 }, (_, i) => `192.0.2.${i % 250}`);
    expect(clientIp(productionRequest(flood))).toBe(CLIENT);
  });
});

describe("when counting hops for other topologies", () => {
  const chain = (xff: string | string[] | undefined, socket: string | null = SOCKET) => ({
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
    socket: { remoteAddress: socket },
  });

  it("should ignore the header entirely when nothing is in front of the app", () => {
    expect(clientIpFrom(chain(`${CLIENT}, ${CLOUDFLARE_EGRESS}`), 0)).toBe(SOCKET);
    expect(clientIpFrom(chain("1.1.1.1"), 0)).toBe(SOCKET);
  });

  it("should take the last entry behind a single proxy", () => {
    // client → nginx → app: nginx appended the client, the caller prepended 1.1.1.1.
    expect(clientIpFrom(chain(`1.1.1.1, ${CLIENT}`), 1)).toBe(CLIENT);
  });

  it("should clamp to the earliest recorded address when the chain is shorter than configured", () => {
    // One proxy where two were configured: the single entry is the only address
    // infrastructure recorded. Reading past it would return the proxy itself and
    // collapse every caller into one bucket.
    expect(clientIpFrom(chain(CLIENT), 2)).toBe(CLIENT);
  });

  it("should fall back to the socket when there is no usable header", () => {
    expect(clientIpFrom(chain(undefined), 2)).toBe(SOCKET);
    expect(clientIpFrom(chain(""), 2)).toBe(SOCKET);
    expect(clientIpFrom(chain("not-an-ip, still-not-an-ip"), 2)).toBe(SOCKET);
  });

  it("should return null rather than a guess when nothing is knowable", () => {
    expect(clientIpFrom({ headers: {}, socket: null }, 2)).toBeNull();
    expect(clientIp(null)).toBeNull();
    expect(clientIpOrUnknown(undefined)).toBe("unknown");
  });

  it("should read a repeated header the same as a joined one", () => {
    expect(clientIpFrom(chain([`1.1.1.1, ${CLIENT}`, CLOUDFLARE_EGRESS]), 2)).toBe(CLIENT);
  });
});

describe("when normalising an address", () => {
  it("should strip a port so one caller is one key", () => {
    expect(normalizeIp("203.0.113.9:44321")).toBe(CLIENT);
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
  });

  it("should fold an IPv4-mapped IPv6 address onto its IPv4 form", () => {
    expect(normalizeIp("::ffff:203.0.113.9")).toBe(CLIENT);
    expect(normalizeIp("::FFFF:203.0.113.9")).toBe(CLIENT);
  });

  it("should lower-case IPv6 so two spellings are not two buckets", () => {
    expect(normalizeIp("2001:DB8::AB")).toBe("2001:db8::ab");
  });

  it("should reject anything that is not an address", () => {
    // Otherwise arbitrary caller text becomes a limiter key and an audit value.
    for (const junk of ["", "   ", "unknown", "1.2.3", "999.1.1.1", "drop table", "<script>", null, undefined]) {
      expect(normalizeIp(junk), String(junk)).toBeNull();
    }
    expect(normalizeIp(" 1.2.3.4 ")).toBe("1.2.3.4"); // surrounding whitespace is fine
  });
});

describe("when resolving how many proxies to trust", () => {
  const cloud = { isProduction: true, deploymentMode: "cloud" };
  const onPrem = { isProduction: true, deploymentMode: "on_premise" };
  const dev = { isProduction: false, deploymentMode: "cloud" };

  it("should default to the deployment's own topology", () => {
    expect(resolveTrustedProxyHops(undefined, cloud)).toBe(CLOUD_TRUSTED_PROXY_HOPS);
    expect(resolveTrustedProxyHops("", onPrem)).toBe(ON_PREMISE_TRUSTED_PROXY_HOPS);
    // Nothing sits in front of a development process, so nothing is trusted.
    expect(resolveTrustedProxyHops(undefined, dev)).toBe(0);
  });

  it("should honour an explicit override, including zero", () => {
    expect(resolveTrustedProxyHops("3", cloud)).toBe(3);
    expect(resolveTrustedProxyHops(" 0 ", cloud)).toBe(0);
    expect(TRUSTED_PROXY_HOPS).toBe(2); // set by this file's vi.hoisted block
  });

  it("should fall back to the default rather than trust a nonsense value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["-1", "abc", String(MAX_TRUSTED_PROXY_HOPS + 1), "2.5.1"]) {
      expect(resolveTrustedProxyHops(bad, cloud), bad).toBe(CLOUD_TRUSTED_PROXY_HOPS);
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
