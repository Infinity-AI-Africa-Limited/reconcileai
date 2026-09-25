/**
 * The session cookie's Secure attribute.
 *
 * `getSessionCookieOptions` had its own answer to "was this request https",
 * separate from the SSO flow cookie's. One was right and one was wrong, which
 * is the usual outcome of asking the same question twice — so both now go
 * through `_core/clientIp.ts`. These tests exist because that delegation was
 * otherwise unguarded: reverting it broke no test at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = ["TRUSTED_PROXY_HOPS", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function cookieOptionsFor(req: any, hops = "2") {
  vi.resetModules();
  process.env.NODE_ENV = "production";
  process.env.TRUSTED_PROXY_HOPS = hops;
  const { getSessionCookieOptions } = await import("./_core/cookies");
  return getSessionCookieOptions(req);
}

const request = (headers: Record<string, string | string[]> = {}, protocol = "http") => ({
  headers,
  socket: { remoteAddress: "10.0.0.5" },
  protocol,
});

describe("when issuing the session cookie", () => {
  it("should be Secure behind the TLS proxy, where the socket itself is plaintext", async () => {
    const opts = await cookieOptionsFor(request({ "x-forwarded-proto": "https,https" }));
    expect(opts.secure).toBe(true);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("none");
    expect(opts.path).toBe("/");
  });

  it("should not be Secure on a genuinely plaintext local request", async () => {
    // Marking it Secure over http makes the browser drop it — sign-in breaks.
    const opts = await cookieOptionsFor(request({}, "http"), "0");
    expect(opts.secure).toBe(false);
  });

  it("should ignore a caller claiming https that no proxy corroborates", async () => {
    // The old `.some(https)` reading believed any entry, including the
    // caller's own. The hop that counts is the proxy's.
    const opts = await cookieOptionsFor(request({ "x-forwarded-proto": "https,http,http" }));
    expect(opts.secure).toBe(false);
  });

  it("should stay Secure when a caller claims http on an https deployment", async () => {
    const opts = await cookieOptionsFor(request({ "x-forwarded-proto": "http,https,https" }));
    expect(opts.secure).toBe(true);
  });
});
