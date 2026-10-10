/**
 * A daily control period: a real calendar day written `YYYY-MM-DD`.
 *
 * One rule for the client and the server. The API refuses any other period, and
 * the Daily Control page holds its query back until the period passes this. Two
 * copies could disagree, and a day the page accepted but the API refused would
 * leave the page showing an error for a date the user believes is fine.
 */
export function isControlPeriod(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  // Built in UTC so the check never depends on the reader's timezone; a day
  // that rolls over (2026-02-30 → March) is not the day that was written.
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}
