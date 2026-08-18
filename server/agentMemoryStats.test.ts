import { describe, expect, it } from "vitest";
import { groupMemoryGrowthByMonth, sixMonthsAgoUtc } from "./agentMemoryStats";

describe("the six-month dashboard boundary", () => {
  it("should subtract six months in UTC for an ordinary mid-month date", () => {
    const now = new Date("2026-08-17T00:11:43.182Z");
    expect(sixMonthsAgoUtc(now).toISOString()).toBe("2026-02-17T00:11:43.182Z");
  });

  /**
   * These expectations are not derived from the implementation — they are the
   * values real MySQL 8.0 returns for the `DATE_SUB(…, INTERVAL 6 MONTH)` this
   * code replaced, captured directly:
   *
   *   SELECT DATE_SUB("2026-08-31 12:00:00", INTERVAL 6 MONTH);  -- 2026-02-28 12:00:00
   *   SELECT DATE_SUB("2026-08-29 00:00:00", INTERVAL 6 MONTH);  -- 2026-02-28 00:00:00
   *   SELECT DATE_SUB("2026-05-31 00:00:00", INTERVAL 6 MONTH);  -- 2025-11-30 00:00:00
   *   SELECT DATE_SUB("2026-03-31 00:00:00", INTERVAL 6 MONTH);  -- 2025-09-30 00:00:00
   *   SELECT DATE_SUB("2026-07-31 00:00:00", INTERVAL 6 MONTH);  -- 2026-01-31 00:00:00
   *
   * Pinning them keeps the portable implementation a faithful port rather than
   * a lookalike that quietly moves the window.
   */
  it.each([
    ["2026-08-31T12:00:00.000Z", "2026-02-28T12:00:00.000Z"],
    ["2026-08-29T00:00:00.000Z", "2026-02-28T00:00:00.000Z"],
    ["2026-05-31T00:00:00.000Z", "2025-11-30T00:00:00.000Z"],
    ["2026-03-31T00:00:00.000Z", "2025-09-30T00:00:00.000Z"],
    ["2026-07-31T00:00:00.000Z", "2026-01-31T00:00:00.000Z"],
  ])("should clamp %s to the same day MySQL DATE_SUB does", (now, expected) => {
    expect(sixMonthsAgoUtc(new Date(now)).toISOString()).toBe(expected);
  });

  it("should never overflow into the month after the intended one", () => {
    // The bug this guards: setUTCMonth keeps the day and rolls forward when the
    // target month is shorter, so 31 Aug produced 3 March and the gte filter
    // then dropped every row from 28 Feb to 2 March.
    for (let day = 1; day <= 31; day++) {
      const now = new Date(Date.UTC(2026, 7, day)); // August 2026
      const boundary = sixMonthsAgoUtc(now);
      expect(boundary.getUTCFullYear(), `day ${day}`).toBe(2026);
      expect(boundary.getUTCMonth(), `day ${day} landed outside February`).toBe(1);
    }
  });

  it("should handle a leap-year February as the target month", () => {
    // 2028 is a leap year: 29 February exists, so 29 August must not clamp to 28.
    expect(sixMonthsAgoUtc(new Date("2028-08-29T00:00:00.000Z")).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(sixMonthsAgoUtc(new Date("2028-08-31T00:00:00.000Z")).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("should cross the year boundary correctly", () => {
    expect(sixMonthsAgoUtc(new Date("2026-01-15T06:30:00.000Z")).toISOString()).toBe(
      "2025-07-15T06:30:00.000Z",
    );
  });

  it("should not mutate the date it was given", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    sixMonthsAgoUtc(now);
    expect(now.toISOString()).toBe("2026-08-31T12:00:00.000Z");
  });
});

describe("monthly growth bucketing", () => {
  it("should group timestamp rows chronologically across year boundaries", () => {
    const growth = groupMemoryGrowthByMonth([
      { createdAt: new Date("2026-01-31T23:59:59.000Z") },
      { createdAt: new Date("2025-12-01T00:00:00.000Z") },
      { createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { createdAt: new Date("2025-12-31T23:00:00.000Z") },
    ]);

    expect(growth).toEqual([
      { month: "2025-12", count: 2 },
      { month: "2026-01", count: 2 },
    ]);
  });

  it("should bucket by UTC, not by the server's local timezone", () => {
    // 23:30 on 31 December UTC is already January in some zones. Bucketing on
    // anything but UTC would move this row into the wrong month depending on
    // where the container happens to run.
    const growth = groupMemoryGrowthByMonth([{ createdAt: new Date("2025-12-31T23:30:00.000Z") }]);
    expect(growth).toEqual([{ month: "2025-12", count: 1 }]);
  });

  it("should return an empty list when the tenant has no memories", () => {
    expect(groupMemoryGrowthByMonth([])).toEqual([]);
  });

  it("should omit months with no activity rather than emitting a zero bucket", () => {
    // The SQL GROUP BY this replaced also returned only non-empty months, so a
    // gap stays a gap and the chart is not silently backfilled.
    const growth = groupMemoryGrowthByMonth([
      { createdAt: new Date("2026-03-02T00:00:00.000Z") },
      { createdAt: new Date("2026-06-09T00:00:00.000Z") },
    ]);
    expect(growth.map((g) => g.month)).toEqual(["2026-03", "2026-06"]);
  });
});
