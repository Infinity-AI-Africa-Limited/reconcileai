/**
 * The callback URL the SHOPLINE install route actually sends.
 *
 * It must equal the Callback URL registered in the Partner Portal exactly, or
 * the authorization is refused. It used to be built from raw proxy headers:
 *
 *   const protocol = req.headers["x-forwarded-proto"] || req.protocol;  // can be "https,https"
 *   const host     = req.headers["x-forwarded-host"]  || req.get("host"); // caller-supplied
 *
 * — which yields `https,https://host/...` behind two proxies, and whatever host
 * a caller asks for otherwise.
 *
 * Asserted at the ROUTE, not on the helper (Greptile P2 on PR #151): a helper
 * test cannot see a call site that stopped using it, and this URL failing the
 * portal's exact-match check is invisible until a merchant tries to install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const SECRET = "test-app-secret";
const KEYS = ["SHOPLINE_APP_SECRET", "SHOPLINE_APP_KEY", "APP_URL", "TRUSTED_PROXY_HOPS", "NODE_ENV"] as const;
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

/** Sign exactly as SHOPLINE does: sorted `k=v&k=v` over every param but `sign`. */
function signedInstallQuery() {
  const params: Record<string, string> = {
    appkey: "test-app-key",
    handle: "reconcileai-dev",
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const message = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join("&");
  params.sign = createHmac("sha256", SECRET).update(message).digest("hex");
  return params;
}

/** Drive the real install handler off the real router. */
async function install(headers: Record<string, string>, appUrl: string) {
  vi.resetModules();
  process.env.NODE_ENV = "production";
  process.env.TRUSTED_PROXY_HOPS = "2";
  process.env.SHOPLINE_APP_SECRET = SECRET;
  process.env.SHOPLINE_APP_KEY = "test-app-key";
  // "" is "not configured" — deleting it would let dotenv refill it on reset.
  process.env.APP_URL = appUrl;

  const { createShoplineRouter } = await import("./connectors/shopline/routes");
  const router = createShoplineRouter() as any;
  const layer = router.stack.find((l: any) => l.route?.path === "/api/shopline/install");
  if (!layer) throw new Error("install route not registered");

  const query = signedInstallQuery();
  const qs = new URLSearchParams(query).toString();
  const req = {
    query,
    url: `/api/shopline/install?${qs}`,
    originalUrl: `/api/shopline/install?${qs}`,
    headers,
    protocol: "http", // the socket, behind TLS termination
    get: (h: string) => headers[h.toLowerCase()],
  };

  const out: { redirect?: string; status?: number; body?: unknown } = {};
  const res = {
    redirect: (_s: number, url: string) => {
      out.redirect = url;
    },
    status: (s: number) => {
      out.status = s;
      return { json: (b: unknown) => { out.body = b; } };
    },
  };

  await layer.route.stack[0].handle(req, res);
  return out;
}

const PROD_HEADERS = {
  host: "www.reconcileaiafrica.com",
  "x-forwarded-proto": "https,https",
};

/**
 * Pull `redirectUri` out of the authorize URL.
 *
 * SHOPLINE's authorize page is hash-routed — `.../oauth-web/#/oauth/authorize?...`
 * — so the parameters live in the FRAGMENT, and `new URL(u).searchParams` is
 * empty. Reading them from the wrong place is how a test like this passes
 * vacuously.
 */
function redirectUriOf(authorizeUrl: string): string | null {
  const url = new URL(authorizeUrl);
  const afterHash = url.hash.includes("?") ? url.hash.slice(url.hash.indexOf("?") + 1) : "";
  const params = new URLSearchParams(afterHash || url.search);
  return params.get("redirectUri");
}

describe("when a merchant starts a SHOPLINE install", () => {
  it("should send the exact callback URL registered in the Partner Portal", async () => {
    const out = await install(PROD_HEADERS, "https://www.reconcileaiafrica.com");
    expect(out.status, JSON.stringify(out.body)).toBeUndefined(); // signature accepted
    expect(out.redirect).toBeDefined();

    const callback = redirectUriOf(out.redirect!);
    expect(callback).toBe("https://www.reconcileaiafrica.com/api/shopline/callback");
  });

  it("should not emit a malformed URL from a forwarded-proto LIST when APP_URL is unset", async () => {
    // The old construction produced `https,https://www.reconcileaiafrica.com/...`.
    const out = await install(PROD_HEADERS, "");
    const callback = redirectUriOf(out.redirect!);

    expect(callback).toBe("https://www.reconcileaiafrica.com/api/shopline/callback");
    expect(callback).not.toContain(",");
    expect(() => new URL(callback!)).not.toThrow();
    expect(new URL(callback!).protocol).toBe("https:");
  });

  it("should ignore x-forwarded-host, which the caller controls", async () => {
    const out = await install(
      { ...PROD_HEADERS, "x-forwarded-host": "evil.tld" },
      "",
    );
    const callback = redirectUriOf(out.redirect!);

    expect(callback).toBe("https://www.reconcileaiafrica.com/api/shopline/callback");
    expect(out.redirect).not.toContain("evil.tld");
  });
});
