/**
 * How demo data is spread across the window a viewer can actually select.
 *
 * The Exceptions and Review Queue screens open on TODAY (`useDateRange` defaults
 * both ends to the current date), offer Today / Yesterday / Last 7 days as
 * presets, and let a viewer pick any custom range from the calendar. A demo is
 * only convincing if every one of those lands on something.
 *
 * It did not. Measured 2026-09-20: BrightGoods had 150 exceptions dated today,
 * NONE yesterday and NONE in the 31-90 day band; Globus had a single exception
 * in the whole 8-30 day range. Both tenants looked operated on one screen and
 * abandoned on the next, because the seeders date everything into a narrow
 * recent band — `index % 10` days for financial services, `randomBetween(0, 7)`
 * for corporate B2B.
 *
 * ── Why deterministic, and why weighted ───────────────────────────────────
 *
 * Deterministic so a re-run produces the same shape and a test can assert it. A
 * random spread makes "is the 8-30 day band populated?" a question you can only
 * answer by looking, which is how the gap survived in the first place.
 *
 * Weighted towards recent because that is what an operated tenant looks like:
 * most activity is this week, with a thinning tail of history behind it. A flat
 * spread over 90 days would put roughly the same count in "today" as in "the
 * second week of August", which reads as synthetic — the same objection the
 * demo readiness thresholds already make about flat channel distributions.
 */

/** The furthest back a viewer is expected to look — three months. */
export const RECENCY_WINDOW_DAYS = 90;

/**
 * The three bands, as [label, firstDay, lastDay, shareOfRows].
 *
 * Shares sum to 1. The first band spans 0-6 so that BOTH the Today and the
 * Yesterday preset land on rows: a band starting at 1 would leave Today empty,
 * and one ending at 0 would leave Yesterday empty, and each of those was a real
 * observed state rather than a hypothetical.
 */
export const RECENCY_BANDS = [
  { label: "0-6 days (Today / Yesterday / Last 7)", from: 0, to: 6, share: 0.45 },
  { label: "7-29 days", from: 7, to: 29, share: 0.3 },
  { label: "30-89 days (the rest of the quarter)", from: 30, to: 89, share: 0.25 },
] as const;

/**
 * How many days before today the `index`-th of `total` rows should be dated.
 *
 * Rows are walked in a stable order (ascending id) by the caller, so the same
 * row lands on the same day every run.
 */
export function daysAgoForIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  const i = Math.min(Math.max(index, 0), total - 1);
  const sizes = bandSizes(total);

  let consumed = 0;
  for (let b = 0; b < RECENCY_BANDS.length; b++) {
    const band = RECENCY_BANDS[b];
    if (i < consumed + sizes[b]) {
      const span = band.to - band.from + 1;
      // Cycle within the band so every day in it is used before any repeats.
      return band.from + ((i - consumed) % span);
    }
    consumed += sizes[b];
  }
  return 0;
}

/**
 * How many rows each band gets.
 *
 * Every band that can be filled IS filled — `Math.max(1, …)` rather than a bare
 * proportion. A first attempt used `Math.round(total * share)`, which floors to
 * zero for small sets and then, because the last band absorbed the remainder,
 * put a lone row 30 days in the past instead of today. Caught by its own test:
 * a tenant with one exception would have shown an empty Today and an empty Last
 * 7 days while claiming to hold data.
 *
 * Fewer rows than bands means the recent band takes them all, deliberately: an
 * empty Today is worse than an empty far end of the quarter, because Today is
 * where every screen opens.
 */
function bandSizes(total: number): number[] {
  const n = RECENCY_BANDS.length;
  if (total <= 0) return RECENCY_BANDS.map(() => 0);

  // Filling every band AND both Today and Yesterday needs at least four rows:
  // day 0, day 1, one in 7-29, one in 30-89. Below that the two goals genuinely
  // conflict, and the recent band wins — a "quarter of history" made of one row
  // is meaningless, while an empty Today is the defect this exists to remove.
  //
  // An earlier version used `total < n` (three), which let bandSizes(3) allocate
  // one row per band and produce days 0, 7 and 30 — leaving Yesterday empty
  // while claiming the invariant held. Review caught it; the test below now
  // covers every small total rather than only the comfortable ones.
  const MIN_FOR_ALL_BANDS = n + 1;
  if (total < MIN_FOR_ALL_BANDS) return RECENCY_BANDS.map((_, i) => (i === 0 ? total : 0));

  // The recent band needs two rows of its own, so Today and Yesterday both fill.
  const sizes = RECENCY_BANDS.map((b, i) =>
    Math.max(i === 0 ? 2 : 1, Math.floor(total * b.share)),
  );
  const sum = sizes.reduce((a, b) => a + b, 0);
  // Any shortfall goes to the recent band, keeping the weighting.
  if (sum < total) sizes[0] += total - sum;
  // Any overshoot comes off the older bands first, never below their minimum —
  // one row each, and two for the recent band so Yesterday keeps its row.
  let over = sum - total;
  for (let b = n - 1; b >= 0 && over > 0; b--) {
    const floorForBand = b === 0 ? 2 : 1;
    const take = Math.min(over, sizes[b] - floorForBand);
    sizes[b] -= take;
    over -= take;
  }
  return sizes;
}

/**
 * The date for the `index`-th of `total` rows, relative to `reference`.
 *
 * The time of day is preserved from `reference` rather than zeroed, so rows do
 * not all land on midnight — a column of identical timestamps is the other way
 * seeded data announces itself.
 */
export function dateForIndex(index: number, total: number, reference: Date = new Date()): Date {
  const d = new Date(reference);
  d.setDate(d.getDate() - daysAgoForIndex(index, total));
  // Spread within the working day: 08:00 + up to ~10h, by index.
  d.setHours(8 + (index % 10), (index * 7) % 60, (index * 13) % 60, 0);
  return d;
}

/**
 * An exception this old should not still be sitting open.
 *
 * A 60-day-old OPEN item is not history, it is an accusation — it says the
 * tenant abandoned its queue. Aged rows are therefore closed, which is both what
 * a real operation looks like and what keeps the Review Queue (which reads
 * `status = "open"`) showing the recent cases rather than a wall of stale ones.
 */
export function statusForAge(daysAgo: number, current: string): string {
  if (daysAgo <= 6) return current;
  if (daysAgo <= 29) return current === "open" ? "in_review" : current;
  return "resolved";
}
