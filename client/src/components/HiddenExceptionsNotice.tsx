import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { useViewAsOrgId } from "@/contexts/PortalContext";
import { toLocalDateString } from "@/hooks/useDateRange";
import { isUnresolvedStatusFilter } from "@shared/exceptionStatus";

/**
 * Says when the date range is hiding unresolved exceptions, and offers the
 * range that shows them.
 *
 * The Payment Exceptions page and the Review Queue open on today, while the
 * dashboard counts unresolved exceptions all-time. A merchant therefore saw "1
 * open exception" on the dashboard and an empty exceptions page: the one row,
 * raised on 19 August, sat outside "today". Nothing on screen said so.
 *
 * The presets stay as they are. This only makes the gap visible and one click
 * to close, and it says nothing when nothing is hidden. Shared by both pages so
 * their wording cannot drift.
 *
 * Only for unresolved statuses: resolved and dismissed exceptions outside the
 * range are history, not hidden work, and flagging them would be noise.
 */
export function HiddenExceptionsNotice({
  dateFrom,
  status,
  onReveal,
}: {
  dateFrom: Date | undefined;
  /** The page's status filter, or undefined for "every unresolved status". */
  status?: string;
  /** Receives the local date (YYYY-MM-DD) the range should start from. */
  onReveal: (from: string) => void;
}) {
  const viewAsOrgId = useViewAsOrgId();
  const unresolved = isUnresolvedStatusFilter(status);
  const hidden = trpc.exceptions.hiddenByRange.useQuery(
    { viewAsOrgId, dateFrom: dateFrom ?? new Date(0), status },
    { enabled: Boolean(dateFrom) && unresolved },
  );

  const count = hidden.data?.count ?? 0;
  const oldest = hidden.data?.oldest ? new Date(hidden.data.oldest) : null;
  if (!unresolved || count === 0 || !oldest) return null;

  const from = toLocalDateString(oldest);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        {count} unresolved exception{count === 1 ? " was" : "s were"} raised before this date range and{" "}
        {count === 1 ? "is" : "are"} not shown.
      </span>
      <Button size="sm" variant="outline" onClick={() => onReveal(from)}>
        Show from {oldest.toLocaleDateString()}
      </Button>
    </div>
  );
}
