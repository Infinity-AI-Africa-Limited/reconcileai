/**
 * Mobile Money Reconciliation Schema
 *
 * Supports reconciliation of mobile money settlement files across two
 * jurisdictions:
 *   Nigeria — NIBSS NIP, OPay, Palmpay (NGN, CBN/NIBSS rules)
 *   Uganda  — MTN MoMo, Airtel Money  (UGX, Bank of Uganda NPS framework)
 *
 * Structured to mirror the poc_runs / poc_exceptions pattern so the existing
 * reconciliation engine and KPI dashboard work without modification.
 *
 * Exception categories (12 total: 8 Nigeria + 4 Uganda) are mobile-money-
 * specific. Per-institution learning is powered by the resolution history in
 * mm_exceptions itself (see applyInstitutionalLearning in mobileMoney-engine.ts).
 */
import {
  int,
  mysqlTable,
  text,
  varchar,
  decimal,
  json,
  timestamp,
  boolean,
  index,
  mysqlEnum,
} from "drizzle-orm/mysql-core";

// ─── Operator enum ────────────────────────────────────────────────────────────
// Nigeria: nip, opay, palmpay — Uganda: mtn_momo_ug, airtel_money_ug
export const MM_OPERATORS = ["nip", "opay", "palmpay", "mtn_momo_ug", "airtel_money_ug"] as const;
export type MmOperator = (typeof MM_OPERATORS)[number];

// ─── Exception category enum ─────────────────────────────────────────────────
export const MM_EXCEPTION_CATEGORIES = [
  // Nigeria (CBN / NIBSS)
  "mm_failed_ussd_debit",       // Customer debited, institution not credited
  "mm_reversal_not_credited",   // Reversal processed, credit not received
  "mm_nip_settlement_shortfall",// Net NIP settlement differs from gross transaction sum
  "mm_duplicate_credit",        // Same session credited twice
  "mm_expired_session_debit",   // USSD session timeout, debit not reversed
  "mm_amount_mismatch",         // Settled amount differs from transaction amount
  "mm_unmatched_nip_inflow",    // NIP credit in settlement, not in internal ledger
  "mm_operator_fee_variance",   // Operator fee deducted differs from contracted rate
  // Uganda (Bank of Uganda NPS framework)
  "mm_wallet_to_bank_failed",   // Wallet debited (operator settled), bank ledger never credited
  "mm_bank_to_wallet_failed",   // Bank ledger debited, wallet never credited (no operator record)
  "mm_withdrawal_tax_variance", // Variance matching Uganda's 0.5% MM withdrawal excise duty
  "mm_momo_settlement_shortfall",// Net MoMo settlement below gross statement sum (trust account)
] as const;
export type MmExceptionCategory = (typeof MM_EXCEPTION_CATEGORIES)[number];

// ─── Mobile Money Reconciliation Run ─────────────────────────────────────────
// One run = one settlement file reconciled against the institution's internal ledger.
export const mmRuns = mysqlTable("mm_runs", {
  id: int("id").autoincrement().primaryKey(),

  // Tenant / POC discriminator — reuses the poc_access_tokens.pocKey system
  pocKey: varchar("pocKey", { length: 64 }).notNull(), // e.g. "lapo"

  // Operator that produced the settlement file
  operator: mysqlEnum("operator", ["nip", "opay", "palmpay", "mtn_momo_ug", "airtel_money_ug"]).notNull(),

  // Settlement period
  settlementDate: varchar("settlementDate", { length: 32 }),
  periodLabel: varchar("periodLabel", { length: 64 }), // e.g. "2025-08-01 to 2025-08-31"

  // Layer 1 — Balance
  settlementCount: int("settlementCount").default(0).notNull(),
  ledgerCount: int("ledgerCount").default(0).notNull(),
  settlementTotal: decimal("settlementTotal", { precision: 30, scale: 2 }).default("0").notNull(),
  ledgerTotal: decimal("ledgerTotal", { precision: 30, scale: 2 }).default("0").notNull(),
  varianceAmount: decimal("varianceAmount", { precision: 30, scale: 2 }).default("0").notNull(),
  currencyCode: varchar("currencyCode", { length: 3 }).default("NGN").notNull(),

  // Layer 2 — Match / exception tallies
  matchedCount: int("matchedCount").default(0).notNull(),
  exceptionCount: int("exceptionCount").default(0).notNull(),
  matchRate: decimal("matchRate", { precision: 5, scale: 2 }),
  status: varchar("status", { length: 24 }).default("BALANCED").notNull(), // BALANCED | VARIANCE_DETECTED

  // Layer 3 — AI summary
  aiSummary: text("aiSummary"),
  summary: json("summary"), // full Layer-1 detail object

  // File metadata
  settlementFileName: varchar("settlementFileName", { length: 500 }),
  ledgerFileName: varchar("ledgerFileName", { length: 500 }),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_mm_runs_poc").on(table.pocKey),
  index("idx_mm_runs_operator").on(table.operator),
  index("idx_mm_runs_created").on(table.createdAt),
]);

export type MmRun = typeof mmRuns.$inferSelect;
export type InsertMmRun = typeof mmRuns.$inferInsert;

// ─── Mobile Money Exception ───────────────────────────────────────────────────
export const mmExceptions = mysqlTable("mm_exceptions", {
  id: int("id").autoincrement().primaryKey(),
  runId: int("runId").notNull(),
  pocKey: varchar("pocKey", { length: 64 }).notNull(),
  operator: mysqlEnum("operator", ["nip", "opay", "palmpay", "mtn_momo_ug", "airtel_money_ug"]).notNull(),

  // Exception classification
  category: varchar("category", { length: 64 }).notNull(), // one of MM_EXCEPTION_CATEGORIES
  side: varchar("side", { length: 16 }), // "settlement" | "ledger"

  // Transaction details
  amount: decimal("amount", { precision: 30, scale: 2 }).default("0").notNull(),
  txnDate: varchar("txnDate", { length: 32 }),
  reference: varchar("reference", { length: 255 }),
  sessionId: varchar("sessionId", { length: 128 }), // USSD/NIP session reference
  nipSessionId: varchar("nipSessionId", { length: 128 }), // NIP-specific session ID
  description: varchar("description", { length: 500 }),
  reversalStatus: varchar("reversalStatus", { length: 32 }), // pending | completed | failed | null

  // Layer 3 — AI agent diagnosis
  agentExplanation: text("agentExplanation"),
  recommendedAction: text("recommendedAction"),
  // Regulatory rule reference — CBN/NIBSS (Nigeria) or BoU NPS framework (Uganda).
  // Column name predates Uganda support; kept for compatibility.
  cbnRuleReference: varchar("cbnRuleReference", { length: 255 }),
  priorityLevel: varchar("priorityLevel", { length: 10 }), // CRITICAL | HIGH | MEDIUM | LOW
  agentConfidence: int("agentConfidence"), // 0-100

  // Review / resolution workflow
  reviewStatus: varchar("reviewStatus", { length: 16 }).default("OPEN").notNull(), // OPEN | ACKNOWLEDGED | RESOLVED | ESCALATED | REJECTED
  reviewedBy: varchar("reviewedBy", { length: 100 }),
  reviewNote: text("reviewNote"),
  reviewedAt: timestamp("reviewedAt"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_mm_exc_run").on(table.runId),
  index("idx_mm_exc_poc").on(table.pocKey),
  index("idx_mm_exc_category").on(table.category),
  index("idx_mm_exc_operator").on(table.operator),
  index("idx_mm_exc_status").on(table.reviewStatus),
]);

export type MmException = typeof mmExceptions.$inferSelect;
export type InsertMmException = typeof mmExceptions.$inferInsert;
