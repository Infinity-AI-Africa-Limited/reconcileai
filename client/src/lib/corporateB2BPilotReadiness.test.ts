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

  it("keeps the controls when a background refetch fails after a good response", () => {
    // React Query retains the last successful `data` and still reports isError,
    // so treating error as absolute replaced a working page — and whatever the
    // operator had typed into it — with one error string on a transient blip.
    expect(pilotReadinessDisplayState({ isLoading: false, hasData: true, hasError: true })).toBe("stale");
  });

  it("does not report a failed refresh as ready", () => {
    // The trap in the obvious fix. These fields drive "Read-only pilot eligible"
    // versus "N gates open" for a regulated bank pilot, so presenting them as
    // current when the refresh failed invites an operator to act on an approval
    // the server may no longer agree with. Usable, but never silently.
    expect(pilotReadinessDisplayState({ isLoading: false, hasData: true, hasError: true })).not.toBe("ready");
  });

  it("still reports stale while a failed query is being retried", () => {
    // isLoading can go true again on a retry while the error and the cached data
    // both persist. The page must not flip back to a spinner over data it holds.
    expect(pilotReadinessDisplayState({ isLoading: true, hasData: true, hasError: true })).toBe("stale");
  });
});
