import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

/**
 * An organisation id that cannot exist, for tests that must reach a mutation's
 * authorization layer without changing anything.
 *
 * `DATABASE_URL` in a developer `.env` and in CI points at the SHARED database,
 * so a tRPC mutation invoked from a test is a real write to real data. That is
 * not hypothetical: the two "does not refuse super_admin" tests below used
 * `organizationId: 1` and quietly set `isDemo = false` and
 * `bankingModel = "conventional"` on Globus Bank Nigeria (Demo) on every run.
 * The isDemo write re-armed the SLA monitor against 411 seeded exceptions and
 * emailed the owner a 382-breach alert — the precise failure the isDemo column
 * had just been added to prevent.
 *
 * Passing an absent id means `assertOrganizationExists` refuses with NOT_FOUND
 * BEFORE the UPDATE, which still proves what these tests are for: the caller got
 * past the super-admin guard and past zod. Authorization is observed; nothing is
 * mutated.
 *
 * The value is chosen so no row CAN hold it, rather than so no row currently
 * does. `organizations.id` is a MySQL signed INT — `int("id").autoincrement()`
 * — whose maximum is 2,147,483,647, so 2,147,483,648 exceeds what the column is
 * physically able to store. A `WHERE id = 2147483648` comparison is legal and
 * simply matches nothing.
 *
 * That distinction is the point. The previous sentinel, 2_146_000_000, was
 * merely implausible: had an organisation ever been created with that id, the
 * existence guard would have accepted it and these tests would have written to
 * a real tenant while the regression assertions stayed green. An earlier version
 * of this comment claimed the value was "asserted below to be absent"; it was
 * not, and an id that cannot exist needs no such assertion.
 */
const MYSQL_SIGNED_INT_MAX = 2_147_483_647;
const ABSENT_ORG_ID = MYSQL_SIGNED_INT_MAX + 1;

/**
 * The tRPC error code from a thrown value, without reaching for `any`.
 *
 * CLAUDE.md §16 bans `any`, and reading `.code` off an untyped error is exactly
 * the hole that ban exists to close: a renamed or absent property yields
 * `undefined`, and `expect(undefined).not.toBe("FORBIDDEN")` passes — so the
 * assertion silently stops testing anything. Returning a descriptive string for
 * an unrecognised shape makes that failure visible instead.
 */
function errorCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : `<no code: ${String(err)}>`;
}

/**
 * Assert a mutation got PAST authorization and validation without writing.
 *
 * Two outcomes are both correct, and which occurs depends on the environment
 * rather than on the code under test:
 *
 *   NOT_FOUND              a database is reachable, so assertOrganizationExists
 *                          ran and refused the absent id before the UPDATE
 *   INTERNAL_SERVER_ERROR  no database configured, so the procedure failed at
 *                          getDb() — also before any write
 *
 * What must never happen is FORBIDDEN or BAD_REQUEST: either would mean the
 * caller never reached the mutation, and the test would pass vacuously.
 * Asserting NOT_FOUND alone made this suite environment-dependent — green in
 * CI, red locally — which is its own kind of unreliable.
 */
async function expectNoWriteButAuthorized(call: () => Promise<unknown>): Promise<void> {
  // The success case is recorded and asserted OUTSIDE the try. Throwing from
  // inside it would be caught by the very catch below, turning "the mutation
  // unexpectedly succeeded" into a confusing assertion about an undefined error
  // code — the loudest signal in this helper, swallowed by its own handler.
  let refused: unknown;
  let succeeded = false;
  try {
    await call();
    succeeded = true;
  } catch (err) {
    refused = err;
  }
  expect(
    succeeded,
    "the mutation SUCCEEDED against an id that cannot exist — the guard is gone, " +
      "and a test in this file may now be writing to a real organisation",
  ).toBe(false);

  const code = errorCode(refused);
  expect(code, `unexpected refusal: ${code}`).not.toBe("FORBIDDEN");
  expect(code).not.toBe("BAD_REQUEST");
  expect(["NOT_FOUND", "INTERNAL_SERVER_ERROR"]).toContain(code);
}

function createCtxWithRole(role: AuthenticatedUser["role"]): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: `test-user-${role}`,
    email: `${role}@test.reconcileai.com`,
    name: `Test ${role}`,
    loginMethod: "manus",
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
      cookie: () => {},
    } as unknown as TrpcContext["res"],
  };
}

// ─── superAdmin.platformStats ─────────────────────────────────────────────────
describe("superAdmin.platformStats", () => {
  it("throws FORBIDDEN for admin role", async () => {
    const ctx = createCtxWithRole("admin");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.superAdmin.platformStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN for user role", async () => {
    const ctx = createCtxWithRole("user");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.superAdmin.platformStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN for cfo role", async () => {
    const ctx = createCtxWithRole("cfo");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.superAdmin.platformStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN for operations role", async () => {
    const ctx = createCtxWithRole("operations");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.superAdmin.platformStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN for compliance role", async () => {
    const ctx = createCtxWithRole("compliance");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.superAdmin.platformStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("allows super_admin role to call platformStats", async () => {
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    // The DB may not be available in test env, so we just check it doesn't throw FORBIDDEN
    try {
      const result = await caller.superAdmin.platformStats();
      expect(result).toHaveProperty("totalOrgs");
      expect(result).toHaveProperty("totalUsers");
      expect(result).toHaveProperty("totalJobs");
    } catch (err) {
      // Only INTERNAL_SERVER_ERROR is acceptable (DB not available in test env)
      expect(errorCode(err)).not.toBe("FORBIDDEN");
    }
  });
});

// ─── superAdmin.platformAnalytics ─────────────────────────────────────────────
describe("superAdmin.platformAnalytics", () => {
  it.each(["admin", "user", "cfo", "operations", "compliance"] as const)(
    "throws FORBIDDEN for %s role",
    async (role) => {
      const ctx = createCtxWithRole(role);
      const caller = appRouter.createCaller(ctx);
      await expect(caller.superAdmin.platformAnalytics()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    },
  );

  it("allows super_admin role and returns the analytics shape", async () => {
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    // DB may be unavailable in the test env — the procedure returns a typed
    // empty payload rather than throwing, so the shape assertions hold either way.
    try {
      const result = await caller.superAdmin.platformAnalytics();
      expect(result).toHaveProperty("totals");
      expect(result.totals).toHaveProperty("orgs");
      expect(result.totals).toHaveProperty("openExceptions");
      expect(result).toHaveProperty("volume");
      expect(result.volume).toHaveProperty("avgMatchRate");
      expect(Array.isArray(result.segmentBreakdown)).toBe(true);
      expect(Array.isArray(result.roleBreakdown)).toBe(true);
      expect(Array.isArray(result.jobStatusBreakdown)).toBe(true);
      expect(Array.isArray(result.moduleBreakdown)).toBe(true);
      expect(Array.isArray(result.orgGrowth)).toBe(true);
      expect(Array.isArray(result.jobTrend)).toBe(true);
      expect(Array.isArray(result.topOrgs)).toBe(true);
    } catch (err) {
      expect(errorCode(err)).not.toBe("FORBIDDEN");
    }
  });
});

// ─── admin.users — super_admin should also be able to access admin procedures ──
describe("admin.users (adminProcedure)", () => {
  it("throws FORBIDDEN for user role", async () => {
    const ctx = createCtxWithRole("user");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.users()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN for cfo role", async () => {
    const ctx = createCtxWithRole("cfo");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.users()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("allows admin role to call admin.users", async () => {
    const ctx = createCtxWithRole("admin");
    const caller = appRouter.createCaller(ctx);
    try {
      const result = await caller.admin.users();
      expect(Array.isArray(result)).toBe(true);
    } catch (err) {
      expect(errorCode(err)).not.toBe("FORBIDDEN");
    }
  });

  it("allows super_admin role to call admin.users (elevated access)", async () => {
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    try {
      const result = await caller.admin.users();
      expect(Array.isArray(result)).toBe(true);
    } catch (err) {
      expect(errorCode(err)).not.toBe("FORBIDDEN");
    }
  });
});

// ─── superAdmin.setOrganizationBankingModel ───────────────────────────────────
//
// Marks an institution as operating on non-interest (NIFI) principles, which
// makes the Super Agent apply the NIFI taxonomy across every rail that tenant
// runs. It is a claim about the institution's LICENCE BASIS and the resulting
// findings are regulator-facing, so a tenant must not be able to assert it about
// itself — hence super_admin only, like the SSO opt-in it mirrors.
describe("superAdmin.setOrganizationBankingModel", () => {
  const NON_STAFF_ROLES = ["admin", "operations", "compliance", "cfo", "user"] as const;

  for (const role of NON_STAFF_ROLES) {
    it(`throws FORBIDDEN for ${role} role`, async () => {
      const ctx = createCtxWithRole(role);
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.superAdmin.setOrganizationBankingModel({
          organizationId: ABSENT_ORG_ID,
          bankingModel: "non_interest",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }

  it("rejects a banking model outside the two known values", async () => {
    // The column is varchar so the database will accept anything; the zod enum
    // is the only thing stopping an arbitrary string being written and then
    // silently read as "not non_interest" forever.
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.superAdmin.setOrganizationBankingModel({
        organizationId: ABSENT_ORG_ID,
        bankingModel: "islamic" as unknown as "non_interest",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a non-positive organizationId", async () => {
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.superAdmin.setOrganizationBankingModel({
        organizationId: 0,
        bankingModel: "conventional",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("does not refuse super_admin on authorization grounds", async () => {
    // Targets an id that cannot exist, so the procedure is refused before any
    // UPDATE runs — see ABSENT_ORG_ID.
    const caller = appRouter.createCaller(createCtxWithRole("super_admin"));
    await expectNoWriteButAuthorized(() =>
      caller.superAdmin.setOrganizationBankingModel({
        organizationId: ABSENT_ORG_ID,
        bankingModel: "conventional",
      }),
    );
  });
});

// ─── superAdmin.setOrganizationIsDemo ─────────────────────────────────────────
//
// Marks a tenant as a demo so SLA alerting skips it. An ALERT-SUPPRESSING
// control, which is why it is super-admin only and why it must not report
// success when it changed nothing: on 2026-08-14 the owner received 374 seeded
// exceptions as real SLA breaches, and believing you have restored or silenced
// alerting when you have not is the same failure one step removed.
describe("superAdmin.setOrganizationIsDemo", () => {
  for (const role of ["admin", "operations", "compliance", "cfo", "user"] as const) {
    it(`throws FORBIDDEN for ${role}`, async () => {
      const caller = appRouter.createCaller(createCtxWithRole(role));
      await expect(
        caller.superAdmin.setOrganizationIsDemo({ organizationId: ABSENT_ORG_ID, isDemo: true }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }

  it("rejects a non-positive organizationId", async () => {
    const caller = appRouter.createCaller(createCtxWithRole("super_admin"));
    await expect(
      caller.superAdmin.setOrganizationIsDemo({ organizationId: 0, isDemo: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a non-boolean isDemo", async () => {
    const caller = appRouter.createCaller(createCtxWithRole("super_admin"));
    await expect(
      // @ts-expect-error deliberately wrong type — zod must reject it
      caller.superAdmin.setOrganizationIsDemo({ organizationId: ABSENT_ORG_ID, isDemo: "yes" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("does not refuse super_admin on authorization grounds", async () => {
    // NEVER a real organisation id here. The earlier version of this test called
    // setOrganizationIsDemo({ organizationId: 1, isDemo: false }) and meant only
    // to observe the authorization result — but the mutation RAN, against the
    // live database, and switched the demo flag off on org 1 (Globus Bank
    // Nigeria (Demo)). The SLA monitor then alerted the owner on 382 fabricated
    // exceptions, which is the exact failure the isDemo column was added to
    // prevent. Twice, on consecutive CI runs.
    const caller = appRouter.createCaller(createCtxWithRole("super_admin"));
    await expectNoWriteButAuthorized(() =>
      caller.superAdmin.setOrganizationIsDemo({ organizationId: ABSENT_ORG_ID, isDemo: false }),
    );
  });
});

// ─── Organisation setters must not claim success on a missing org ─────────────
describe("super-admin organisation setters verify the org exists", () => {
  const SRC = readFileSync(join(__dirname, "routers.ts"), "utf8");

  it("defines a single shared existence guard", () => {
    expect(SRC).toMatch(/async function assertOrganizationExists\(/);
  });

  it("checks existence rather than affectedRows", () => {
    // MySQL reports affected_rows as rows CHANGED, not matched, so setting a
    // field to the value it already holds returns 0. Rejecting that no-op as
    // "not found" would be a worse bug than the one being fixed.
    const body = SRC.slice(SRC.indexOf("async function assertOrganizationExists("));
    expect(body.slice(0, 900)).not.toMatch(/affectedRows/);
    expect(body.slice(0, 900)).toMatch(/code: "NOT_FOUND"/);
  });

  it("is applied by every org-level setter, not just the newest", () => {
    // All four had the same defect: UPDATE … WHERE id = ? then an unconditional
    // { success: true }. Fixing only the one review flagged would leave three.
    for (const proc of [
      "updateOrganizationSegment",
      "setOrganizationSso",
      "setOrganizationBankingModel",
      "setOrganizationIsDemo",
    ]) {
      const start = SRC.indexOf(`${proc}: superAdminProcedure`);
      expect(start, `${proc} not found`).toBeGreaterThan(-1);
      const body = SRC.slice(start, start + 2200);
      expect(body, `${proc} must assert the organisation exists`).toMatch(
        /assertOrganizationExists\(drizzle, input\.organizationId\)/,
      );
      // The guard has to run BEFORE the write, or it proves nothing.
      expect(
        body.indexOf("assertOrganizationExists"),
        `${proc} must check before updating`,
      ).toBeLessThan(body.indexOf("drizzle.update(organizations)"));
    }
  });
});

// ─── Tests must not mutate real organisations ────────────────────────────────
//
// The incident: "does not refuse super_admin on authorization grounds" called
// setOrganizationIsDemo({ organizationId: 1, isDemo: false }) intending only to
// observe the authorization outcome. DATABASE_URL points at the shared database,
// so the mutation RAN and turned the demo flag off on Globus Bank Nigeria
// (Demo). The SLA monitor then alerted the owner on 382 fabricated exceptions —
// the exact failure isDemo was added to prevent — on two consecutive CI runs.
//
// A test that calls a mutation is a write. This pins that no test in this file
// aims one at an organisation that might exist.
describe("this test file never aims a mutation at a real organisation", () => {
  const SELF = readFileSync(join(__dirname, "superAdmin.test.ts"), "utf8");
  const CODE = SELF.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("uses ABSENT_ORG_ID for every organisation-mutating call", () => {
    // Any organizationId literal handed to a set*/update* mutation must be the
    // sentinel or an obviously-invalid value that zod rejects before the DB.
    const offenders: string[] = [];
    for (const m of CODE.matchAll(/caller\.superAdmin\.(setOrganization\w+|updateOrganization\w+)\(\s*\{[^}]*organizationId:\s*([A-Za-z0-9_]+)/g)) {
      const [, proc, arg] = m;
      // 0 and negatives are rejected by zod (BAD_REQUEST) before any query runs.
      if (arg === "ABSENT_ORG_ID" || arg === "0") continue;
      offenders.push(`${proc}(organizationId: ${arg})`);
    }
    expect(
      offenders,
      "A test aims an organisation mutation at an id that may exist. DATABASE_URL " +
        "points at the shared database, so this is a real write — use ABSENT_ORG_ID, " +
        "which assertOrganizationExists refuses before the UPDATE.",
    ).toEqual([]);
  });

  it("uses a sentinel the id column cannot physically hold", () => {
    // Not "implausibly large" — impossible. organizations.id is a MySQL signed
    // INT, so anything above 2,147,483,647 can never be stored, and the guard
    // can never be handed a real row by accident.
    expect(Number.isInteger(ABSENT_ORG_ID)).toBe(true);
    expect(ABSENT_ORG_ID).toBeGreaterThan(MYSQL_SIGNED_INT_MAX);
    // Still positive, so zod admits it and the call reaches the guard rather
    // than short-circuiting on BAD_REQUEST — which would pass vacuously.
    expect(ABSENT_ORG_ID).toBeGreaterThan(0);
  });

  it("declares the id column as the INT the sentinel is chosen against", () => {
    // If organizations.id ever widens to bigint, the sentinel stops being
    // impossible and this assumption needs revisiting.
    const SCHEMA = readFileSync(join(__dirname, "..", "drizzle", "schema.ts"), "utf8");
    const orgTable = SCHEMA.slice(SCHEMA.indexOf("export const organizations = mysqlTable("));
    expect(orgTable.slice(0, 200)).toMatch(/id: int\("id"\)\.autoincrement\(\)/);
  });

  it("relies on a guard that actually runs before the write", () => {
    // If assertOrganizationExists were removed, ABSENT_ORG_ID would stop being
    // protective and these tests would resume writing.
    const ROUTERS = readFileSync(join(__dirname, "routers.ts"), "utf8");
    expect(ROUTERS).toMatch(/async function assertOrganizationExists\(/);
  });
});
