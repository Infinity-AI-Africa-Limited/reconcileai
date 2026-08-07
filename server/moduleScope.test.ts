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
  ALL_MODULE_TYPES,
} from "../shared/moduleScope";

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

describe("when the guard is enforced server-side", () => {
  const ROUTERS = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");

  it("should refuse an inapplicable module on both module mutations", () => {
    // Hiding the card is presentation. Without these, a retail admin could still
    // enable account_level by calling the procedure directly — the same trap as
    // the assessment lead pipeline, where a hidden nav entry fronted an open
    // procedure.
    expect((ROUTERS.match(/await assertModuleAvailable\(ctx, input\.moduleType\)/g) ?? []).length).toBe(2);
  });

  it("should decide using the shared rule, not a second inline copy", () => {
    expect(ROUTERS).toMatch(/from "@shared\/moduleScope"/);
    expect(ROUTERS).toMatch(/moduleAppliesTo\(moduleType, org\?\.segment\)/);
  });
});

describe("when a tenant is provisioned", () => {
  const PROVISIONING = fs.readFileSync(path.join(__dirname, "provisioning.ts"), "utf8");

  it("should seed only the modules the vertical can use", () => {
    // Was: `for (const moduleType of ["settlement", "account_level"] as const)`,
    // which enabled GL-to-CBS reconciliation for every SHOPLINE merchant.
    expect(PROVISIONING).toMatch(/modulesForSegment\(org\?\.segment\)/);
    expect(PROVISIONING).not.toMatch(/\["settlement", "account_level"\] as const/);
  });

  it("should look the segment up rather than assume one", () => {
    expect(PROVISIONING).toMatch(/segment: organizations\.segment/);
  });
});
