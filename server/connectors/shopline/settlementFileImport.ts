/**
 * Settlement-file import — reconcile against ANY payment system.
 *
 * SHOPLINE Payments is opt-in and approval-gated; merchants may instead use any
 * of ~26 third-party providers, or Cash on Delivery. For those merchants the
 * `/payments/store/*` API returns 404 and there is no automatic payment leg —
 * SHOPLINE simply does not hold their settlement data.
 *
 * The order leg is never the problem: `/orders.json` gives us what the store
 * believes it was paid, by which gateway, with that gateway's reference. What is
 * missing is what actually SETTLED. That is exactly the artefact every gateway,
 * PSP and courier already emits as a CSV/XLSX export, so this module lets the
 * merchant supply it and completes the reconciliation.
 *
 * ── The join that matters ────────────────────────────────────────────────────
 * The retail engine matches the orders channel against the payments channel on
 * `transactionRef`. `normaliseOrder` writes the SHOPLINE order id there, and
 * `normalisePaymentTransaction` writes `seller_order_id` — the order id again.
 * So an imported settlement row MUST carry the ORDER reference in
 * `transactionRef`; the gateway's own id goes to `externalRef`. Mapping the
 * gateway id into `transactionRef` would produce a file that imports cleanly and
 * matches nothing, which is the worst possible outcome — it looks like it worked.
 *
 * Pure functions here (parse / detect / map) are unit-testable without a DB.
 */
import Papa from "papaparse";
import { loadExcelJS } from "../../exceljsLoader";
import type { InsertTransaction } from "../../../drizzle/schema";

/** Fields we try to recover from an arbitrary settlement export. */
export type SettlementField =
  /** The MERCHANT'S order reference — the join key to the orders channel. */
  | "orderRef"
  /** The gateway's own transaction id — evidence, not the join key. */
  | "gatewayRef"
  | "amount"
  | "currency"
  | "settledAt"
  | "fee"
  | "description";

/**
 * Header synonyms drawn from the exports merchants actually send: Stripe,
 * PayPal, Adyen, Paystack, Flutterwave, Razorpay, OceanPayment, plus courier
 * COD remittance sheets. Ordered — earlier entries win, so the most specific
 * and least ambiguous names come first.
 */
export const SETTLEMENT_ALIASES: Record<SettlementField, string[]> = {
  // Deliberately ahead of the generic "reference": on a gateway export,
  // "reference" is usually the GATEWAY's ref, while the order link is explicit.
  orderRef: [
    "order_id", "order_no", "order_number", "order_ref", "order_reference",
    "merchant_order_id", "merchant_order_no", "seller_order_id", "shop_order_id",
    "invoice_id", "invoice_no", "invoice", "cart_id", "checkout_id",
    "merchant_reference", "merchant_ref", "client_reference", "reference_no",
  ],
  gatewayRef: [
    "transaction_id", "txn_id", "transaction_ref", "txn_ref", "charge_id",
    "payment_id", "payment_ref", "gateway_ref", "gateway_transaction_id",
    "psp_reference", "pspreference", "acquirer_reference", "settlement_id",
    "balance_transaction", "id", "reference",
  ],
  amount: [
    "settlement_amount", "settled_amount", "amount_settled", "net_amount", "net",
    "payout_amount", "remitted_amount", "remittance_amount", "amount_paid",
    "paid_amount", "gross_amount", "gross", "amount", "transaction_amount",
    "value", "total", "total_amount",
  ],
  currency: ["currency", "currency_code", "ccy", "settlement_currency"],
  settledAt: [
    "settlement_date", "settled_at", "settled_on", "payout_date", "paid_at",
    "remittance_date", "value_date", "posted_at", "posting_date", "created_at",
    "created", "transaction_date", "date", "datetime", "timestamp",
  ],
  fee: [
    "fee", "fees", "total_fee", "transaction_fee", "processing_fee", "charge",
    "charges", "commission", "mdr", "merchant_discount", "deduction",
  ],
  description: ["description", "narration", "details", "memo", "remarks", "type", "status"],
};

/** Required to produce a matchable row. Everything else is enrichment. */
export const REQUIRED_FIELDS: SettlementField[] = ["orderRef", "amount"];

/** Normalise a header the same way the client-side connectors do. */
export function normalizeHeader(h: string): string {
  return String(h ?? "").trim().toLowerCase().replace(/['"]/g, "").replace(/\s+/g, "_");
}

export interface ParsedFile {
  headers: string[];
  rows: Record<string, string>[];
  parseErrors: string[];
}

const MAX_ROWS = 200_000;

/**
 * Parse a CSV or Excel settlement export into header-keyed rows.
 *
 * Excel is parsed HERE rather than in the browser on purpose: exceljs is a
 * server-only dependency behind `exceljsLoader` (an ESM/CJS interop shim), and
 * pulling it into the client bundle to read a once-a-month file would cost every
 * page load.
 */
export async function parseSettlementFile(
  content: Buffer | string,
  fileName: string,
): Promise<ParsedFile> {
  const isExcel = /\.(xlsx|xlsm|xls)$/i.test(fileName);
  if (!isExcel) {
    const text = typeof content === "string" ? content : content.toString("utf8");
    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });
    const rows = (parsed.data ?? []) as Record<string, string>[];
    assertRowCap(rows.length);
    return {
      headers: parsed.meta?.fields ?? Object.keys(rows[0] ?? {}),
      rows,
      parseErrors: (parsed.errors ?? []).slice(0, 10).map(
        (e) => `row ${typeof e.row === "number" ? e.row + 2 : "?"}: ${e.message}`,
      ),
    };
  }

  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    (typeof content === "string" ? Buffer.from(content, "base64") : content) as never,
  );
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [], parseErrors: ["Workbook contains no worksheets"] };

  const headers: string[] = [];
  const rows: Record<string, string>[] = [];
  ws.eachRow((row, rowNumber) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      values[col - 1] = cellToString(cell);
    });
    if (rowNumber === 1) {
      for (const v of values) headers.push(String(v ?? "").trim());
      return;
    }
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) rec[h] = values[i] ?? ""; });
    // Skip fully blank rows — trailing empties are endemic in exported sheets.
    if (Object.values(rec).some((v) => String(v).trim() !== "")) rows.push(rec);
  });
  assertRowCap(rows.length);
  return { headers, rows, parseErrors: [] };
}

function assertRowCap(n: number): void {
  if (n > MAX_ROWS) {
    throw new Error(`File has ${n.toLocaleString()} rows — split files above ${MAX_ROWS.toLocaleString()}`);
  }
}

/** exceljs cells can be richtext/formula/hyperlink/date objects, not just scalars. */
function cellToString(cell: { value: unknown; text?: string }): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.result === "number" || typeof o.result === "string") return String(o.result);
    if (Array.isArray(o.richText)) return o.richText.map((r) => (r as { text: string }).text).join("");
    if (typeof cell.text === "string") return cell.text;
    return "";
  }
  return String(v);
}

export type ColumnMap = Partial<Record<SettlementField, string>>;

/**
 * Work out which column feeds which field.
 *
 * `overrides` (raw header names supplied by the merchant) always win — detection
 * is a convenience, never a constraint. A gateway with unusual headers must
 * still be importable, which is the whole point of supporting "any" provider.
 */
export function detectColumns(headers: string[], overrides?: ColumnMap): {
  mapping: ColumnMap;
  missingRequired: SettlementField[];
} {
  const byNormalized = new Map<string, string>();
  for (const h of headers) {
    const n = normalizeHeader(h);
    if (n && !byNormalized.has(n)) byNormalized.set(n, h);
  }

  const mapping: ColumnMap = {};
  const claimed = new Set<string>();
  // Apply overrides first so detection cannot steal a column the user assigned.
  for (const [field, header] of Object.entries(overrides ?? {})) {
    if (header && headers.includes(header)) {
      mapping[field as SettlementField] = header;
      claimed.add(header);
    }
  }
  for (const field of Object.keys(SETTLEMENT_ALIASES) as SettlementField[]) {
    if (mapping[field]) continue;
    for (const alias of SETTLEMENT_ALIASES[field]) {
      const actual = byNormalized.get(alias);
      if (actual && !claimed.has(actual)) {
        mapping[field] = actual;
        claimed.add(actual);
        break;
      }
    }
  }
  return {
    mapping,
    missingRequired: REQUIRED_FIELDS.filter((f) => !mapping[f]),
  };
}

/** Money strings in the wild: "1,234.56", "$1,234.56", "(12.30)" for negatives. */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const parenNegative = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "").replace(/[^0-9.,\-]/g, "");

  // Separator disambiguation. Getting this wrong is silently catastrophic:
  // "₦12,000" read as European decimal becomes 12.00 — a 1000x understatement
  // that still looks like a plausible amount.
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Both present: whichever comes last is the decimal separator.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    const parts = s.split(",");
    // Repeated commas, or a final group of exactly 3 digits, means thousands
    // ("12,000"). A 1-2 digit tail means a European decimal ("12,30").
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

export function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Prefer unambiguous ISO; fall back to Date parsing for everything else.
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface MapResult {
  rows: InsertTransaction[];
  failures: Array<{ rowIndex: number; reason: string }>;
}

export interface SettlementMapContext {
  organizationId: number;
  paymentsChannelId: number;
  batchId: number;
  userId: number;
  defaultCurrency: string;
  /** Label recorded on each row so the source of truth is auditable. */
  sourceLabel: string;
}

/**
 * Map parsed rows onto canonical payment-leg transactions.
 *
 * `transactionRef` is the ORDER reference so the engine can match; the gateway's
 * own id is preserved in `externalRef` and `rawData.gatewayRef` for evidence.
 */
export function mapSettlementRows(
  rows: Record<string, string>[],
  mapping: ColumnMap,
  ctx: SettlementMapContext,
): MapResult {
  const out: InsertTransaction[] = [];
  const failures: Array<{ rowIndex: number; reason: string }> = [];

  rows.forEach((row, i) => {
    const rowIndex = i + 2; // 1-based + header
    const orderRef = mapping.orderRef ? String(row[mapping.orderRef] ?? "").trim() : "";
    if (!orderRef) { failures.push({ rowIndex, reason: "missing order reference" }); return; }

    const amount = parseAmount(mapping.amount ? row[mapping.amount] : undefined);
    if (amount === null) { failures.push({ rowIndex, reason: "unparseable amount" }); return; }

    const settledAt = parseDate(mapping.settledAt ? row[mapping.settledAt] : undefined);
    const gatewayRef = mapping.gatewayRef ? String(row[mapping.gatewayRef] ?? "").trim() : "";
    const fee = parseAmount(mapping.fee ? row[mapping.fee] : undefined);
    const currency = (mapping.currency ? String(row[mapping.currency] ?? "").trim() : "") || ctx.defaultCurrency;
    const desc = mapping.description ? String(row[mapping.description] ?? "").trim() : "";

    out.push({
      batchId: ctx.batchId,
      channelId: ctx.paymentsChannelId,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      transactionRef: orderRef,
      externalRef: gatewayRef || null,
      description: desc || `Settlement import (${ctx.sourceLabel})`,
      amount: String(Math.abs(amount)),
      currency: currency.toUpperCase().slice(0, 3),
      transactionDate: settledAt ?? new Date(),
      valueDate: settledAt,
      debitCredit: amount >= 0 ? "credit" : "debit",
      counterparty: ctx.sourceLabel,
      isReversal: amount < 0,
      status: "unmatched",
      rawData: {
        gatewayEventType: amount >= 0 ? "payment" : "refund",
        originalOrderRef: orderRef,
        gatewayRef: gatewayRef || undefined,
        feeAmount: fee ?? undefined,
        importedFrom: ctx.sourceLabel,
      },
    } as InsertTransaction);
  });

  return { rows: out, failures };
}
