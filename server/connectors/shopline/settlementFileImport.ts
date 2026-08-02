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
import type { InsertTransaction } from "../../../drizzle/schema";
import {
  parseTabularFile,
  normalizeHeader,
  parseAmount,
  parseDate,
  resolveColumn,
  type ParsedTable,
} from "../../ingest/fileParser";

// Re-exported so the retail import keeps a single, stable surface even though
// the mechanics now live in the shared ingestion core.
export { normalizeHeader, parseAmount, parseDate };
export type ParsedFile = ParsedTable;

/**
 * Parse a settlement export. Thin alias over the shared tabular parser — the
 * CSV/XLSX mechanics are identical for every inbound path; only the MAPPING
 * below is retail-specific.
 */
export const parseSettlementFile = parseTabularFile;

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
    const actual = resolveColumn(headers, SETTLEMENT_ALIASES[field], claimed);
    if (actual) {
      mapping[field] = actual;
      claimed.add(actual);
    }
  }
  return {
    mapping,
    missingRequired: REQUIRED_FIELDS.filter((f) => !mapping[f]),
  };
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
