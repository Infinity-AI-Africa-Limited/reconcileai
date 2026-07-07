/**
 * CBS connector registry — one profile per core-banking platform.
 *
 * The WoodCore connector proved the engine (auth manager, retrying client,
 * webhook receiver, batch sync, DLQ, health, canonical ingest). Every other
 * CBS runs on that SAME engine; what differs per platform lives here:
 *
 *   - default auth mode + API-key header name
 *   - default endpoint paths (always overridable per org via endpointsJson)
 *   - default API field mappings   (payload → canonical, per entity)
 *   - default CSV field mappings   (fallback import when no API access yet)
 *
 * Like WoodCore, the T24/Mambu/Flexcube profiles are built from our
 * understanding of each platform's API conventions — every path and mapping
 * is configuration, so vendor docs land as config changes, not code.
 *
 * Entity model is shared: savings_transaction (deposit/current accounts),
 * loan_transaction, journal_entry (GL). Canonical dedupe keys are namespaced
 * per entity, so the same engine serves every CBS.
 */
import type { WcEndpoints, WcEntity } from "../woodcore/types";
import { DEFAULT_ENDPOINTS as WOODCORE_ENDPOINTS } from "../woodcore/types";
import { DEFAULT_MAPPINGS as WOODCORE_API_MAPPINGS, type MappingRule } from "../woodcore/mapping";

export type CbsType = "woodcore" | "t24" | "mambu" | "flexcube" | "lapo";

export const CBS_TYPES: CbsType[] = ["woodcore", "t24", "mambu", "flexcube", "lapo"];

export interface CbsProfile {
  type: CbsType;
  label: string;
  vendor: string;
  /** organizations.onboardingChannel value stamped by this connector. */
  onboardingChannel: string;
  /** Canonical channels row: code prefix (per-org suffix appended) + display name. */
  channelCodePrefix: string;
  channelName: string;
  defaultAuthMode: "oauth2" | "api_key" | "basic";
  defaultApiKeyHeader: string;
  defaultTenantId: string;
  defaultEndpoints: WcEndpoints;
  /** API payload → canonical, per entity. */
  apiMappings: Record<WcEntity, MappingRule[]>;
  /** CSV column → canonical, per entity (fallback import). */
  csvMappings: Record<WcEntity, MappingRule[]>;
  /** Shown in the UI under the connector name. */
  notes: string;
  /**
   * Hidden from the "Via Core Banking Connector" onboarding picker. LAPO is
   * not a core-banking VENDOR — it's a direct client whose custom channel pack
   * is added during DIRECT onboarding. The profile still exists in the registry
   * (its connector config, webhook routing and DLQ rely on cbsType), it just
   * doesn't appear as a CBS option.
   */
  pickerHidden?: boolean;
}

// ─── WoodCore (Apache Fineract) — the proven original ───────────────────────
const woodcoreCsv: Record<WcEntity, MappingRule[]> = {
  savings_transaction: [
    { target: "externalId", source: "transaction_id", transform: "string" },
    { target: "typeEnum", source: "transaction_type_enum", transform: "number" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "currency_code", default: "NGN" },
    { target: "transactionDate", source: "transaction_date", transform: "wcDate" },
    { target: "transactionRef", source: "receipt_number", transform: "string" },
    { target: "counterparty", source: "account_no", transform: "string" },
    { target: "isReversal", source: "is_reversed", transform: "boolean", default: false },
  ],
  loan_transaction: [
    { target: "externalId", source: "transaction_id", transform: "string" },
    { target: "typeEnum", source: "transaction_type_enum", transform: "number" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "currency_code", default: "NGN" },
    { target: "transactionDate", source: "transaction_date", transform: "wcDate" },
    { target: "counterparty", source: "loan_account_no", transform: "string" },
    { target: "isReversal", source: "is_reversed", transform: "boolean", default: false },
  ],
  journal_entry: [
    { target: "externalId", source: "entry_id", transform: "string" },
    { target: "typeEnum", source: "type_enum", transform: "number" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "currency_code", default: "NGN" },
    { target: "transactionDate", source: "entry_date", transform: "wcDate" },
    { target: "transactionRef", source: "transaction_id", transform: "string" },
    { target: "counterparty", source: "gl_code", transform: "string" },
    { target: "isReversal", source: "reversed", transform: "boolean", default: false },
  ],
};

// ─── Temenos T24 / Transact (IRIS-style REST) ────────────────────────────────
// Convention basis: Temenos IRIS R18+ exposes /party/accounts/{id}/transactions
// with bookingDate, amount, currency, transactionReference, narrative and a
// creditDebitIndicator of "CREDIT"/"DEBIT".
const t24Api: Record<WcEntity, MappingRule[]> = {
  savings_transaction: [
    { target: "externalId", source: "transactionId", transform: "string" },
    { target: "typeLabel", source: "transactionName", transform: "string" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "currency", default: "NGN" },
    { target: "debitCredit", source: "creditDebitIndicator", transform: "directionWord" },
    { target: "transactionDate", source: "bookingDate", transform: "wcDate" },
    { target: "valueDate", source: "valueDate", transform: "wcDate" },
    { target: "transactionRef", source: "transactionReference", transform: "string" },
    { target: "counterparty", source: "accountId", transform: "string" },
    { target: "description", source: "narrative", transform: "string" },
    { target: "isReversal", source: "reversalIndicator", transform: "boolean", default: false },
  ],
  loan_transaction: [
    { target: "externalId", source: "transactionId", transform: "string" },
    { target: "typeLabel", source: "activityName", transform: "string" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "currency", default: "NGN" },
    { target: "debitCredit", source: "creditDebitIndicator", transform: "directionWord" },
    { target: "transactionDate", source: "bookingDate", transform: "wcDate" },
    { target: "transactionRef", source: "transactionReference", transform: "string" },
    { target: "counterparty", source: "arrangementId", transform: "string" },
    { target: "description", source: "narrative", transform: "string" },
    { target: "isReversal", source: "reversalIndicator", transform: "boolean", default: false },
  ],
  journal_entry: [
    { target: "externalId", source: "entryId", transform: "string" },
    { target: "typeLabel", source: "transactionCode", transform: "string" },
    { target: "amount", source: "amountLcy", transform: "absAmount" },
    { target: "currency", source: "currency", default: "NGN" },
    { target: "debitCredit", source: "creditDebitIndicator", transform: "directionWord" },
    { target: "transactionDate", source: "bookingDate", transform: "wcDate" },
    { target: "transactionRef", source: "transactionReference", transform: "string" },
    { target: "counterparty", source: "accountNumber", transform: "string" },
    { target: "description", source: "narrative", transform: "string" },
    { target: "isReversal", source: "reversalIndicator", transform: "boolean", default: false },
  ],
};

const t24Csv: Record<WcEntity, MappingRule[]> = {
  savings_transaction: [
    { target: "externalId", source: "TRANS.ID", transform: "string" },
    { target: "typeLabel", source: "TXN.TYPE", transform: "string" },
    { target: "amount", source: "AMOUNT", transform: "absAmount" },
    { target: "currency", source: "CURRENCY", default: "NGN" },
    { target: "debitCredit", source: "DR.CR.MARKER", transform: "directionWord" },
    { target: "transactionDate", source: "BOOKING.DATE", transform: "wcDate" },
    { target: "valueDate", source: "VALUE.DATE", transform: "wcDate" },
    { target: "transactionRef", source: "TRANS.REFERENCE", transform: "string" },
    { target: "counterparty", source: "ACCOUNT.NO", transform: "string" },
    { target: "description", source: "NARRATIVE", transform: "string" },
  ],
  loan_transaction: [
    { target: "externalId", source: "TRANS.ID", transform: "string" },
    { target: "typeLabel", source: "ACTIVITY", transform: "string" },
    { target: "amount", source: "AMOUNT", transform: "absAmount" },
    { target: "currency", source: "CURRENCY", default: "NGN" },
    { target: "debitCredit", source: "DR.CR.MARKER", transform: "directionWord" },
    { target: "transactionDate", source: "BOOKING.DATE", transform: "wcDate" },
    { target: "counterparty", source: "ARRANGEMENT.ID", transform: "string" },
    { target: "description", source: "NARRATIVE", transform: "string" },
  ],
  journal_entry: [
    { target: "externalId", source: "STMT.ID", transform: "string" },
    { target: "typeLabel", source: "TRANSACTION.CODE", transform: "string" },
    { target: "amount", source: "AMOUNT.LCY", transform: "absAmount" },
    { target: "currency", source: "CURRENCY", default: "NGN" },
    { target: "debitCredit", source: "DR.CR.MARKER", transform: "directionWord" },
    { target: "transactionDate", source: "BOOKING.DATE", transform: "wcDate" },
    { target: "transactionRef", source: "OUR.REFERENCE", transform: "string" },
    { target: "counterparty", source: "PL.CATEGORY", transform: "string" },
    { target: "description", source: "NARRATIVE", transform: "string" },
  ],
};

// ─── Mambu (cloud SaaS, REST v2) ─────────────────────────────────────────────
// Convention basis: Mambu API v2 /deposits/{id}/transactions and
// /loans/{id}/transactions return typed transactions with string `type`
// (DEPOSIT, WITHDRAWAL, FEE_APPLIED, INTEREST_APPLIED, DISBURSEMENT,
// REPAYMENT, …), ISO-8601 dates, and an `encodedKey` id. GL journal entries
// via /gljournalentries with entryType DEBIT/CREDIT.
const mambuApi: Record<WcEntity, MappingRule[]> = {
  savings_transaction: [
    { target: "externalId", source: "encodedKey", transform: "string" },
    { target: "typeLabel", source: "type", transform: "string" },
    { target: "debitCredit", source: "type", transform: "typeWordDirection" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "currencyCode", default: "NGN" },
    { target: "transactionDate", source: "valueDate", transform: "wcDate" },
    { target: "valueDate", source: "creationDate", transform: "wcDate" },
    { target: "transactionRef", source: "id", transform: "string" },
    { target: "counterparty", source: "parentAccountKey", transform: "string" },
    { target: "description", source: "notes", transform: "string" },
    { target: "isReversal", source: "adjustmentTransactionKey", transform: "presentAsBool", default: false },
  ],
  loan_transaction: [
    { target: "externalId", source: "encodedKey", transform: "string" },
    { target: "typeLabel", source: "type", transform: "string" },
    { target: "debitCredit", source: "type", transform: "typeWordDirection" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "currencyCode", default: "NGN" },
    { target: "transactionDate", source: "valueDate", transform: "wcDate" },
    { target: "transactionRef", source: "id", transform: "string" },
    { target: "counterparty", source: "parentAccountKey", transform: "string" },
    { target: "description", source: "notes", transform: "string" },
    { target: "isReversal", source: "adjustmentTransactionKey", transform: "presentAsBool", default: false },
  ],
  journal_entry: [
    { target: "externalId", source: "entryId", transform: "string" },
    { target: "typeLabel", source: "type", transform: "string" },
    { target: "debitCredit", source: "type", transform: "directionWord" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "glAccount.currency.code", default: "NGN" },
    { target: "transactionDate", source: "bookingDate", transform: "wcDate" },
    { target: "transactionRef", source: "transactionId", transform: "string" },
    { target: "counterparty", source: "glAccount.glCode", transform: "string" },
    { target: "isReversal", source: "reversalEntryKey", transform: "presentAsBool", default: false },
  ],
};

const mambuCsv: Record<WcEntity, MappingRule[]> = {
  savings_transaction: [
    { target: "externalId", source: "Transaction ID", transform: "string" },
    { target: "typeLabel", source: "Type", transform: "string" },
    { target: "debitCredit", source: "Type", transform: "typeWordDirection" },
    { target: "amount", source: "Amount", transform: "absAmount" },
    { target: "currency", source: "Currency", default: "NGN" },
    { target: "transactionDate", source: "Value Date", transform: "wcDate" },
    { target: "counterparty", source: "Account ID", transform: "string" },
    { target: "description", source: "Notes", transform: "string" },
  ],
  loan_transaction: [
    { target: "externalId", source: "Transaction ID", transform: "string" },
    { target: "typeLabel", source: "Type", transform: "string" },
    { target: "debitCredit", source: "Type", transform: "typeWordDirection" },
    { target: "amount", source: "Amount", transform: "absAmount" },
    { target: "currency", source: "Currency", default: "NGN" },
    { target: "transactionDate", source: "Value Date", transform: "wcDate" },
    { target: "counterparty", source: "Account ID", transform: "string" },
  ],
  journal_entry: [
    { target: "externalId", source: "Entry ID", transform: "string" },
    { target: "typeLabel", source: "Type", transform: "string" },
    { target: "debitCredit", source: "Type", transform: "directionWord" },
    { target: "amount", source: "Amount", transform: "absAmount" },
    { target: "currency", source: "Currency", default: "NGN" },
    { target: "transactionDate", source: "Booking Date", transform: "wcDate" },
    { target: "transactionRef", source: "Transaction ID", transform: "string" },
    { target: "counterparty", source: "GL Code", transform: "string" },
  ],
};

// ─── Oracle FLEXCUBE (FCUBS REST/gateway) ────────────────────────────────────
// Convention basis: FCUBS exports/gateway responses use TRN_REF_NO, AC_NO,
// LCY_AMOUNT/FCY_AMOUNT, DRCR_IND ("D"/"C"), TRN_DT, TRN_CODE, AC_ENTRY_SR_NO.
const flexcubeApi: Record<WcEntity, MappingRule[]> = {
  savings_transaction: [
    { target: "externalId", source: "acEntrySrNo", transform: "string" },
    { target: "typeLabel", source: "trnCode", transform: "string" },
    { target: "debitCredit", source: "drcrInd", transform: "directionWord" },
    { target: "amount", source: "lcyAmount", transform: "absAmount" },
    { target: "currency", source: "acCcy", default: "NGN" },
    { target: "transactionDate", source: "trnDt", transform: "wcDate" },
    { target: "valueDate", source: "valueDt", transform: "wcDate" },
    { target: "transactionRef", source: "trnRefNo", transform: "string" },
    { target: "counterparty", source: "acNo", transform: "string" },
    { target: "description", source: "lcyAmountText", transform: "string" },
  ],
  loan_transaction: [
    { target: "externalId", source: "acEntrySrNo", transform: "string" },
    { target: "typeLabel", source: "eventCode", transform: "string" },
    { target: "debitCredit", source: "drcrInd", transform: "directionWord" },
    { target: "amount", source: "lcyAmount", transform: "absAmount" },
    { target: "currency", source: "acCcy", default: "NGN" },
    { target: "transactionDate", source: "trnDt", transform: "wcDate" },
    { target: "transactionRef", source: "trnRefNo", transform: "string" },
    { target: "counterparty", source: "accountNumber", transform: "string" },
  ],
  journal_entry: [
    { target: "externalId", source: "acEntrySrNo", transform: "string" },
    { target: "typeLabel", source: "trnCode", transform: "string" },
    { target: "debitCredit", source: "drcrInd", transform: "directionWord" },
    { target: "amount", source: "lcyAmount", transform: "absAmount" },
    { target: "currency", source: "acCcy", default: "NGN" },
    { target: "transactionDate", source: "trnDt", transform: "wcDate" },
    { target: "transactionRef", source: "trnRefNo", transform: "string" },
    { target: "counterparty", source: "glCode", transform: "string" },
  ],
};

const flexcubeCsv: Record<WcEntity, MappingRule[]> = {
  savings_transaction: [
    { target: "externalId", source: "AC_ENTRY_SR_NO", transform: "string" },
    { target: "typeLabel", source: "TRN_CODE", transform: "string" },
    { target: "debitCredit", source: "DRCR_IND", transform: "directionWord" },
    { target: "amount", source: "LCY_AMOUNT", transform: "absAmount" },
    { target: "currency", source: "AC_CCY", default: "NGN" },
    { target: "transactionDate", source: "TRN_DT", transform: "wcDate" },
    { target: "valueDate", source: "VALUE_DT", transform: "wcDate" },
    { target: "transactionRef", source: "TRN_REF_NO", transform: "string" },
    { target: "counterparty", source: "AC_NO", transform: "string" },
  ],
  loan_transaction: [
    { target: "externalId", source: "AC_ENTRY_SR_NO", transform: "string" },
    { target: "typeLabel", source: "EVENT_CODE", transform: "string" },
    { target: "debitCredit", source: "DRCR_IND", transform: "directionWord" },
    { target: "amount", source: "LCY_AMOUNT", transform: "absAmount" },
    { target: "currency", source: "AC_CCY", default: "NGN" },
    { target: "transactionDate", source: "TRN_DT", transform: "wcDate" },
    { target: "transactionRef", source: "TRN_REF_NO", transform: "string" },
    { target: "counterparty", source: "ACCOUNT_NUMBER", transform: "string" },
  ],
  journal_entry: [
    { target: "externalId", source: "AC_ENTRY_SR_NO", transform: "string" },
    { target: "typeLabel", source: "TRN_CODE", transform: "string" },
    { target: "debitCredit", source: "DRCR_IND", transform: "directionWord" },
    { target: "amount", source: "LCY_AMOUNT", transform: "absAmount" },
    { target: "currency", source: "AC_CCY", default: "NGN" },
    { target: "transactionDate", source: "TRN_DT", transform: "wcDate" },
    { target: "transactionRef", source: "TRN_REF_NO", transform: "string" },
    { target: "counterparty", source: "GL_CODE", transform: "string" },
  ],
};

// ─── LAPO MFB (custom multi-source integration) ─────────────────────────────
// LAPO is NOT a vendor-API CBS: it is a proprietary core plus seven channel
// systems (mobile, USSD, agent, NIP, three card processors) integrated through
// the LAPO ETL (server/connectors/lapo/ + shared/lapoSources.ts). It lives in
// this registry so the onboarding hub, connector config (webhook secret/DLQ/
// health), and org provisioning all work unchanged. The entity mappings below
// are the CBS-ledger file shape only — real ingestion routes through the LAPO
// source profiles, per source system.
const lapoLedgerRules: MappingRule[] = [
  { target: "externalId", source: "reference", transform: "string" },
  { target: "typeLabel", source: "channel", transform: "string" },
  { target: "amount", source: "amount", transform: "absAmount" },
  { target: "currency", source: "currency", default: "NGN" },
  { target: "debitCredit", source: "dr_cr", transform: "directionWord" },
  { target: "transactionDate", source: "transaction_date", transform: "wcDate" },
  { target: "valueDate", source: "value_date", transform: "wcDate" },
  { target: "description", source: "narration", transform: "string" },
  { target: "counterparty", source: "account_name", transform: "string" },
];
const lapoEntityMappings: Record<WcEntity, MappingRule[]> = {
  savings_transaction: lapoLedgerRules,
  loan_transaction: lapoLedgerRules,
  journal_entry: lapoLedgerRules,
};

const LAPO_PROFILE: CbsProfile = {
  type: "lapo",
  label: "LAPO MFB (multi-source)",
  vendor: "LAPO proprietary core + channel systems (custom ETL)",
  onboardingChannel: "lapo",
  channelCodePrefix: "LAPO_CBS",
  channelName: "LAPO Unified Ledger",
  defaultAuthMode: "api_key",
  defaultApiKeyHeader: "x-api-key",
  defaultTenantId: "default",
  defaultEndpoints: {
    savingsTransactions: "/exports/ledger/transactions",
    loanTransactions: "/exports/loans/transactions",
    journalEntries: "/exports/gl/entries",
    tokenUrl: "/oauth/token",
    ping: "/health",
    writeBack: "/notes",
  },
  apiMappings: lapoEntityMappings,
  csvMappings: lapoEntityMappings,
  notes:
    "Custom multi-source integration: 8 source systems (CBS ledger, mobile, USSD, agent, NIP, Interswitch/UPSL/eTranzact cards) via SFTP daily batches + realtime events. Provisions all source channels, timing tolerances and the LAPO exception taxonomy at onboarding. All shapes are config — updatable the day LAPO provides real specs.",
  // Onboarded via the DIRECT channel (custom channel pack), not the CBS picker.
  pickerHidden: true,
};

// ─── The registry ────────────────────────────────────────────────────────────
export const CBS_PROFILES: Record<CbsType, CbsProfile> = {
  lapo: LAPO_PROFILE,
  woodcore: {
    type: "woodcore",
    label: "WoodCore",
    vendor: "WoodCore (Apache Fineract)",
    onboardingChannel: "woodcore",
    channelCodePrefix: "WOODCORE_CBS",
    channelName: "WoodCore Core Banking",
    defaultAuthMode: "oauth2",
    defaultApiKeyHeader: "x-api-key",
    defaultTenantId: "default",
    defaultEndpoints: WOODCORE_ENDPOINTS,
    apiMappings: WOODCORE_API_MAPPINGS,
    csvMappings: woodcoreCsv,
    notes: "Live and tested against the WoodCore Fineract tenant.",
  },
  t24: {
    type: "t24",
    label: "Temenos T24",
    vendor: "Temenos T24 / Transact",
    onboardingChannel: "t24",
    channelCodePrefix: "T24_CBS",
    channelName: "Temenos T24 Core Banking",
    defaultAuthMode: "basic",
    defaultApiKeyHeader: "x-api-key",
    defaultTenantId: "default",
    defaultEndpoints: {
      savingsTransactions: "/v1.0.0/holdings/accounts/transactions",
      loanTransactions: "/v1.0.0/holdings/arrangements/transactions",
      journalEntries: "/v1.0.0/accounting/journalEntries",
      tokenUrl: "/oauth/token",
      ping: "/v1.0.0/reference/currencies?limit=1",
      writeBack: "/v1.0.0/notes",
    },
    apiMappings: t24Api,
    csvMappings: t24Csv,
    notes: "Built on Temenos IRIS API conventions; endpoints/mappings are per-bank configurable (T24 installations vary widely).",
  },
  mambu: {
    type: "mambu",
    label: "Mambu",
    vendor: "Mambu (cloud SaaS)",
    onboardingChannel: "mambu",
    channelCodePrefix: "MAMBU_CBS",
    channelName: "Mambu Core Banking",
    defaultAuthMode: "api_key",
    defaultApiKeyHeader: "apikey",
    defaultTenantId: "default",
    defaultEndpoints: {
      savingsTransactions: "/api/deposits/transactions:search",
      loanTransactions: "/api/loans/transactions:search",
      journalEntries: "/api/gljournalentries",
      tokenUrl: "/oauth/token",
      ping: "/api/branches?limit=1",
      writeBack: "/api/comments",
    },
    apiMappings: mambuApi,
    csvMappings: mambuCsv,
    notes: "Built on Mambu API v2 conventions (apikey header, string transaction types, ISO dates).",
  },
  flexcube: {
    type: "flexcube",
    label: "Oracle FLEXCUBE",
    vendor: "Oracle FLEXCUBE Universal Banking (FCUBS)",
    onboardingChannel: "flexcube",
    channelCodePrefix: "FLEXCUBE_CBS",
    channelName: "Oracle FLEXCUBE Core Banking",
    defaultAuthMode: "basic",
    defaultApiKeyHeader: "x-api-key",
    defaultTenantId: "default",
    defaultEndpoints: {
      savingsTransactions: "/fcubs/accounts/transactions",
      loanTransactions: "/fcubs/loans/transactions",
      journalEntries: "/fcubs/gl/entries",
      tokenUrl: "/oauth/token",
      ping: "/fcubs/branches?limit=1",
      writeBack: "/fcubs/notes",
    },
    apiMappings: flexcubeApi,
    csvMappings: flexcubeCsv,
    notes: "Built on FCUBS gateway/export conventions (DRCR_IND D/C, TRN_REF_NO, LCY_AMOUNT); most FLEXCUBE sites start with the CSV fallback.",
  },
};

export function getCbsProfile(type: string | null | undefined): CbsProfile {
  return CBS_PROFILES[(type ?? "woodcore") as CbsType] ?? CBS_PROFILES.woodcore;
}

/** Compact list for UI dropdowns (onboarding hub, connector page). */
export function listCbsProfiles(): Array<Pick<CbsProfile, "type" | "label" | "vendor" | "notes" | "defaultAuthMode">> {
  return CBS_TYPES.map((t) => CBS_PROFILES[t])
    .filter((p) => !p.pickerHidden)
    .map((p) => ({ type: p.type, label: p.label, vendor: p.vendor, notes: p.notes, defaultAuthMode: p.defaultAuthMode }));
}
