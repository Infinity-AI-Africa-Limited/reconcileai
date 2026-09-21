/**
 * The shared "still needs work" rule. Lives in shared/, tested here because
 * shared/ is not in the vitest include list.
 */
import { describe, it, expect } from "vitest";
import { isUnresolvedStatusFilter, UNRESOLVED_EXCEPTION_STATUSES } from "@shared/exceptionStatus";

describe("when a list is filtered by exception status", () => {
  it("should treat 'every status' as showing unresolved work", () => {
    // The Payment Exceptions page's "All" filter includes open cases, so rows
    // it hides by date ARE hidden work.
    expect(isUnresolvedStatusFilter(undefined)).toBe(true);
  });

  it("should treat each unresolved status as work", () => {
    for (const s of UNRESOLVED_EXCEPTION_STATUSES) expect(isUnresolvedStatusFilter(s), s).toBe(true);
  });

  it("should not treat history as hidden work", () => {
    // Resolved and dismissed rows outside a date range are history. Flagging
    // them would put a warning on every page of an archive.
    expect(isUnresolvedStatusFilter("resolved")).toBe(false);
    expect(isUnresolvedStatusFilter("dismissed")).toBe(false);
  });

  it("should keep the list the Age Tracker ages", () => {
    // The tracker's query and the hidden-work count now read the same list; a
    // change here changes both, which is the point of sharing it.
    expect([...UNRESOLVED_EXCEPTION_STATUSES]).toEqual(["open", "in_review", "escalated"]);
  });
});
