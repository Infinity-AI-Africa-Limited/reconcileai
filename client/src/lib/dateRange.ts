/**
 * Date ranges for list screens: presets, calendar days, and what gets saved.
 *
 * Pure, so the rules are tested rather than eyeballed. `useDateRange` composes
 * these; pages consume the hook.
 *
 * ── Two defects this module exists to prevent ─────────────────────────────
 *
 * 1. A preset was SAVED AS DATES. Clicking "Today" on 20 September stored
 *    {from: "2026-09-20", to: "2026-09-20"}, so the page reopened on the 21st
 *    showing the 20th — labelled as a custom range, with nothing on screen to
 *    say the view was a day old. A preset is now saved as its NAME and resolved
 *    against the clock every time it is read.
 *
 * 2. A calendar day was parsed as UTC. `new Date("2026-09-21")` is midnight UTC,
 *    which is still the 20th anywhere west of Greenwich, so "Today" for a viewer
 *    in the Americas — where SHOPLINE's App Store reviewers sit — started and
 *    ended a day early. A day is now read in the viewer's own zone.
 */

export type DatePreset = "today" | "yesterday" | "last7" | "all" | "custom";

export const DATE_PRESETS: { key: Exclude<DatePreset, "custom">; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 days" },
  // What every dashboard counts. Without it a count on the dashboard had no
  // range on the page that could show the same rows.
  { key: "all", label: "All dates" },
];

/** A range as the calendar inputs hold it: local days, or "" for unbounded. */
export interface DayRange {
  from: string;
  to: string;
}

/** Local calendar day of `d`, as YYYY-MM-DD. */
export function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Local midnight of a YYYY-MM-DD day, or null if it is not a real day.
 *
 * Built from its parts, never `new Date(str)`: the string form is parsed as
 * UTC (defect 2 above). Rejects rollovers such as 2026-02-31, which the Date
 * constructor would silently turn into 3 March.
 */
export function parseLocalDay(day: string): Date | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** First instant of a local day. */
export function localDayStart(day: string): Date | undefined {
  return parseLocalDay(day) ?? undefined;
}

/** Last instant of a local day — inclusive, so a one-day range holds the whole day. */
export function localDayEnd(day: string): Date | undefined {
  const start = parseLocalDay(day);
  if (!start) return undefined;
  return new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59, 999);
}

function shiftDays(now: Date, days: number): string {
  return toLocalDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

/** The days a preset stands for, as of `now`. */
export function rangeForPreset(preset: Exclude<DatePreset, "custom">, now: Date = new Date()): DayRange {
  switch (preset) {
    case "today":
      return { from: shiftDays(now, 0), to: shiftDays(now, 0) };
    case "yesterday":
      return { from: shiftDays(now, -1), to: shiftDays(now, -1) };
    case "last7":
      return { from: shiftDays(now, -6), to: shiftDays(now, 0) };
    case "all":
      return { from: "", to: "" };
  }
}

/** Which preset a range is, if any. */
export function presetOf(range: DayRange, now: Date = new Date()): DatePreset {
  for (const p of DATE_PRESETS) {
    const r = rangeForPreset(p.key, now);
    if (r.from === range.from && r.to === range.to) return p.key;
  }
  return "custom";
}

/** The instants a range covers, for a query. Unbounded sides are undefined. */
export function rangeBounds(range: DayRange): { from?: Date; to?: Date } {
  return { from: localDayStart(range.from), to: localDayEnd(range.to) };
}

// ─── What is saved ───────────────────────────────────────────────────────────

/**
 * The saved shape. Versioned because the previous shape — bare dates — is the
 * defect this replaces, and reading it back would resurrect exactly the stale
 * range it produced. An unversioned value is therefore ignored, once.
 */
export type SavedRange = { v: 2; preset: Exclude<DatePreset, "custom"> } | { v: 2; from: string; to: string };

export function toSaved(range: DayRange, now: Date = new Date()): SavedRange {
  const preset = presetOf(range, now);
  return preset === "custom" ? { v: 2, from: range.from, to: range.to } : { v: 2, preset };
}

/** A saved value back to days, or null when it is absent, legacy or malformed. */
export function fromSaved(raw: unknown, now: Date = new Date()): DayRange | null {
  if (typeof raw !== "object" || raw === null || (raw as { v?: unknown }).v !== 2) return null;
  const saved = raw as Record<string, unknown>;
  if (typeof saved.preset === "string") {
    const known = DATE_PRESETS.find((p) => p.key === saved.preset);
    return known ? rangeForPreset(known.key, now) : null;
  }
  if (typeof saved.from === "string" && typeof saved.to === "string") {
    const ok = (s: string) => s === "" || parseLocalDay(s) !== null;
    return ok(saved.from) && ok(saved.to) ? { from: saved.from, to: saved.to } : null;
  }
  return null;
}

// ─── What a link can ask for ────────────────────────────────────────────────

/**
 * A range named in a URL — `?range=all`, `?range=last7`, or `?from=&to=` — or
 * null when the URL names none. A link wins over the saved range for that
 * visit, so a dashboard count opens on the rows it counted.
 */
export function rangeFromSearch(search: string, now: Date = new Date()): DayRange | null {
  const params = new URLSearchParams(search);
  const named = params.get("range");
  if (named) {
    const known = DATE_PRESETS.find((p) => p.key === named);
    return known ? rangeForPreset(known.key, now) : null;
  }
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (!from && !to) return null;
  if ((from && !parseLocalDay(from)) || (to && !parseLocalDay(to))) return null;
  return { from, to };
}
