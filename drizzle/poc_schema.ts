/**
 * Generic POC schema — hub-ready.
 *
 * Backs the public, no-login company POC pages (e.g. Salad Africa). Unlike the
 * Woodcore POC (which reads a mirrored CBS database), these POCs let a prospect
 * upload their own files and run reconciliation. A `pocSlug` discriminator keeps
 * each company's POC isolated and lets future POCs reuse the same tables.
 *
 * POC data is intentionally separate from the real tenant `transactions` table.
 */
import {
  int,
  mysqlTable,
  text,
  varchar,
  decimal,
  json,
  timestamp,
  index,
} from "drizzle-orm/mysql-core";

// An uploaded + extracted file (one side of a reconciliation: ledger or statement).
export const pocUploads = mysqlTable("poc_uploads", {
  id: int("id").autoincrement().primaryKey(),
  pocSlug: varchar("pocSlug", { length: 64 }).notNull(),
  side: varchar("side", { length: 16 }).notNull(), // "ledger" | "statement"
  fileName: varchar("fileName", { length: 500 }),
  fileType: varchar("fileType", { length: 16 }), // pdf | excel | csv
  rowCount: int("rowCount").default(0).notNull(),
  // Canonical extracted rows (date, description, amount, debitCredit, reference, balance?).
  rows: json("rows").notNull(),
  notes: text("notes"), // extraction notes / warnings shown to the user
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_poc_uploads_slug").on(table.pocSlug),
]);
export type PocUpload = typeof pocUploads.$inferSelect;
export type InsertPocUpload = typeof pocUploads.$inferInsert;

// A reconciliation run (Layer 1 balance summary lives here).
export const pocRuns = mysqlTable("poc_runs", {
  id: int("id").autoincrement().primaryKey(),
  pocSlug: varchar("pocSlug", { length: 64 }).notNull(),
  ledgerUploadId: int("ledgerUploadId"),
  statementUploadId: int("statementUploadId"),
  currencyCode: varchar("currencyCode", { length: 3 }).default("NGN").notNull(),
  // Layer 1 — balance
  ledgerCount: int("ledgerCount").default(0).notNull(),
  statementCount: int("statementCount").default(0).notNull(),
  ledgerTotal: decimal("ledgerTotal", { precision: 30, scale: 2 }).default("0").notNull(),
  statementTotal: decimal("statementTotal", { precision: 30, scale: 2 }).default("0").notNull(),
  varianceAmount: decimal("varianceAmount", { precision: 30, scale: 2 }).default("0").notNull(),
  status: varchar("status", { length: 24 }).default("BALANCED").notNull(), // BALANCED | VARIANCE_DETECTED
  // Match/exception tallies (Layer 2)
  matchedCount: int("matchedCount").default(0).notNull(),
  exceptionCount: int("exceptionCount").default(0).notNull(),
  matchRate: decimal("matchRate", { precision: 5, scale: 2 }),
  summary: json("summary"), // full Layer-1 detail object
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_poc_runs_slug").on(table.pocSlug),
]);
export type PocRun = typeof pocRuns.$inferSelect;
export type InsertPocRun = typeof pocRuns.$inferInsert;

// An exception (Layer 2 classification + Layer 3 AI analysis).
export const pocExceptions = mysqlTable("poc_exceptions", {
  id: int("id").autoincrement().primaryKey(),
  runId: int("runId").notNull(),
  pocSlug: varchar("pocSlug", { length: 64 }).notNull(),
  category: varchar("category", { length: 48 }).notNull(), // IN_LEDGER_NOT_IN_BANK | IN_BANK_NOT_IN_LEDGER | AMOUNT_MISMATCH | DUPLICATE | REVERSAL
  side: varchar("side", { length: 16 }), // ledger | statement
  amount: decimal("amount", { precision: 30, scale: 2 }).default("0").notNull(),
  txnDate: varchar("txnDate", { length: 32 }),
  reference: varchar("reference", { length: 255 }),
  description: varchar("description", { length: 500 }),
  // Layer 3 — AI agent
  agentExplanation: text("agentExplanation"),
  recommendedAction: text("recommendedAction"),
  priorityLevel: varchar("priorityLevel", { length: 10 }), // CRITICAL | HIGH | MEDIUM | LOW
  agentConfidence: int("agentConfidence"),
  // Review status
  reviewStatus: varchar("reviewStatus", { length: 16 }).default("OPEN").notNull(), // OPEN | ACKNOWLEDGED | RESOLVED | ESCALATED
  reviewedBy: varchar("reviewedBy", { length: 100 }),
  reviewNote: text("reviewNote"),
  reviewedAt: timestamp("reviewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_poc_exceptions_run").on(table.runId),
  index("idx_poc_exceptions_slug").on(table.pocSlug),
]);
export type PocException = typeof pocExceptions.$inferSelect;
export type InsertPocException = typeof pocExceptions.$inferInsert;

// Shareable report links.
export const pocShareTokens = mysqlTable("poc_share_tokens", {
  id: int("id").autoincrement().primaryKey(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  runId: int("runId").notNull(),
  pocSlug: varchar("pocSlug", { length: 64 }).notNull(),
  createdBy: varchar("createdBy", { length: 100 }),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_poc_share_token").on(table.token),
]);
export type PocShareToken = typeof pocShareTokens.$inferSelect;
export type InsertPocShareToken = typeof pocShareTokens.$inferInsert;
