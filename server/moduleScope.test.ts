/**
 * Which reconciliation modules a vertical is offered.
 *
 * `account_level` reconciles a general ledger against a core banking system —
 * the Woodcore POC's core. A SHOPLINE merchant operates neither: their money
 * moves order -> gateway -> payout, with no GL to tie back to.
 *
 * They were offered it anyway, described as delivering "100% audit trail
 * completeness for CBN compliance" and "zero licence revocations" — a promise
 * about a regulator they do not answer to and a licence they do not hold. And
 * `provisionTenantBaseline` switched it ON for every new tenant, so every
 * SHOPLINE merchant was provisioned with it enabled.
 *
 * The rule lives in shared/ because the client hides the card and the server
 * refuses the mutation, and those two must not be able to disagree.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  modulesForSegment,
  moduleAppliesTo,
  moduleUnavailableReason,
  scopeModuleRows,
  ALL_MODULE_TYPES,
} from "../shared/moduleScope";
import { modulesToProvision } from "./provisioning";

describe("when the tenant is a retail merchant", () => {
  it("should offer settlement only", () => {
    expect(modulesForSegment("retail_commerce")).toEqual(["settlement"]);
  });

  it("should refuse account_level, which needs a GL and a core banking system", () => {
    expect(moduleAppliesTo("account_level", "retail_commerce")).toBe(false);
  });

  it("should explain the refusal in terms the merchant can act on", () => {
    const reason = moduleUnavailableReason("account_level", "retail_commerce");
    expect(reason).toMatch(/general ledger/i);
    expect(reason).toMatch(/core banking/i);
    // Never quote CBN or licences at someone subject to neither.
    expect(reason).not.toMatch(/CBN|licence/i);
  });
});

describe("when the tenant is any other vertical", () => {
  it("should keep both modules for financial services", () => {
    expect(modulesForSegment("financial_services")).toEqual([...ALL_MODULE_TYPES]);
  });

  it("should keep both for corporate B2B, which does run a general ledger", () => {
    // An FMCG distributor reconciles bank accounts against a GL. Only retail is
    // narrowed — this is not a general "hide the complicated module" rule.
    expect(modulesForSegment("corporate_b2b")).toEqual([...ALL_MODULE_TYPES]);
    expect(moduleAppliesTo("account_level", "corporate_b2b")).toBe(true);
  });

  it("should keep both for the platform operator", () => {
    expect(modulesForSegment("super_admin")).toEqual([...ALL_MODULE_TYPES]);
  });
});

describe("when the segment is unknown", () => {
  it("should keep both rather than silently disabling one", () => {
    // This rule REMOVES a capability from one vertical. Defaulting to the narrow
    // set would disable account_level for every legacy org with no segment set,
    // which is the wrong direction to fail on missing data.
    for (const unknown of [null, undefined, "", "something_new"]) {
      expect(modulesForSegment(unknown as string | null)).toEqual([...ALL_MODULE_TYPES]);
    }
  });
});

describe("when a tenant provisioned before the rule is listed", () => {
  // Provisioning runs once, so it cannot reach a tenant that already exists.
  // Both SHOPLINE merchants in production still carry an enabled account_level
  // row from before the scope rule landed, and superAdmin.updateOrganizationSegment
  // can retype any org to retail tomorrow without re-provisioning it. The read
  // has to be scoped or those rows keep reporting as available.
  const rows = [
    { moduleType: "settlement", isEnabled: true },
    { moduleType: "account_level", isEnabled: true },
  ];

  it("should not list a stale account_level row to a retail merchant", () => {
    expect(scopeModuleRows(rows, "retail_commerce")).toEqual([
      { moduleType: "settlement", isEnabled: true },
    ]);
  });

  it("should agree with the guard that refuses the same module", () => {
    // The list and assertModuleAvailable must never disagree: a module shown as
    // available and then refused on toggle is worse than one never shown.
    for (const segment of ["retail_commerce", "financial_services", "corporate_b2b", "super_admin"]) {
      const listed = scopeModuleRows(rows, segment).map((r) => r.moduleType);
      const allowed = ALL_MODULE_TYPES.filter((m) => moduleAppliesTo(m, segment));
      expect(listed, `list and guard disagree for ${segment}`).toEqual([...allowed]);
    }
  });

  it("should leave every other vertical's rows alone", () => {
    for (const segment of ["financial_services", "corporate_b2b", "super_admin"]) {
      expect(scopeModuleRows(rows, segment), `${segment} lost a row`).toEqual(rows);
    }
  });

  it("should keep everything when the segment is unknown", () => {
    // Same direction as modulesForSegment: this rule REMOVES a module, so
    // missing data must not strip a tenant of one it actually uses.
    for (const unknown of [null, undefined, "", "something_new"]) {
      expect(scopeModuleRows(rows, unknown as string | null)).toEqual(rows);
    }
  });

  it("should preserve row fields, not just the module name", () => {
    // The caller renders isEnabled off these rows; filtering must not reshape them.
    const withExtras = [{ moduleType: "settlement", isEnabled: false, organizationId: 7 }];
    expect(scopeModuleRows(withExtras, "retail_commerce")).toEqual(withExtras);
  });
});

describe("when provisioning decides which modules to seed", () => {
  it("should report a failed segment lookup instead of throwing it", async () => {
    // provisionTenantBaseline promises a checklist and never a rejection — the
    // encryption-key and quota steps have already run by this point, and letting
    // this escape discards their results and leaves a half-provisioned tenant
    // behind a generic error.
    const outcome = await modulesToProvision(async () => {
      throw new Error("ECONNRESET");
    });
    expect(outcome).toEqual({ failed: "ECONNRESET" });
  });

  it("should NOT fall back to enabling everything", async () => {
    // The dangerous default. modulesForSegment answers an unknown segment with
    // BOTH modules — correct when the segment is genuinely unset, but on a
    // transient DB blip it would switch account_level back on for exactly the
    // retail tenants this step exists to keep it away from.
    const outcome = await modulesToProvision(async () => {
      throw new Error("connection lost");
    });
    expect(outcome).not.toHaveProperty("modules");
  });

  it("should provision the vertical's modules when the lookup succeeds", async () => {
    expect(await modulesToProvision(async () => "retail_commerce")).toEqual({
      modules: ["settlement"],
    });
    expect(await modulesToProvision(async () => "financial_services")).toEqual({
      modules: [...ALL_MODULE_TYPES],
    });
  });

  it("should keep both when the org genuinely has no segment", async () => {
    // A resolved null is an answer, not a failure — legacy orgs keep everything.
    expect(await modulesToProvision(async () => null)).toEqual({
      modules: [...ALL_MODULE_TYPES],
    });
  });
});

describe("when the guard is enforced server-side", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");
  // The two guarded domains each have their own file now — module config and
  // reconciliation runs — and the rule itself sits in shared.ts so neither can
  // hold a private copy. These anchors moved with the modules domain; the
  // helper below fails loudly rather than quietly when that happens, which is
  // what made repointing them a build failure and not a silent hole.
  const ROUTERS = read("routers.ts");
  const MODULES = read("routers/modules.ts");
  const RECONCILIATION = read("routers/reconciliation.ts");
  const SHARED = read("routers/shared.ts");
  const GUARD = "await assertModuleAvailable(ctx, input.moduleType)";

  /**
   * Source between two anchors, so "the guard runs BEFORE the write" is
   * checkable rather than just "the guard appears somewhere in the file".
   *
   * A missing anchor FAILS rather than returning an empty slice. That matters
   * more than it looks: these assertions read source as text, so if a procedure
   * is moved to another file and the anchors are not repointed, a laxer version
   * of this helper would keep passing against a file that no longer contains the
   * procedure — a green ratchet guarding nothing.
   */
  function between(source: string, startAnchor: string, endAnchor: string): string {
    const start = source.indexOf(startAnchor);
    expect(start, `anchor missing: ${startAnchor}`).toBeGreaterThan(-1);
    const end = source.indexOf(endAnchor, start);
    expect(end, `anchor missing after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("should refuse an inapplicable module before the config row is written", () => {
    // Hiding the card is presentation. Without these, a retail admin could still
    // enable account_level by calling the procedure directly — the same trap as
    // the assessment lead pipeline, where a hidden nav entry fronted an open
    // procedure.
    expect(between(MODULES, "toggle: adminProcedure", "dbConn.update(db.moduleConfigurations)")).toContain(GUARD);
    expect(between(MODULES, "updateConfig: adminProcedure", "dbConn.update(db.moduleConfigurations)")).toContain(GUARD);
  });

  it("should refuse an inapplicable module before a reconciliation job is persisted", () => {
    // The module toggle is NOT the gate for a run: these procedures take
    // moduleType straight from the caller and never consult moduleConfigurations,
    // so guarding only the toggle left the actual engine reachable. The public
    // API (POST /api/v1/reconciliation/runs) calls reconciliation.create too, so
    // the guard has to sit on the procedure, not on the UI that fronts it.
    expect(between(RECONCILIATION, "create: operationsProcedure", "db.createReconciliationJob(")).toContain(GUARD);
    expect(between(RECONCILIATION, "createMultiChannel: operationsProcedure", "db.createReconciliationJob(")).toContain(GUARD);
  });

  it("should decide using the shared rule, not a second inline copy", () => {
    expect(SHARED).toMatch(/from "@shared\/moduleScope"/);
    expect(SHARED).toMatch(/moduleAppliesTo\(moduleType, org\?\.segment\)/);
    // One definition, imported by both callers. Two would be free to drift, and
    // the drift would show up as a vertical quietly regaining a module.
    expect(ROUTERS).not.toMatch(/function assertModuleAvailable/);
    expect(MODULES).not.toMatch(/function assertModuleAvailable/);
    expect(RECONCILIATION).not.toMatch(/function assertModuleAvailable/);
  });
});

// The provisioning behaviour these used to assert as source text now lives in
// "when provisioning decides which modules to seed" above, which calls the real
// function. Those greps pinned an expression (`modulesForSegment(org?.segment)`)
// rather than an outcome, so they broke on a refactor that changed nothing a
// tenant can observe — and would have kept passing had the call been rewired to
// the wrong argument.
