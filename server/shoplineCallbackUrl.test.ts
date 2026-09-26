/**
 * The URLs the SHOPLINE routes actually send a merchant to.
 *
 * Three of them are built from this deployment's origin:
 *
 *   - the OAuth callback URL on install, which must equal the Callback URL
 *     registered in the Partner Portal exactly, or the authorization is refused;
 *   - the welcome page the callback redirects to once the install succeeds;
 *   - the error page it redirects to when the install fails.
 *
 * All three used to be built from raw proxy headers:
 *
 *   const protocol = req.headers["x-forwarded-proto"] || req.protocol;  // can be "https,https"
 *   const host     = req.headers["x-forwarded-host"]  || req.get("host"); // caller-supplied
 *
 * — which yields `https,https://host/...` behind two proxies, and whatever host
 * a caller asks for otherwise.
 *
 * Asserted at the ROUTE, not on the helper (Greptile P2 on PR #151): a helper
 * test cannot see a call site that stopped using it, and each of these URLs
 * failing is invisible until a merchant installs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

// The callback exchanges a code with SHOPLINE, reads the store and provisions a
// tenant. Those are not the subject here — the redirect it ends with is — so
// only they are replaced, and everything else the router touches stays real.
const exchangeCodeForToken = vi.hoisted(() => vi.fn());
vi.mock("./connectors/shopline/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connectors/shopline/auth")>()),
  exchangeCodeForToken,
}));
const onboardShoplineMerchant = vi.hoisted(() => vi.fn());
vi.mock("./connectors/shopline/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connectors/shopline/onboarding")>()),
  onboardShoplineMerchant,
}));
const fetchStoreMetadata = vi.hoisted(() => vi.fn());
vi.mock("./connectors/shopline/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connectors/shopline/apiClient")>()),
  fetchStoreMetadata,
  registerWebhook: vi.fn(async () => undefined),
}));

const SECRET = "test-app-secret";
const KEYS = ["SHOPLINE_APP_SECRET", "SHOPLINE_APP_KEY", "APP_URL", "TRUSTED_PROXY_HOPS", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};

// The first import of the router transforms its whole dependency graph —
// seconds on a cold runner, at vitest's 5s per-test limit. Pay it once, outside
// any test's budget; each case still re-imports after vi.resetModules().
beforeAll(async () => {
  await import("./connectors/shopline/routes");
}, 60_000);

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  exchangeCodeForToken.mockReset();
  onboardShoplineMerchant.mockReset();
  fetchStoreMetadata.mockReset();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

/** The slice of a request the SHOPLINE routes read. */
interface FakeRequest {
  query: Record<string, string>;
  url: string;
  originalUrl: string;
  headers: Record<string, string>;
  protocol: string;
  get: (header: string) => string | undefined;
}

/** The slice of a response they write. */
interface FakeResponse {
  redirect: (status: number, url: string) => void;
  status: (code: number) => { json: (body: unknown) => void };
}

/** The slice of an Express router this test walks to find a route's handler. */
interface RouterStack {
  stack: Array<{
    route?: { path: string; stack: Array<{ handle: (req: FakeRequest, res: FakeResponse) => unknown }> };
  }>;
}

interface Outcome {
  redirect?: string;
  status?: number;
  body?: unknown;
}

/** Sign exactly as SHOPLINE does: sorted `k=v&k=v` over every param but `sign`. */
function signedQuery(extra: Record<string, string> = {}) {
  const params: Record<string, string> = {
    appkey: "test-app-key",
    handle: "reconcileai-dev",
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...extra,
  };
  const message = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join("&");
  params.sign = createHmac("sha256", SECRET).update(message).digest("hex");
  return params;
}

/** Drive a real SHOPLINE route handler off the real router. */
async function drive(
  path: "/api/shopline/install" | "/api/shopline/callback",
  query: Record<string, string>,
  headers: Record<string, string>,
  appUrl: string,
): Promise<Outcome> {
  vi.resetModules();
  process.env.NODE_ENV = "production";
  process.env.TRUSTED_PROXY_HOPS = "2";
  process.env.SHOPLINE_APP_SECRET = SECRET;
  process.env.SHOPLINE_APP_KEY = "test-app-key";
  // "" is "not configured" — deleting it would let dotenv refill it on reset.
  process.env.APP_URL = appUrl;

  const { createShoplineRouter } = await import("./connectors/shopline/routes");
  // A structural view of the router: only the stack this test walks.
  const router = createShoplineRouter() as unknown as RouterStack;
  const layer = router.stack.find(l => l.route?.path === path);
  if (!layer?.route) throw new Error(`${path} not registered`);

  const qs = new URLSearchParams(query).toString();
  const req: FakeRequest = {
    query,
    url: `${path}?${qs}`,
    originalUrl: `${path}?${qs}`,
    headers,
    protocol: "http", // the socket, behind TLS termination
    get: (h: string) => headers[h.toLowerCase()],
  };

  const out: Outcome = {};
  const res: FakeResponse = {
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

const install = (headers: Record<string, string>, appUrl: string) =>
  drive("/api/shopline/install", signedQuery(), headers, appUrl);

const callback = (headers: Record<string, string>, appUrl: string) =>
  drive("/api/shopline/callback", signedQuery({ code: "one-time-code" }), headers, appUrl);

const PROD_HEADERS = {
  host: "www.reconcileaiafrica.com",
  "x-forwarded-proto": "https,https",
};

const APP = "https://www.reconcileaiafrica.com";

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
    const out = await install(PROD_HEADERS, APP);
    expect(out.status, JSON.stringify(out.body)).toBeUndefined(); // signature accepted
    expect(out.redirect).toBeDefined();

    const callbackUrl = redirectUriOf(out.redirect!);
    expect(callbackUrl).toBe(`${APP}/api/shopline/callback`);
  });

  it("should not emit a malformed URL from a forwarded-proto LIST when APP_URL is unset", async () => {
    // The old construction produced `https,https://www.reconcileaiafrica.com/...`.
    const out = await install(PROD_HEADERS, "");
    const callbackUrl = redirectUriOf(out.redirect!);

    expect(callbackUrl).toBe(`${APP}/api/shopline/callback`);
    expect(callbackUrl).not.toContain(",");
    expect(() => new URL(callbackUrl!)).not.toThrow();
    expect(new URL(callbackUrl!).protocol).toBe("https:");
  });

  it("should ignore x-forwarded-host, which the caller controls", async () => {
    const out = await install({ ...PROD_HEADERS, "x-forwarded-host": "evil.tld" }, "");
    const callbackUrl = redirectUriOf(out.redirect!);

    expect(callbackUrl).toBe(`${APP}/api/shopline/callback`);
    expect(out.redirect).not.toContain("evil.tld");
  });
});

describe("when SHOPLINE sends the merchant back after a successful install", () => {
  beforeEach(() => {
    exchangeCodeForToken.mockResolvedValue({ accessToken: "access-token", scope: "read_orders", expireTime: "" });
    fetchStoreMetadata.mockResolvedValue({ id: "1785294964809", name: "ReconcileAI Dev Store", currency: "USD" });
    // A reconnection, so the route does not start a background backfill.
    onboardShoplineMerchant.mockResolvedValue({
      organizationId: 60001,
      organizationCode: "SL_RECONCILEAI_DEV",
      slStoreId: 7,
      isReconnection: true,
    });
  });

  it("should land them on THIS deployment's welcome page, whatever host the caller names", async () => {
    // APP_URL unset, a forwarded-proto LIST, and a caller-chosen host: the three
    // inputs that each broke the old construction.
    const out = await callback({ ...PROD_HEADERS, "x-forwarded-host": "evil.tld" }, "");

    expect(out.status, JSON.stringify(out.body)).toBeUndefined(); // signature accepted
    expect(onboardShoplineMerchant).toHaveBeenCalledTimes(1); // the success path really ran
    expect(out.redirect).toBe(`${APP}/shopline/welcome?org=SL_RECONCILEAI_DEV&reconnect=true`);
    expect(new URL(out.redirect!).protocol).toBe("https:");
  });

  it("should prefer APP_URL over the Host the request arrived on", async () => {
    // A request that reached the app by its platform hostname still lands the
    // merchant on the canonical domain.
    const out = await callback({ host: "reconcileai-production.up.railway.app", "x-forwarded-proto": "https,https" }, APP);

    expect(out.redirect).toBe(`${APP}/shopline/welcome?org=SL_RECONCILEAI_DEV&reconnect=true`);
  });
});

describe("when the install fails after SHOPLINE sends the merchant back", () => {
  it("should send them to THIS deployment's error page, well-formed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    exchangeCodeForToken.mockRejectedValue(new Error("authorization code expired"));

    const out = await callback({ ...PROD_HEADERS, "x-forwarded-host": "evil.tld" }, "");

    expect(out.status, JSON.stringify(out.body)).toBeUndefined(); // failed AFTER the signature check
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(out.redirect).toBe(`${APP}/shopline/error?reason=install_failed`);
    expect(out.redirect).not.toContain(",");
    expect(onboardShoplineMerchant).not.toHaveBeenCalled();
  });
});
