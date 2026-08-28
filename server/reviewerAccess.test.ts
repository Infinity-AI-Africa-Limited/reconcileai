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

// Only the liveness probe is replaced; every other export stays real, so the
// constants asserted below are the shipped values rather than the mock's.
const liveness = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./reviewerAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reviewerAccess")>()),
  isReviewerSessionLive: liveness,
}));

import { router, publicProcedure, protectedProcedure, adminProcedure } from "./_core/trpc";
import { REVIEWER_ROLE, REVIEWER_LOGIN_METHOD, reviewerLinkUrl, DEFAULT_REVIEWER_LINK_TTL_DAYS, MAX_REVIEWER_LINK_TTL_DAYS } from "./reviewerAccess";

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

  it("should still be allowed to sign out after the link is revoked", async () => {
    // Otherwise a revoked reviewer is stuck holding a cookie they cannot clear.
    liveness.mockResolvedValue(false);
    await expect(caller(reviewer).auth.logout()).resolves.toBe("logged out");
  });
});

describe("when a link is revoked after it has been used", () => {
  const reviewer = userLike({ role: REVIEWER_ROLE, isReadOnly: true, loginMethod: REVIEWER_LOGIN_METHOD });

  // Also found in review. The session cookie is a stateless JWT, so revocation
  // stopped new exchanges and did nothing to sessions already minted — they kept
  // working for the full TTL. An operator revoking during an incident would
  // reasonably believe access had stopped.
  it("should cut off reads immediately, not at session expiry", async () => {
    liveness.mockResolvedValue(false);
    await expect(caller(reviewer).protectedRead()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("should let a live link keep reading", async () => {
    liveness.mockResolvedValue(true);
    await expect(caller(reviewer).protectedRead()).resolves.toBe("read");
  });

  it("should fail closed when liveness cannot be determined", async () => {
    liveness.mockRejectedValue(new Error("database unavailable"));
    await expect(caller(reviewer).protectedRead()).rejects.toThrow();
  });

  // The liveness probe keys on the reviewer login method, NOT on isReadOnly.
  // An operator may legitimately mark an ordinary user read-only; such a user
  // has no link behind them, and keying on isReadOnly would lock them out of
  // reads entirely.
  it("should not demand a link from a read-only user who never had one", async () => {
    const readOnlyStaff = userLike({ role: "compliance", isReadOnly: true, loginMethod: "magic_link" });
    liveness.mockResolvedValue(false);
    await expect(caller(readOnlyStaff).protectedRead()).resolves.toBe("read");
    expect(liveness).not.toHaveBeenCalled();
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
    expect(SERVICE).toMatch(/\.set\(\{ isReadOnly: true, isActive: true, role: REVIEWER_ROLE, organizationId \}\)/);
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
    expect(SERVICE).toMatch(/ensureReviewerUser\(params\.organizationId, token\)/);
    expect(SERVICE).not.toMatch(/reviewer_org_\$\{organizationId\}/);
  });

  it("should derive the identity from a hash, keeping the token out of the users table", () => {
    expect(SERVICE).toMatch(/createHash\("sha256"\)\.update\(token\)/);
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
