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
import { readFileSync } from "node:fs";
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
  ["getStore", (c, orgId) => c.shoplineConnector.getStore({ storeId: 1, organizationId: orgId })],
  ["planStatus", (c, orgId) => c.shoplineConnector.planStatus({ organizationId: orgId })],
  [
    "importSettlementFile",
    (c, orgId) =>
      c.shoplineConnector.importSettlementFile({
        organizationId: orgId,
        fileName: "scope-test.csv",
        content: "order_id,amount\norder-1,1.00",
        sourceLabel: "scope test",
        dryRun: true,
      }),
  ],
  [
    "exceptionIntelligence",
    (c, orgId) => c.shoplineConnector.exceptionIntelligence({ category: "retail_chargeback", organizationId: orgId }),
  ],
] as const;

/**
 * Operator tools that also name an organisation, but for a different reason.
 *
 * `provisionStore` is a `superAdminProcedure` whose `organizationId` is
 * REQUIRED — it provisions a store into a named tenant, so there is no
 * "own organisation" fallback to test. It is gated by the procedure's own
 * middleware rather than by `resolveOrgScope`.
 *
 * It is listed because the refusal property is identical and worth asserting: a
 * tenant admin must not be able to provision a store into somebody else's
 * organisation. Only the no-override case does not apply to it.
 */
const OPERATOR_ONLY_CALLS: ReadonlyArray<readonly [string, (c: Caller, orgId: number) => Promise<unknown>]> = [
  [
    "provisionStore",
    (c, orgId) =>
      c.shoplineConnector.provisionStore({
        organizationId: orgId,
        storeHandle: "some-store",
        storeShoplineId: "1785294964809",
        currency: "USD",
      }),
  ],
] as const;

/** Everything that lets a caller name a tenant, however it is gated. */
const ALL_ORG_NAMING_CALLS = [...SCOPED_CALLS, ...OPERATOR_ONLY_CALLS] as const;

/**
 * The roster above must not go stale, and enumerating it by hand is how it did.
 *
 * The first version covered four procedures. `exceptionIntelligence` and
 * `planStatus` also take an `organizationId`, were also authorising AFTER the
 * database lookup, and were simply absent — so the suite reported green over an
 * incomplete fix. Review caught what these tests were shaped not to see.
 *
 * So the roster is checked against the router rather than trusted: every
 * procedure whose INPUT SCHEMA declares `organizationId` must appear above.
 */
function proceduresAcceptingAnOrgOverride(): string[] {
  const source = readFileSync("server/routers/shoplineConnector.ts", "utf8");
  const declarations = [
    // `\w*` not `\w+`: protectedProcedure has nothing between the prefix and
    // "Procedure", so a + here silently matches only superAdminProcedure and the
    // detector reports one procedure instead of seven — a vacuous check that
    // looks like a passing one.
    ...source.matchAll(/^[ ]{2,4}([A-Za-z][A-Za-z0-9]*): (?:protected|super|public)\w*Procedure/gm),
  ];
  const found = new Set<string>();

  for (const [index, declaration] of declarations.entries()) {
    const start = declaration.index ?? 0;
    const end = declarations[index + 1]?.index ?? source.length;
    // Only the input schema counts. `organizationId` appears throughout the
    // handler bodies as a column reference, which would match every procedure.
    const head = source.slice(start, end).split("=> {")[0];
    if (/organizationId: z\./.test(head)) found.add(declaration[1]);
  }
  return [...found];
}

/** The tRPC error code a call rejected with, or null if it did not reject. */
async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof TRPCError ? err.code : `NON_TRPC:${(err as Error)?.message}`;
  }
}

describe("the roster of scoped procedures", () => {
  it("should cover every procedure that accepts an organizationId override", () => {
    const declared = proceduresAcceptingAnOrgOverride().sort();
    const covered = ALL_ORG_NAMING_CALLS.map(([name]) => name).sort();
    // A new override-taking procedure fails here until it is exercised below.
    // That is the only thing stopping this suite drifting back to partial, which
    // is how exceptionIntelligence and planStatus went unnoticed the first time.
    expect(covered).toEqual(expect.arrayContaining(declared));
  });

  it("should find some, so the check above cannot pass vacuously", () => {
    expect(proceduresAcceptingAnOrgOverride().length).toBeGreaterThanOrEqual(6);
  });
});

describe("when a tenant user names another organisation", () => {
  it.each(ALL_ORG_NAMING_CALLS)("should refuse %s with FORBIDDEN", async (_name, run) => {
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
