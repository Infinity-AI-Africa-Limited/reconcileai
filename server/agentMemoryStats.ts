export type MonthlyMemoryGrowth = {
  month: string;
  count: number;
};

/** Last calendar day of the given UTC year/month (month is 0-indexed). */
function lastDayOfUtcMonth(year: number, monthIndex: number): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Inclusive UTC boundary for the rolling six-month dashboard window.
 *
 * The day-of-month is clamped to the target month's length, which is both the
 * correct calendar answer and what the MySQL `DATE_SUB(NOW(), INTERVAL 6 MONTH)`
 * this replaced already did — so the port does not quietly move the window.
 *
 * `Date#setUTCMonth` alone is not enough: it keeps the day-of-month and lets it
 * overflow into the next month when the target is shorter. On 31 August that
 * yields 3 March rather than 28 February, and the `gte` filter downstream then
 * drops every row from 28 February to 2 March. Three of five month-ends in a
 * year hit this, so it is a recurring silent under-count rather than an edge case.
 */
export function sixMonthsAgoUtc(now: Date = new Date()): Date {
  const boundary = new Date(now.getTime());
  const dayOfMonth = boundary.getUTCDate();

  // Move to day 1 first so shifting the month cannot overflow, then restore the
  // day clamped to whatever the target month actually has.
  boundary.setUTCDate(1);
  boundary.setUTCMonth(boundary.getUTCMonth() - 6);
  boundary.setUTCDate(
    Math.min(dayOfMonth, lastDayOfUtcMonth(boundary.getUTCFullYear(), boundary.getUTCMonth())),
  );

  return boundary;
}

/**
 * Builds chronological YYYY-MM buckets from timestamp rows returned by Drizzle.
 * This works consistently for MySQL, TiDB, and local development databases.
 *
 * Note the earliest bucket is partial by construction: a window starting on 28
 * February reports February from the 28th onward. That matches the behaviour of
 * the SQL this replaced; it is a property of a rolling window, not a defect.
 */
export function groupMemoryGrowthByMonth(rows: Array<{ createdAt: Date }>): MonthlyMemoryGrowth[] {
  const buckets = new Map<string, number>();

  for (const row of rows) {
    const month = row.createdAt.toISOString().slice(0, 7);
    buckets.set(month, (buckets.get(month) ?? 0) + 1);
  }

  const growth: MonthlyMemoryGrowth[] = [];
  buckets.forEach((count, month) => growth.push({ month, count }));
  return growth.sort((left, right) => left.month.localeCompare(right.month));
}
