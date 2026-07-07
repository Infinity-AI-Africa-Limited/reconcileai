/**
 * Currency-aware formatting and priority thresholds (gap-closure plan WS-6).
 *
 * Shared by the POC engine, the mobile money engine, and any future channel so
 * money formatting and amount-driven priorities agree everywhere. The
 * authoritative currency list is SUPPORTED_CURRENCIES in drizzle/schema.ts.
 */

const CURRENCY_SYMBOL: Record<string, string> = {
  NGN: "₦",
  UGX: "USh ",
  KES: "KSh ",
  GHS: "GH₵",
  ZAR: "R",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** Currencies conventionally displayed without decimal places. */
const ZERO_DECIMAL = new Set(["UGX", "RWF", "XOF", "XAF"]);

export function fmtMoney(n: number, currency = "NGN"): string {
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const digits = ZERO_DECIMAL.has(currency) ? 0 : 2;
  return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// Priority thresholds hold roughly equivalent purchasing power per currency.
// Currencies without an entry fall back to the NGN band — add a row when a
// tenant starts reconciling in that currency.
export const PRIORITY_THRESHOLDS: Record<string, { critical: number; high: number; medium: number }> = {
  NGN: { critical: 500_000, high: 100_000, medium: 10_000 },
  UGX: { critical: 2_000_000, high: 400_000, medium: 40_000 },
  KES: { critical: 50_000, high: 10_000, medium: 1_000 },
  GHS: { critical: 5_000, high: 1_000, medium: 100 },
  ZAR: { critical: 10_000, high: 2_000, medium: 200 },
  USD: { critical: 500, high: 100, medium: 10 },
  EUR: { critical: 500, high: 100, medium: 10 },
  GBP: { critical: 400, high: 80, medium: 8 },
};

export function priorityFor(amount: number, currency = "NGN"): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  const t = PRIORITY_THRESHOLDS[currency] ?? PRIORITY_THRESHOLDS.NGN;
  const abs = Math.abs(amount);
  if (abs >= t.critical) return "CRITICAL";
  if (abs >= t.high) return "HIGH";
  if (abs >= t.medium) return "MEDIUM";
  return "LOW";
}
