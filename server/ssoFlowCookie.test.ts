/**
 * The SSO flow cookie, driven through the real route handler.
 *
 * `/api/oauth/:provider/start` stores the PKCE verifier, the CSRF state and the
 * OIDC nonce in a cookie, and set its `secure` attribute from `req.protocol`.
 * Behind a TLS-terminating proxy that reads `http`, so **every production SSO
 * sign-in set this cookie without Secure** — the browser would then send those
 * values over a plaintext request to the same host.
 *
 * Asserted against the handler rather than the helper, because the helper being
 * right is not the part that was broken.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookieOptions, Express, Request, Response } from "express";

// The first import of the SSO module transforms its whole dependency graph.
// That took ~4–5s on a cold local runner — right at vitest's 5s per-test limit,
// so the first case failed intermittently. Pay it once, outside any test's
// budget; each case still re-imports a fresh instance after vi.resetModules().
beforeAll(async () => {
  await import("./_core/sso");
}, 60_000);

/** What `registerSsoRoutes` hands `app.get` — Express's own handler shape. */
type Handler = (req: Request, res: Response) => Promise<void> | void;

/** The slice of a request the start route reads. */
interface FakeRequest {
  params: { provider: string };
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  protocol: string;
  get: (header: string) => string | undefined;
}

/** The slice of a response the start route writes, plus what it recorded. */
interface CapturedResponse {
  cookies: Array<{ name: string; value: string; options: CookieOptions }>;
  redirects: string[];
  cookie(name: string, value: string, options: CookieOptions): void;
  redirect(status: number, url: string): void;
}

/**
 * The fakes implement only what the route touches, so they are widened to
 * Express's types once, here — typed on both sides, rather than `any`.
 */
const asRequest = (req: FakeRequest) => req as unknown as Request;
const asResponse = (res: CapturedResponse) => res as unknown as Response;

const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "JWT_SECRET", "APP_URL", "TRUSTED_PROXY_HOPS", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Register the real routes against a fake Express app and hand back the start handler. */
async function startHandler(env: Record<string, string | undefined>): Promise<Handler> {
  vi.resetModules();
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.JWT_SECRET = "test-jwt-secret-value-long-enough-for-hs256";
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v; // "" means "configured as empty", which dotenv will not refill
  }

  const routes = new Map<string, Handler>();
  // A fake app that only records `get` registrations — the one method used.
  const app = { get: (path: string, h: Handler) => routes.set(path, h) };
  const { registerSsoRoutes } = await import("./_core/sso");
  registerSsoRoutes(app as unknown as Express);

  const handler = routes.get("/api/oauth/:provider/start");
  if (!handler) throw new Error("start route not registered");
  return handler;
}

/** A request as it arrives in production: TLS ends at the edge, the socket is plaintext. */
function behindTlsProxy(): FakeRequest {
  return {
    params: { provider: "google" },
    // Node always populates `host`; a fixture without it is not a real request.
    headers: {
      host: "www.reconcileaiafrica.com",
      "x-forwarded-proto": "https,https",
      "x-forwarded-for": "203.0.113.9, 198.51.100.7",
    },
    socket: { remoteAddress: "10.0.0.5" },
    protocol: "http", // what Express reports without `trust proxy`
    get: (h: string) => (h.toLowerCase() === "host" ? "www.reconcileaiafrica.com" : undefined),
  };
}

function captureRes(): CapturedResponse {
  const cookies: CapturedResponse["cookies"] = [];
  return {
    cookies,
    redirects: [],
    cookie(name: string, value: string, options: CookieOptions) {
      cookies.push({ name, value, options });
    },
    redirect(_status: number, url: string) {
      this.redirects.push(url);
    },
  };
}

describe("when starting an SSO sign-in from behind the TLS proxy", () => {
  it("should mark the flow cookie Secure", async () => {
    const handler = await startHandler({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: "2" });
    const res = captureRes();
    await handler(asRequest(behindTlsProxy()), asResponse(res));

    expect(res.cookies).toHaveLength(1);
    const cookie = res.cookies[0];
    // The PKCE verifier, state and nonce are inside this value.
    expect(cookie.options.secure).toBe(true);
    // The attributes that were already right must stay right.
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe("lax"); // must survive the IdP redirect back
    expect(cookie.options.path).toBe("/api/oauth");
  });

  it("should send an https redirect_uri when APP_URL is not configured", async () => {
    // APP_URL normally decides this; without it the scheme came from
    // req.protocol, so the redirect_uri claimed http for an https deployment —
    // and a redirect_uri must match the provider's registration exactly.
    const handler = await startHandler({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: "2", APP_URL: "" });
    const res = captureRes();
    await handler(asRequest(behindTlsProxy()), asResponse(res));

    expect(res.redirects).toHaveLength(1);
    const redirectUri = new URL(res.redirects[0]).searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://www.reconcileaiafrica.com/api/oauth/google/callback");
  });

  it("should still prefer APP_URL when it is configured", async () => {
    const handler = await startHandler({
      NODE_ENV: "production",
      TRUSTED_PROXY_HOPS: "2",
      APP_URL: "https://reconcile.bank.internal",
    });
    const res = captureRes();
    await handler(asRequest(behindTlsProxy()), asResponse(res));

    const redirectUri = new URL(res.redirects[0]).searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://reconcile.bank.internal/api/oauth/google/callback");
  });
});

describe("when starting an SSO sign-in over plain http locally", () => {
  it("should not claim Secure on a cookie the browser would then drop", async () => {
    // Nothing in front of the app, genuinely http: marking the cookie Secure
    // would make the browser discard it and break the flow entirely.
    const handler = await startHandler({ NODE_ENV: "development", TRUSTED_PROXY_HOPS: undefined });
    const res = captureRes();
    await handler(
      asRequest({
        params: { provider: "google" },
        headers: { host: "localhost:3000" },
        socket: { remoteAddress: "127.0.0.1" },
        protocol: "http",
        get: (h: string) => (h.toLowerCase() === "host" ? "localhost:3000" : undefined),
      }),
      asResponse(res),
    );

    expect(res.cookies[0].options.secure).toBe(false);
  });
});
