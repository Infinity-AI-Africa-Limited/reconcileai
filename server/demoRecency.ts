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
 * Which calendar "today" a tenant's demo is written for.
 *
 * "Today" does not exist without a timezone: at any instant two calendar dates
 * are in effect somewhere. An earlier revision used UTC, and review showed where
 * that breaks — after 21:00 UTC it is already tomorrow in Kampala, so rows
 * written for the UTC "today" landed on a Kampala viewer's Yesterday while the
 * script, measuring in UTC, reported Today populated. A false success.
 *
 * The honest anchor is the tenant's OWN local day, which is what its operators
 * see. Organisations record `country` (ISO 3166-1 alpha-3) but no timezone, so
 * this maps the markets the platform serves. An unlisted country is NOT given a
 * guessed zone: the script refuses and asks for `--tz`, because a wrong anchor
 * produces exactly the empty-Today it exists to prevent.
 */
export const COUNTRY_TIMEZONES: Readonly<Record<string, string>> = {
  NGA: "Africa/Lagos",
  UGA: "Africa/Kampala",
  GHA: "Africa/Accra",
  KEN: "Africa/Nairobi",
};

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in ms. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant the calendar day `daysAgo` days before `reference` BEGINS, in
 * `timeZone`.
 *
 * The ONE definition of "N days ago" used both to write rows and to measure
 * which band they landed in, so the two cannot disagree about a boundary. The
 * offset is re-read at the candidate midnight, because on a daylight-saving
 * change the offset at noon is not the offset at midnight.
 */
export function zonedDayStart(reference: Date, daysAgo: number, timeZone: string): Date {
  const offset = zoneOffsetMs(reference, timeZone);
  const wall = new Date(reference.getTime() + offset);
  const wallMidnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - daysAgo);
  let instant = wallMidnight - offset;
  const offsetThen = zoneOffsetMs(new Date(instant), timeZone);
  if (offsetThen !== offset) instant = wallMidnight - offsetThen;
  return new Date(instant);
}

/**
 * The instant at which the tenant's wall clock reads `secondsIntoDay` past
 * midnight, `daysAgo` days before `reference`.
 *
 * Built as a WALL time and then resolved to an instant, rather than by adding
 * elapsed hours to midnight. On a daylight-saving day those differ: London's
 * clocks go back at 02:00 on 25 October, so midnight plus eight elapsed hours
 * is 07:00 on the wall, not 08:00. The offset is re-read at the candidate
 * instant for the same reason zonedDayStart re-reads it.
 */
export function wallTimeInZone(reference: Date, daysAgo: number, secondsIntoDay: number, timeZone: string): Date {
  const offset = zoneOffsetMs(reference, timeZone);
  const wall = new Date(reference.getTime() + offset);
  const wallInstant =
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - daysAgo) + secondsIntoDay * 1000;
  let instant = wallInstant - offset;
  const offsetThen = zoneOffsetMs(new Date(instant), timeZone);
  if (offsetThen !== offset) instant = wallInstant - offsetThen;
  return new Date(instant);
}

/** Working hours: rows land between 08:00:00 and 17:59:59 on the wall clock. */
const WORKDAY_START_S = 8 * 3600;
const WORKDAY_S = 10 * 3600;
/**
 * The step between consecutive rows' time of day. Prime, and coprime with the
 * 36,000-second working day, so `index * STRIDE mod 36000` is DIFFERENT for
 * every index below 36,000: no two rows share a time of day, so no two rows on
 * the same day share a timestamp.
 *
 * The version before used `index % 10` hours with `index * 7 % 60` minutes and
 * `index * 13 % 60` seconds — which repeats every 60 rows, so rows 60 apart that
 * fell on the same day had IDENTICAL timestamps. The quarter band, with its
 * 60-day span, did exactly that for Globus Bank's 139 rows there.
 */
const TIME_STRIDE_S = 7919;

function plannedSecondsIntoDay(index: number): number {
  return WORKDAY_START_S + ((index * TIME_STRIDE_S) % WORKDAY_S);
}

/**
 * The timestamp for the `index`-th of `total` rows, relative to `reference`,
 * in the tenant's `timeZone`.
 *
 * Whole seconds, because that is what the timestamp columns store: two values a
 * few milliseconds apart are the SAME stored value, so "distinct" has to mean
 * distinct seconds. Independent of the host's timezone, pinned by a test.
 *
 * ── Never in the future, and no collapse at midnight ──────────────────────
 *
 * A run at 07:40 wrote every "today" row between 08:00 and 17:59 — up to ten
 * hours AHEAD of the clock: 36 exceptions on Globus Bank and 4 on BrightGoods
 * were "created later today". So a today row whose working-hours time has not
 * arrived is placed in the part of today that HAS happened, before 08:00.
 *
 * The first version of that spread milliseconds across the elapsed part of the
 * day, which review showed collapses: just after midnight there are only a few
 * seconds of today, so every row stored as the same second. Now each today row
 * gets its own whole-second slot, and when there are more today rows than
 * seconds of today so far — at 00:00:10 there are ten — the rest go to
 * yesterday rather than share a timestamp. That is also simply true: ten seconds
 * into a day, not much has happened yet.
 */
export function dateForIndex(
  index: number,
  total: number,
  reference: Date = new Date(),
  timeZone: string = "UTC",
): Date {
  const refS = Math.floor(reference.getTime() / 1000) * 1000;
  const days = daysAgoForIndex(index, total);
  const planned = wallTimeInZone(reference, days, plannedSecondsIntoDay(index), timeZone).getTime();
  if (days > 0 || planned <= refS) return new Date(planned);

  // A today row whose time has not come yet. Today rows are band 0's every
  // seventh row (daysAgoForIndex cycles band 0 through days 0..6), so this
  // row's rank among them, and their number, follow from `index` and `total`.
  const rank = Math.floor(index / 7);
  const todayRows = Math.ceil(bandSizes(total)[0] / 7);
  const dayStart = zonedDayStart(reference, 0, timeZone).getTime();
  // The last usable second: now, or 07:59:59 if working hours have started —
  // slots stay below 08:00 so they cannot collide with rows kept at their
  // planned working-hours time.
  const limit = Math.min(refS, wallTimeInZone(reference, 0, WORKDAY_START_S - 1, timeZone).getTime());
  const seconds = Math.floor((limit - dayStart) / 1000) + 1;

  if (seconds >= todayRows) {
    return new Date(dayStart + Math.floor((rank * seconds) / todayRows) * 1000);
  }
  if (rank < seconds) return new Date(dayStart + rank * 1000);
  // Not enough of today has happened to give this row a second of its own.
  return wallTimeInZone(reference, 1, plannedSecondsIntoDay(index), timeZone);
}

/**
 * When an exception on a transaction dated `txDate` was detected.
 *
 * Exceptions used to be dated independently of their transactions, which left
 * 253 of Globus Bank's and 35 of BrightGoods' raised BEFORE the transaction they
 * are about — up to 85 days early — on the very screen that shows both dates
 * side by side (the Age Tracker). Reconciliation finds a break after the
 * transaction exists, so detection follows it: five minutes to four hours
 * later, never after `now`, and never before the transaction.
 */
export function anchoredDetection(txDate: Date, index: number, now: Date = new Date()): Date {
  const nowS = Math.floor(now.getTime() / 1000) * 1000;
  const tx = Math.floor(txDate.getTime() / 1000) * 1000;
  if (tx >= nowS) return new Date(tx);
  const lag = (5 * 60 + ((index * 37) % 236) * 60) * 1000;
  if (tx + lag <= nowS) return new Date(tx + lag);
  return new Date(tx + Math.floor((nowS - tx) / 2000) * 1000);
}

/**
 * How far to move a tenant's whole timeline so its newest transaction sits at
 * `now`. Whole seconds, never negative: a timeline already current is left alone.
 */
export function rollDeltaMs(newest: Date | null, now: Date = new Date()): number {
  if (!newest) return 0;
  return Math.max(0, Math.floor((now.getTime() - newest.getTime()) / 1000) * 1000);
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
