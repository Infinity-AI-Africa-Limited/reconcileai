/**
 * Read-only reviewer sessions.
 *
 * The link hands an external party a real session in the production
 * application, so the write ban is the load-bearing control and is tested as
 * behaviour — a procedure is actually called and actually refused — rather than
 * by reading the middleware and trusting it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";

// JWT_SECRET must exist before _core/env is first imported: ENV is a frozen
// snapshot, so setting it later would leave every signed session unverifiable
// and these tests would fail for entirely the wrong reason.
vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "reviewer-access-test-secret-value-0123456789";
});

// Only the liveness probe is replaced; every other export stays real, so the
// constants asserted below are the shipped values rather than the mock's.
const liveness = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./reviewerAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reviewerAccess")>()),
  isReviewerSessionLive: liveness,
}));

// The database is not the subject here; the gate is.
const getUserByOpenId = vi.hoisted(() => vi.fn());
const getDb = vi.hoisted(() => vi.fn());
vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getUserByOpenId,
  getDb,
  upsertUser: vi.fn(async () => undefined),
}));

/**
 * A drizzle chain that answers with fixed rows.
 *
 * `platformScopeIsSafe` reaches the database through `./db`, which is a
 * cross-module import and therefore genuinely interceptable here — unlike a
 * module calling its own export, which module mocking cannot reach.
 */
function fakeDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "where", "orderBy"]) chain[method] = () => chain;
  chain.limit = async () => rows;
  return chain;
}

/** Answers successive queries with successive result sets, in call order. */
function fakeDbSequence(results: unknown[][]) {
  const queue = [...results];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "where", "orderBy"]) chain[method] = () => chain;
  chain.limit = async () => queue.shift() ?? [];
  return chain;
}

import { COOKIE_NAME } from "@shared/const";
import { sdk } from "./_core/sdk";
import { router, publicProcedure, protectedProcedure, adminProcedure } from "./_core/trpc";
import { REVIEWER_ROLE, REVIEWER_ROLES, REVIEWER_LOGIN_METHOD, platformScopeIsSafe, reviewerLinkUrl, DEFAULT_REVIEWER_LINK_TTL_DAYS, MAX_REVIEWER_LINK_TTL_DAYS } from "./reviewerAccess";

/**
 * A stand-in router built from the REAL exported builders.
 *
 * The point is to exercise what every router in the application is made of. A
 * test that re-declared the middleware locally would pass while the shipped
 * builders were unguarded.
 */
const probe = router({
  publicRead: publicProcedure.query(() => "read"),
  publicWrite: publicProcedure.mutation(() => "written"),
  protectedRead: protectedProcedure.query(() => "read"),
  protectedWrite: protectedProcedure.mutation(() => "written"),
  adminWrite: adminProcedure.mutation(() => "written"),
  // Named to match the real procedure path the guard allows through.
  auth: router({ logout: publicProcedure.mutation(() => "logged out") }),
});

beforeEach(() => {
  liveness.mockReset();
  liveness.mockResolvedValue(true);
  getUserByOpenId.mockReset();
  getDb.mockReset();
});

type AnyUser = Parameters<typeof probe.createCaller>[0]["user"];

function userLike(overrides: Record<string, unknown>): AnyUser {
  return {
    id: 1, openId: "u_1", name: "Test", email: "t@example.com", loginMethod: null,
    role: "admin", organizationId: 10, isGuest: false, isReadOnly: false, isActive: true,
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    ...overrides,
  } as unknown as AnyUser;
}

const caller = (user: AnyUser) =>
  probe.createCaller({ req: {} as never, res: {} as never, user });

describe("when a reviewer holds a read-only session", () => {
  const reviewer = userLike({ role: REVIEWER_ROLE, isReadOnly: true });

  it("should let them read", async () => {
    await expect(caller(reviewer).protectedRead()).resolves.toBe("read");
    await expect(caller(reviewer).publicRead()).resolves.toBe("read");
  });

  it("should refuse every write, whichever builder the procedure used", async () => {
    // The ban lives on the BASE procedure, so it does not matter which builder a
    // procedure was written with — including builders that did not exist when
    // the ban was added.
    for (const call of [
      () => caller(reviewer).protectedWrite(),
      () => caller(reviewer).publicWrite(),
      () => caller(reviewer).adminWrite(),
    ]) {
      await expect(call()).rejects.toThrow(TRPCError);
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("should explain itself, because a silent refusal reads as a broken product", async () => {
    await expect(caller(reviewer).protectedWrite()).rejects.toThrow(/read-only review session/i);
  });
});

describe("when the session is an ordinary one", () => {
  it("should still allow writes", async () => {
    const admin = userLike({ role: "admin" });
    await expect(caller(admin).protectedWrite()).resolves.toBe("written");
    await expect(caller(admin).adminWrite()).resolves.toBe("written");
  });

  // The regression this guards is precisely why isReadOnly is a separate column.
  // `isGuest` already carries "cannot write" on the procedures built from
  // guestProtectedProcedure, so reusing it for a GLOBAL ban looked tempting —
  // and would have broken the demo, where a guest legitimately calls
  // demo.activate to switch segments.
  it("should not have swept demo guests into the read-only ban", async () => {
    const guest = userLike({ role: "user", isGuest: true, isReadOnly: false });
    await expect(caller(guest).protectedWrite()).resolves.toBe("written");
  });

  it("should leave anonymous callers alone", async () => {
    await expect(caller(null).publicRead()).resolves.toBe("read");
    await expect(caller(null).publicWrite()).resolves.toBe("written");
  });
});

describe("when a reviewer signs out", () => {
  const reviewer = userLike({ role: REVIEWER_ROLE, isReadOnly: true, loginMethod: REVIEWER_LOGIN_METHOD });

  // Found in review. Logout is a publicProcedure MUTATION, so the blanket write
  // ban reached it first and refused it — leaving the session alive on the
  // device, the exact opposite of the control's purpose.
  it("should be allowed to end its own session", async () => {
    await expect(caller(reviewer).auth.logout()).resolves.toBe("logged out");
  });

  it("should still be able to sign out once the link is revoked", async () => {
    // A revoked reviewer no longer authenticates at all, so they arrive with no
    // user. Logout must still clear their cookie rather than leaving them stuck
    // holding one — which is why it is a publicProcedure and why the write ban
    // exempts it.
    await expect(caller(null).auth.logout()).resolves.toBe("logged out");
  });
});

/**
 * Revocation is enforced at AUTHENTICATION, not in the tRPC middleware.
 *
 * The first fix put it in tRPC, which was the instance rather than the class:
 * the monitoring stream and the storage proxy authenticate the same cookie
 * without passing through tRPC, and would have kept serving a revoked reviewer
 * until the session expired. So these exercise `sdk.authenticateRequest` — the
 * one gate every surface goes through — with a REAL signed session cookie.
 */
describe("when a link is revoked after it has been used", () => {
  const reviewerUser = userLike({
    id: 77, openId: "rvw_abc", role: REVIEWER_ROLE, isReadOnly: true, loginMethod: REVIEWER_LOGIN_METHOD,
  });

  async function requestWithSessionFor(user: AnyUser) {
    const u = user as unknown as { openId: string };
    const token = await sdk.createSessionToken(u.openId, { name: "Reviewer" });
    getUserByOpenId.mockResolvedValue(user);
    return { headers: { cookie: `${COOKIE_NAME}=${token}` } } as never;
  }

  it("should refuse the session everywhere once the link is revoked", async () => {
    liveness.mockResolvedValue(false);
    const req = await requestWithSessionFor(reviewerUser);
    await expect(sdk.authenticateRequest(req)).rejects.toThrow(/revoked or has expired/i);
  });

  it("should admit the session while the link is live", async () => {
    liveness.mockResolvedValue(true);
    const req = await requestWithSessionFor(reviewerUser);
    await expect(sdk.authenticateRequest(req)).resolves.toMatchObject({ id: 77 });
  });

  it("should fail closed when liveness cannot be determined", async () => {
    liveness.mockRejectedValue(new Error("database unavailable"));
    const req = await requestWithSessionFor(reviewerUser);
    await expect(sdk.authenticateRequest(req)).rejects.toThrow();
  });

  // Keyed on the reviewer login method, NOT on isReadOnly. An operator may
  // legitimately mark an ordinary user read-only; such a user has no link behind
  // them, and keying on isReadOnly would refuse them everything.
  it("should not demand a link from a read-only user who never had one", async () => {
    const readOnlyStaff = userLike({
      id: 78, openId: "staff_1", role: "compliance", isReadOnly: true, loginMethod: "magic_link",
    });
    liveness.mockResolvedValue(false);
    const req = await requestWithSessionFor(readOnlyStaff);
    await expect(sdk.authenticateRequest(req)).resolves.toMatchObject({ id: 78 });
    expect(liveness).not.toHaveBeenCalled();
  });
});

describe("when the reviewer row's read-only flag is cleared", () => {
  // `users.isReadOnly` is an ordinary editable column. As the only source of the
  // write ban it was one admin edit — or any future code path that rewrites a
  // user row without preserving the flag — away from turning a LIVE reviewer
  // session write-capable, with nothing looking wrong: valid link, successful
  // authentication, and a downstream guard that simply stops matching.
  const writableOnPaper = userLike({
    id: 79, openId: "rvw_xyz", role: REVIEWER_ROLE, isReadOnly: false, loginMethod: REVIEWER_LOGIN_METHOD,
  });

  it("should still hand back a read-only session", async () => {
    liveness.mockResolvedValue(true);
    getUserByOpenId.mockResolvedValue(writableOnPaper);
    const token = await sdk.createSessionToken("rvw_xyz", { name: "Reviewer" });
    const req = { headers: { cookie: `${COOKIE_NAME}=${token}` } } as never;

    const authed = await sdk.authenticateRequest(req);
    expect(authed.isReadOnly).toBe(true);
  });

  it("should still refuse that session's writes", async () => {
    // The end the previous assertion exists to serve: derived read-only has to
    // reach the guard, not merely be set on an object.
    liveness.mockResolvedValue(true);
    getUserByOpenId.mockResolvedValue(writableOnPaper);
    const token = await sdk.createSessionToken("rvw_xyz", { name: "Reviewer" });
    const authed = await sdk.authenticateRequest({ headers: { cookie: `${COOKIE_NAME}=${token}` } } as never);

    await expect(caller(authed as unknown as AnyUser).protectedWrite())
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("when the reviewer identity is created", () => {
  const SERVICE = fs.readFileSync(path.join(__dirname, "reviewerAccess.ts"), "utf8");

  it("should use operations rather than admin", () => {
    // Read-only stops writes; it does nothing about reads. An admin session can
    // query team membership and integration configuration, which is neither a
    // reviewer's business nor part of the journey under review.
    expect(REVIEWER_ROLE).toBe("operations");
  });

  it("should re-assert read-only on every issue rather than trusting the stored row", () => {
    // The user row is editable from the admin screens. This identity must not be
    // able to drift into a writable one through an unrelated edit.
    expect(SERVICE).toMatch(/\.set\(\{ isReadOnly: true, isActive: true, role, organizationId \}\)/);
  });

  it("should re-check read-only again at sign-in, not just at issue time", () => {
    expect(SERVICE).toMatch(/!user\.isReadOnly\) return \{ ok: false, reason: "user_unavailable" \}/);
  });

  it("should give the identity an address nothing can deliver to", () => {
    // A reachable address would be a second way in — a password reset or magic
    // link that bypasses revocation entirely.
    expect(SERVICE).toMatch(/@reviewer\.invalid/);
  });

  it("should mint one identity PER LINK, so revocation can reach a live session", () => {
    // Per-tenant identities cannot support revocation: the session JWT carries
    // only an openId, so with a shared identity there is no way to tell which
    // link a live session came from — revoking one of two would cut off both
    // reviewers or neither.
    expect(SERVICE).toMatch(/function reviewerOpenId\(token: string\)/);
    expect(SERVICE).toMatch(/ensureReviewerUser\(params\.organizationId, token, scope\)/);
    expect(SERVICE).not.toMatch(/reviewer_org_\$\{organizationId\}/);
  });

  it("should derive the identity from a hash, keeping the token out of the users table", () => {
    expect(SERVICE).toMatch(/createHash\("sha256"\)\.update\(token\)/);
  });
});

describe("when the link is scoped to the whole platform", () => {
  const SERVICE = fs.readFileSync(path.join(__dirname, "reviewerAccess.ts"), "utf8");

  it("should use super_admin for platform and operations for one tenant", () => {
    // A YC-style reviewer needs the operator view and all three verticals, which
    // is cross-tenant by definition. A SHOPLINE reviewer needs one merchant
    // portal and must not get more.
    expect(REVIEWER_ROLES.platform).toBe("super_admin");
    expect(REVIEWER_ROLES.tenant).toBe("operations");
    expect(REVIEWER_ROLE).toBe(REVIEWER_ROLES.tenant);
  });

  it("should still be read-only, super_admin or not", () => {
    // The role decides what a session may SEE. The write ban is separate,
    // global, and derived from the login method — so widening the role does not
    // widen what the session can do.
    expect(SERVICE).toMatch(/isReadOnly: true/);
  });

  // BEHAVIOURAL, not a source regex. The structural versions of these passed
  // while the function was mutated to `return true` — they asserted that the
  // right predicates appear in the file, never that the answer depends on them.
  it("should allow a platform link when every organisation is a demo", async () => {
    getDb.mockResolvedValue(fakeDb([])); // no real tenant found
    await expect(platformScopeIsSafe()).resolves.toBe(true);
  });

  it("should withhold it the moment one real tenant exists", async () => {
    // Every organisation in production is a demo today, which is the only reason
    // a cross-tenant link is acceptable at all. Onboard one real bank and an
    // outstanding link becomes a disclosure of that bank's data.
    getDb.mockResolvedValue(fakeDb([{ id: 1 }]));
    await expect(platformScopeIsSafe()).resolves.toBe(false);
  });

  it("should fail closed when the database cannot answer", async () => {
    getDb.mockResolvedValue(null);
    await expect(platformScopeIsSafe()).resolves.toBe(false);
  });

  it("should count a real tenant even when it has been deactivated", async () => {
    // Deactivating an organisation stops its members signing in; it does not
    // delete its rows, and allOrganizations / getOrgContext / dashboard.stats do
    // not filter on isActive either. Treating an inactive real tenant as absent
    // would report the platform safe with that customer's data one click away.
    const SERVICE_NOW = fs.readFileSync(path.join(__dirname, "reviewerAccess.ts"), "utf8");
    const predicate = SERVICE_NOW.slice(
      SERVICE_NOW.indexOf("export async function platformScopeIsSafe"),
      SERVICE_NOW.indexOf("return !realTenant;"),
    );
    expect(predicate).not.toMatch(/isActive/);
  });

  it("should ask the question in terms of isDemo, excluding the operator's own org", () => {
    // The operator's super_admin org is never isDemo and holds no tenant data,
    // so counting it would withhold every platform link permanently.
    expect(SERVICE).toMatch(/eq\(organizations\.isDemo, false\)/);
    expect(SERVICE).toMatch(/ne\(organizations\.segment, "super_admin"\)/);
  });

  it("should re-check that condition at SIGN-IN, not only when the link was issued", () => {
    // Issue-time alone would be meaningless: the link outlives the moment it was
    // created, and the condition it depends on is exactly the one that changes
    // when the business succeeds. Nobody will connect "we signed our first bank"
    // to "an old reviewer link is still live".
    const resolve = SERVICE.slice(SERVICE.indexOf("export async function resolveReviewerLink"));
    expect(resolve).toMatch(/scope === "platform" && !\(await platformScopeIsSafe\(\)\)/);
    expect(resolve).toMatch(/reason: "platform_scope_withdrawn"/);
  });

  it("should refuse to issue one under the same condition", () => {
    const issue = SERVICE.slice(SERVICE.indexOf("export async function issueReviewerLink"), SERVICE.indexOf("function toView"));
    expect(issue).toMatch(/scope === "platform" && !\(await platformScopeIsSafe\(\)\)/);
  });

  it("should land a platform reviewer on the operator view, not a vertical's home page", () => {
    // /home resolves a starting page per vertical — right for a tenant reviewer,
    // arbitrary for someone here to see the whole platform.
    const INDEX = fs.readFileSync(path.join(__dirname, "_core", "index.ts"), "utf8");
    expect(INDEX).toMatch(/resolved\.scope === "platform" \? "\/admin\/super-admin" : "\/home"/);
  });
});

/**
 * The first-customer condition is part of LIVENESS, not only of sign-in.
 *
 * These use the REAL `isReviewerSessionLive` (the rest of the file mocks it), so
 * they prove the composition rather than a stand-in for it.
 */
describe("when a real tenant appears after a platform reviewer has signed in", () => {
  let realLiveness: typeof import("./reviewerAccess").isReviewerSessionLive;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("./reviewerAccess")>("./reviewerAccess");
    realLiveness = actual.isReviewerSessionLive;
  });

  const liveLink = (scope: string) => [{ id: 5, scope }];

  it("should end the session on the next request, not at session expiry", async () => {
    // Checking only at sign-in leaves a reviewer who signed in the day before
    // onboarding reading the new tenant's data for the rest of the TTL — the
    // revocation bug again, one condition further along.
    getDb.mockResolvedValue(fakeDbSequence([liveLink("platform"), [{ id: 99 }]]));
    await expect(realLiveness(77)).resolves.toBe(false);
  });

  it("should keep the session while every organisation is still a demo", async () => {
    getDb.mockResolvedValue(fakeDbSequence([liveLink("platform"), []]));
    await expect(realLiveness(77)).resolves.toBe(true);
  });

  it("should not impose the platform condition on a tenant-scoped session", async () => {
    // A tenant link is pinned to one organisation and is unaffected by what else
    // the platform holds. Only the link row is consulted.
    getDb.mockResolvedValue(fakeDbSequence([liveLink("tenant"), [{ id: 99 }]]));
    await expect(realLiveness(77)).resolves.toBe(true);
  });

  it("should still refuse a revoked or expired link before any of that", async () => {
    getDb.mockResolvedValue(fakeDbSequence([[], []]));
    await expect(realLiveness(77)).resolves.toBe(false);
  });
});

describe("when a link is issued", () => {
  it("should build a URL against the configured origin", () => {
    expect(reviewerLinkUrl("tok123", "https://www.reconcileaiafrica.com"))
      .toBe("https://www.reconcileaiafrica.com/api/reviewer-access?key=tok123");
  });

  it("should not double the slash when the origin carries a trailing one", () => {
    expect(reviewerLinkUrl("tok123", "https://example.com/"))
      .toBe("https://example.com/api/reviewer-access?key=tok123");
  });

  it("should outlast a review without becoming permanent", () => {
    expect(DEFAULT_REVIEWER_LINK_TTL_DAYS).toBe(90);
    expect(MAX_REVIEWER_LINK_TTL_DAYS).toBeLessThanOrEqual(180);
    expect(DEFAULT_REVIEWER_LINK_TTL_DAYS).toBeLessThanOrEqual(MAX_REVIEWER_LINK_TTL_DAYS);
  });
});

describe("when the guard is wired into the procedure builders", () => {
  const TRPC = fs.readFileSync(path.join(__dirname, "_core", "trpc.ts"), "utf8");

  it("should build every exported builder from the guarded base", () => {
    // The behavioural tests above cover the builders that exist today. This
    // catches the way the guarantee would be lost tomorrow: someone re-basing a
    // builder on the raw `t.procedure` and quietly dropping the ban.
    expect(TRPC).toMatch(/const baseProcedure = t\.procedure\.use\(refuseReadOnlyWrites\)/);
    expect(TRPC).toMatch(/export const publicProcedure = baseProcedure/);
    expect(TRPC).toMatch(/export const protectedProcedure = baseProcedure\.use\(requireUser\)/);
    expect(TRPC).toMatch(/export const adminProcedure = baseProcedure\.use\(/);
    // No exported builder may go back to the unguarded procedure.
    expect(TRPC).not.toMatch(/export const \w+Procedure = t\.procedure/);
  });

  it("should allow queries and refuse everything else, rather than naming what to block", () => {
    // An allow-list: a new tRPC operation type cannot land on the permitted side
    // by default.
    expect(TRPC).toMatch(/type !== "query"/);
  });
});
