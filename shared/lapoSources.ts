/**
 * LAPO MFB — source-system registry (deliverable 1: data source mapping).
 *
 * LAPO runs a proprietary core for specific product lines plus the standard
 * Nigerian channel stack. Every transaction-generating system we reconcile is
 * declared here as a config profile: transport, file signature + column
 * aliases, settlement timing, dedupe identity, and matching tolerances.
 *
 * BUILT WITHOUT LAPO TECHNICAL DOCS (none exist yet on our side): shapes are
 * based on (a) the LAPO POC sample files already in the repo
 * (scripts/generate_lapo_samples.py), (b) standard NIBSS NIP settlement report
 * columns, (c) ISO-8583/Postilion-lineage processor settlement layouts
 * (Interswitch/UPSL/eTranzact), and (d) common USSD/mobile/agent recon export
 * conventions. When LAPO hands over real specs, updating a profile here —
 * signature, aliases, timing — is configuration, not a parser rewrite.
 *
 * Shared between server (ETL: server/connectors/lapo/etl.ts) and client
 * (upload auto-detection: client/src/lib/connectors/formats.ts).
 */

export type LapoTransport = "sftp_batch" | "realtime_api" | "both";

export type LapoSourceKey =
  | "cbs_ledger"
  | "mobile_banking"
  | "ussd"
  | "agent_banking"
  | "nibss_nip"
  | "cards_interswitch"
  | "cards_upsl"
  | "cards_etranzact";

export const LAPO_SOURCE_KEYS: LapoSourceKey[] = [
  "cbs_ledger",
  "mobile_banking",
  "ussd",
  "agent_banking",
  "nibss_nip",
  "cards_interswitch",
  "cards_upsl",
  "cards_etranzact",
];

/** Column aliases are normalized: lowercase, quotes stripped, spaces → _ . */
export interface LapoFileFormat {
  /** Stable id stored on upload batches, e.g. "lapo_cbs_ledger". */
  id: string;
  /** Headers that must ALL be present to auto-detect this format. */
  signature: string[];
  aliases: {
    transactionRef?: string[];
    externalRef?: string[];
    description?: string[];
    amount?: string[];
    /** Split-ledger layouts: separate debit/credit amount columns. */
    amountDebit?: string[];
    amountCredit?: string[];
    currency?: string[];
    transactionDate?: string[];
    valueDate?: string[];
    debitCredit?: string[];
    counterparty?: string[];
  };
}

export interface LapoSourceProfile {
  key: LapoSourceKey;
  label: string;
  /** Which system produces it (for the operator, not the machine). */
  systemDescription: string;
  /** channels.channelType value for this source's canonical channel. */
  channelType:
    | "bank_core"
    | "mobile_banking"
    | "ussd"
    | "agent_banking"
    | "nibss"
    | "card_payments";
  transport: LapoTransport;
  /** Daily batch expected? (drives the zero-data-loss completeness check) */
  expectedDailyFile: boolean;
  /** T+N settlement lag between event and file/ledger visibility. */
  settlementLagDays: number;
  /** Local cutoff hour (Africa/Lagos) after which events roll to next batch. */
  cutoffHourLocal: number;
  /**
   * Matching tolerances for reconciliation jobs against the unified ledger —
   * deliverable 3 (cross-channel timing differences). dateWindowDays covers
   * the settlement lag + one day of cutoff drift.
   */
  matching: { amountTolerancePct: number; dateWindowDays: number };
  /** Which fields make a row's stable identity (dedupe/externalRef). */
  identityFields: string[];
  format: LapoFileFormat;
  /** Direction semantics when no explicit debit/credit column exists. */
  defaultDirection?: "debit" | "credit";
  regulatoryNote: string;
}

// ─── The eight source systems ────────────────────────────────────────────────
export const LAPO_SOURCES: Record<LapoSourceKey, LapoSourceProfile> = {
  // The unified ledger — the side every channel reconciles AGAINST.
  cbs_ledger: {
    key: "cbs_ledger",
    label: "CBS Unified Ledger",
    systemDescription: "Proprietary core banking ledger export (all product lines).",
    channelType: "bank_core",
    transport: "sftp_batch",
    expectedDailyFile: true,
    settlementLagDays: 0,
    cutoffHourLocal: 23,
    matching: { amountTolerancePct: 0, dateWindowDays: 1 },
    identityFields: ["reference"],
    format: {
      id: "lapo_cbs_ledger",
      // Mirrors scripts/generate_lapo_samples.py (the POC's live shape).
      signature: ["narration", "debit_(ngn)", "credit_(ngn)"],
      aliases: {
        transactionRef: ["reference", "transaction_reference", "tran_id"],
        transactionDate: ["transaction_date", "tran_date", "posting_date"],
        valueDate: ["value_date"],
        description: ["narration", "description"],
        amountDebit: ["debit_(ngn)", "debit", "debit_amount", "dr_amount"],
        amountCredit: ["credit_(ngn)", "credit", "credit_amount", "cr_amount"],
        counterparty: ["channel", "account_name", "terminal_id"],
        currency: ["currency", "ccy"],
      },
    },
    regulatoryNote:
      "Ledger integrity underpins every CBN return; unexplained ledger orphans age into the MFB unreconciled-items schedule.",
  },

  mobile_banking: {
    key: "mobile_banking",
    label: "Mobile Banking",
    systemDescription: "LAPO mobile app transactions (transfers, airtime, bills).",
    channelType: "mobile_banking",
    transport: "both",
    expectedDailyFile: true,
    settlementLagDays: 0,
    cutoffHourLocal: 23,
    matching: { amountTolerancePct: 0, dateWindowDays: 1 },
    identityFields: ["transaction_id"],
    format: {
      id: "lapo_mobile_banking",
      signature: ["transaction_id", "wallet_id"],
      aliases: {
        transactionRef: ["transaction_id", "txn_id", "reference"],
        externalRef: ["transaction_id", "session_ref"],
        transactionDate: ["transaction_date", "datetime", "created_at"],
        amount: ["amount", "transaction_amount"],
        debitCredit: ["type", "transaction_type", "dr_cr"],
        counterparty: ["wallet_id", "account_number", "beneficiary"],
        description: ["narration", "description", "service"],
        currency: ["currency"],
      },
    },
    regulatoryNote:
      "CBN Consumer Protection: failed digital debits must reverse within 24h — feeds lapo_failed_debit_unreversed exceptions.",
  },

  ussd: {
    key: "ussd",
    label: "USSD (*371#-class sessions)",
    systemDescription: "USSD gateway transaction log (session-based).",
    channelType: "ussd",
    transport: "both",
    expectedDailyFile: true,
    settlementLagDays: 0,
    cutoffHourLocal: 23,
    matching: { amountTolerancePct: 0, dateWindowDays: 1 },
    identityFields: ["session_id"],
    format: {
      id: "lapo_ussd",
      signature: ["session_id", "msisdn"],
      aliases: {
        transactionRef: ["session_id", "reference"],
        externalRef: ["session_id"],
        transactionDate: ["transaction_date", "session_time", "datetime"],
        amount: ["amount", "transaction_amount"],
        debitCredit: ["type", "transaction_type"],
        counterparty: ["msisdn", "phone", "account_number"],
        description: ["service", "menu_option", "narration"],
        currency: ["currency"],
      },
    },
    defaultDirection: "debit",
    regulatoryNote:
      "USSD session timeouts with successful debits are the highest-volume MFB complaint class (CBN 24h reversal rule).",
  },

  agent_banking: {
    key: "agent_banking",
    label: "Agent Banking Network",
    systemDescription: "Agent/POS agency transactions (cash-in/cash-out, float).",
    channelType: "agent_banking",
    transport: "sftp_batch",
    expectedDailyFile: true,
    settlementLagDays: 1,
    cutoffHourLocal: 22,
    matching: { amountTolerancePct: 0, dateWindowDays: 2 },
    identityFields: ["agent_id", "reference"],
    format: {
      id: "lapo_agent_banking",
      signature: ["agent_id", "agent_name"],
      aliases: {
        transactionRef: ["reference", "transaction_ref", "receipt_no"],
        externalRef: ["reference", "terminal_ref"],
        transactionDate: ["transaction_date", "datetime"],
        amount: ["amount", "transaction_amount"],
        debitCredit: ["type", "transaction_type", "dr_cr"],
        counterparty: ["agent_id", "agent_name", "customer_account"],
        description: ["narration", "service_type"],
        currency: ["currency"],
      },
    },
    regulatoryNote:
      "CBN agent-banking guidelines require daily agent-float reconciliation; float mismatches feed lapo_agent_float_mismatch.",
  },

  nibss_nip: {
    key: "nibss_nip",
    label: "NIBSS NIP (inward + outward)",
    systemDescription: "NIBSS Instant Payments settlement report + realtime notifications.",
    channelType: "nibss",
    transport: "both",
    expectedDailyFile: true,
    settlementLagDays: 0,
    cutoffHourLocal: 23,
    matching: { amountTolerancePct: 0, dateWindowDays: 1 },
    identityFields: ["session_id"],
    format: {
      // Same signature as the platform-wide nibss_nip connector format — one
      // NIP truth everywhere (client formats.ts detects it identically).
      id: "nibss_nip",
      signature: ["session_id", "name_enquiry_ref"],
      aliases: {
        transactionRef: ["payment_reference", "transaction_ref", "session_id"],
        externalRef: ["session_id"],
        transactionDate: ["transaction_date", "tran_date_time", "datetime"],
        amount: ["amount", "amount_debited", "transaction_amount"],
        debitCredit: ["transaction_type", "dr_cr", "direction"],
        counterparty: ["beneficiary_account_name", "originator_account_name"],
        description: ["narration", "transaction_type"],
        currency: ["currency", "currency_code"],
      },
    },
    regulatoryNote:
      "NIP failed-but-debited must auto-reverse T+1 (CBN/NIBSS operating rules); unsettled inward NIP is a daily exposure item.",
  },

  cards_interswitch: {
    key: "cards_interswitch",
    label: "Cards — Interswitch",
    systemDescription: "Interswitch settlement report (POS/ATM/web card transactions).",
    channelType: "card_payments",
    transport: "sftp_batch",
    expectedDailyFile: true,
    settlementLagDays: 1,
    cutoffHourLocal: 0,
    matching: { amountTolerancePct: 0.005, dateWindowDays: 2 },
    identityFields: ["rrn", "stan"],
    format: {
      id: "interswitch_settlement", // matches the existing platform connector
      signature: ["rrn", "stan"],
      aliases: {
        transactionRef: ["rrn", "retrieval_reference_number"],
        externalRef: ["stan", "system_trace_audit_number"],
        transactionDate: ["transaction_date", "datetime", "tran_date"],
        valueDate: ["settlement_date"],
        amount: ["settlement_amount_(ngn)", "net_settlement_(ngn)", "transaction_amount_(ngn)", "transaction_amount", "settlement_amount", "amount"],
        debitCredit: ["dr_cr", "transaction_type"],
        counterparty: ["merchant_name", "terminal_id", "merchant_id"],
        description: ["transaction_type", "narration", "card_type"],
        currency: ["currency_code", "currency"],
      },
    },
    defaultDirection: "credit",
    regulatoryNote:
      "T+1 net settlement with interchange/scheme fee deductions — gross-vs-net variance feeds lapo_card_settlement_short.",
  },

  cards_upsl: {
    key: "cards_upsl",
    label: "Cards — Unified Payments (UPSL)",
    systemDescription: "UPSL settlement report (card transactions).",
    channelType: "card_payments",
    transport: "sftp_batch",
    expectedDailyFile: true,
    settlementLagDays: 1,
    cutoffHourLocal: 0,
    matching: { amountTolerancePct: 0.005, dateWindowDays: 2 },
    identityFields: ["rrn", "stan"],
    format: {
      id: "lapo_upsl_settlement",
      // Same ISO-8583 lineage as Interswitch but distinguished by the
      // UPSL-style acquirer column so detection is unambiguous.
      signature: ["rrn", "acquirer_institution"],
      aliases: {
        transactionRef: ["rrn", "retrieval_reference_number"],
        externalRef: ["stan", "trace_number"],
        transactionDate: ["transaction_date", "tran_date"],
        valueDate: ["settlement_date"],
        amount: ["net_settlement", "settlement_amount", "transaction_amount", "amount"],
        debitCredit: ["dr_cr", "transaction_type"],
        counterparty: ["merchant_name", "terminal_id", "acquirer_institution"],
        description: ["transaction_type", "card_scheme"],
        currency: ["currency", "currency_code"],
      },
    },
    defaultDirection: "credit",
    regulatoryNote: "Same T+1 net-settlement semantics as Interswitch; per-processor fee tables differ.",
  },

  cards_etranzact: {
    key: "cards_etranzact",
    label: "Cards — eTranzact",
    systemDescription: "eTranzact settlement report (card/switch transactions).",
    channelType: "card_payments",
    transport: "sftp_batch",
    expectedDailyFile: false, // volume-dependent; files arrive on activity days
    settlementLagDays: 1,
    cutoffHourLocal: 0,
    matching: { amountTolerancePct: 0.005, dateWindowDays: 2 },
    identityFields: ["transaction_ref"],
    format: {
      id: "lapo_etranzact_settlement",
      signature: ["etz_ref", "transaction_ref"],
      aliases: {
        transactionRef: ["transaction_ref", "etz_ref"],
        externalRef: ["etz_ref", "trace_id"],
        transactionDate: ["transaction_date", "datetime"],
        valueDate: ["settlement_date"],
        amount: ["net_amount", "settlement_amount", "amount"],
        debitCredit: ["dr_cr", "type"],
        counterparty: ["merchant", "terminal_id"],
        description: ["transaction_type", "narration"],
        currency: ["currency"],
      },
    },
    defaultDirection: "credit",
    regulatoryNote: "Lower-volume processor; completeness checked on activity days only.",
  },
};

export function getLapoSource(key: string): LapoSourceProfile | null {
  return (LAPO_SOURCES as Record<string, LapoSourceProfile>)[key] ?? null;
}

/** Channel code for a source's canonical channel: LAPO_<SRC>_<orgId>. */
export function lapoChannelCode(key: LapoSourceKey, organizationId: number): string {
  return `LAPO_${key.toUpperCase()}_${organizationId}`;
}

/** Stable dedupe identity, namespaced per source: lapo:<src>:<id parts>. */
export function lapoExternalRef(key: LapoSourceKey, idParts: Array<string | null | undefined>): string | null {
  const parts = idParts.map((p) => (p ?? "").trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return `lapo:${key}:${parts.join(":")}`;
}
