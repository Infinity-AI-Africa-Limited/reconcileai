/**
 * An intact chain that verified under an allowance must say so on the
 * persistent badge, not only in a passing toast (lib/auditIntegrity.ts).
 */
import { describe, it, expect } from "vitest";
import { intactBadge, intactToastSuffix, intactTooltip } from "./auditIntegrity";

describe("when a chain verified exactly as written", () => {
  it("should say only that it is intact", () => {
    const c = { signedRows: 23, roundedRows: 0, forkedRows: 0 };
    expect(intactBadge(c)).toBe("Chain intact (23)");
    expect(intactTooltip(c)).toBeUndefined();
    expect(intactToastSuffix(c)).toBe("");
  });
});

describe("when some entries verified under an allowance", () => {
  it("should count each kind on the badge", () => {
    expect(intactBadge({ signedRows: 717, roundedRows: 83, forkedRows: 8 })).toBe("Chain intact (717 · 83 rounded · 8 concurrent)");
    expect(intactBadge({ signedRows: 5, roundedRows: 0, forkedRows: 2 })).toBe("Chain intact (5 · 2 concurrent)");
  });

  it("should explain each allowance in the tooltip, and what it does not excuse", () => {
    const tip = intactTooltip({ signedRows: 717, roundedRows: 83, forkedRows: 8 })!;
    expect(tip).toMatch(/83 entries were signed by the earliest audit writer/);
    expect(tip).toMatch(/8 entries were written at the same moment as another/);
    expect(tip).toMatch(/Any other change to these entries is still detected\.$/);
  });

  it("should carry the same caveats in the toast", () => {
    expect(intactToastSuffix({ signedRows: 9, roundedRows: 1, forkedRows: 1 })).toBe(
      " (1 at the second they were signed, stored rounded up; 1 written concurrently before writes were serialised)",
    );
  });
});
