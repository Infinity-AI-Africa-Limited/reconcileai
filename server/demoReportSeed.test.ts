/**
 * Which stored reports are the demo seed's own, and so may be replaced.
 *
 * Replacement is a DELETE, so the rule that picks its rows is the thing that
 * decides whether a user's report survives. It was once the title — which the
 * Reports screen auto-fills — and would have deleted user work; it is now a
 * marker no user-reachable path writes. Moved out of SQL (JSON_EXTRACT) into this
 * pure check, which both the seeder and the recency script use.
 */
import { describe, it, expect } from "vitest";
import { DEMO_REPORT_MARKER, isSeededReportSummary } from "./demoReportSeed";

describe("when deciding whether a stored report is the demo seed's own", () => {
  it("should recognise a summary carrying the marker", () => {
    expect(isSeededReportSummary({ jobName: "x", demoSeedMarker: DEMO_REPORT_MARKER })).toBe(true);
  });

  it("should never claim a user's report, even one with the same title", () => {
    // A report generated from the Reports screen has no marker at all.
    expect(isSeededReportSummary({ jobName: "BrightGoods FMCG — Distributor Settlement Reconciliation" })).toBe(false);
  });

  it("should not adopt a report written under a different marker version", () => {
    expect(isSeededReportSummary({ demoSeedMarker: "reconcileai-demo-seed-v0" })).toBe(false);
  });

  it("should reject shapes that are not a parsed summary", () => {
    // A stringified summary is how reports.generate used to store them; it must
    // not be mistaken for — or crash on the way to — a marked one.
    for (const v of [null, undefined, "", DEMO_REPORT_MARKER, JSON.stringify({ demoSeedMarker: DEMO_REPORT_MARKER }), 42]) {
      expect(isSeededReportSummary(v), JSON.stringify(v)).toBe(false);
    }
  });
});
