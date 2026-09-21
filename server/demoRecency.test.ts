/**
 * The demo recency spread.
 *
 * These pin the property that actually matters and that was observed broken: a
 * viewer clicking Today, Yesterday or Last 7 days, or picking any range inside
 * the last three months from the calendar, must land on rows.
 */
import { describe, it, expect } from "vitest";
import {
  daysAgoForIndex,
  dateForIndex,
  statusForAge,
  RECENCY_BANDS,
  RECENCY_WINDOW_DAYS,
} from "./demoRecency";

/** Days-ago assigned to a whole set, as the script would walk it. */
const spread = (total: number) =>
  Array.from({ length: total }, (_, i) => daysAgoForIndex(i, total));

describe("when demo rows are spread across the selectable window", () => {
  it("should put rows on today AND on yesterday, at EVERY total", () => {
    // Both are preset buttons. BrightGoods had 150 exceptions on today and none
    // on yesterday, so the Yesterday button opened onto an empty screen.
    //
    // Swept across totals rather than checked at one comfortable size: the first
    // version asserted this at 50 rows only, and bandSizes(3) quietly produced
    // days 0, 7, 30 — Yesterday empty, invariant broken, test green.
    for (let total = 2; total <= 60; total++) {
      const days = spread(total);
      expect(days, `total=${total}: no row dated today`).toContain(0);
      expect(days, `total=${total}: no row dated yesterday`).toContain(1);
    }
  });

  it("should fill all three bands once there are enough rows to do so", () => {
    // Four is the true minimum: day 0, day 1, one in 7-29, one in 30-89. Below
    // it the goals conflict and the recent band wins, which is stated rather
    // than left as an accident.
    for (let total = 4; total <= 60; total++) {
      const days = spread(total);
      for (const band of RECENCY_BANDS) {
        const inBand = days.filter((d) => d >= band.from && d <= band.to).length;
        expect(inBand, `total=${total}: ${band.label} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("should fill every band, including the one that was empty", () => {
    // 8-30 days held a single exception on Globus; 31-90 held none on
    // BrightGoods. A spread that leaves either empty is the bug, not a variant.
    const days = spread(50);
    for (const band of RECENCY_BANDS) {
      const inBand = days.filter((d) => d >= band.from && d <= band.to).length;
      expect(inBand, `${band.label} is empty`).toBeGreaterThan(0);
    }
  });

  it("should never date a row outside the three-month window", () => {
    for (const total of [1, 7, 16, 50, 542, 2000]) {
      for (const d of spread(total)) {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d, `${total} rows produced a day beyond the window`).toBeLessThan(RECENCY_WINDOW_DAYS);
      }
    }
  });

  it("should weight towards recent rather than spreading flat", () => {
    // A flat spread puts as much in mid-August as in today, which reads as
    // synthetic. Most of the data should sit in the first week.
    const days = spread(200);
    const recent = days.filter((d) => d <= 6).length;
    const oldest = days.filter((d) => d >= 30).length;
    expect(recent).toBeGreaterThan(oldest);
    expect(recent / days.length).toBeGreaterThan(0.35);
  });

  it("should be deterministic, so a re-run does not reshuffle the demo", () => {
    expect(spread(120)).toEqual(spread(120));
  });

  it("should behave for degenerate totals rather than throwing", () => {
    expect(() => spread(0)).not.toThrow();
    expect(daysAgoForIndex(0, 0)).toBe(0);
    expect(daysAgoForIndex(5, 1)).toBe(0); // index clamped into range
  });
});

describe("when a demo row is given its timestamp", () => {
  it("should land the requested number of days back", () => {
    const reference = new Date("2026-09-20T12:00:00Z");
    const d = dateForIndex(0, 10, reference);
    expect(Math.round((reference.getTime() - d.getTime()) / 86_400_000)).toBe(0);
  });

  it("should not stack every row on the same timestamp", () => {
    // A column of identical times is the other way seeded data announces itself.
    const reference = new Date("2026-09-20T12:00:00Z");
    const times = Array.from({ length: 10 }, (_, i) => dateForIndex(i, 10, reference).toISOString());
    expect(new Set(times).size).toBeGreaterThan(1);
  });
});

describe("when an exception is aged backwards", () => {
  it("should leave this week's cases exactly as they are", () => {
    // The recent band is the live queue; its statuses are the demo's story.
    expect(statusForAge(0, "open")).toBe("open");
    expect(statusForAge(6, "in_review")).toBe("in_review");
  });

  it("should not leave a two-month-old case sitting open", () => {
    // A 60-day-old open item says the tenant abandoned its queue.
    expect(statusForAge(60, "open")).toBe("resolved");
    expect(statusForAge(89, "in_review")).toBe("resolved");
  });

  it("should move a mid-window open case into review rather than closing it", () => {
    expect(statusForAge(20, "open")).toBe("in_review");
  });

  it("should never reopen something already resolved", () => {
    for (const age of [0, 6, 20, 60]) {
      expect(statusForAge(age, "resolved")).toBe("resolved");
    }
  });
});
