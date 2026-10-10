import { describe, expect, it } from "vitest";
import {
  dailyControlSourceStatusCopy,
  dailyControlStatusCopy,
  dailyControlView,
  governedStartBlockers,
  humanizeControlReason,
  isControlPeriod,
  localControlPeriod,
} from "./dailyControl";

describe("when the default control period is derived from the user's clock", () => {
  it("should use the local calendar day, never one converted through UTC", () => {
    expect(localControlPeriod(new Date(2026, 9, 10, 0, 5))).toBe("2026-10-10");
    expect(localControlPeriod(new Date(2026, 0, 2, 23, 59))).toBe("2026-01-02");
  });
});

describe("when a control period is checked before it is sent", () => {
  it.each(["2026-10-10", "2024-02-29", "2026-12-31"])(
    "should accept the real calendar day %s",
    period => {
      expect(isControlPeriod(period)).toBe(true);
    }
  );

  it.each([
    ["a cleared date picker", ""],
    ["a day that does not exist", "2026-02-30"],
    ["a non-leap 29 February", "2026-02-29"],
    ["a thirteenth month", "2026-13-01"],
    ["an unpadded day", "2026-10-1"],
    ["a date with a time", "2026-10-10T00:00"],
    ["another format", "10/10/2026"],
  ])("should refuse %s", (_label, period) => {
    expect(isControlPeriod(period)).toBe(false);
  });
});

describe("when the page decides what its body shows", () => {
  it("should report an invalid period before anything else, since its query is held back", () => {
    expect(dailyControlView({ periodIsValid: false, isLoading: true, hasError: true })).toBe(
      "invalid_period"
    );
  });

  it("should report an error over a reload that is still in flight", () => {
    expect(dailyControlView({ periodIsValid: true, isLoading: true, hasError: true })).toBe("error");
  });

  it("should report loading, then the assessment", () => {
    expect(dailyControlView({ periodIsValid: true, isLoading: true, hasError: false })).toBe("loading");
    expect(dailyControlView({ periodIsValid: true, isLoading: false, hasError: false })).toBe("assessed");
  });
});

describe("when readiness is presented to an operator", () => {
  it("should not present a ready preflight as a completed control", () => {
    const ready = dailyControlStatusCopy("ready_to_reconcile");

    expect(ready.label).toBe("Evidence ready for reconciliation");
    expect(ready.summary).toContain("separate, governed action");
    expect(ready.tone).toBe("ready");
  });

  it("should keep incomplete and blocked evidence visibly distinct", () => {
    expect(dailyControlStatusCopy("incomplete").tone).toBe("attention");
    expect(dailyControlStatusCopy("blocked").tone).toBe("blocked");
    expect(dailyControlSourceStatusCopy("awaiting_source")).toEqual({
      label: "Awaiting source",
      tone: "waiting",
    });
  });

  it("should turn a stable machine reason into safe operator copy", () => {
    expect(humanizeControlReason("source_contract_version_mismatch")).toBe(
      "Source Contract Version Mismatch"
    );
  });
});

describe("when Start is withheld although the evidence is ready", () => {
  it("should list the governed-admission rules that refuse it, but not repeat that evidence is not ready", () => {
    expect(
      governedStartBlockers({ admissible: false, reasons: ["evidence_not_ready", "mixed_time_zones"] })
    ).toEqual(["mixed_time_zones"]);
  });

  it("should list nothing once a run would be admitted", () => {
    expect(governedStartBlockers({ admissible: true, reasons: [] })).toEqual([]);
  });
});
