/**
 * Links from a count to the list that holds those rows, and the reading of
 * those links on arrival.
 *
 * Both ends live here so they cannot disagree: a dashboard that writes
 * `?status=open` to a page that reads `?filter=open` would open on everything
 * while looking like a working link.
 *
 * ── The rule every link follows ───────────────────────────────────────────
 *
 * A link opens on EXACTLY the rows its number counted. Every dashboard counts
 * all-time, so exception links carry `range=all`; the Exceptions page would
 * otherwise open on its default of today and show a fraction of the count —
 * which is the "1 open exception on the dashboard, none on the page" report
 * this started from.
 */

/** Statuses the Payment Exceptions page can filter by — its Status menu. */
export const EXCEPTION_LIST_STATUSES = ["open", "in_review", "escalated", "resolved", "dismissed"] as const;
export type ExceptionListStatus = (typeof EXCEPTION_LIST_STATUSES)[number];

/** Statuses the Transactions page can filter by — its Status menu. */
export const TRANSACTION_LIST_STATUSES = ["pending", "matched", "unmatched", "exception"] as const;
export type TransactionListStatus = (typeof TRANSACTION_LIST_STATUSES)[number];

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** The Payment Exceptions list for an all-time count, optionally one status. */
export function exceptionsHref(status?: ExceptionListStatus): string {
  return withQuery("/exceptions", { status, range: "all" });
}

/**
 * The Transactions list. It already opens on every date, so no range is sent —
 * sending one would pin the view to a range the page does not default to.
 */
export function transactionsHref(opts: { status?: TransactionListStatus; channelId?: number | null } = {}): string {
  return withQuery("/transactions", {
    status: opts.status,
    channelId: opts.channelId != null ? String(opts.channelId) : undefined,
  });
}

/**
 * A status named in the URL, if it is one the page offers. Anything else is
 * dropped rather than sent to the server as a filter nothing can match — an
 * unknown status would render an empty list that looks like a real answer.
 */
export function statusFromSearch<T extends string>(search: string, allowed: readonly T[]): T | undefined {
  const value = new URLSearchParams(search).get("status");
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** A channel id named in the URL, if it is a positive integer. */
export function channelFromSearch(search: string): number | undefined {
  const value = new URLSearchParams(search).get("channelId");
  if (value === null || !/^[1-9][0-9]*$/.test(value)) return undefined;
  return Number(value);
}
