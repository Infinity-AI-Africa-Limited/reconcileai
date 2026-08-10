/**
 * Assessment lead-pipeline access.
 *
 * `complianceAssessments` holds Infinity AI's OWN sales pipeline — the leads
 * captured by the public CBN readiness tool. Respondent names, work emails,
 * institution names, risk scores. It is platform-operator data, not tenant
 * data, and the table carries no organizationId to scope by because it is not
 * meant to be reachable from inside a tenant at all.
 *
 * Every one of these procedures guarded on `ctx.user.role !== "admin"`, which
 * ANY organisation's admin satisfies. At the time this was found the only two
 * `admin` accounts on the platform were both SHOPLINE retail merchants, who
 * could therefore list the whole pipeline, export it to CSV, and — via
 * bulkSendDemoInvites — send mail to all of it on Infinity AI's behalf.
 *
 * The nav item was `roles: ["admin"]`, so the LINK was hidden from most users.
 * That is the trap this file exists to prevent: hiding a menu entry is not
 * access control, and a reader who sees the nav gate can easily assume the
 * procedure behind it is gated too.
 *
 * ── How this is tested, and why it changed ────────────────────────────────
 *
 * The first version of this file read `routers.ts` off disk and asserted that
 * each procedure was DECLARED as `superAdminProcedure`. That checks that the
 * code is wired a particular way, not that it behaves a particular way, and it
 * fails at both ends: it would pass if `superAdminProcedure` itself were
 * weakened to let admins through, and it would fail on a rename that changed
 * nothing. Review called it correctly.
 *
 * These call the procedures instead and assert the outcome a caller actually
 * gets. That survives any refactor that keeps the behaviour, and breaks the
 * moment the behaviour regresses — including regressions in the shared guard,
 * which the source check could never see.
 *
 * No database is needed and none is used. The guard runs as middleware, before
 * any handler touches the DB, so a refused call never reaches one. The
 * permitted case asserts only that the caller is NOT refused — what the handler
 * then does with the data is that handler's own test, and asserting on it here
 * would make an authorisation test fail for unrelated reasons.
 */
import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";

type Caller = ReturnType<typeof appRouter.createCaller>;

/** A session context in the shape the tRPC procedures read. */
function contextFor(role: string | null, organizationId: number | null = 42) {
  return {
    user: role === null ? null : { id: 7, role, organizationId, email: "person@example.com" },
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie: () => {}, clearCookie: () => {} },
  } as never;
}

const callerAs = (role: string | null) => appRouter.createCaller(contextFor(role));

/** A 48-character token, the length every by-token procedure requires. */
const TOKEN = "a".repeat(48);

/**
 * Every procedure that reads or mutates the lead pipeline, with a VALID input.
 *
 * The inputs are valid on purpose. An invalid one would be rejected as a bad
 * request, and a test that cannot tell BAD_REQUEST from FORBIDDEN proves
 * nothing about authorisation.
 */
const OPERATOR_CALLS: ReadonlyArray<readonly [string, (c: Caller) => Promise<unknown>]> = [
  ["listAll", (c) => c.assessment.listAll({ page: 1, pageSize: 20 })],
  ["exportCsv", (c) => c.assessment.exportCsv({})],
  ["countBulkEligible", (c) => c.assessment.countBulkEligible()],
  ["bulkSendDemoInvites", (c) => c.assessment.bulkSendDemoInvites()],
  ["sendDemoInvite", (c) => c.assessment.sendDemoInvite({ token: TOKEN })],
  ["markContacted", (c) => c.assessment.markContacted({ token: TOKEN, contacted: true })],
  ["updateNotes", (c) => c.assessment.updateNotes({ token: TOKEN, notes: "note" })],
  ["setFollowUpDue", (c) => c.assessment.setFollowUpDue({ token: TOKEN, dueAt: null })],
  ["setPipelineStage", (c) => c.assessment.setPipelineStage({ token: TOKEN, stage: "contacted" })],
] as const;

/** The tRPC error code a call rejected with, or null if it did not reject. */
async function refusalCode(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (err) {
    return err instanceof TRPCError ? err.code : `non-trpc: ${String(err)}`;
  }
}

/**
 * Roles that exist on the platform and are NOT Infinity AI staff. `admin` is
 * the one that mattered — it is an ORGANISATION role, held by every tenant's
 * administrator, and it was the original guard.
 */
const TENANT_ROLES = ["admin", "cfo", "operations", "compliance", "user"] as const;

describe("when a tenant user calls a lead-pipeline procedure", () => {
  for (const role of TENANT_ROLES) {
    for (const [name, call] of OPERATOR_CALLS) {
      it(`should refuse ${name} for a ${role}`, async () => {
        const code = await refusalCode(() => call(callerAs(role)));
        expect(
          code,
          `${role} reached assessment.${name}. This table is Infinity AI's own sales ` +
            `pipeline and has no organizationId to scope by, so any caller who is not ` +
            `platform staff can read or mail every lead on it.`,
        ).toBe("FORBIDDEN");
      });
    }
  }
});

describe("when nobody is signed in", () => {
  for (const [name, call] of OPERATOR_CALLS) {
    it(`should refuse ${name}`, async () => {
      // UNAUTHORIZED rather than FORBIDDEN: the authentication check comes
      // first. Either way the pipeline is not reachable, which is the claim.
      const code = await refusalCode(() => call(callerAs(null)));
      expect(["UNAUTHORIZED", "FORBIDDEN"]).toContain(code);
    });
  }
});

describe("when Infinity AI staff call a lead-pipeline procedure", () => {
  for (const [name, call] of OPERATOR_CALLS) {
    it(`should let a super_admin past the guard for ${name}`, async () => {
      // Asserts only that the guard does not refuse. The handler beyond it
      // needs a database, so it may fail here for an unrelated reason — that is
      // the handler's business, not this file's. What must never happen is
      // FORBIDDEN, which would mean the tightening over-reached and locked the
      // pipeline away from the only people entitled to it.
      const code = await refusalCode(() => call(callerAs("super_admin")));
      expect(
        code,
        `assessment.${name} refused a super_admin. The tightening must not lock ` +
          `Infinity AI out of its own pipeline.`,
      ).not.toBe("FORBIDDEN");
    });
  }
});

describe("when a prospect uses the public funnel", () => {
  // The whole point of the funnel is that a prospect can submit without an
  // account and read their own result back by unguessable token. The tightening
  // above must not reach into these — locking them would break lead capture.
  const PUBLIC_CALLS: ReadonlyArray<readonly [string, (c: Caller) => Promise<unknown>]> = [
    ["getByToken", (c) => c.assessment.getByToken({ token: TOKEN })],
    ["unsubscribe", (c) => c.assessment.unsubscribe({ token: TOKEN })],
  ] as const;

  for (const [name, call] of PUBLIC_CALLS) {
    it(`should not require a session for ${name}`, async () => {
      const code = await refusalCode(() => call(callerAs(null)));
      expect(
        ["UNAUTHORIZED", "FORBIDDEN"],
        `assessment.${name} must stay reachable without an account.`,
      ).not.toContain(code);
    });
  }
});
