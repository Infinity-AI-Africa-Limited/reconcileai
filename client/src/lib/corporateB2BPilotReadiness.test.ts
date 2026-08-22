import { describe, expect, it } from "vitest";
import { pilotReadinessDisplayState } from "./corporateB2BPilotReadiness";

describe("Corporate B2B Pilot Controls readiness display", () => {
  it("shows a server error rather than loading indefinitely when the query failed without cached data", () => {
    expect(pilotReadinessDisplayState({ isLoading: false, hasData: false, hasError: true })).toBe("error");
  });

  it("shows loading only while a successful readiness response remains unresolved", () => {
    expect(pilotReadinessDisplayState({ isLoading: true, hasData: false, hasError: false })).toBe("loading");
    expect(pilotReadinessDisplayState({ isLoading: false, hasData: true, hasError: false })).toBe("ready");
  });
});
