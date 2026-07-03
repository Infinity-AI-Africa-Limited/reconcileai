/**
 * Mobile Money Reconciliation Schema
 *
 * Supports reconciliation of mobile money settlement files from Nigerian
 * operators: NIBSS NIP, OPay, and Palmpay. Structured to mirror the
 * poc_runs / poc_exceptions pattern so the existing reconciliation engine,
 * exception intelligence flywheel, and KPI dashboard all work without
 * modification.
 *
 * Exception categories (8 total) are mobile-money-specific and are also
 * registered in exceptionIntelligence.ts so every resolution feeds the
 * Per-Institution Learning Flywheel.
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
export const MM_OPERATORS = ["nip", "opay", "palmpay"] as const;
export type MmOperator = (typeof MM_OPERATORS)[number];

// ─── Exception category enum ─────────────────────────────────────────────────
export const MM_EXCEPTION_CATEGORIES = [
  "mm_failed_ussd_debit",       // Customer debited, institution not credited
  "mm_reversal_not_credited",   // Reversal processed, credit not received
  "mm_nip_settlement_shortfall",// Net settlement differs from gross transaction sum
  "mm_duplicate_credit",        // Same session credited twice
  "mm_expired_session_debit",   // USSD session timeout, debit not reversed
  "mm_amount_mismatch",         // Settled amount differs from transaction amount
  "mm_unmatched_nip_inflow",    // NIP credit in settlement, not in internal ledger
  "mm_operator_fee_variance",   // Operator fee deducted differs from contracted rate
] as const;
export type MmExceptionCategory = (typeof MM_EXCEPTION_CATEGORIES)[number];

// ─── Mobile Money Reconciliation Run ─────────────────────────────────────────
// One run = one settlement file reconciled against the institution's internal ledger.
export const mmRuns = mysqlTable("mm_runs", {
  id: int("id").autoincrement().primaryKey(),

  // Tenant / POC discriminator — reuses the poc_access_tokens.pocKey system
  pocKey: varchar("pocKey", { length: 64 }).notNull(), // e.g. "lapo"

  // Operator that produced the settlement file
  operator: mysqlEnum("operator", ["nip", "opay", "palmpay"]).notNull(),

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
  operator: mysqlEnum("operator", ["nip", "opay", "palmpay"]).notNull(),

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
  cbnRuleReference: varchar("cbnRuleReference", { length: 255 }), // e.g. "CBN Mobile Money Policy 2021, Section 4.3"
  priorityLevel: varchar("priorityLevel", { length: 10 }), // CRITICAL | HIGH | MEDIUM | LOW
  agentConfidence: int("agentConfidence"), // 0-100

  // Review / resolution workflow
  reviewStatus: varchar("reviewStatus", { length: 16 }).default("OPEN").notNull(), // OPEN | ACKNOWLEDGED | RESOLVED | ESCALATED
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
