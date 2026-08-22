/**
 * The Pilot Controls screen must not mask a failed readiness request as an
 * indefinite loading state. Keep this small decision rule independent of the
 * page component so it is exercised by the configured client-side test suite.
 *
 * A failed request has TWO cases, and collapsing them is a defect either way:
 *
 *   no cached data  — nothing can be shown, so show the error. Falling through
 *                     to "loading" here is the indefinite spinner this rule was
 *                     written to prevent.
 *   cached data     — a background refetch failed after a good response. React
 *                     Query keeps the last successful `data` and still reports
 *                     `isError`, so treating error as absolute replaced a
 *                     working page — and the operator's in-progress form —
 *                     with a single error string on any transient blip.
 *
 * The second case is NOT simply "ready" either, which is where the obvious fix
 * goes wrong on this screen. These fields drive "Read-only pilot eligible"
 * versus "N gates open" for a regulated bank pilot: contract approved, data
 * processing approved, no-write acknowledged. Rendering them as current when
 * the refresh failed invites an operator to act on an approval the server may
 * no longer agree with, which is exactly what this page exists to govern.
 *
 * So it is reported as "stale" — the controls stay usable, and the page says
 * plainly that what you are looking at could not be refreshed.
 */
export function pilotReadinessDisplayState(input: {
  isLoading: boolean;
  hasData: boolean;
  hasError: boolean;
}): "error" | "loading" | "stale" | "ready" {
  if (input.hasError) return input.hasData ? "stale" : "error";
  if (input.isLoading || !input.hasData) return "loading";
  return "ready";
}
