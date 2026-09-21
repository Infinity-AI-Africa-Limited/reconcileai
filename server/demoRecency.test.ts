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
  zonedDayStart,
  wallTimeInZone,
  anchoredDetection,
  rollDeltaMs,
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
  const LAGOS = "Africa/Lagos";
  /** The calendar date a timestamp falls on, as seen in `timeZone`. */
  const localDate = (d: Date, timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  it("should land the requested number of the TENANT's calendar days back", () => {
    const reference = new Date("2026-09-20T12:00:00Z");
    for (let i = 0; i < 40; i++) {
      const d = dateForIndex(i, 40, reference, LAGOS);
      const expected = zonedDayStart(reference, daysAgoForIndex(i, 40), LAGOS);
      expect(localDate(d, LAGOS), `row ${i}`).toBe(localDate(expected, LAGOS));
    }
  });

  it("should put today's rows on the viewer's today after local midnight but before UTC midnight", () => {
    // The review finding, exactly. At 21:30 UTC it is already 00:30 tomorrow in
    // Kampala. Anchored to UTC, day-0 rows landed on the Kampala viewer's
    // Yesterday while the script reported Today populated.
    const reference = new Date("2026-09-20T21:30:00Z");
    const kampalaToday = localDate(reference, "Africa/Kampala"); // 2026-09-21
    expect(kampalaToday).toBe("2026-09-21");
    for (let i = 0; i < 30; i++) {
      if (daysAgoForIndex(i, 30) !== 0) continue;
      const d = dateForIndex(i, 30, reference, "Africa/Kampala");
      expect(localDate(d, "Africa/Kampala"), `row ${i}`).toBe(kampalaToday);
    }
  });

  it("should never date a row after the moment the script ran", () => {
    // A 07:40 run wrote today's rows at 08:00-17:59 — up to ten hours ahead of
    // the clock. 36 Globus and 4 BrightGoods exceptions were "created later
    // today". Swept across a whole day of run times, in two zones.
    for (const zone of [LAGOS, "Africa/Kampala"]) {
      for (let minute = 0; minute < 24 * 60; minute += 17) {
        const reference = new Date(Date.UTC(2026, 8, 20, 0, minute, 0));
        for (let i = 0; i < 60; i++) {
          const d = dateForIndex(i, 60, reference, zone);
          expect(d.getTime(), `${zone} run at +${minute}m, row ${i}`).toBeLessThanOrEqual(reference.getTime());
        }
      }
    }
  });

  it("should produce the same instant whatever timezone the HOST runs in", () => {
    // The first version used setDate/setHours, so the machine running the script
    // decided which day a row landed on. Same inputs under the most extreme
    // real zones must give byte-identical output.
    const reference = new Date("2026-09-20T23:30:00Z");
    const original = process.env.TZ;
    try {
      const results = ["Pacific/Kiritimati", "Pacific/Pago_Pago", LAGOS, "UTC"].map((tz) => {
        process.env.TZ = tz;
        return Array.from({ length: 30 }, (_, i) => dateForIndex(i, 30, reference, LAGOS).toISOString());
      });
      for (const r of results.slice(1)) expect(r).toEqual(results[0]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("should place past days in the tenant's working hours", () => {
    const reference = new Date("2026-09-20T12:00:00Z");
    const hour = (d: Date) =>
      Number(new Intl.DateTimeFormat("en-GB", { timeZone: LAGOS, hour: "2-digit", hourCycle: "h23" }).format(d));
    for (let i = 0; i < 100; i++) {
      if (daysAgoForIndex(i, 100) === 0) continue; // today is clamped to "so far"
      const h = hour(dateForIndex(i, 100, reference, LAGOS));
      expect(h, `row ${i}`).toBeGreaterThanOrEqual(8);
      expect(h, `row ${i}`).toBeLessThanOrEqual(17);
    }
  });

  it("should find local midnight correctly across a daylight-saving change", () => {
    // London leaves BST at 01:00 UTC on 25 Oct 2026. Midnight on the 25th is
    // still BST (23:00 UTC on the 24th), though noon that day is GMT — so the
    // offset has to be re-read at the midnight itself.
    const start = zonedDayStart(new Date("2026-10-25T12:00:00Z"), 0, "Europe/London");
    expect(start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
  });

  it("should not stack every row on the same timestamp", () => {
    // A column of identical times is the other way seeded data announces itself.
    const reference = new Date("2026-09-20T12:00:00Z");
    const times = Array.from({ length: 10 }, (_, i) => dateForIndex(i, 10, reference, LAGOS).toISOString());
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

describe("when timestamps must stay distinct and on the wall clock", () => {
  const LAGOS = "Africa/Lagos";
  const localHour = (d: Date, tz: string) =>
    Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(d));
  const localDate = (d: Date, tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  it("should keep working hours on the WALL clock across a daylight-saving change", () => {
    // Review finding, verbatim: on 25 Oct 2026 in London, midnight + 8 elapsed
    // hours is 07:00 on the wall. Rows must still read 08:00-17:59.
    const reference = new Date("2026-10-27T12:00:00Z");
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const d = dateForIndex(i, 400, reference, "Europe/London");
      if (localDate(d, "Europe/London") !== "2026-10-25") continue;
      checked++;
      expect(localHour(d, "Europe/London"), `row ${i}`).toBeGreaterThanOrEqual(8);
      expect(localHour(d, "Europe/London"), `row ${i}`).toBeLessThanOrEqual(17);
    }
    expect(checked, "no row landed on the DST day, so the test proved nothing").toBeGreaterThan(0);
    expect(wallTimeInZone(reference, 2, 8 * 3600, "Europe/London").toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });

  it("should give every row a distinct whole second, however soon after midnight it runs", () => {
    // Review finding: just after midnight the old spread stored every today row
    // as the same second. Columns hold seconds, so distinct means distinct
    // seconds — and never later than the run.
    const midnight = zonedDayStart(new Date("2026-09-21T12:00:00Z"), 0, LAGOS).getTime();
    for (const after of [0, 1, 10, 300, 7 * 3600 + 59 * 60, 8 * 3600, 12 * 3600]) {
      const reference = new Date(midnight + after * 1000);
      for (const total of [50, 558]) {
        const stamps = Array.from({ length: total }, (_, i) => dateForIndex(i, total, reference, LAGOS));
        for (const d of stamps) {
          expect(d.getTime() % 1000, "not a whole second").toBe(0);
          expect(d.getTime(), `+${after}s total=${total}: in the future`).toBeLessThanOrEqual(reference.getTime());
        }
        expect(new Set(stamps.map((d) => d.getTime())).size, `+${after}s total=${total}: duplicates`).toBe(total);
      }
    }
  });

  it("should move today's overflow to yesterday rather than stack it", () => {
    // Ten seconds into the day there are ten seconds of today. With 558 rows
    // there are more today rows than that; the rest belong to yesterday.
    const midnight = zonedDayStart(new Date("2026-09-21T12:00:00Z"), 0, LAGOS).getTime();
    const reference = new Date(midnight + 10_000);
    const today = Array.from({ length: 558 }, (_, i) => dateForIndex(i, 558, reference, LAGOS))
      .filter((d) => d.getTime() >= midnight).length;
    expect(today).toBeGreaterThan(0);
    expect(today).toBeLessThanOrEqual(11);
  });

  it("should keep a quarter's worth of rows free of shared timestamps", () => {
    // The old time-of-day formula repeated every 60 rows, so rows 60 apart on
    // the same day collided — 139 rows in Globus Bank's quarter band did.
    const reference = new Date("2026-09-21T12:00:00Z");
    const stamps = Array.from({ length: 2000 }, (_, i) => dateForIndex(i, 2000, reference, LAGOS).getTime());
    expect(new Set(stamps).size).toBe(2000);
  });
});

describe("when an exception is anchored to its transaction", () => {
  const now = new Date("2026-09-21T12:00:00Z");

  it("should never be raised before the transaction it is about", () => {
    // 253 Globus and 35 BrightGoods exceptions were, up to 85 days early, on the
    // Age Tracker — the screen that shows both dates side by side.
    for (let i = 0; i < 300; i++) {
      const tx = new Date(now.getTime() - (i % 90) * 86_400_000 - (i % 17) * 60_000);
      const d = anchoredDetection(tx, i, now);
      expect(d.getTime(), `row ${i}`).toBeGreaterThanOrEqual(Math.floor(tx.getTime() / 1000) * 1000);
      expect(d.getTime(), `row ${i}`).toBeLessThanOrEqual(now.getTime());
      expect(d.getTime() % 1000).toBe(0);
    }
  });

  it("should fit detection into the time available for a very recent transaction", () => {
    const tx = new Date(now.getTime() - 90_000); // 90 seconds ago
    const d = anchoredDetection(tx, 3, now);
    expect(d.getTime()).toBeGreaterThanOrEqual(Math.floor(tx.getTime() / 1000) * 1000);
    expect(d.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

describe("when a tenant's timeline is rolled forward", () => {
  it("should move it by the whole seconds since its newest transaction", () => {
    const now = new Date("2026-09-21T12:00:00.750Z");
    expect(rollDeltaMs(new Date("2026-09-20T12:00:00Z"), now)).toBe(86_400_000);
  });

  it("should leave a current or future timeline alone rather than move it backwards", () => {
    const now = new Date("2026-09-21T12:00:00Z");
    expect(rollDeltaMs(now, now)).toBe(0);
    expect(rollDeltaMs(new Date("2026-09-22T00:00:00Z"), now)).toBe(0);
    expect(rollDeltaMs(null, now)).toBe(0);
  });
});
