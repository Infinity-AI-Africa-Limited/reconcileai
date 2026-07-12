/**
 * Uganda market pack — source-system registry (validation gap G1).
 *
 * The rails a Ugandan bank/MFI/PSP reconciles, per the market-entry research
 * (docs/market/NG_UG_RECONCILIATION_VALIDATION.md): mobile money is the
 * economy's rail (MTN MoMo + Airtel Money), agent banking runs on ONE shared
 * rail (Agent Banking Company of Uganda — every bank plugs into it), and the
 * defining risks are trust-account backing (BoU NPS Act: e-money must be
 * 1:1 backed), suspense-account integrity (the MTN internal-fraud class), and
 * float trapped in 24–48h inter-network settlement.
 *
 * BUILT WITHOUT CLIENT DOCS: file shapes follow common Ugandan statement/
 * settlement-report conventions and are config — when the first Ugandan
 * client shares real samples, updating signatures/aliases here is a
 * configuration change, not a parser rewrite. Pattern-sibling of
 * shared/lapoSources.ts (the LAPO pack).
 */

export type UgandaTransport = "sftp_batch" | "realtime_api" | "both";

export type UgandaSourceKey =
  | "cbs_ledger"
  | "mtn_momo"
  | "airtel_money"
  | "abc_agent_rail"
  | "uniss_rtgs"
  | "ach_eft"
  | "card_switch"
  | "trust_account";

export const UGANDA_SOURCE_KEYS: UgandaSourceKey[] = [
  "cbs_ledger",
  "mtn_momo",
  "airtel_money",
  "abc_agent_rail",
  "uniss_rtgs",
  "ach_eft",
  "card_switch",
  "trust_account",
];

/** Column aliases normalized: lowercase, quotes stripped, spaces → _ . */
export interface UgandaFileFormat {
  id: string;
  signature: string[];
  aliases: {
    transactionRef?: string[];
    externalRef?: string[];
    description?: string[];
    amount?: string[];
    amountDebit?: string[];
    amountCredit?: string[];
    currency?: string[];
    transactionDate?: string[];
    valueDate?: string[];
    debitCredit?: string[];
    counterparty?: string[];
  };
}

export interface UgandaSourceProfile {
  key: UgandaSourceKey;
  label: string;
  systemDescription: string;
  channelType:
    | "bank_core"
    | "mobile_money"
    | "agent_banking"
    | "rtgs"
    | "bank_transfer"
    | "card_payments";
  transport: UgandaTransport;
  expectedDailyFile: boolean;
  /** Settlement lag between event and file/ledger visibility (the 24–48h problem). */
  settlementLagDays: number;
  cutoffHourLocal: number; // Africa/Kampala (UTC+3), display-side only
  matching: { amountTolerancePct: number; dateWindowDays: number };
  identityFields: string[];
  format: UgandaFileFormat;
  defaultDirection?: "debit" | "credit";
  regulatoryNote: string;
}

export const UGANDA_SOURCES: Record<UgandaSourceKey, UgandaSourceProfile> = {
  cbs_ledger: {
    key: "cbs_ledger",
    label: "CBS Ledger (UGX)",
    systemDescription: "The institution's core banking ledger export — the side every rail reconciles against.",
    channelType: "bank_core",
    transport: "sftp_batch",
    expectedDailyFile: true,
    settlementLagDays: 0,
    cutoffHourLocal: 23,
    matching: { amountTolerancePct: 0, dateWindowDays: 1 },
    identityFields: ["reference"],
    format: {
      id: "ug_cbs_ledger",
      signature: ["narration", "debit_(ugx)", "credit_(ugx)"],
      aliases: {
        transactionRef: ["reference", "transaction_reference", "tran_id"],
        transactionDate: ["transaction_date", "tran_date", "posting_date"],
        valueDate: ["value_date"],
        description: ["narration", "description"],
        amountDebit: ["debit_(ugx)", "debit", "debit_amount", "dr_amount"],
        amountCredit: ["credit_(ugx)", "credit", "credit_amount", "cr_amount"],
        counterparty: ["channel", "account_name", "account_no"],
        currency: ["currency", "ccy"],
      },
    },
    regulatoryNote:
      "Ledger orphans age into examination findings; unexplained wallet-side liabilities without ledger legs are the e-money-minting fraud precursor (ug_wallet_liability_orphan).",
  },

  mtn_momo: {
    key: "mtn_momo",
    label: "MTN MoMo",
    systemDescription: "MTN Mobile Money wallet↔bank flows: daily settlement statement + realtime notifications.",
    channelType: "mobile_money",
    transport: "both",
    expectedDailyFile: true,
    settlementLagDays: 1, // inter-network settlement runs 24–48h
    cutoffHourLocal: 23,
    matching: { amountTolerancePct: 0, dateWindowDays: 2 },
    identityFields: ["transaction_id"],
    format: {
      id: "ug_mtn_momo",
      signature: ["transaction_id", "msisdn"],
      aliases: {
        transactionRef: ["transaction_id", "financial_transaction_id", "reference"],
        externalRef: ["transaction_id", "external_id"],
        transactionDate: ["transaction_date", "datetime", "completion_time"],
        amount: ["amount", "transaction_amount"],
        debitCredit: ["type", "transaction_type", "direction"],
        counterparty: ["msisdn", "phone", "account_number", "party_id"],
        description: ["narration", "reason", "service"],
        currency: ["currency"],
      },
    },
    regulatoryNote:
      "BoU NPS Act 2020 licenses the issuer; the historic MTN loss came from suspense-account manipulation during settlement — suspense entries from this rail feed ug_suspense_aged_entry.",
  },

  airtel_money: {
    key: "airtel_money",
    label: "Airtel Money",
    systemDescription: "Airtel Money wallet↔bank flows: daily settlement statement + realtime notifications.",
    channelType: "mobile_money",
    transport: "both",
    expectedDailyFile: true,
    settlementLagDays: 1,
    cutoffHourLocal: 23,
    matching: { amountTolerancePct: 0, dateWindowDays: 2 },
    identityFields: ["transaction_id"],
    format: {
      id: "ug_airtel_money",
      signature: ["transaction_id", "airtel_money_id"],
      aliases: {
        transactionRef: ["transaction_id", "airtel_money_id", "reference"],
        externalRef: ["transaction_id"],
        transactionDate: ["transaction_date", "datetime"],
        amount: ["amount", "transaction_amount"],
        debitCredit: ["type", "transaction_type"],
        counterparty: ["msisdn", "phone", "account_number"],
        description: ["narration", "service"],
        currency: ["currency"],
      },
    },
    regulatoryNote: "Same NPS framework and interoperability lag class as MTN MoMo.",
  },

  abc_agent_rail: {
    key: "abc_agent_rail",
    label: "ABC Shared Agent Rail",
    systemDescription:
      "Agent Banking Company of Uganda — the UBA-owned shared agent platform all banks plug into. Daily settlement file per member bank.",
    channelType: "agent_banking",
    transport: "sftp_batch",
    expectedDailyFile: true,
    settlementLagDays: 1,
    cutoffHourLocal: 22,
    matching: { amountTolerancePct: 0, dateWindowDays: 2 },
    identityFields: ["agent_id", "reference"],
    format: {
      id: "ug_abc_agent_rail",
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
      "Financial Institutions (Agent Banking) Regulations 2017: daily agent settlement/float reconciliation against the SHARED rail — the multi-bank rail makes per-bank position errors systemic, not local.",
  },

  uniss_rtgs: {
    key: "uniss_rtgs",
    label: "UNISS (RTGS)",
    systemDescription: "Bank of Uganda UNISS real-time gross settlement — high-value/interbank positions.",
    channelType: "rtgs",
    transport: "sftp_batch",
    expectedDailyFile: true,
    settlementLagDays: 0,
    cutoffHourLocal: 16,
    matching: { amountTolerancePct: 0, dateWindowDays: 1 },
    identityFields: ["settlement_reference"],
    format: {
      id: "ug_uniss_rtgs",
      signature: ["settlement_reference", "counterparty_bank"],
      aliases: {
        transactionRef: ["settlement_reference", "reference", "trn_ref"],
        transactionDate: ["settlement_date", "value_date", "transaction_date"],
        amount: ["amount", "settlement_amount"],
        debitCredit: ["dr_cr", "direction", "type"],
        counterparty: ["counterparty_bank", "beneficiary_bank"],
        description: ["narration", "details"],
        currency: ["currency"],
      },
    },
    regulatoryNote: "BoU settlement-account position must reconcile daily; UNISS breaks are same-day escalation items.",
  },

  ach_eft: {
    key: "ach_eft",
    label: "ACH / EFT Clearing",
    systemDescription: "Uganda clearing house EFT/cheque batches (T+1/T+2), including returns.",
    channelType: "bank_transfer",
    transport: "sftp_batch",
    expectedDailyFile: true,
    settlementLagDays: 2,
    cutoffHourLocal: 15,
    matching: { amountTolerancePct: 0, dateWindowDays: 3 },
    identityFields: ["batch_id", "item_ref"],
    format: {
      id: "ug_ach_eft",
      signature: ["batch_id", "item_ref"],
      aliases: {
        transactionRef: ["item_ref", "reference"],
        externalRef: ["batch_id", "item_ref"],
        transactionDate: ["clearing_date", "transaction_date"],
        valueDate: ["value_date", "settlement_date"],
        amount: ["amount"],
        debitCredit: ["dr_cr", "type"],
        counterparty: ["counterparty_bank", "account_name"],
        description: ["narration", "return_reason"],
        currency: ["currency"],
      },
    },
    regulatoryNote: "Unprocessed clearing RETURNS are silent double-credits — feed ug_ach_return_unprocessed.",
  },

  card_switch: {
    key: "card_switch",
    label: "Card Switch (Interswitch EA)",
    systemDescription: "Card/POS/ATM switch settlement report (Interswitch East Africa lineage: RRN/STAN keyed).",
    channelType: "card_payments",
    transport: "sftp_batch",
    expectedDailyFile: false,
    settlementLagDays: 1,
    cutoffHourLocal: 0,
    matching: { amountTolerancePct: 0.005, dateWindowDays: 2 },
    identityFields: ["rrn", "stan"],
    format: {
      id: "ug_card_switch",
      signature: ["rrn", "stan"],
      aliases: {
        transactionRef: ["rrn", "retrieval_reference_number"],
        externalRef: ["stan"],
        transactionDate: ["transaction_date", "tran_date"],
        valueDate: ["settlement_date"],
        amount: ["settlement_amount", "transaction_amount", "amount"],
        debitCredit: ["dr_cr", "transaction_type"],
        counterparty: ["terminal_id", "merchant_name"],
        description: ["transaction_type", "narration"],
        currency: ["currency", "currency_code"],
      },
    },
    defaultDirection: "credit",
    regulatoryNote: "T+1 net settlement with interchange deductions — variance feeds ug_card_switch_variance.",
  },

  trust_account: {
    key: "trust_account",
    label: "E-Money Trust Account",
    systemDescription:
      "Custodian-bank statement of the e-money trust/settlement account — the balance that must back wallet liabilities 1:1.",
    channelType: "bank_core",
    transport: "sftp_batch",
    expectedDailyFile: true,
    settlementLagDays: 0,
    cutoffHourLocal: 23,
    matching: { amountTolerancePct: 0, dateWindowDays: 1 },
    identityFields: ["reference"],
    format: {
      id: "ug_trust_account",
      signature: ["trust_account_no", "narration"],
      aliases: {
        transactionRef: ["reference", "transaction_reference"],
        transactionDate: ["transaction_date", "posting_date"],
        valueDate: ["value_date"],
        amountDebit: ["debit_(ugx)", "debit", "dr_amount"],
        amountCredit: ["credit_(ugx)", "credit", "cr_amount"],
        counterparty: ["trust_account_no", "account_name"],
        description: ["narration"],
        currency: ["currency"],
      },
    },
    regulatoryNote:
      "BoU NPS Act 2020: issued e-money must be fully backed by the trust account. Wallet-liability vs trust-balance variance (ug_trust_account_mismatch) is THE licence-threatening exception class.",
  },
};

export function getUgandaSource(key: string): UgandaSourceProfile | null {
  return (UGANDA_SOURCES as Record<string, UgandaSourceProfile>)[key] ?? null;
}

/** Channel code per source: UG_<SRC>_<orgId>. */
export function ugandaChannelCode(key: UgandaSourceKey, organizationId: number): string {
  return `UG_${key.toUpperCase()}_${organizationId}`;
}

/** Stable dedupe identity, namespaced per rail: ug:<src>:<id parts>. */
export function ugandaExternalRef(key: UgandaSourceKey, idParts: Array<string | null | undefined>): string | null {
  const parts = idParts.map((p) => (p ?? "").trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return `ug:${key}:${parts.join(":")}`;
}
