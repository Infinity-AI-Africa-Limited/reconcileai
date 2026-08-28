/**
 * Read-only reviewer sessions.
 *
 * The link hands an external party a real session in the production
 * application, so the write ban is the load-bearing control and is tested as
 * behaviour — a procedure is actually called and actually refused — rather than
 * by reading the middleware and trusting it.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure, adminProcedure } from "./_core/trpc";
import { REVIEWER_ROLE, reviewerLinkUrl, DEFAULT_REVIEWER_LINK_TTL_DAYS, MAX_REVIEWER_LINK_TTL_DAYS } from "./reviewerAccess";

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
