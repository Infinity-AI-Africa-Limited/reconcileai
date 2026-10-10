import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { dailyControlView, isControlPeriod } from "@/lib/dailyControl";

/**
 * The Daily Control page's data, and the decisions about it (CLAUDE.md §16:
 * pages render; hooks decide).
 *
 * The query is held back until the period is a real calendar day, under the
 * API's own rule, so an empty or half-typed date never reaches the server.
 * Clearing the date picker used to send `controlPeriod: ""`, which the API
 * refused.
 */
export function useDailyControlReadiness(controlPeriod: string, organizationId: number | undefined) {
  const periodIsValid = isControlPeriod(controlPeriod);
  const input = useMemo(
    () => ({ organizationId, controlPeriod }),
    [controlPeriod, organizationId]
  );
  const readiness = trpc.controlEvidence.assessReadiness.useQuery(input, {
    retry: false,
    enabled: periodIsValid,
  });
  const view = dailyControlView({
    periodIsValid,
    isLoading: readiness.isLoading,
    hasError: Boolean(readiness.error),
  });
  return {
    view,
    /** Present only when the view is `assessed`, so a stale result is never shown under another date. */
    assessment: view === "assessed" ? readiness.data : undefined,
    errorMessage: readiness.error?.message ?? null,
    isFetching: readiness.isFetching,
    refetch: () => void readiness.refetch(),
  };
}

export type DailyControlReadiness = ReturnType<typeof useDailyControlReadiness>;
