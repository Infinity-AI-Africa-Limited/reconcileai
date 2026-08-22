/**
 * The Pilot Controls screen must not mask a failed readiness request as an
 * indefinite loading state. Keep this small decision rule independent of the
 * page component so it is exercised by the configured client-side test suite.
 */
export function pilotReadinessDisplayState(input: {
  isLoading: boolean;
  hasData: boolean;
  hasError: boolean;
}): "error" | "loading" | "ready" {
  if (input.hasError) return "error";
  if (input.isLoading || !input.hasData) return "loading";
  return "ready";
}
