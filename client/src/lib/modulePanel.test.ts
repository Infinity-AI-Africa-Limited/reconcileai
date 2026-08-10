/**
 * The module page's rule for an unresolved segment.
 *
 * The bug this pins: the page waited only on `modules.list`, while the segment
 * came from a second, independent query. Whichever finished first decided the
 * page. `modulesForSegment` answers an unknown segment with the WIDE set — right
 * for the provisioner it was written for, wrong for a screen, because on a
 * screen "unknown" also means "the lookup did not come back", and a retail
 * merchant was then shown Account-Level.
 */
import { describe, it, expect } from "vitest";
import { modulePanelFor } from "./modulePanel";

const resolved = (segment: string | null) => ({ segment, isPending: false, isFailed: false });

describe("when the segment has not resolved yet", () => {
  it("should wait rather than show a list it may have to take back", () => {
    const panel = modulePanelFor({ segment: null, isPending: true, isFailed: false });
    expect(panel.kind).toBe("loading");
  });

  it("should not fall through to the wide set just because the segment reads null", () => {
    // The exact defect: null-while-loading and null-because-legacy are the same
    // value, and only one of them may answer with both modules.
    const loading = modulePanelFor({ segment: null, isPending: true, isFailed: false });
    expect(loading).not.toEqual({ kind: "ready", modules: ["settlement", "account_level"] });
  });
});

describe("when the segment lookup failed", () => {
  it("should report it instead of guessing", () => {
    // `retry: false` on the query means this does not resolve itself — guessing
    // wide would leave a merchant looking at Account-Level for the whole session.
    const panel = modulePanelFor({ segment: null, isPending: false, isFailed: true });
    expect(panel.kind).toBe("unresolved");
  });

  it("should not guess narrow either, which would strip a bank of a module it has", () => {
    const panel = modulePanelFor({ segment: null, isPending: false, isFailed: true });
    expect(panel).not.toEqual({ kind: "ready", modules: ["settlement"] });
  });
});

describe("when the segment is known", () => {
  it("should offer a retail merchant settlement only", () => {
    expect(modulePanelFor(resolved("retail_commerce"))).toEqual({
      kind: "ready",
      modules: ["settlement"],
    });
  });

  it("should offer the other verticals both", () => {
    for (const s of ["financial_services", "corporate_b2b", "super_admin"]) {
      expect(modulePanelFor(resolved(s)), `${s} lost a module`).toEqual({
        kind: "ready",
        modules: ["settlement", "account_level"],
      });
    }
  });

  it("should keep both when a resolved answer carries no segment", () => {
    // A legacy or org-less account: genuinely answered, not uncertain. This must
    // stay wide, matching provisionTenantBaseline — narrowing on missing data
    // would silently disable account_level for every org whose segment is unset.
    expect(modulePanelFor(resolved(null))).toEqual({
      kind: "ready",
      modules: ["settlement", "account_level"],
    });
  });
});
