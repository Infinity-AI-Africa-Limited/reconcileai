import { describe, expect, it } from "vitest";
import {
  dailyControlSourceStatusCopy,
  dailyControlStatusCopy,
  humanizeControlReason,
  localControlPeriod,
} from "./dailyControl";

describe("daily control presentation policy", () => {
  it("formats the local calendar day without converting it through UTC", () => {
    expect(localControlPeriod(new Date(2026, 9, 10, 0, 5))).toBe("2026-10-10");
    expect(localControlPeriod(new Date(2026, 0, 2, 23, 59))).toBe("2026-01-02");
  });

  it("does not present a ready preflight as a completed control", () => {
    const ready = dailyControlStatusCopy("ready_to_reconcile");

    expect(ready.label).toBe("Evidence ready for reconciliation");
    expect(ready.summary).toContain("separate, governed action");
    expect(ready.tone).toBe("ready");
  });

  it("keeps incomplete and blocked evidence visibly distinct", () => {
    expect(dailyControlStatusCopy("incomplete").tone).toBe("attention");
    expect(dailyControlStatusCopy("blocked").tone).toBe("blocked");
    expect(dailyControlSourceStatusCopy("awaiting_source")).toEqual({
      label: "Awaiting source",
      tone: "waiting",
    });
  });

  it("turns a stable machine reason into safe operator copy", () => {
    expect(humanizeControlReason("source_contract_version_mismatch")).toBe(
      "Source Contract Version Mismatch"
    );
  });
});
