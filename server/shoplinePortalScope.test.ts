/**
 * Cross-tenant scope on the SHOPLINE connector's portal-aware procedures.
 *
 * Settlement Monitor and Sync Status accept an `organizationId` so an Infinity
 * AI support session viewing a merchant's portal sees THAT merchant's connector
 * data rather than its own. The parameter is the whole risk: it lets a caller
 * name a tenant, so the only thing standing between it and a cross-tenant read
 * is `resolveOrgScope` refusing a non-super-admin.
 *
 * ── Why this file calls the procedures instead of reading the source ────────
 *
 * The version that shipped with the change asserted strings against the router
 * and the two pages — `expect(connectorRouter).toContain("const orgId = ...")`,
 * and even a literal `"syncStatus: protectedProcedure\n    .input(z.object({"`.
 * That checks the code is written a particular way, not that it behaves a
 * particular way, and it fails at both ends: it would pass unchanged if
 * `resolveOrgScope` were weakened to let any admin through, and it breaks on a
 * reformat that changed nothing.
 *
 * `assessmentLeadAccess.test.ts` already made this exact correction after
 * review, for the same reason. These call the procedures and assert the outcome
 * a caller actually gets.
 *
 * ── Why no database is needed ───────────────────────────────────────────────
 *
 * The scope is resolved before the handler opens a connection, so a refused
 * call never reaches one. That ordering is deliberate: with the lookup first, a
 * cross-tenant attempt during a database outage answered INTERNAL_SERVER_ERROR
 * instead of FORBIDDEN, which is both the wrong answer and untestable here.
 *
 * The permitted case therefore asserts only that the caller is NOT refused —
 * what the handler then reads is that handler's own concern, and asserting on
 * it would make an authorisation test fail for unrelated reasons.
 */
import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";

type Caller = ReturnType<typeof appRouter.createCaller>;

function contextFor(role: string | null, organizationId: number | null = 42) {
  return {
    user: role === null ? null : { id: 7, role, organizationId, email: "person@example.com" },
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie: () => {}, clearCookie: () => {} },
  } as never;
}

const callerAs = (role: string | null, orgId: number | null = 42) =>
  appRouter.createCaller(contextFor(role, orgId));

/** Another tenant's id — never the caller's own 42. */
const OTHER_ORG = 60001;

/**
 * Every procedure that accepts an `organizationId` override, with a valid input.
 *
 * Inputs are valid on purpose: a call rejected as BAD_REQUEST proves nothing
 * about authorisation, and a test that cannot tell the two apart is noise.
 */
const SCOPED_CALLS: ReadonlyArray<readonly [string, (c: Caller, orgId: number) => Promise<unknown>]> = [
  ["syncStatus", (c, orgId) => c.shoplineConnector.syncStatus({ organizationId: orgId })],
  ["recentWebhookEvents", (c, orgId) => c.shoplineConnector.recentWebhookEvents({ limit: 50, organizationId: orgId })],
  ["triggerManualSync", (c, orgId) => c.shoplineConnector.triggerManualSync({ storeId: 1, organizationId: orgId })],
  ["listStores", (c, orgId) => c.shoplineConnector.listStores({ organizationId: orgId })],
] as const;

/** The tRPC error code a call rejected with, or null if it did not reject. */
async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof TRPCError ? err.code : `NON_TRPC:${(err as Error)?.message}`;
  }
}

describe("when a tenant user names another organisation", () => {
  it.each(SCOPED_CALLS)("should refuse %s with FORBIDDEN", async (_name, run) => {
    for (const role of ["admin", "user", "operations", "compliance", "cfo"]) {
      const code = await codeOf(() => run(callerAs(role), OTHER_ORG));
      expect(code, `role ${role} must not read organisation ${OTHER_ORG}`).toBe("FORBIDDEN");
    }
  });

  it("should refuse even when the named organisation is the caller's own", async () => {
    // The override is a super-admin capability, not a self-service one. Letting
    // it through for a matching id would make the guard depend on the value
    // rather than on the role, and the next caller to pass a different one
    // would be relying on a check that had already been softened.
    for (const [name, run] of SCOPED_CALLS) {
      const code = await codeOf(() => run(callerAs("admin", 42), 42));
      expect(code, name).toBe("FORBIDDEN");
    }
  });
});

describe("when Infinity AI staff name another organisation", () => {
  it.each(SCOPED_CALLS)("should not refuse %s on authorisation grounds", async (_name, run) => {
    const code = await codeOf(() => run(callerAs("super_admin"), OTHER_ORG));
    expect(code).not.toBe("FORBIDDEN");
    expect(code).not.toBe("UNAUTHORIZED");
  });
});

describe("when no organisation is named", () => {
  it.each(SCOPED_CALLS)("should not refuse %s for an ordinary tenant user", async (_name, run) => {
    // Omitting the override is the normal path: the procedure falls back to the
    // caller's own organisation, which every authenticated tenant user may read.
    const code = await codeOf(() =>
      (run as unknown as (c: Caller, orgId: undefined) => Promise<unknown>)(callerAs("admin"), undefined),
    );
    expect(code).not.toBe("FORBIDDEN");
  });

  it("should still refuse a caller with no organisation at all", async () => {
    // "No organisation" is not "unknown organisation" — an account with none
    // must not fall through into a shared pseudo-tenant (CLAUDE.md §9C). There
    // are 22 such accounts on the platform, so this is a live path.
    //
    // PRECONDITION_FAILED rather than FORBIDDEN, and that is the better answer:
    // the caller is not barred from the data, their account is simply not
    // linked to a tenant yet. What matters here is that it REFUSES rather than
    // resolving to something.
    const code = await codeOf(() => callerAs("admin", null).shoplineConnector.syncStatus({}));
    expect(code).toBe("PRECONDITION_FAILED");
  });

  it("should refuse an unauthenticated caller outright", async () => {
    const code = await codeOf(() => callerAs(null).shoplineConnector.syncStatus({}));
    expect(code).toBe("UNAUTHORIZED");
  });
});
