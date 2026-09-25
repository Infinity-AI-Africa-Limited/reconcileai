/**
 * The origin a reviewer sign-in link is built on, asserted where it is issued.
 *
 * `reviewerAccess.issue` hands an operator a URL they paste into an App Store
 * submission or an investor email. It used to build that URL from raw proxy
 * headers, so behind two proxies it could begin `https,https://`, and a
 * caller-supplied `X-Forwarded-Host` decided which host it named. It now goes
 * through `appOriginFor` — and this test drives the real procedure, because a
 * test of `appOriginFor` alone cannot notice a call site that stopped using it
 * (Greptile, PR #151).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

// The first import of the router transforms its whole dependency graph —
// seconds on a cold runner, at vitest's 5s per-test limit. Pay it once, outside
// any test's budget; each case still re-imports after vi.resetModules().
beforeAll(async () => {
  await import("./routers/reviewerAccess");
}, 60_000);

// Issuing writes a row; that is not the subject here. The URL origin handed to
// it is — so only the two database-backed calls are replaced.
const issueReviewerLink = vi.hoisted(() => vi.fn());
const organizationIdByCode = vi.hoisted(() => vi.fn());
vi.mock("./reviewerAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reviewerAccess")>()),
  issueReviewerLink,
  organizationIdByCode,
}));

const KEYS = ["APP_URL", "TRUSTED_PROXY_HOPS", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  issueReviewerLink.mockReset();
  issueReviewerLink.mockImplementation(async (params: { appUrl: string }) => ({
    url: `${params.appUrl}/api/reviewer-access?key=issued`,
  }));
  organizationIdByCode.mockReset();
  organizationIdByCode.mockResolvedValue(60001);
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A super admin — the only role that may issue a reviewer link. */
const operator = {
  id: 1,
  openId: "op_1",
  name: "Operator",
  email: "ops@example.com",
  loginMethod: "magic_link",
  role: "super_admin",
  organizationId: 1,
  isGuest: false,
  isReadOnly: false,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
} as unknown as NonNullable<TrpcContext["user"]>;

/** The slice of a request `appOriginFor` reads. */
interface FakeRequest {
  headers: Record<string, string>;
  protocol: string;
  socket: { remoteAddress: string };
}

/** Issue a link through the real procedure; return the origin it was built on. */
async function issueBehind(headers: Record<string, string>, appUrl: string): Promise<string> {
  vi.resetModules();
  process.env.NODE_ENV = "production";
  process.env.TRUSTED_PROXY_HOPS = "2";
  // "" is "not configured" — deleting it would let dotenv refill it on reset.
  process.env.APP_URL = appUrl;

  const { reviewerAccessRouter } = await import("./routers/reviewerAccess");
  const req: FakeRequest = { headers, protocol: "http", socket: { remoteAddress: "10.0.0.5" } };
  const caller = reviewerAccessRouter.createCaller({
    // The fakes carry only what the procedure reads; widened once, here.
    req: req as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: operator,
  });

  const link = await caller.issue({ label: "SHOPLINE App Store review" });
  expect(issueReviewerLink).toHaveBeenCalledTimes(1);
  const [params] = issueReviewerLink.mock.calls[0] as [{ appUrl: string }];
  // The operator is handed exactly the URL built on that origin.
  expect(link).toEqual({ url: `${params.appUrl}/api/reviewer-access?key=issued` });
  return params.appUrl;
}

const APP = "https://www.reconcileaiafrica.com";

describe("when an operator issues a reviewer sign-in link", () => {
  it("should build it on APP_URL, which no request can influence", async () => {
    const origin = await issueBehind(
      { host: "reconcileai-production.up.railway.app", "x-forwarded-host": "evil.tld", "x-forwarded-proto": "https,https" },
      APP,
    );
    expect(origin).toBe(APP);
  });

  it("should never take the host from x-forwarded-host when APP_URL is unset", async () => {
    const origin = await issueBehind(
      { host: "www.reconcileaiafrica.com", "x-forwarded-host": "evil.tld", "x-forwarded-proto": "https,https" },
      "",
    );
    expect(origin).toBe(APP);
    expect(origin).not.toContain("evil.tld");
  });

  it("should not produce a malformed origin from a forwarded-proto LIST", async () => {
    // `https,https://…` was a possible output of the old construction.
    const origin = await issueBehind({ host: "www.reconcileaiafrica.com", "x-forwarded-proto": "https,https" }, "");
    expect(origin).not.toContain(",");
    expect(new URL(`${origin}/api/reviewer-access`).protocol).toBe("https:");
  });

  it("should refuse rather than issue a link with no origin at all", async () => {
    // Better an error the operator sees than a URL beginning "undefined" pasted
    // into an App Store submission.
    await expect(issueBehind({}, "")).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});
