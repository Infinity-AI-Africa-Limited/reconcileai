/**
 * One role rule for the UI and the API.
 *
 * The defect behind it: Daily Control offered a CFO an enabled "Start governed
 * control" button whenever the EVIDENCE was admissible, while
 * `operationsProcedure` refuses every reconciliation write from that role. So
 * the button was enabled on exactly the days it could not work, and answered
 * FORBIDDEN on a day the page had just reported as ready — which reads as a
 * broken control rather than a role boundary.
 *
 * The list now lives in `shared/`, and this file pins the thing that matters
 * about that: the server's refusal and the client's hiding are driven by the
 * same values. A copy on each side would drift silently, and the drift is only
 * visible to whoever clicks.
 */
import { describe, expect, it } from "vitest";
import {
  RECONCILIATION_READ_ONLY_ROLES,
  roleCanWriteReconciliation,
} from "../shared/reconciliationWriteRoles";
import { governedStartBlockers, canStartGovernedControl } from "../client/src/lib/dailyControl";

const admissible = { admissible: true, reasons: [] as string[] };

describe("when a role is checked against the reconciliation write rule", () => {
  it("should be exactly the two roles the API refuses", () => {
    // Pinned as a value, not re-derived: this is the contract both sides read.
    expect([...RECONCILIATION_READ_ONLY_ROLES]).toEqual(["cfo", "compliance"]);
  });

  it("should refuse a write from each of them", () => {
    for (const role of RECONCILIATION_READ_ONLY_ROLES) {
      expect(roleCanWriteReconciliation(role)).toBe(false);
    }
  });

  it("should permit the roles that operate reconciliation", () => {
    for (const role of ["admin", "operations", "user"]) {
      expect(roleCanWriteReconciliation(role)).toBe(true);
    }
  });

  it("should treat an unrecorded role as permitted, exactly as the API does", () => {
    // Deliberately NOT fail-closed, and the one place that choice is written
    // down. The server refuses a named deny-list and lets everything else
    // through; a client that failed closed would hide a button the API would
    // have honoured — the same disagreement in the other direction.
    expect(roleCanWriteReconciliation(undefined)).toBe(true);
    expect(roleCanWriteReconciliation(null)).toBe(true);
    expect(roleCanWriteReconciliation("")).toBe(true);
  });
});

describe("when the Daily Control page decides whether to offer Start", () => {
  it("should withhold it from a read-only role on an admissible day", () => {
    for (const role of RECONCILIATION_READ_ONLY_ROLES) {
      expect(
        canStartGovernedControl({ governedAdmission: admissible, role })
      ).toBe(false);
      expect(governedStartBlockers(admissible, { role })).toContain(
        "your_role_cannot_start_a_run"
      );
    }
  });

  it("should offer it to an operations user on an admissible day", () => {
    expect(
      canStartGovernedControl({ governedAdmission: admissible, role: "operations" })
    ).toBe(true);
    expect(governedStartBlockers(admissible, { role: "operations" })).toEqual([]);
  });

  it("should keep withholding it when the evidence is not admissible either", () => {
    // Both halves are required and they answer different questions: the
    // evidence, and the viewer.
    expect(
      canStartGovernedControl({
        governedAdmission: { admissible: false },
        role: "operations",
      })
    ).toBe(false);
  });

  it("should still tell a read-only role why the evidence is blocked", () => {
    // Their own reason is added, never substituted: a CFO is often the person
    // who needs to know what is wrong with the day.
    const blockers = governedStartBlockers(
      { admissible: false, reasons: ["internal_register_source_count"] },
      { role: "cfo" }
    );

    expect(blockers).toContain("internal_register_source_count");
    expect(blockers).toContain("your_role_cannot_start_a_run");
  });

  it("should keep hiding the reason the status banner already gives", () => {
    expect(
      governedStartBlockers(
        { admissible: false, reasons: ["evidence_not_ready"] },
        { role: "operations" }
      )
    ).toEqual([]);
  });
});
