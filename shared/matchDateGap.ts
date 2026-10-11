/**
 * How a match's date gap is rendered, and the one thing every surface must
 * agree on: **null is unknown, never zero.**
 *
 * `matches.dateDifference` is a nullable `int` and the engine now stores null
 * for a pair matched on reference alone whose timestamps could not be read —
 * matched by reference, date gap unknown. Three surfaces then coerced that
 * null to `0` (`?? 0` in the Excel export, `|| 0` in the CSV export and in the
 * Reconciliation table), so an unknown gap was reported as "0 days apart".
 *
 * That is not a cosmetic default. Zero days is the strongest possible claim
 * about a date gap — it says the two legs agree exactly — and it was being
 * asserted precisely where nothing is known. In an export a CFO reads, a
 * confident wrong number is worse than a blank.
 *
 * Each surface renders the unknown differently, which is why this module holds
 * the meaning rather than one string: a CSV wants an empty field, a
 * spreadsheet wants an empty cell so the column still sums and charts, and a
 * screen wants a word. What they share is that none of them may print 0.
 */

/** A stored date gap in days, or null when it could not be computed. */
export type MatchDateGap = number | null | undefined;

/** Shown on screen in place of a number. */
export const DATE_GAP_UNKNOWN_LABEL = "Unknown";

/**
 * True when the gap is genuinely absent rather than zero.
 *
 * Note `0` is a legitimate, common value — an exact same-day match — so this
 * cannot be a truthiness test. `|| 0` was the original bug in two of the three
 * call sites and would be again.
 */
export function isDateGapUnknown(gap: MatchDateGap): boolean {
  return gap === null || gap === undefined || !Number.isFinite(gap);
}

/**
 * For a screen: `"Unknown"`, or the gap with its unit.
 *
 * Singular for exactly one day, because "1 days" in a financial report reads
 * as a bug and invites doubt about the rest of the figures.
 */
export function dateGapLabel(gap: MatchDateGap): string {
  if (isDateGapUnknown(gap)) return DATE_GAP_UNKNOWN_LABEL;
  return `${gap} ${gap === 1 ? "day" : "days"}`;
}

/**
 * For a CSV field: the number, or empty.
 *
 * Empty is the conventional "no value" in a numeric CSV column — a reader that
 * parses the column gets NaN or a blank rather than a plausible zero, which is
 * the outcome we want when the value is unknown.
 */
export function dateGapCsvCell(gap: MatchDateGap): string {
  return isDateGapUnknown(gap) ? "" : String(gap);
}

/**
 * For a spreadsheet cell: the number, or null.
 *
 * ExcelJS writes null as a genuinely empty cell, so the column still
 * aggregates over the rows that do have a gap instead of being dragged towards
 * zero by the ones that do not.
 */
export function dateGapSheetCell(gap: MatchDateGap): number | null {
  return isDateGapUnknown(gap) ? null : (gap as number);
}
