import { useState, useMemo, useCallback } from "react";
import {
  type DatePreset,
  type DayRange,
  fromSaved,
  presetOf,
  rangeBounds,
  rangeForPreset,
  toSaved,
} from "@/lib/dateRange";

export { DATE_PRESETS, toLocalDateString, type DatePreset } from "@/lib/dateRange";

// ─── localStorage, wrapped so a blocked store never breaks the page ─────────

function readStorage(key: string): DayRange | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? fromSaved(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, range: DayRange) {
  try {
    localStorage.setItem(key, JSON.stringify(toSaved(range)));
  } catch {}
}

type DefaultPreset = Extract<DatePreset, "today" | "all">;

/**
 * Persistent date-range state for a list screen. The rules live in
 * `@/lib/dateRange`; this only holds state and saves it.
 *
 * @param storageKey  Unique localStorage key per page.
 * @param opts.defaultPreset  What an unsaved page opens on (default "today").
 * @param opts.initial  A range named by the URL. It wins for this visit and is
 *   NOT saved — following a dashboard link must not change what the page opens
 *   on next time. Only the viewer's own choices are saved.
 */
export function useDateRange(
  storageKey: string,
  opts: { defaultPreset?: DefaultPreset; initial?: DayRange | null } = {},
) {
  const defaultPreset: DefaultPreset = opts.defaultPreset ?? "today";
  const [range, setRange] = useState<DayRange>(
    () => opts.initial ?? readStorage(storageKey) ?? rangeForPreset(defaultPreset),
  );

  const choose = useCallback(
    (next: DayRange) => {
      setRange(next);
      writeStorage(storageKey, next);
    },
    [storageKey],
  );

  const setDateFrom = useCallback((v: string) => choose({ from: v, to: range.to }), [choose, range.to]);
  const setDateTo = useCallback((v: string) => choose({ from: range.from, to: v }), [choose, range.from]);
  const applyPreset = useCallback(
    (preset: Exclude<DatePreset, "custom">) => choose(rangeForPreset(preset)),
    [choose],
  );
  const resetToDefault = useCallback(() => applyPreset(defaultPreset), [applyPreset, defaultPreset]);

  const activePreset: DatePreset = useMemo(() => presetOf(range), [range]);
  const bounds = useMemo(() => rangeBounds(range), [range]);

  const isToday = activePreset === "today";
  const isAll = activePreset === "all";
  const isSingleDay = range.from !== "" && range.from === range.to;
  const label = isToday
    ? "Today"
    : isAll
      ? "All dates"
      : isSingleDay
        ? range.from
        : `${range.from || "…"} – ${range.to || "…"}`;

  return {
    dateFrom: range.from,
    dateTo: range.to,
    /** First instant of the range, or undefined when it is unbounded. */
    dateFromObj: bounds.from,
    /** Last instant of the range (inclusive), or undefined when unbounded. */
    dateToObj: bounds.to,
    setDateFrom,
    setDateTo,
    applyPreset,
    resetToDefault,
    activePreset,
    isToday,
    isAll,
    isSingleDay,
    /** True while the range is what this page opens on. */
    isDefault: activePreset === defaultPreset,
    defaultPreset,
    label,
  };
}

export type DateRangeState = ReturnType<typeof useDateRange>;
