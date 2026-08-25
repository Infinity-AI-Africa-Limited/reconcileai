import { describe, expect, it } from "vitest";
import { requirePilotManager } from "./routers/corporateB2BPilot";
import {
  calculateCorporateB2BPilotReadiness,
  pilotStateTransitionRefusal,
  type PilotReadinessConfig,
  type PilotReadinessSource,
  type PilotRoster,
  type QueueDurability,
} from "./corporateB2BPilotReadiness";

// Typed against the schema rather than left to inference, so a renamed column
// or a widened status enum fails here instead of passing through an `any`.
const approvedConfig: PilotReadinessConfig = {
  noWriteAcknowledged: true,
  pilotScope: "Distributor receipts against approved invoices",
  dataContractStatus: "approved",
  rosterStatus: "approved",
  allocationPolicyStatus: "approved",
  dailyCloseOwner: "Finance Controller",
  aiAssistanceMode: "disabled",
  aiBoundaryReference: null,
  operationalRecoveryStatus: "passed",
  retentionDays: 90,
  contractStatus: "approved",
  dataProcessingStatus: "approved",
  contractReference: "SOW-001",
  dataProcessingReference: "DPA-001",
};

const twoGoodSources: PilotReadinessSource[] = [
  { sourceType: "invoice_ar", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
  { sourceType: "bank_statement", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
];

const goodRoster: PilotRoster = { total: 10, active: 10, pending: 0, flagged: 0, duplicateNames: 0 };

/**
 * A pilot whose every gate is closed. B6 needs `confirmed` durability, so the
 * "everything is ready" fixture has to state which deployment it describes —
 * which is the point of making B6 a real check.
 */
function readiness(overrides: {
  config?: PilotReadinessConfig | null;
  sources?: PilotReadinessSource[];
  roster?: Partial<PilotRoster>;
  queueDurability?: QueueDurability;
} = {}) {
  return calculateCorporateB2BPilotReadiness({
    config: overrides.config === undefined ? approvedConfig : overrides.config,
    sources: overrides.sources ?? twoGoodSources,
    roster: { ...goodRoster, ...overrides.roster },
    queueDurability: overrides.queueDurability ?? "confirmed",
  });
}

describe("Corporate B2B pilot readiness", () => {
  it("allows a CFO to manage audited pilot controls while retaining the explicit role boundary", () => {
    expect(() => requirePilotManager("cfo")).not.toThrow();
    expect(() => requirePilotManager("admin")).not.toThrow();
    expect(() => requirePilotManager("super_admin")).not.toThrow();
    expect(() => requirePilotManager("operations")).toThrow(/Only a CFO, administrator, or Infinity AI staff member/);
  });

  it("recognises the merged and proven P1–P7 foundation release while retaining all tenant evidence gates", () => {
    const result = readiness();
    expect(result.blockedBy).toEqual([]);
    expect(result.canStartReadOnlyPilot).toBe(true);
  });

  it("rejects a source route that lacks a customer-owned credential or control total", () => {
    const result = readiness({
      sources: [
        { sourceType: "invoice_ar", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
        { sourceType: "bank_statement", status: "tested", customerOwnedCredentials: false, controlTotalRequired: true },
      ],
    });
    expect(result.blockedBy).toContain("B1");
    expect(result.blockedBy).toContain("B2");
  });

  it("keeps unconfirmed distributor identities from passing B3", () => {
    expect(readiness({ roster: { pending: 1 } }).blockedBy).toContain("B3");
  });

  it("requires an evidence reference before private AI assistance is permitted", () => {
    const result = readiness({
      config: { ...approvedConfig, aiAssistanceMode: "private_approved", aiBoundaryReference: "" },
    });
    expect(result.blockedBy).toContain("B5");
  });
});

describe("when the roster has nobody to reconcile against", () => {
  // "No pending and no flagged" is satisfied by a roster of entirely INACTIVE
  // distributors, which is not a governed population — it is an empty one
  // wearing the same green tick.
  it("should block B3 when every distributor is inactive", () => {
    expect(readiness({ roster: { total: 10, active: 0 } }).blockedBy).toContain("B3");
  });

  it("should block B3 when two roster rows share a canonical name", () => {
    // B3 exists because ungoverned aliases produce false match candidates, and
    // a duplicated identity is the most direct way to get one.
    expect(readiness({ roster: { duplicateNames: 1 } }).blockedBy).toContain("B3");
  });

  it("should pass B3 once the same roster is governed — proving the two above are real", () => {
    expect(readiness().blockedBy).not.toContain("B3");
  });
});

describe("B6 — durable-queue deployment evidence", () => {
  // B6 was hardcoded `ready: true` while its own detail text said durable
  // queueing "remains mandatory where the selected deployment enables queued
  // processing". A gate that states a condition and then does not test it is
  // decoration; reconciliation runs go through that queue.
  it("should close only when a queue has actually been built on the durable backend", () => {
    expect(readiness({ queueDurability: "confirmed" }).blockedBy).not.toContain("B6");
  });

  it("should stay open on the in-process fallback, where queued work is lost on restart", () => {
    const result = readiness({ queueDurability: "fallback" });
    expect(result.blockedBy).toContain("B6");
    expect(result.canStartReadOnlyPilot).toBe(false);
  });

  it("should stay open when REDIS_URL is merely configured", () => {
    // A wrong or unreachable URL is indistinguishable from a correct one until
    // something connects. Configuration is not evidence of capability.
    const result = readiness({ queueDurability: "configured_unverified" });
    expect(result.blockedBy).toContain("B6");
    expect(result.gates.find((gate) => gate.id === "B6")?.detail).toMatch(/unverified/i);
  });
});

describe("what a green gate actually proves", () => {
  // The closure register is explicit that "a toggle in Pilot Controls does not"
  // close C3/C8. Rendering nine identical ticks invites exactly that reading.
  it("should mark platform-read gates as verified and customer toggles as attested", () => {
    const byId = Object.fromEntries(readiness().gates.map((gate) => [gate.id, gate.basis]));
    expect(byId.B3).toBe("platform_verified");
    expect(byId.B5).toBe("platform_verified");
    expect(byId.B6).toBe("platform_verified");
    expect(byId.B0).toBe("customer_attested");
    expect(byId.B7).toBe("customer_attested");
    expect(byId.B8).toBe("customer_attested");
  });

  it("should count how many green gates rest on an attestation alone", () => {
    // B0, B1, B2, B4, B7, B8 — six of the nine.
    expect(readiness().attestedGatesGreen).toBe(6);
  });
});

describe("when evidence is only whitespace", () => {
  // A gate is the record that a control EXISTS. `Boolean(" ")` is true, so a
  // space bar satisfied B0, B4 and B8 and the workspace showed green gates for
  // evidence nobody had supplied — the precise failure a readiness register is
  // there to prevent. B5 was not raised in review but failed the same way.
  const blank = "   ";

  it("should not accept a blank pilot scope as the read-only boundary (B0)", () => {
    const result = readiness({ config: { ...approvedConfig, pilotScope: blank } });
    expect(result.blockedBy).toContain("B0");
    expect(result.canStartReadOnlyPilot).toBe(false);
  });

  it("should not accept a blank daily-close owner (B4)", () => {
    expect(readiness({ config: { ...approvedConfig, dailyCloseOwner: blank } }).blockedBy).toContain("B4");
  });

  it("should not accept blank contract or data-processing references (B8)", () => {
    for (const field of ["contractReference", "dataProcessingReference"] as const) {
      const result = readiness({ config: { ...approvedConfig, [field]: blank } });
      expect(result.blockedBy, `${field} blank must block B8`).toContain("B8");
    }
  });

  it("should not accept a blank AI boundary reference for a private approved route (B5)", () => {
    const result = readiness({
      config: { ...approvedConfig, aiAssistanceMode: "private_approved", aiBoundaryReference: blank },
    });
    expect(result.blockedBy).toContain("B5");
  });

  it("should still pass every gate when the same evidence is real", () => {
    // The control: these tests must fail because the value is blank, not
    // because the fixture drifted into being unreadable.
    const result = readiness();
    expect(result.blockedBy).toEqual([]);
    expect(result.canStartReadOnlyPilot).toBe(true);
  });
});

describe("advancing the pilot state", () => {
  // The state field is the claim a customer or an examiner reads first, and it
  // used to be settable to "parallel run" while eight of the gates printed
  // directly above it were red. The closure register: a live parallel run is
  // not permitted until every gate is closed with evidence, and failure "never
  // means silently widen scope".
  const open = readiness({ config: null, queueDurability: "fallback" });
  const closed = readiness();

  it("should refuse a parallel run while any gate is open", () => {
    const refusal = pilotStateTransitionRefusal("parallel_run", "dry_run", open);
    expect(refusal).toMatch(/every release gate/i);
    expect(refusal).toContain("B0");
  });

  it("should allow a parallel run once every gate is closed", () => {
    expect(pilotStateTransitionRefusal("parallel_run", "dry_run", closed)).toBeNull();
  });

  it("should refuse a dry run until the boundary, data contract, sources and legal terms are recorded", () => {
    const refusal = pilotStateTransitionRefusal("dry_run", "data_validation", open);
    expect(refusal).toMatch(/B0/);
    expect(refusal).toMatch(/B8/);
    // A dry run does not need the recovery drill or the durable queue yet.
    expect(refusal).not.toMatch(/B6/);
    expect(refusal).not.toMatch(/B7/);
  });

  it("should require limited control to follow a parallel run rather than jump to it", () => {
    expect(pilotStateTransitionRefusal("limited_control", "dry_run", closed)).toMatch(/follows an accepted parallel run/i);
    expect(pilotStateTransitionRefusal("limited_control", "parallel_run", closed)).toBeNull();
  });

  it("should never gate suspending or stepping back", () => {
    // A control that can be entered but not left is not a safety control.
    expect(pilotStateTransitionRefusal("suspended", "limited_control", open)).toBeNull();
    expect(pilotStateTransitionRefusal("preparation", "parallel_run", open)).toBeNull();
    expect(pilotStateTransitionRefusal("dry_run", "parallel_run", open)).toBeNull();
  });

  it("should allow staying in the current state while gates are open", () => {
    // Otherwise an operator could not save any other field without first
    // closing every gate — the register would become unusable exactly when it
    // is most needed.
    expect(pilotStateTransitionRefusal("data_validation", "data_validation", open)).toBeNull();
  });
});
