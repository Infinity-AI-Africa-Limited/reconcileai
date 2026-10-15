import { describe, expect, it } from "vitest";
import {
  boundedEvidenceCount,
  evidencePackIssueCopy,
  evidencePackStateCopy,
  formatEvidenceTime,
  looksLikeGovernedControl,
} from "./governedControlEvidence";

describe("when a governed evidence pack is presented", () => {
  it("should label a linked evidence pack without calling it a control conclusion", () => {
    const copy = evidencePackStateCopy("reconstructable");
    expect(copy.label).toBe("Evidence linked");
    expect(copy.description).toMatch(/linked/i);
    expect(copy.description).not.toMatch(/conclusion/i);
  });

  it("should turn stable gap codes into operator-safe instructions", () => {
    expect(evidencePackIssueCopy("manifest_policy_version_mismatch")).toMatch(/policy version/i);
    expect(evidencePackIssueCopy("other")).toMatch(/unrecognised/i);
  });

  it("should use local display only after the server supplies an ISO time", () => {
    expect(formatEvidenceTime(null)).toBe("Not yet recorded");
    expect(formatEvidenceTime("2026-10-10T08:00:00.000Z")).not.toBe("Not yet recorded");
  });

  it("should label a capped timeline as a minimum rather than a complete count", () => {
    expect(boundedEvidenceCount(1, false, "reference")).toBe("1 reference");
    expect(boundedEvidenceCount(20, true, "reference")).toBe("At least 20 references");
  });

  it("should use the governed marker only as a client hint", () => {
    expect(looksLikeGovernedControl(JSON.stringify({ governedDailyControl: {} }))).toBe(true);
    expect(looksLikeGovernedControl("not-json")).toBe(false);
    expect(looksLikeGovernedControl({})).toBe(false);
  });
});
