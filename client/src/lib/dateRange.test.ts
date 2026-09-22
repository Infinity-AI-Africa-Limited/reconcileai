/**
 * Date ranges on list screens. See dateRange.ts for the two defects this pins:
 * presets saved as dates (a stale "Today"), and calendar days read as UTC.
 *
 * On the second: the UTC reading is only WRONG west of Greenwich, so the day
 * tests below can only tell the old parser from the new one in such a zone.
 * CI runs in UTC, where both agree. It was verified by running this file under
 * TZ=America/New_York with the old `new Date(day)` restored — it fails there.
 */
import { describe, it, expect } from "vitest";
import {
  fromSaved,
  localDayEnd,
  localDayStart,
  parseLocalDay,
  presetOf,
  rangeBounds,
  rangeForPreset,
  rangeFromSearch,
  toLocalDateString,
  toSaved,
} from "./dateRange";

// 13:14 on 21 September 2026, local time — whatever zone the suite runs in.
const NOW = new Date(2026, 8, 21, 13, 14);
const NEXT_DAY = new Date(2026, 8, 22, 9, 0);

describe("when a calendar day is read", () => {
  it("should start at the viewer's own midnight, on that day", () => {
    const d = parseLocalDay("2026-09-21")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 8, 21, 0, 0]);
    expect(toLocalDateString(d)).toBe("2026-09-21");
  });

  it("should reject a day that does not exist rather than roll into the next month", () => {
    expect(parseLocalDay("2026-02-31")).toBeNull();
    expect(parseLocalDay("2026-13-01")).toBeNull();
    expect(parseLocalDay("21/09/2026")).toBeNull();
    expect(parseLocalDay("")).toBeNull();
  });

  it("should end a one-day range at the last instant of that day, so the day is included", () => {
    const end = localDayEnd("2026-09-21")!;
    expect([end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([21, 23, 59, 59, 999]);
    expect(localDayStart("2026-09-21")!.getTime()).toBeLessThan(end.getTime());
  });

  it("should leave an unbounded side undefined rather than invent a date", () => {
    expect(rangeBounds({ from: "", to: "" })).toEqual({ from: undefined, to: undefined });
  });
});

describe("when a preset is chosen", () => {
  it("should cover the days it names", () => {
    expect(rangeForPreset("today", NOW)).toEqual({ from: "2026-09-21", to: "2026-09-21" });
    expect(rangeForPreset("yesterday", NOW)).toEqual({ from: "2026-09-20", to: "2026-09-20" });
    expect(rangeForPreset("last7", NOW)).toEqual({ from: "2026-09-15", to: "2026-09-21" });
    expect(rangeForPreset("all", NOW)).toEqual({ from: "", to: "" });
  });

  it("should recognise a range as its preset, and anything else as custom", () => {
    expect(presetOf({ from: "2026-09-21", to: "2026-09-21" }, NOW)).toBe("today");
    expect(presetOf({ from: "", to: "" }, NOW)).toBe("all");
    expect(presetOf({ from: "2026-09-01", to: "2026-09-10" }, NOW)).toBe("custom");
  });

  it("should cross a month boundary correctly", () => {
    expect(rangeForPreset("last7", new Date(2026, 9, 3))).toEqual({ from: "2026-09-27", to: "2026-10-03" });
  });
});

describe("when a range is saved and the page is opened again the next day", () => {
  it("should reopen 'Today' on the NEW day, because the preset is saved by name", () => {
    // The defect: {from: "2026-09-21", to: "2026-09-21"} was saved, so the 22nd
    // opened on the 21st.
    const saved = toSaved(rangeForPreset("today", NOW), NOW);
    expect(saved).toEqual({ v: 2, preset: "today" });
    expect(fromSaved(JSON.parse(JSON.stringify(saved)), NEXT_DAY)).toEqual({ from: "2026-09-22", to: "2026-09-22" });
  });

  it("should keep a custom range exactly as chosen", () => {
    const saved = toSaved({ from: "2026-08-01", to: "2026-08-15" }, NOW);
    expect(fromSaved(saved, NEXT_DAY)).toEqual({ from: "2026-08-01", to: "2026-08-15" });
  });

  it("should ignore the old dates-only shape instead of resurrecting a stale range", () => {
    expect(fromSaved({ from: "2026-09-20", to: "2026-09-20" }, NEXT_DAY)).toBeNull();
  });

  it("should ignore anything malformed", () => {
    for (const v of [null, "today", 42, { v: 2 }, { v: 2, preset: "tomorrow" }, { v: 2, from: "x", to: "y" }]) {
      expect(fromSaved(v, NOW), JSON.stringify(v)).toBeNull();
    }
  });
});

describe("when a link names a range", () => {
  it("should honour a named preset", () => {
    expect(rangeFromSearch("?range=all", NOW)).toEqual({ from: "", to: "" });
    expect(rangeFromSearch("?status=open&range=last7", NOW)).toEqual({ from: "2026-09-15", to: "2026-09-21" });
  });

  it("should honour explicit days, including an open end", () => {
    expect(rangeFromSearch("?from=2026-08-19&to=2026-09-21", NOW)).toEqual({ from: "2026-08-19", to: "2026-09-21" });
    expect(rangeFromSearch("?from=2026-08-19", NOW)).toEqual({ from: "2026-08-19", to: "" });
  });

  it("should name no range when the link carries none or a bad one, so the saved range applies", () => {
    expect(rangeFromSearch("", NOW)).toBeNull();
    expect(rangeFromSearch("?status=open", NOW)).toBeNull();
    expect(rangeFromSearch("?range=forever", NOW)).toBeNull();
    expect(rangeFromSearch("?from=2026-02-31", NOW)).toBeNull();
  });
});
