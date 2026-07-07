/**
 * Settlement-file connector registry.
 *
 * ReconcileAI ingests CSV exports from many systems. Rather than forcing every
 * institution to hand-map columns, we ship format-aware connectors: when the
 * header row matches a known rail's signature, we apply that rail's column map
 * automatically ("zero mapping, out of the box"). Anything unrecognised falls
 * back to the generic flexible-alias parser, so nothing regresses.
 *
 * IMPORTANT FOR REVIEWERS: the exact NIBSS / Interswitch header names below are
 * based on the common settlement/transaction report exports. They are
 * intentionally config-driven — adjusting a mapping to match a real PTB sample
 * file is a one-line change here, NOT a parser rewrite. Validate against a live
 * sample before the pilot and tweak the `signature` / `aliases` as needed.
 */

export type CanonicalField =
  | "transactionRef"
  | "externalRef"
  | "description"
  | "amount"
  | "currency"
  | "transactionDate"
  | "valueDate"
  | "debitCredit"
  | "counterparty";

export interface ConnectorFormat {
  /** Stable id stored on the upload batch, e.g. "nibss_nip". */
  id: string;
  /** Human label for the UI badge. */
  label: string;
  /** One-line description shown on hover/help. */
  description: string;
  /**
   * Normalized headers that must ALL be present for this format to be detected.
   * Use distinctive columns so the match is unambiguous (avoid false positives).
   */
  signature: string[];
  /** Per-field ordered alias lists (normalized header names) specific to this rail. */
  aliases: Partial<Record<CanonicalField, string[]>>;
}

/** Normalize a raw CSV header the same way the parser does (lowercase, quotes out, spaces → _). */
export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/['"]/g, "").replace(/\s+/g, "_");
}

/**
 * Generic flexible aliases — the long-standing behaviour. Every format also
 * falls back to these, so a known-format file with an extra/renamed column still
 * resolves. The generic format itself has an empty signature (always the floor).
 */
const GENERIC_ALIASES: Record<CanonicalField, string[]> = {
  transactionRef: ["reference", "ref", "transaction_ref", "txn_ref", "transaction_reference"],
  externalRef: ["external_ref", "ext_ref", "counterparty_ref", "session_id"],
  description: ["description", "narration", "memo", "details", "remarks"],
  amount: ["amount", "transaction_amount", "value", "txn_amount"],
  currency: ["currency", "ccy"],
  transactionDate: ["date", "transaction_date", "transactiondate", "txn_date", "posting_date"],
  valueDate: ["value_date", "valuedate", "settlement_date"],
  debitCredit: ["type", "debit_credit", "debitcredit", "direction", "dr_cr"],
  counterparty: ["counterparty", "beneficiary", "sender", "other_party", "account_name"],
};

export const GENERIC_FORMAT: ConnectorFormat = {
  id: "generic",
  label: "Generic CSV",
  description: "Flexible column mapping for any settlement/transaction CSV export.",
  signature: [],
  aliases: GENERIC_ALIASES,
};

/**
 * NIBSS Instant Payments (NIP) settlement / transaction report.
 * Distinctive columns: SESSION_ID + NAME_ENQUIRY_REF (NIP-specific).
 */
export const NIBSS_NIP_FORMAT: ConnectorFormat = {
  id: "nibss_nip",
  label: "NIBSS NIP settlement file",
  description: "NIBSS Instant Payments settlement/transaction report (session-id keyed).",
  signature: ["session_id", "name_enquiry_ref"],
  aliases: {
    amount: ["amount", "amount_debited", "transaction_amount"],
    transactionDate: ["transaction_date", "tran_date_time", "trandatetime", "datetime"],
    transactionRef: ["payment_reference", "transaction_ref", "session_id"],
    externalRef: ["session_id", "name_enquiry_ref"],
    counterparty: ["beneficiary_account_name", "beneficiary_name", "originator_account_name"],
    description: ["narration", "transaction_type"],
    debitCredit: ["transaction_type", "dr_cr"],
    currency: ["currency", "currency_code"],
  },
};

/**
 * Interswitch settlement report (ISO-8583 / Postilion lineage).
 * Distinctive columns: RRN + STAN (retrieval reference + system trace).
 */
export const INTERSWITCH_SETTLEMENT_FORMAT: ConnectorFormat = {
  id: "interswitch_settlement",
  label: "Interswitch settlement file",
  description: "Interswitch card/POS settlement report (RRN + STAN keyed).",
  signature: ["rrn", "stan"],
  aliases: {
    amount: ["transaction_amount", "amount", "settlement_amount"],
    transactionDate: ["transaction_date", "datetime", "date_time", "tran_date"],
    transactionRef: ["rrn", "retrieval_reference_number", "transaction_ref"],
    externalRef: ["stan", "system_trace_audit_number"],
    counterparty: ["merchant_name", "merchant_id", "terminal_id"],
    description: ["narration", "description", "transaction_type"],
    debitCredit: ["dr_cr", "transaction_type"],
    currency: ["currency_code", "currency"],
  },
};

// ─── LAPO multi-source formats (derived from the shared source registry) ─────
// The LAPO integration declares its file shapes once in shared/lapoSources.ts;
// registering them here means the Upload page auto-detects LAPO drops too.
// Split debit/credit ledgers map both columns as `amount` aliases — exactly one
// side is filled per row, so resolveField picks the right value; the LAPO
// server ETL (the recommended path) derives direction from which side is set.
import { LAPO_SOURCES } from "@shared/lapoSources";

const LAPO_FORMATS: ConnectorFormat[] = Object.values(LAPO_SOURCES)
  .filter((s) => !["nibss_nip", "interswitch_settlement"].includes(s.format.id)) // already registered
  .map((s) => ({
    id: s.format.id,
    label: `LAPO — ${s.label}`,
    description: s.systemDescription,
    signature: s.format.signature,
    aliases: {
      transactionRef: s.format.aliases.transactionRef,
      externalRef: s.format.aliases.externalRef,
      description: s.format.aliases.description,
      amount: [
        ...(s.format.aliases.amount ?? []),
        ...(s.format.aliases.amountCredit ?? []),
        ...(s.format.aliases.amountDebit ?? []),
      ],
      currency: s.format.aliases.currency,
      transactionDate: s.format.aliases.transactionDate,
      valueDate: s.format.aliases.valueDate,
      debitCredit: s.format.aliases.debitCredit,
      counterparty: s.format.aliases.counterparty,
    },
  }));

/** Ordered most-specific-first; generic is the implicit fallback (not listed). */
export const CONNECTOR_FORMATS: ConnectorFormat[] = [
  NIBSS_NIP_FORMAT,
  INTERSWITCH_SETTLEMENT_FORMAT,
  ...LAPO_FORMATS,
];

/**
 * Pick the most specific format whose full signature is present in the header
 * row. Ties break toward the longer (more distinctive) signature. Falls back to
 * the generic format when nothing matches.
 */
export function detectFormat(normalizedHeaders: string[]): ConnectorFormat {
  const headerSet = new Set(normalizedHeaders);
  let best: ConnectorFormat = GENERIC_FORMAT;
  let bestScore = 0;
  for (const fmt of CONNECTOR_FORMATS) {
    if (fmt.signature.length === 0) continue;
    const matched = fmt.signature.every((h) => headerSet.has(h));
    if (matched && fmt.signature.length > bestScore) {
      best = fmt;
      bestScore = fmt.signature.length;
    }
  }
  return best;
}

/** Look up a format by id (for per-channel overrides). Returns undefined if unknown. */
export function formatById(id: string | null | undefined): ConnectorFormat | undefined {
  if (!id) return undefined;
  if (id === GENERIC_FORMAT.id) return GENERIC_FORMAT;
  return CONNECTOR_FORMATS.find((f) => f.id === id);
}

/**
 * Resolve a canonical field from a row using the format's aliases first, then
 * the generic aliases as a fallback. Returns "" when no alias is present/filled.
 */
export function resolveField(
  row: Record<string, string>,
  format: ConnectorFormat,
  field: CanonicalField,
): string {
  const lists = [format.aliases[field] ?? [], GENERIC_ALIASES[field]];
  for (const list of lists) {
    for (const key of list) {
      const v = row[key];
      if (v != null && v !== "") return v;
    }
  }
  return "";
}

/** Does this format (incl. generic fallback) have a usable header for the field? */
export function hasField(
  headers: string[],
  format: ConnectorFormat,
  field: CanonicalField,
): boolean {
  const headerSet = new Set(headers);
  const lists = [format.aliases[field] ?? [], GENERIC_ALIASES[field]];
  return lists.some((list) => list.some((key) => headerSet.has(key)));
}
