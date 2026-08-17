export type MonthlyMemoryGrowth = {
  month: string;
  count: number;
};

/**
 * Returns the inclusive UTC boundary for the rolling six-month dashboard window.
 * Keeping the boundary in application code avoids database-specific date functions.
 */
export function sixMonthsAgoUtc(now: Date = new Date()): Date {
  const boundary = new Date(now.getTime());
  boundary.setUTCMonth(boundary.getUTCMonth() - 6);
  return boundary;
}

/**
 * Builds chronological YYYY-MM buckets from timestamp rows returned by Drizzle.
 * This works consistently for MySQL, TiDB, and local development databases.
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
