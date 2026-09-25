/**
 * The origin this deployment advertises in URLs that point back at it.
 *
 * Four places built one: the OAuth redirect_uri, the SHOPLINE post-install
 * redirect, the SHOPLINE error redirect, and reviewer links. Three of them read
 * raw proxy headers, which fails two ways:
 *
 *   - `x-forwarded-proto` can arrive as a LIST. "https,https" interpolated into
 *     `${protocol}://${host}` produces `https,https://host` — a malformed URL,
 *     and for SHOPLINE that URL is the OAuth callback the merchant is sent to.
 *   - `x-forwarded-host` is CALLER-SUPPLIED. A redirect built from it sends the
 *     visitor wherever the caller asked, and a redirect_uri built from it stops
 *     matching what the provider has registered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Type-only, so it is erased: the module itself is imported fresh per case below.
import type { ProxiedRequest } from "./_core/clientIp";

const KEYS = ["APP_URL", "TRUSTED_PROXY_HOPS", "NODE_ENV"] as const;
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

async function originFor(req: ProxiedRequest | null, env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  process.env.NODE_ENV = "production";
  process.env.TRUSTED_PROXY_HOPS = "2";
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v; // "" means "configured as empty", which dotenv will not refill
  }
  const { appOriginFor } = await import("./_core/clientIp");
  return appOriginFor(req);
}

const APP = "https://www.reconcileaiafrica.com";

describe("when building a URL that points back at this deployment", () => {
  it("should use APP_URL, which no request can influence", async () => {
    const hostile = {
      headers: { host: "evil.tld", "x-forwarded-host": "evil.tld", "x-forwarded-proto": "http" },
      protocol: "http",
    };
    expect(await originFor(hostile, { APP_URL: APP })).toBe(APP);
    expect(await originFor(hostile, { APP_URL: `${APP}/` })).toBe(APP);
  });

  it("should never honour x-forwarded-host when APP_URL is unset", async () => {
    // This is the open redirect: the visitor is sent wherever the caller asked.
    const req = {
      headers: { host: "www.reconcileaiafrica.com", "x-forwarded-host": "evil.tld", "x-forwarded-proto": "https,https" },
      protocol: "http",
    };
    expect(await originFor(req, { APP_URL: "" })).toBe(APP);
  });

  it("should not produce a malformed origin from a forwarded-proto list", async () => {
    // `https,https://host` was a real possible output of the old construction.
    const req = {
      headers: { host: "www.reconcileaiafrica.com", "x-forwarded-proto": "https,https" },
      protocol: "http",
    };
    const origin = await originFor(req, { APP_URL: "" });
    expect(origin).toBe(APP);
    expect(() => new URL(`${origin}/api/shopline/callback`)).not.toThrow();
    expect(new URL(`${origin}/api/shopline/callback`).protocol).toBe("https:");
  });

  it("should keep the https scheme for a proxied deployment with no APP_URL", async () => {
    const req = { headers: { host: "reconcile.bank.internal", "x-forwarded-proto": "https" }, protocol: "http" };
    expect(await originFor(req, { APP_URL: "" })).toBe("https://reconcile.bank.internal");
  });

  it("should say http only when the request really was http", async () => {
    const req = { headers: { host: "localhost:3000" }, protocol: "http" };
    expect(await originFor(req, { APP_URL: "", TRUSTED_PROXY_HOPS: "0" })).toBe("http://localhost:3000");
  });

  it("should return empty rather than a broken URL when there is nothing to build from", async () => {
    expect(await originFor({ headers: {} }, { APP_URL: "" })).toBe("");
    expect(await originFor(null, { APP_URL: "" })).toBe("");
  });
});
