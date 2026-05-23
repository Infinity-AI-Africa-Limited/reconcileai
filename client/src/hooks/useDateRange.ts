import { useState, useMemo, useCallback } from "react";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function startOfDay(dateStr: string): Date {
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(dateStr: string): Date {
  const d = new Date(dateStr);
  d.setHours(23, 59, 59, 999);
  return d;
}

function getToday() {
  return toLocalDateString(new Date());
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toLocalDateString(d);
}

function getLast7From() {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return toLocalDateString(d);
}

// ─── Preset definitions ───────────────────────────────────────────────────────

export type DatePreset = "today" | "yesterday" | "last7" | "custom";

export const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 days" },
];

function presetDates(preset: DatePreset): { from: string; to: string } {
  const today = getToday();
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = getYesterday();
      return { from: y, to: y };
    }
    case "last7":
      return { from: getLast7From(), to: today };
    default:
      return { from: today, to: today };
  }
}

function detectPreset(from: string, to: string): DatePreset {
  const today = getToday();
  const yesterday = getYesterday();
  const last7from = getLast7From();
  if (from === today && to === today) return "today";
  if (from === yesterday && to === yesterday) return "yesterday";
  if (from === last7from && to === today) return "last7";
  return "custom";
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

function readStorage(key: string): { from: string; to: string } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.from && parsed?.to) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, from: string, to: string) {
  try {
    localStorage.setItem(key, JSON.stringify({ from, to }));
  } catch {}
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Persistent date-range state backed by localStorage.
 * @param storageKey  Unique localStorage key per page (e.g. "reconcileai_exceptions_daterange")
 */
export function useDateRange(storageKey: string) {
  const today = useMemo(() => getToday(), []);

  const [dateFrom, setDateFromRaw] = useState<string>(() => {
    const saved = readStorage(storageKey);
    return saved?.from ?? today;
  });

  const [dateTo, setDateToRaw] = useState<string>(() => {
    const saved = readStorage(storageKey);
    return saved?.to ?? today;
  });

  const setDateFrom = useCallback(
    (v: string) => {
      setDateFromRaw(v);
      writeStorage(storageKey, v, dateTo);
    },
    [storageKey, dateTo]
  );

  const setDateTo = useCallback(
    (v: string) => {
      setDateToRaw(v);
      writeStorage(storageKey, dateFrom, v);
    },
    [storageKey, dateFrom]
  );

  const applyPreset = useCallback(
    (preset: DatePreset) => {
      const { from, to } = presetDates(preset);
      setDateFromRaw(from);
      setDateToRaw(to);
      writeStorage(storageKey, from, to);
    },
    [storageKey]
  );

  const resetToToday = useCallback(() => applyPreset("today"), [applyPreset]);

  const activePreset: DatePreset = useMemo(
    () => detectPreset(dateFrom, dateTo),
    [dateFrom, dateTo]
  );

  const isToday = activePreset === "today";
  const isSingleDay = dateFrom === dateTo;

  const dateFromObj = useMemo(() => startOfDay(dateFrom), [dateFrom]);
  const dateToObj = useMemo(() => endOfDay(dateTo), [dateTo]);

  return {
    dateFrom,
    dateTo,
    dateFromObj,
    dateToObj,
    setDateFrom,
    setDateTo,
    applyPreset,
    resetToToday,
    activePreset,
    isToday,
    isSingleDay,
    today,
  };
}
