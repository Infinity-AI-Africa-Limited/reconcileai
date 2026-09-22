/**
 * Which exception statuses still need someone to act.
 *
 * Written out in three places before this — the Age Tracker's aging query, the
 * hidden-by-date-range count, and the notice that reports it — so a new status
 * added to one would silently disagree with the others: the tracker would age a
 * case the notice never mentioned, or the other way round. Shared here because
 * the client decides whether to show the notice and the server decides what to
 * count, and the two must not be able to differ.
 */
export const UNRESOLVED_EXCEPTION_STATUSES = ["open", "in_review", "escalated"] as const;

export type UnresolvedExceptionStatus = (typeof UNRESOLVED_EXCEPTION_STATUSES)[number];

/**
 * Does a list filtered to `status` show unresolved work?
 *
 * `undefined` means "every status" (the Payment Exceptions page's "All"), which
 * includes unresolved work. Resolved and dismissed are history: rows of theirs
 * outside a date range are not hidden work, and flagging them would be noise.
 */
export function isUnresolvedStatusFilter(status: string | undefined): boolean {
  return status === undefined || (UNRESOLVED_EXCEPTION_STATUSES as readonly string[]).includes(status);
}
