import { z } from "zod";

/**
 * The instants a MySQL / TiDB `TIMESTAMP` column can hold: 1970-01-01 00:00:01
 * to 2038-01-19 03:14:07 UTC.
 *
 * Outside that range a strict server refuses the write
 * (`ER_TRUNCATED_WRONG_VALUE`), which reaches the caller as a masked 500 — and
 * a non-strict one would store a zero date silently. So a date a caller sends
 * for such a column is checked at the edge and refused with a reason. Found by
 * the control-policy real-database suite: an operator's "effective 2099" date
 * failed the insert.
 *
 * Whole seconds at both ends: these columns keep no fractional seconds and
 * MySQL ROUNDS on write, so 03:14:07.6 would round past the maximum.
 */
export const TIMESTAMP_MIN = new Date("1970-01-01T00:00:01.000Z");
export const TIMESTAMP_MAX = new Date("2038-01-19T03:14:07.000Z");

export const STORABLE_TIMESTAMP_MESSAGE =
  "Date must be between 1970-01-01T00:00:01Z and 2038-01-19T03:14:07Z, the range the database can store.";

export function isStorableTimestamp(date: Date): boolean {
  const time = date.getTime();
  return time >= TIMESTAMP_MIN.getTime() && time <= TIMESTAMP_MAX.getTime();
}

/** An ISO date-time with an offset, parsed to a Date the TIMESTAMP column can hold. */
export const storableDateInput = z
  .string()
  .datetime({ offset: true })
  .transform((value, ctx) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid ISO date-time" });
      return z.NEVER;
    }
    if (!isStorableTimestamp(date)) {
      ctx.addIssue({ code: "custom", message: STORABLE_TIMESTAMP_MESSAGE });
      return z.NEVER;
    }
    return date;
  });
