import { describe, expect, it } from "vitest";
import { deriveOrgCode, WOODCORE_ONBOARDING_CHANNEL } from "./onboarding";

describe("onboarding — deriveOrgCode", () => {
  it("derives an uppercase underscore code from the institution name", () => {
    expect(deriveOrgCode("Sunrise Microfinance Bank")).toBe("SUNRISE_MICROFINANCE_BANK");
  });

  it("caps at three words and 40 chars", () => {
    expect(deriveOrgCode("First Interstate Continental Trust and Savings")).toBe(
      "FIRST_INTERSTATE_CONTINENTAL",
    );
    expect(deriveOrgCode("A".repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it("strips punctuation and collapses separators", () => {
    expect(deriveOrgCode("Lapo M.F.B. (Nigeria) Ltd!")).toBe("LAPO_M_F");
  });

  it("falls back for empty/only-symbol names", () => {
    expect(deriveOrgCode("!!!")).toBe("WOODCORE_CLIENT");
    expect(deriveOrgCode("")).toBe("WOODCORE_CLIENT");
  });

  it("channel constant matches the organizations.onboardingChannel value", () => {
    expect(WOODCORE_ONBOARDING_CHANNEL).toBe("woodcore");
  });
});
