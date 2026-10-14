import { describe, expect, it } from "vitest";
import {
  evidencePackIssueCopy,
  evidencePackStateCopy,
  formatEvidenceTime,
  looksLikeGovernedControl,
} from "./governedControlEvidence";

describe("governed evidence pack presentation", () => {
  it("labels a linked evidence pack without calling it a control conclusion", () => {
    const copy = evidencePackStateCopy("reconstructable");
    expect(copy.label).toBe("Evidence linked");
    expect(copy.description).toMatch(/linked/i);
    expect(copy.description).not.toMatch(/conclusion/i);
  });

  it("turns stable gap codes into operator-safe instructions", () => {
    expect(evidencePackIssueCopy("manifest_policy_version_mismatch")).toMatch(/policy version/i);
    expect(evidencePackIssueCopy("other")).toMatch(/unrecognised/i);
  });

  it("uses local display only after the server supplies an ISO time", () => {
    expect(formatEvidenceTime(null)).toBe("Not yet recorded");
    expect(formatEvidenceTime("2026-10-10T08:00:00.000Z")).not.toBe("Not yet recorded");
  });

  it("uses the governed marker only as a client hint", () => {
    expect(looksLikeGovernedControl(JSON.stringify({ governedDailyControl: {} }))).toBe(true);
    expect(looksLikeGovernedControl("not-json")).toBe(false);
    expect(looksLikeGovernedControl({})).toBe(false);
  });
});
