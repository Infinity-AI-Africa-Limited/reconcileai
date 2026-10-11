/**
 * An unknown date gap must never be rendered as zero.
 *
 * `matches.dateDifference` is nullable, and the engine stores null for a pair
 * matched on reference alone whose timestamps could not be read — matched by
 * reference, date gap unknown. Three surfaces then coerced that to `0`: `?? 0`
 * in the Excel export, `|| 0` in the CSV export, and `|| 0` in the
 * Reconciliation table.
 *
 * Zero is the strongest claim available about a date gap — it says the two
 * legs agree exactly — and it was being asserted precisely where nothing was
 * known. In an export a CFO reads, a confident wrong number is worse than a
 * blank.
 *
 * Lives in client/src/lib because that is the client path vitest collects; the
 * module itself is in shared/ because the server exports and the screen have
 * to agree about what null means.
 */
import { describe, expect, it } from "vitest";
import {
  DATE_GAP_UNKNOWN_LABEL,
  dateGapCsvCell,
  dateGapLabel,
  dateGapSheetCell,
  isDateGapUnknown,
} from "@shared/matchDateGap";

/** Everything the column can hold that is not a usable number. */
const UNKNOWN = [null, undefined, Number.NaN];

describe("when a match's date gap is unknown", () => {
  it("should not be confused with zero by the predicate", () => {
    for (const value of UNKNOWN) {
      expect(isDateGapUnknown(value)).toBe(true);
    }
  });

  it("should say so on screen rather than claiming zero days", () => {
    for (const value of UNKNOWN) {
      expect(dateGapLabel(value)).toBe(DATE_GAP_UNKNOWN_LABEL);
    }
  });

  it("should export as an empty CSV field", () => {
    // Empty, not "Unknown": a reader parsing this column numerically gets a
    // blank rather than a plausible 0.
    for (const value of UNKNOWN) {
      expect(dateGapCsvCell(value)).toBe("");
    }
  });

  it("should export as an empty spreadsheet cell", () => {
    // Null so the column still aggregates over the rows that DO have a gap,
    // instead of being dragged towards zero by the ones that do not.
    for (const value of UNKNOWN) {
      expect(dateGapSheetCell(value)).toBeNull();
    }
  });
});

describe("when a match's date gap is zero", () => {
  it("should be reported as zero, because that is a real answer", () => {
    // The reason none of this can be a truthiness check: an exact same-day
    // match legitimately has a gap of 0, and it is the commonest value there
    // is. `|| 0` hid the unknown case precisely because 0 is falsy.
    expect(isDateGapUnknown(0)).toBe(false);
    expect(dateGapLabel(0)).toBe("0 days");
    expect(dateGapCsvCell(0)).toBe("0");
    expect(dateGapSheetCell(0)).toBe(0);
  });
});

describe("when a match's date gap is a real number of days", () => {
  it("should carry the number through every surface", () => {
    expect(dateGapLabel(3)).toBe("3 days");
    expect(dateGapCsvCell(3)).toBe("3");
    expect(dateGapSheetCell(3)).toBe(3);
  });

  it("should say one day in the singular", () => {
    // "1 days" in a financial report reads as a bug and invites doubt about
    // the rest of the figures on the page.
    expect(dateGapLabel(1)).toBe("1 day");
  });

  it("should not round or reinterpret a fractional gap", () => {
    // The column is an int, but the formatter must not quietly invent
    // precision it was not given either way.
    expect(dateGapCsvCell(2.5)).toBe("2.5");
    expect(dateGapSheetCell(2.5)).toBe(2.5);
  });
});
