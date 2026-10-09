/**
 * Money coercion — the single implementation, shared by client and server.
 *
 * Amounts arrive as strings from every direction: pasted CSVs, bank exports,
 * gateway payout files, courier remittance sheets. Reading one wrongly is the
 * worst class of bug this platform can have, because a mis-parsed amount is
 * still a plausible amount — nothing downstream flags it.
 *
 * There were three separate implementations before this:
 *   - server/apiIngestionService  `replace(/[^0-9.-]/g,"")`  (SFTP + API path)
 *   - client Upload.tsx           `replace(/[,\s]/g,"")`     (the 57M-row path)
 *   - the SHOPLINE settlement importer
 * They disagreed. The first silently inverted the sign of "(12.30)"; the first
 * two both read the European "1.234,56" as 1.23456. This file exists so there
 * is exactly one answer to "what number is this?".
 *
 * Lives in shared/ rather than server/ so the browser-side upload parser uses
 * the same logic without duplicating it — the client parses files before
 * posting them, so a server-only fix would leave the main path broken.
 */

/**
 * Parse a money string as written by real-world exports.
 *
 * Handles currency symbols and spacing, thousands grouping, European decimal
 * commas, and the accounting negative `(12.30)`.
 *
 * Returns `null` — never `NaN` — for unreadable input, so callers are forced to
 * decide what an unparseable amount means rather than accidentally storing
 * `NaN` or coercing it to zero.
 */
export function parseMoney(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  let s = String(raw).trim();
  if (!s) return null;

  // Accounting negatives: "(12.30)" means -12.30. Stripping the parens without
  // recording this loses the sign entirely and posts a refund as a credit.
  const parenNegative = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "").replace(/[^0-9.,\-]/g, "");
  if (!s || s === "-" || s === "." || s === ",") return null;

  // Separator disambiguation. Getting this wrong is silently catastrophic:
  // "₦12,000" read as a European decimal becomes 12.00 — a 1000x understatement
  // that still looks like a plausible amount.
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Both present: whichever appears last is the decimal separator.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    const parts = s.split(",");
    // Repeated commas, or a final group of exactly 3 digits, means thousands
    // grouping ("12,000"). A 1-2 digit tail means a European decimal ("12,30").
    const thousands = parts.length > 2 || parts[parts.length - 1].length === 3;
    s = thousands ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (hasDot) {
    // A single dot is a decimal point in virtually every export; only repeated
    // dots indicate grouping ("1.234.567").
    if (s.split(".").length > 2) s = s.replace(/\./g, "");
  }

  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return parenNegative ? -Math.abs(n) : n;
}

/**
 * An exact decimal: a whole number of units at a stated scale, so
 * `{ units: 125010n, scale: 2 }` is 1250.10. Never a JS float.
 */
export interface ExactDecimal {
  units: bigint;
  scale: number;
}

/** No real money total needs more; a longer string is refused, not turned into a huge BigInt. */
const MAX_EXACT_DECIMAL_LENGTH = 64;

/**
 * Read a CANONICAL decimal string exactly: the strict counterpart of
 * `parseMoney`, for values a contract states rather than values a file happens
 * to contain.
 *
 * `parseMoney` is lenient on purpose. It reads "₦1,250.10", "1.234,56" and
 * "(12.30)" as real exports write them, and it returns a float. Neither suits
 * a control total, which is agreed in advance and compared for equality:
 * leniency would let a malformed contract value through, and a float cannot
 * promise that two equal totals compare equal.
 *
 * Accepts an optional sign, digits, and a fraction of ANY length, because
 * currencies differ: TND and LYD have three minor-unit digits, JPY none.
 * Returns null for anything else, including a number, which has already been
 * through a float by the time it arrives.
 */
export function parseExactDecimal(raw: unknown): ExactDecimal | null {
  if (typeof raw !== "string" || raw.length > MAX_EXACT_DECIMAL_LENGTH) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const units = BigInt(whole + fraction);
  return { units: sign === "-" ? -units : units, scale: fraction.length };
}

/** Exact equality at any scale: 1250.1, 1250.10 and 1250.100 are one amount. */
export function exactDecimalsEqual(a: ExactDecimal, b: ExactDecimal): boolean {
  const scale = Math.max(a.scale, b.scale);
  return (
    a.units * 10n ** BigInt(scale - a.scale) ===
    b.units * 10n ** BigInt(scale - b.scale)
  );
}

/** Parse a date, returning null (never an Invalid Date) when unreadable. */
export function parseMoneyDate(raw: string | Date | undefined | null): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
