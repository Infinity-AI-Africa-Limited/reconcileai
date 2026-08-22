import {
  int,
  tinyint,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  decimal,
  boolean,
  json,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

// ─── Organizations (Multi-Tenant) ───────────────────────────────────
export const organizations = mysqlTable("organizations", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  country: varchar("country", { length: 3 }).default("NGA").notNull(), // ISO 3166-1 alpha-3
  baseCurrency: varchar("baseCurrency", { length: 3 }).default("NGN").notNull(),
  // Segment determines which portal instance this org belongs to:
  // - financial_services: banks, MFBs, fintechs, payment processors
  // - corporate_b2b: FMCG distributors, corporate treasury, B2B payments
  // - super_admin: Infinity AI internal (cross-tenant visibility)
  // - retail_commerce: e-commerce merchants (SHOPLINE vertical)
  segment: mysqlEnum("segment", ["financial_services", "corporate_b2b", "super_admin", "retail_commerce"]).default("financial_services").notNull(),
  // How this organization arrived on the platform:
  // - "direct":   onboarded directly by ReconcileAI (own data connection/uploads)
  // - "woodcore": onboarded through the WoodCore CBS connector (WoodCore client bank)
  // - future CBS connectors add their own channel code here (varchar, not enum, on purpose)
  onboardingChannel: varchar("onboardingChannel", { length: 50 }).default("direct").notNull(),
  // Enterprise SSO opt-in, per organization. Email/magic-link is the default
  // for every org; a client's users can only use Google / Microsoft Entra ID
  // sign-in once the org is switched on here ("when the client requests it").
  // Values: "none" (default) | "google" | "microsoft" | "both".
  // Which banking model this institution operates on. Orthogonal to `segment`:
  // a non-interest bank is still `financial_services` and still runs NIP, POS
  // and cheque clearing — what differs is how income may be earned and shared.
  //   "conventional" (default) | "non_interest"
  // Varchar rather than an enum for the same reason as onboardingChannel: the
  // CBN recognises institutions offering Islamic financial services AND other
  // non-interest principles, and a window or subsidiary of a conventional bank
  // is a third shape. Adding one should not need a migration.
  // Drives the NIFI exception taxonomy (server/exceptions/non-interest.ts),
  // which applies across every rail rather than to a channel.
  bankingModel: varchar("bankingModel", { length: 30 }).default("conventional").notNull(),
  /**
   * This organisation exists for demos and sales, not for a real client.
   *
   * A FACT about the tenant, held where the fact belongs. Demo-ness was
   * previously inferred by substring-matching free-text reconciliation job names
   * for "Demo" / "vs CBS GL" / "BrightGoods" — a case-sensitive match against
   * names each seeder invents independently. A seeder that named its jobs
   * "… — FSDEMO-v2" matched none of them (uppercase DEMO ≠ Demo), so 374 seeded
   * exceptions were reported to the owner as real SLA breaches, under an email
   * footer stating that demo data was excluded.
   *
   * Anything that must not treat fabricated data as real reads this column.
   */
  isDemo: boolean("isDemo").default(false).notNull(),
  // Bank-controlled boundary for all model-assisted exception analysis. When
  // false, deterministic matching, exception routing and audit evidence remain
  // available, but no exception context is sent to a model provider.
  aiAssistanceEnabled: boolean("aiAssistanceEnabled").default(true).notNull(),
  ssoProvider: varchar("ssoProvider", { length: 20 }).default("none").notNull(),
  settings: json("settings"), // org-level config: matching rules, thresholds, etc.
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Organization = typeof organizations.$inferSelect;
export type InsertOrganization = typeof organizations.$inferInsert;

// ─── Users ───────────────────────────────────────────────────────────
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  // super_admin: Infinity AI staff only — cross-tenant visibility, hidden from client users
  role: mysqlEnum("role", ["super_admin", "admin", "cfo", "operations", "compliance", "user"]).default("user").notNull(),
  organizationId: int("organizationId"),
  isGuest: boolean("isGuest").default(false).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
}, (table) => [
  index("idx_users_org").on(table.organizationId),
  index("idx_users_email").on(table.email),
]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Channels ────────────────────────────────────────────────────────
export const channels = mysqlTable("channels", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  name: varchar("name", { length: 100 }).notNull(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  description: text("description"),
  channelType: mysqlEnum("channelType", [
    "bank_core", "nibss", "pos", "atm", "mobile_money", "bank_transfer",
    "agent_banking", "fintech_api", "card_payments", "rtgs", "swift",
    "mobile_banking", "ussd", "qr_payment",
    // Cheque clearing (NIBSS NACS / Cheque Truncation). Its own type rather than
    // folded into bank_transfer, so the Super Agent can select the cheque
    // taxonomy from the channel — see server/exceptions/channelMapping.ts.
    "cheque_clearing",
    // Retail / e-commerce channel types (SHOPLINE vertical)
    "ecommerce_gateway", "marketplace_payout", "buy_now_pay_later", "digital_wallet",
  ]).default("bank_transfer").notNull(),
  country: varchar("country", { length: 3 }).default("NGA").notNull(),
  defaultCurrency: varchar("defaultCurrency", { length: 3 }).default("NGN").notNull(),
  // Channel-specific matching configuration
  matchingConfig: json("matchingConfig"), // { amountTolerance, dateWindowDays, refFormat, etc. }
  fileFormat: json("fileFormat"), // Expected CSV column mapping for this channel
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_channels_org").on(table.organizationId),
  index("idx_channels_type").on(table.channelType),
]);

export type Channel = typeof channels.$inferSelect;
export type InsertChannel = typeof channels.$inferInsert;

// ─── Upload Batches ──────────────────────────────────────────────────
export const uploadBatches = mysqlTable("upload_batches", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  channelId: int("channelId").notNull(),
  organizationId: int("organizationId"),
  fileName: varchar("fileName", { length: 500 }).notNull(),
  fileUrl: text("fileUrl"),
  fileHash: varchar("fileHash", { length: 64 }), // SHA-256 for idempotency
  detectedFormat: varchar("detectedFormat", { length: 64 }), // connector that parsed this file (e.g. nibss_nip, interswitch_settlement, generic)
  totalRows: int("totalRows").default(0).notNull(),
  validRows: int("validRows").default(0).notNull(),
  invalidRows: int("invalidRows").default(0).notNull(),
  status: mysqlEnum("status", ["pending", "processing", "completed", "failed"])
    .default("pending")
    .notNull(),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
}, (table) => [
  index("idx_batches_user").on(table.userId),
  index("idx_batches_channel").on(table.channelId),
  index("idx_batches_org").on(table.organizationId),
  index("idx_batches_hash").on(table.fileHash),
  index("idx_batches_status").on(table.status),
]);

export type UploadBatch = typeof uploadBatches.$inferSelect;
export type InsertUploadBatch = typeof uploadBatches.$inferInsert;

// ─── Transactions ────────────────────────────────────────────────────
export const transactions = mysqlTable("transactions", {
  id: int("id").autoincrement().primaryKey(),
  batchId: int("batchId").notNull(),
  channelId: int("channelId").notNull(),
  userId: int("userId").notNull(),
  organizationId: int("organizationId"),
  transactionRef: varchar("transactionRef", { length: 255 }),
  externalRef: varchar("externalRef", { length: 255 }),
  description: text("description"),
  amount: decimal("amount", { precision: 18, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).default("NGN").notNull(),
  transactionDate: timestamp("transactionDate").notNull(),
  valueDate: timestamp("valueDate"),
  debitCredit: mysqlEnum("debitCredit", ["debit", "credit"]).notNull(),
  counterparty: varchar("counterparty", { length: 255 }),
  // Reversal tracking
  isReversal: boolean("isReversal").default(false).notNull(),
  originalTransactionRef: varchar("originalTransactionRef", { length: 255 }),
  status: mysqlEnum("status", ["unmatched", "matched", "exception", "manually_matched", "reversed"])
    .default("unmatched")
    .notNull(),
  matchId: int("matchId"),
  rawData: json("rawData"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_txn_batch").on(table.batchId),
  index("idx_txn_channel").on(table.channelId),
  index("idx_txn_user").on(table.userId),
  index("idx_txn_org").on(table.organizationId),
  index("idx_txn_ref").on(table.transactionRef),
  index("idx_txn_ext_ref").on(table.externalRef),
  index("idx_txn_status").on(table.status),
  index("idx_txn_match").on(table.matchId),
  // Composite index for reconciliation queries
  index("idx_txn_channel_date_status").on(table.channelId, table.transactionDate, table.status),
  // Composite index for duplicate detection
  index("idx_txn_ref_channel").on(table.transactionRef, table.channelId),
  index("idx_txn_amount_date").on(table.amount, table.transactionDate),
]);

export type Transaction = typeof transactions.$inferSelect;
export type InsertTransaction = typeof transactions.$inferInsert;

// ─── Reconciliation Jobs ─────────────────────────────────────────────
export const reconciliationJobs = mysqlTable("reconciliation_jobs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  organizationId: int("organizationId"),
  // transaction_integrity kept for backward compat with existing job records; new jobs use settlement or account_level
  moduleType: mysqlEnum("moduleType", ["transaction_integrity", "settlement", "account_level"])
    .default("settlement")
    .notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  sourceChannelId: int("sourceChannelId").notNull(),
  targetChannelId: int("targetChannelId").notNull(),
  dateFrom: timestamp("dateFrom").notNull(),
  dateTo: timestamp("dateTo").notNull(),
  // The job's dominant transaction currency, set at completion (WS-6). A job
  // may still contain minority-currency legs — those surface as
  // currency_mismatch / fx_rate_variance exceptions, each carrying its own currency.
  currency: varchar("currency", { length: 3 }).default("NGN").notNull(),
  amountTolerance: decimal("amountTolerance", { precision: 5, scale: 4 }).default("0.005").notNull(),
  dateWindowDays: int("dateWindowDays").default(3).notNull(),
  // Engine configuration snapshot
  engineConfig: json("engineConfig"), // Frozen config at run time
  // Groups child jobs created by a single multi-channel run (one source vs. many targets).
  multiRunId: varchar("multiRunId", { length: 36 }),
  status: mysqlEnum("status", ["pending", "running", "completed", "failed", "cancelled"])
    .default("pending")
    .notNull(),
  totalSourceTxns: int("totalSourceTxns").default(0).notNull(),
  totalTargetTxns: int("totalTargetTxns").default(0).notNull(),
  matchedCount: int("matchedCount").default(0).notNull(),
  exceptionCount: int("exceptionCount").default(0).notNull(),
  unmatchedCount: int("unmatchedCount").default(0).notNull(),
  matchRate: decimal("matchRate", { precision: 5, scale: 2 }),
  processingTimeMs: int("processingTimeMs"), // Track engine performance
  // Bank fee/charge "noise" set aside from the reconciliation (not counted as
  // exceptions). excludedItems holds the flagged rows + reason for the user.
  excludedCount: int("excludedCount").default(0).notNull(),
  excludedItems: json("excludedItems"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  /**
   * Set by recoverStuckReconciliationJobs() when a job stuck in pending/running
   * past the staleness window is declared dead. It is NOT the same thing as
   * status "failed": a runner-failed job is eligible for a queue retry, whereas
   * an abandoned one has already been reported to the user as failed and must
   * never execute again. A durable BullMQ entry can outlive the sweep, and the
   * handler resets the job's artifacts before running — so without this marker a
   * resurrected entry would wipe and re-run work the user already saw finish.
   */
  abandonedAt: timestamp("abandonedAt"),
  /**
   * Liveness signal, refreshed periodically by the runner while a job executes.
   *
   * Distinct from `startedAt`, which records when the run began and must stay
   * accurate for duration reporting. Without a heartbeat the recovery sweep can
   * only guess from age, so a reconciliation that legitimately runs longer than
   * the staleness window gets declared dead while it is still working — and
   * because abandonment is terminal and its artifacts are discarded, that
   * destroys real work rather than merely mislabelling it.
   */
  heartbeatAt: timestamp("heartbeatAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_jobs_user").on(table.userId),
  index("idx_jobs_org").on(table.organizationId),
  index("idx_jobs_module").on(table.moduleType),
  index("idx_jobs_status").on(table.status),
  index("idx_jobs_source").on(table.sourceChannelId),
  index("idx_jobs_target").on(table.targetChannelId),
  index("idx_jobs_created").on(table.createdAt),
  index("idx_jobs_multirun").on(table.multiRunId),
]);

export type ReconciliationJob = typeof reconciliationJobs.$inferSelect;
export type InsertReconciliationJob = typeof reconciliationJobs.$inferInsert;

// ─── Matches ─────────────────────────────────────────────────────────
export const matches = mysqlTable("matches", {
  id: int("id").autoincrement().primaryKey(),
  /**
   * Owning tenant. Nullable, and deliberately so: 2,000 existing rows point at
   * a jobId with no surviving job, leaving no parent to inherit an org from.
   * NULL therefore means "legacy / underivable", exactly as it does on
   * `transactions` — never "any organization". New rows always carry the
   * organization of the job that produced them.
   */
  organizationId: int("organizationId"),
  jobId: int("jobId").notNull(),
  sourceTransactionId: int("sourceTransactionId").notNull(),
  targetTransactionId: int("targetTransactionId").notNull(),
  matchType: mysqlEnum("matchType", ["exact", "fuzzy", "amount_tolerance", "date_window", "ai_suggested", "manual", "reversal"])
    .notNull(),
  confidenceScore: decimal("confidenceScore", { precision: 5, scale: 2 }).notNull(),
  amountDifference: decimal("amountDifference", { precision: 18, scale: 2 }),
  dateDifference: int("dateDifference"),
  matchReason: text("matchReason"),
  status: mysqlEnum("status", ["confirmed", "pending_review", "rejected"])
    .default("confirmed")
    .notNull(),
  reviewedBy: int("reviewedBy"),
  reviewedAt: timestamp("reviewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_matches_org").on(table.organizationId),
  index("idx_matches_job").on(table.jobId),
  index("idx_matches_source").on(table.sourceTransactionId),
  index("idx_matches_target").on(table.targetTransactionId),
  index("idx_matches_status").on(table.status),
  index("idx_matches_type").on(table.matchType),
]);

export type Match = typeof matches.$inferSelect;
export type InsertMatch = typeof matches.$inferInsert;

// ─── Exceptions ──────────────────────────────────────────────────────
export const exceptions = mysqlTable("exceptions", {
  id: int("id").autoincrement().primaryKey(),
  /**
   * Owning tenant. Financial-services exceptions are control records and must
   * never be attributable to "no organisation". Migration 0084 quarantines
   * legacy orphaned rows before enforcing this at the database layer.
   */
  organizationId: int("organizationId").notNull(),
  jobId: int("jobId").notNull(),
  transactionId: int("transactionId").notNull(),
  category: mysqlEnum("category", [
    "missing_counterparty",
    "amount_mismatch",
    "timing_difference",
    "duplicate_transaction",
    "unmatched",
    "reversal_unmatched",
    "currency_mismatch",
    // Same reference, different currencies, amounts differing by an implied FX
    // rate — settlement-vs-transaction-date rate variance (WS-6).
    "fx_rate_variance",
    "format_error",
  ]).notNull(),
  // Fine-grained vertical category that does NOT fit the fixed core enum above —
  // e.g. a retail `retail_chargeback_not_posted`. The `category` column stays a
  // coarse core enum (for list filters/reports), while the exception intelligence
  // flywheel (agentMemory + shared pattern pool) learns on this precise category
  // when present, so retail moat isn't blended into the coarse buckets. Null for
  // ordinary financial-services exceptions.
  subCategory: varchar("subCategory", { length: 64 }),
  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"])
    .default("medium")
    .notNull(),
  // Denormalized from the transaction at insert so exception lists/reports can
  // state amounts in the right currency without a join (WS-6).
  currency: varchar("currency", { length: 3 }).default("NGN").notNull(),
  description: text("description"),
  suggestedResolution: text("suggestedResolution"),
  aiAnalysis: text("aiAnalysis"),
  status: mysqlEnum("status", ["open", "in_review", "resolved", "dismissed", "escalated"])
    .default("open")
    .notNull(),
  assignedTo: int("assignedTo"),
  assignedAt: timestamp("assignedAt"),
  assignedBy: int("assignedBy"),
  resolvedBy: int("resolvedBy"),
  resolvedAt: timestamp("resolvedAt"),
  resolutionNotes: text("resolutionNotes"),
  // CBS staleness detection: set when a re-run finds the same anomaly after RESOLVED status
  cbsStillAnomalous: boolean("cbsStillAnomalous").default(false),
  cbsVerificationNote: text("cbsVerificationNote"),
  userKeptResolved: boolean("userKeptResolved").default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_exceptions_org").on(table.organizationId),
  index("idx_exceptions_job").on(table.jobId),
  index("idx_exceptions_txn").on(table.transactionId),
  index("idx_exceptions_status").on(table.status),
  index("idx_exceptions_severity").on(table.severity),
  index("idx_exceptions_category").on(table.category),
  index("idx_exceptions_assigned").on(table.assignedTo),
]);

export type Exception = typeof exceptions.$inferSelect;
export type InsertException = typeof exceptions.$inferInsert;

// ─── Audit Logs ──────────────────────────────────────────────────────
export const auditLogs = mysqlTable("audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId"),
  organizationId: int("organizationId"),
  action: varchar("action", { length: 100 }).notNull(),
  entityType: varchar("entityType", { length: 50 }).notNull(),
  entityId: int("entityId"),
  details: json("details"),
  ipAddress: varchar("ipAddress", { length: 45 }),
  userAgent: varchar("userAgent", { length: 500 }),
  // Tamper-evidence: per-org hash chain. recordHash = SHA-256(canonical(entry) + prevRecordHash);
  // any altered/removed row breaks the chain at verification time.
  sequenceNumber: int("sequenceNumber"),
  recordHash: varchar("recordHash", { length: 64 }),
  prevRecordHash: varchar("prevRecordHash", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_audit_user").on(table.userId),
  index("idx_audit_org").on(table.organizationId),
  index("idx_audit_entity").on(table.entityType, table.entityId),
  index("idx_audit_action").on(table.action),
  index("idx_audit_created").on(table.createdAt),
  index("idx_audit_org_seq").on(table.organizationId, table.sequenceNumber),
]);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

// ─── Exception Age / Escalation Tracker settings ─────────────────────
// Per-org SLA target (days) for exception resolution. Items open longer than
// this are "over-aged" and escalate in the Age Tracker. Default 7 days.
export const exceptionAgingSettings = mysqlTable("exception_aging_settings", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull().unique(),
  slaDays: int("slaDays").default(7).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_aging_settings_org").on(table.organizationId),
]);
export type ExceptionAgingSettings = typeof exceptionAgingSettings.$inferSelect;
export type InsertExceptionAgingSettings = typeof exceptionAgingSettings.$inferInsert;

// ─── Reconciliation Reports ─────────────────────────────────────────
export const reconciliationReports = mysqlTable("reconciliation_reports", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  userId: int("userId").notNull(),
  organizationId: int("organizationId"),
  reportType: mysqlEnum("reportType", ["daily", "weekly", "monthly", "custom"]).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  summary: json("summary"),
  fileUrl: text("fileUrl"),
  format: mysqlEnum("format", ["pdf", "excel", "csv"]).default("pdf").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_reports_job").on(table.jobId),
  index("idx_reports_user").on(table.userId),
  index("idx_reports_org").on(table.organizationId),
]);

export type ReconciliationReport = typeof reconciliationReports.$inferSelect;
export type InsertReconciliationReport = typeof reconciliationReports.$inferInsert;

// ─── Webhooks (External Integration) ────────────────────────────────
export const webhooks = mysqlTable("webhooks", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  url: text("url").notNull(),
  secret: varchar("secret", { length: 255 }).notNull(), // HMAC signing secret
  events: json("events").notNull(), // ["reconciliation.completed", "exception.created", etc.]
  isActive: boolean("isActive").default(true).notNull(),
  lastTriggeredAt: timestamp("lastTriggeredAt"),
  failureCount: int("failureCount").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_webhooks_org").on(table.organizationId),
  index("idx_webhooks_user").on(table.userId),
  index("idx_webhooks_active").on(table.isActive),
]);

export type Webhook = typeof webhooks.$inferSelect;
export type InsertWebhook = typeof webhooks.$inferInsert;

// ─── Webhook Deliveries (WS-4) ───────────────────────────────────────
// One row per delivery attempt chain: created pending, updated by the retry
// queue until delivered or attempts exhaust. Powers the admin delivery
// dashboard and the ≥99.5% reliability KPI. Org-scoped through webhookId
// (RLS class: derived).
export const webhookDeliveries = mysqlTable("webhook_deliveries", {
  id: int("id").autoincrement().primaryKey(),
  webhookId: int("webhookId").notNull(), // → webhooks.id (org scope derives from it)
  event: varchar("event", { length: 64 }).notNull(), // e.g. exception.created
  url: text("url").notNull(), // snapshot at dispatch time
  status: mysqlEnum("status", ["pending", "delivered", "failed"]).default("pending").notNull(),
  attempts: int("attempts").default(0).notNull(),
  maxAttempts: int("maxAttempts").default(6).notNull(),
  responseStatus: int("responseStatus"), // last HTTP status (null on network error)
  lastError: varchar("lastError", { length: 500 }),
  payloadSummary: varchar("payloadSummary", { length: 500 }), // event + ids only, never row data
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  lastAttemptAt: timestamp("lastAttemptAt"),
  deliveredAt: timestamp("deliveredAt"),
}, (table) => [
  index("idx_whd_webhook").on(table.webhookId),
  index("idx_whd_status").on(table.status),
  index("idx_whd_created").on(table.createdAt),
]);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type InsertWebhookDelivery = typeof webhookDeliveries.$inferInsert;

// ─── API Keys (External Integration) ────────────────────────────────
export const apiKeys = mysqlTable("api_keys", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  keyHash: varchar("keyHash", { length: 64 }).notNull().unique(), // SHA-256 of the key
  keyPrefix: varchar("keyPrefix", { length: 8 }).notNull(), // First 8 chars for identification
  permissions: json("permissions").notNull(), // ["read:transactions", "write:upload", etc.]
  isActive: boolean("isActive").default(true).notNull(),
  lastUsedAt: timestamp("lastUsedAt"),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_apikeys_org").on(table.organizationId),
  index("idx_apikeys_user").on(table.userId),
  index("idx_apikeys_hash").on(table.keyHash),
  index("idx_apikeys_prefix").on(table.keyPrefix),
]);

export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = typeof apiKeys.$inferInsert;

// ─── Supported Currencies (Pan-African) ─────────────────────────────
export const SUPPORTED_CURRENCIES = [
  "NGN", // Nigerian Naira
  "KES", // Kenyan Shilling
  "GHS", // Ghanaian Cedi
  "ZAR", // South African Rand
  "TZS", // Tanzanian Shilling
  "UGX", // Ugandan Shilling
  "XOF", // West African CFA Franc
  "XAF", // Central African CFA Franc
  "EGP", // Egyptian Pound
  "MAD", // Moroccan Dirham
  "RWF", // Rwandan Franc
  "ETB", // Ethiopian Birr
  "USD", // US Dollar (for international settlements)
  "EUR", // Euro (for international settlements)
  "GBP", // British Pound (for international settlements)
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// ─── African Countries ──────────────────────────────────────────────
export const AFRICAN_COUNTRIES = [
  { code: "NGA", name: "Nigeria", currency: "NGN" },
  { code: "KEN", name: "Kenya", currency: "KES" },
  { code: "GHA", name: "Ghana", currency: "GHS" },
  { code: "ZAF", name: "South Africa", currency: "ZAR" },
  { code: "TZA", name: "Tanzania", currency: "TZS" },
  { code: "UGA", name: "Uganda", currency: "UGX" },
  { code: "RWA", name: "Rwanda", currency: "RWF" },
  { code: "ETH", name: "Ethiopia", currency: "ETB" },
  { code: "EGY", name: "Egypt", currency: "EGP" },
  { code: "MAR", name: "Morocco", currency: "MAD" },
  { code: "SEN", name: "Senegal", currency: "XOF" },
  { code: "CMR", name: "Cameroon", currency: "XAF" },
] as const;


// ─── Scheduled Reconciliation Tasks ─────────────────────────────────
export const scheduledTasks = mysqlTable("scheduled_tasks", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  organizationId: int("organizationId"),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  sourceChannelId: int("sourceChannelId").notNull(),
  targetChannelId: int("targetChannelId").notNull(),
  // Schedule configuration
  frequency: mysqlEnum("frequency", ["daily", "weekly", "biweekly", "monthly"]).notNull(),
  scheduledTime: varchar("scheduledTime", { length: 5 }).notNull(), // HH:mm format
  scheduledDayOfWeek: int("scheduledDayOfWeek"), // 0-6 for weekly (0=Sunday)
  scheduledDayOfMonth: int("scheduledDayOfMonth"), // 1-31 for monthly
  timezone: varchar("timezone", { length: 64 }).default("Africa/Lagos").notNull(),
  // Reconciliation config
  amountTolerance: decimal("amountTolerance", { precision: 5, scale: 4 }).default("0.005").notNull(),
  dateWindowDays: int("dateWindowDays").default(3).notNull(),
  lookbackDays: int("lookbackDays").default(1).notNull(), // How many days back to reconcile
  // Email report settings
  sendEmailReport: boolean("sendEmailReport").default(true).notNull(),
  emailRecipients: json("emailRecipients"), // ["email1@bank.com", "email2@bank.com"]
  // Status
  isActive: boolean("isActive").default(true).notNull(),
  lastRunAt: timestamp("lastRunAt"),
  lastRunJobId: int("lastRunJobId"),
  lastRunStatus: mysqlEnum("lastRunStatus", ["success", "failed", "skipped"]),
  nextRunAt: timestamp("nextRunAt"),
  totalRuns: int("totalRuns").default(0).notNull(),
  successfulRuns: int("successfulRuns").default(0).notNull(),
  failedRuns: int("failedRuns").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_sched_user").on(table.userId),
  index("idx_sched_org").on(table.organizationId),
  index("idx_sched_active").on(table.isActive),
  index("idx_sched_next_run").on(table.nextRunAt),
  index("idx_sched_source").on(table.sourceChannelId),
  index("idx_sched_target").on(table.targetChannelId),
]);

export type ScheduledTask = typeof scheduledTasks.$inferSelect;
export type InsertScheduledTask = typeof scheduledTasks.$inferInsert;

// ─── Schedule Run History ───────────────────────────────────────────
export const scheduleRunHistory = mysqlTable("schedule_run_history", {
  id: int("id").autoincrement().primaryKey(),
  scheduledTaskId: int("scheduledTaskId").notNull(),
  jobId: int("jobId"),
  status: mysqlEnum("status", ["success", "failed", "skipped", "running"]).notNull(),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  matchedCount: int("matchedCount"),
  exceptionCount: int("exceptionCount"),
  totalTransactions: int("totalTransactions"),
  matchRate: decimal("matchRate", { precision: 5, scale: 2 }),
  errorMessage: text("errorMessage"),
  emailSent: boolean("emailSent").default(false).notNull(),
  emailError: text("emailError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_run_hist_task").on(table.scheduledTaskId),
  index("idx_run_hist_job").on(table.jobId),
  index("idx_run_hist_status").on(table.status),
  index("idx_run_hist_started").on(table.startedAt),
]);

export type ScheduleRunHistory = typeof scheduleRunHistory.$inferSelect;
export type InsertScheduleRunHistory = typeof scheduleRunHistory.$inferInsert;

// ─── Email Report Preferences ───────────────────────────────────────
export const emailPreferences = mysqlTable("email_preferences", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  organizationId: int("organizationId"),
  // Global email settings
  emailEnabled: boolean("emailEnabled").default(true).notNull(),
  defaultRecipients: json("defaultRecipients"), // ["cfo@bank.com", "ops@bank.com"]
  // Report preferences
  includeMatchBreakdown: boolean("includeMatchBreakdown").default(true).notNull(),
  includeExceptionDetails: boolean("includeExceptionDetails").default(true).notNull(),
  includeChannelPerformance: boolean("includeChannelPerformance").default(true).notNull(),
  includeTrendAnalysis: boolean("includeTrendAnalysis").default(false).notNull(),
  // Notification thresholds
  notifyOnCompletion: boolean("notifyOnCompletion").default(true).notNull(),
  notifyOnFailure: boolean("notifyOnFailure").default(true).notNull(),
  notifyOnHighExceptions: boolean("notifyOnHighExceptions").default(true).notNull(),
  highExceptionThreshold: int("highExceptionThreshold").default(10).notNull(), // Notify if exceptions > N
  lowMatchRateThreshold: decimal("lowMatchRateThreshold", { precision: 5, scale: 2 }).default("80.00").notNull(), // Notify if match rate < N%
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_email_pref_user").on(table.userId),
  index("idx_email_pref_org").on(table.organizationId),
]);

export type EmailPreference = typeof emailPreferences.$inferSelect;
export type InsertEmailPreference = typeof emailPreferences.$inferInsert;

// ─── Job Progress Events (for real-time monitoring) ─────────────────
export const jobProgressEvents = mysqlTable("job_progress_events", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  phase: mysqlEnum("phase", [
    "queued", "loading_data", "pass1_exact_match", "pass2_fuzzy_match",
    "pass3_tolerance_match", "duplicate_detection", "reversal_detection",
    "exception_categorization", "ai_analysis", "finalizing", "completed", "failed"
  ]).notNull(),
  progress: int("progress").default(0).notNull(), // 0-100
  message: text("message"),
  processedCount: int("processedCount").default(0).notNull(),
  totalCount: int("totalCount").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_progress_job").on(table.jobId),
  index("idx_progress_phase").on(table.phase),
  index("idx_progress_created").on(table.createdAt),
]);

export type JobProgressEvent = typeof jobProgressEvents.$inferSelect;
export type InsertJobProgressEvent = typeof jobProgressEvents.$inferInsert;

// ─── API Ingestion Logs ──────────────────────────────────────────────
export const apiIngestionLogs = mysqlTable("api_ingestion_logs", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  apiKeyId: int("apiKeyId"), // FK to api_keys table
  endpoint: varchar("endpoint", { length: 255 }).notNull(), // e.g., /api/v1/transactions/upload
  method: varchar("method", { length: 10 }).notNull(), // POST, PUT, etc.
  channelId: int("channelId"),
  fileName: varchar("fileName", { length: 500 }),
  fileHash: varchar("fileHash", { length: 64 }), // SHA-256 for idempotency
  payloadSize: int("payloadSize"), // bytes
  totalRows: int("totalRows"),
  validRows: int("validRows"),
  invalidRows: int("invalidRows"),
  status: mysqlEnum("status", ["success", "failed", "partial"]).notNull(),
  statusCode: int("statusCode"), // HTTP status code
  errorMessage: text("errorMessage"),
  processingTimeMs: int("processingTimeMs"),
  uploadBatchId: int("uploadBatchId"), // FK to upload_batches
  reconciliationJobId: int("reconciliationJobId"), // FK to reconciliation_jobs if auto-reconcile enabled
  ipAddress: varchar("ipAddress", { length: 45 }), // IPv4 or IPv6
  userAgent: text("userAgent"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_api_log_org").on(table.organizationId),
  index("idx_api_log_key").on(table.apiKeyId),
  index("idx_api_log_status").on(table.status),
  index("idx_api_log_created").on(table.createdAt),
  index("idx_api_log_batch").on(table.uploadBatchId),
  index("idx_api_log_hash").on(table.fileHash),
]);

export type ApiIngestionLog = typeof apiIngestionLogs.$inferSelect;
export type InsertApiIngestionLog = typeof apiIngestionLogs.$inferInsert;

// ─── SFTP Credentials ────────────────────────────────────────────────
export const sftpCredentials = mysqlTable("sftp_credentials", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  userId: int("userId").notNull(), // Who created this config
  name: varchar("name", { length: 255 }).notNull(), // Friendly name
  host: varchar("host", { length: 255 }).notNull(),
  port: int("port").default(22).notNull(),
  username: varchar("username", { length: 255 }).notNull(),
  // Password stored encrypted (use platform secrets or vault)
  passwordEncrypted: text("passwordEncrypted"),
  // Or use SSH key
  privateKeyEncrypted: text("privateKeyEncrypted"),
  // Remote path configuration
  remotePath: varchar("remotePath", { length: 500 }).default("/").notNull(), // Directory to monitor
  filePattern: varchar("filePattern", { length: 255 }).default("*.csv").notNull(), // Glob pattern
  archivePath: varchar("archivePath", { length: 500 }), // Where to move processed files
  // Channel mapping
  channelId: int("channelId").notNull(), // Which channel these files belong to
  // Polling configuration
  pollingEnabled: boolean("pollingEnabled").default(true).notNull(),
  pollingIntervalMinutes: int("pollingIntervalMinutes").default(15).notNull(), // Check every N minutes
  // Auto-reconciliation
  autoReconcile: boolean("autoReconcile").default(false).notNull(),
  reconcileTargetChannelId: int("reconcileTargetChannelId"), // If autoReconcile, which channel to reconcile against
  // Status
  isActive: boolean("isActive").default(true).notNull(),
  lastPolledAt: timestamp("lastPolledAt"),
  lastSuccessAt: timestamp("lastSuccessAt"),
  lastErrorAt: timestamp("lastErrorAt"),
  lastErrorMessage: text("lastErrorMessage"),
  totalFilesProcessed: int("totalFilesProcessed").default(0).notNull(),
  totalFilesFailed: int("totalFilesFailed").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_sftp_org").on(table.organizationId),
  index("idx_sftp_user").on(table.userId),
  index("idx_sftp_channel").on(table.channelId),
  index("idx_sftp_active").on(table.isActive),
  index("idx_sftp_polling").on(table.pollingEnabled),
]);

export type SftpCredential = typeof sftpCredentials.$inferSelect;
export type InsertSftpCredential = typeof sftpCredentials.$inferInsert;

// ─── SFTP Ingestion Logs ─────────────────────────────────────────────
export const sftpIngestionLogs = mysqlTable("sftp_ingestion_logs", {
  id: int("id").autoincrement().primaryKey(),
  sftpCredentialId: int("sftpCredentialId").notNull(),
  organizationId: int("organizationId"),
  channelId: int("channelId"),
  fileName: varchar("fileName", { length: 500 }).notNull(),
  filePath: varchar("filePath", { length: 1000 }).notNull(),
  fileSize: bigint("fileSize", { mode: "number" }), // bytes
  fileHash: varchar("fileHash", { length: 64 }), // SHA-256
  totalRows: int("totalRows"),
  validRows: int("validRows"),
  invalidRows: int("invalidRows"),
  status: mysqlEnum("status", ["success", "failed", "partial", "skipped"]).notNull(),
  errorMessage: text("errorMessage"),
  processingTimeMs: int("processingTimeMs"),
  uploadBatchId: int("uploadBatchId"), // FK to upload_batches
  reconciliationJobId: int("reconciliationJobId"), // FK if auto-reconcile
  archivedPath: varchar("archivedPath", { length: 1000 }), // Where file was moved after processing
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_sftp_log_cred").on(table.sftpCredentialId),
  index("idx_sftp_log_org").on(table.organizationId),
  index("idx_sftp_log_status").on(table.status),
  index("idx_sftp_log_created").on(table.createdAt),
  index("idx_sftp_log_hash").on(table.fileHash),
]);

export type SftpIngestionLog = typeof sftpIngestionLogs.$inferSelect;
export type InsertSftpIngestionLog = typeof sftpIngestionLogs.$inferInsert;

// ─── Bucket (object-storage) Drop Ingestion ──────────────────────────
// The S3-compatible sibling of SFTP. Many banks, PSPs and couriers deliver
// settlement files to a bucket rather than an SFTP host, and several prefer it
// (IAM-scoped, no long-lived SSH keys, no host to keep patched).
//
// Deliberately parallel to sftp_credentials rather than shoehorned into it: the
// connection model genuinely differs (bucket/prefix/region/endpoint vs
// host/port/path) and overloading one table would leave half the columns NULL
// for every row. Both feed the SAME processing core, which is where sharing
// actually matters. A future `ingestion_sources` generalisation could unify
// them, but that is a migration of live SFTP config and not worth it yet.
export const bucketIngestionSources = mysqlTable("bucket_ingestion_sources", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  userId: int("userId").notNull(), // Who created this config
  name: varchar("name", { length: 255 }).notNull(),
  /** s3 = AWS; r2/minio/other require an explicit endpoint. */
  provider: mysqlEnum("provider", ["s3", "r2", "minio", "other"]).default("s3").notNull(),
  bucket: varchar("bucket", { length: 255 }).notNull(),
  /** Key prefix to watch, e.g. "settlements/incoming/". Empty = bucket root. */
  prefix: varchar("prefix", { length: 500 }).default("").notNull(),
  region: varchar("region", { length: 64 }).default("auto").notNull(),
  /** Custom S3 endpoint for R2/MinIO. NULL = AWS default for the region. */
  endpoint: varchar("endpoint", { length: 500 }),
  /** Credentials encrypted at rest with the same envelope as SFTP secrets. */
  accessKeyIdEncrypted: text("accessKeyIdEncrypted"),
  secretAccessKeyEncrypted: text("secretAccessKeyEncrypted"),
  filePattern: varchar("filePattern", { length: 255 }).default("*.csv").notNull(),
  /** Move processed objects under this prefix. NULL + deleteAfterProcess=false
   *  leaves them in place (dedupe is by content hash, so that is safe). */
  archivePrefix: varchar("archivePrefix", { length: 500 }),
  deleteAfterProcess: boolean("deleteAfterProcess").default(false).notNull(),
  channelId: int("channelId").notNull(),
  pollingEnabled: boolean("pollingEnabled").default(true).notNull(),
  pollingIntervalMinutes: int("pollingIntervalMinutes").default(15).notNull(),
  autoReconcile: boolean("autoReconcile").default(false).notNull(),
  reconcileTargetChannelId: int("reconcileTargetChannelId"),
  isActive: boolean("isActive").default(true).notNull(),
  lastPolledAt: timestamp("lastPolledAt"),
  lastSuccessAt: timestamp("lastSuccessAt"),
  lastErrorAt: timestamp("lastErrorAt"),
  lastErrorMessage: text("lastErrorMessage"),
  totalFilesProcessed: int("totalFilesProcessed").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_bucket_src_org").on(table.organizationId),
  index("idx_bucket_src_channel").on(table.channelId),
  index("idx_bucket_src_active").on(table.isActive),
]);

export type BucketIngestionSource = typeof bucketIngestionSources.$inferSelect;
export type InsertBucketIngestionSource = typeof bucketIngestionSources.$inferInsert;

export const bucketIngestionLogs = mysqlTable("bucket_ingestion_logs", {
  id: int("id").autoincrement().primaryKey(),
  bucketSourceId: int("bucketSourceId").notNull(),
  organizationId: int("organizationId").notNull(),
  channelId: int("channelId").notNull(),
  objectKey: varchar("objectKey", { length: 1000 }).notNull(),
  fileSize: int("fileSize"),
  /** SHA-256 over the object's BYTES — the idempotency key for re-polling. */
  fileHash: varchar("fileHash", { length: 64 }),
  totalRows: int("totalRows"),
  validRows: int("validRows"),
  invalidRows: int("invalidRows"),
  status: mysqlEnum("status", ["success", "failed", "partial", "skipped"]).notNull(),
  errorMessage: text("errorMessage"),
  processingTimeMs: int("processingTimeMs"),
  uploadBatchId: int("uploadBatchId"),
  reconciliationJobId: int("reconciliationJobId"),
  archivedKey: varchar("archivedKey", { length: 1000 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_bucket_log_src").on(table.bucketSourceId),
  index("idx_bucket_log_org").on(table.organizationId),
  index("idx_bucket_log_status").on(table.status),
  index("idx_bucket_log_hash").on(table.fileHash),
  index("idx_bucket_log_created").on(table.createdAt),
]);

export type BucketIngestionLog = typeof bucketIngestionLogs.$inferSelect;
export type InsertBucketIngestionLog = typeof bucketIngestionLogs.$inferInsert;

// ─── Email-forward Ingestion (Tier A) ────────────────────────────────
// The genuinely plug-and-play transport: the merchant sets ONE forwarding rule
// in their mail client and every provider that emails a payout report works,
// with no API, no credentials and no per-provider integration.
//
// It is also the only surface where an unauthenticated stranger can hand us a
// file, so it carries two independent controls rather than one:
//   1. addressToken — unguessable, per source. Knowing the address is required.
//   2. allowedSenders — knowing the address is NOT sufficient; the sender must
//      also match. An EMPTY allow-list rejects everything (fail closed), so a
//      half-configured source can never be an open inbox.
export const emailIngestionSources = mysqlTable("email_ingestion_sources", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  /** Random, unguessable local-part suffix: settle-<addressToken>@<domain>. */
  addressToken: varchar("addressToken", { length: 64 }).notNull(),
  /**
   * Newline/comma separated senders permitted to deliver here. Entries are
   * either a full address ("payouts@stripe.com") or a domain ("@stripe.com").
   * Empty means NOTHING is accepted — never "accept anything".
   */
  allowedSenders: text("allowedSenders"),
  channelId: int("channelId").notNull(),
  /** Reject attachments above this size before downloading them. */
  maxAttachmentBytes: int("maxAttachmentBytes").default(10485760).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  lastReceivedAt: timestamp("lastReceivedAt"),
  lastErrorAt: timestamp("lastErrorAt"),
  lastErrorMessage: text("lastErrorMessage"),
  totalFilesProcessed: int("totalFilesProcessed").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("idx_email_src_token").on(table.addressToken),
  index("idx_email_src_org").on(table.organizationId),
  index("idx_email_src_active").on(table.isActive),
]);

export type EmailIngestionSource = typeof emailIngestionSources.$inferSelect;
export type InsertEmailIngestionSource = typeof emailIngestionSources.$inferInsert;

// Every inbound delivery is logged, ACCEPTED OR NOT. A rejected message is the
// more interesting record: it is how a leaked address or a probing sender
// becomes visible instead of silently disappearing.
export const emailIngestionLogs = mysqlTable("email_ingestion_logs", {
  id: int("id").autoincrement().primaryKey(),
  /** Null when the address matched no source — we still record the attempt. */
  emailSourceId: int("emailSourceId"),
  organizationId: int("organizationId"),
  channelId: int("channelId"),
  /** Provider message id — the idempotency key against webhook retries. */
  providerMessageId: varchar("providerMessageId", { length: 255 }),
  fromAddress: varchar("fromAddress", { length: 320 }),
  toAddress: varchar("toAddress", { length: 320 }),
  subject: varchar("subject", { length: 500 }),
  attachmentName: varchar("attachmentName", { length: 500 }),
  fileSize: int("fileSize"),
  fileHash: varchar("fileHash", { length: 64 }),
  totalRows: int("totalRows"),
  validRows: int("validRows"),
  invalidRows: int("invalidRows"),
  status: mysqlEnum("status", ["success", "partial", "failed", "rejected", "skipped"]).notNull(),
  /** Why a delivery was refused — unknown_address, sender_not_allowed, … */
  rejectionReason: varchar("rejectionReason", { length: 64 }),
  errorMessage: text("errorMessage"),
  uploadBatchId: int("uploadBatchId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_email_log_src").on(table.emailSourceId),
  index("idx_email_log_org").on(table.organizationId),
  index("idx_email_log_status").on(table.status),
  index("idx_email_log_msg").on(table.providerMessageId),
  index("idx_email_log_created").on(table.createdAt),
]);

export type EmailIngestionLog = typeof emailIngestionLogs.$inferSelect;
export type InsertEmailIngestionLog = typeof emailIngestionLogs.$inferInsert;

// ─── User Role Preferences ───────────────────────────────────────────
export const userRolePreferences = mysqlTable("user_role_preferences", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  organizationId: int("organizationId"),
  // Role-specific view preferences
  defaultView: mysqlEnum("defaultView", ["cfo", "operations", "auditor", "standard"]).default("standard").notNull(),
  // Widget visibility and ordering (JSON array of widget IDs)
  visibleWidgets: json("visibleWidgets"), // ["match_rate", "exceptions", "channel_health", ...]
  widgetOrder: json("widgetOrder"), // [1, 3, 2, 4, ...] for drag-and-drop reordering
  // Data filters
  defaultChannelFilter: json("defaultChannelFilter"), // [channelId1, channelId2, ...]
  defaultDateRange: varchar("defaultDateRange", { length: 50 }).default("7d").notNull(), // "7d", "30d", "90d", "custom"
  // Notification preferences
  desktopNotifications: boolean("desktopNotifications").default(false).notNull(),
  emailDigestFrequency: mysqlEnum("emailDigestFrequency", ["none", "daily", "weekly"]).default("none").notNull(),
  // Theme and display
  theme: mysqlEnum("theme", ["light", "dark", "auto"]).default("light").notNull(),
  compactMode: boolean("compactMode").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("idx_role_pref_user_org").on(table.userId, table.organizationId),
  index("idx_role_pref_user").on(table.userId),
  index("idx_role_pref_view").on(table.defaultView),
]);

export type UserRolePreference = typeof userRolePreferences.$inferSelect;
export type InsertUserRolePreference = typeof userRolePreferences.$inferInsert;

// ─── Anomaly Detection ───────────────────────────────────────────────
export const anomalyScores = mysqlTable("anomaly_scores", {
  id: int("id").autoincrement().primaryKey(),
  transactionId: int("transactionId").notNull(),
  organizationId: int("organizationId"),
  anomalyScore: decimal("anomalyScore", { precision: 5, scale: 4 }).notNull(), // 0.0000 to 1.0000
  detectionMethod: mysqlEnum("detectionMethod", [
    "statistical_zscore",
    "statistical_iqr",
    "pattern_time",
    "pattern_frequency",
    "pattern_counterparty",
    "llm_semantic",
    "ensemble",
  ]).notNull(),
  detectionReason: text("detectionReason"), // Human-readable explanation
  detectionMetadata: json("detectionMetadata"), // Method-specific details
  isFlagged: boolean("isFlagged").default(true).notNull(),
  reviewStatus: mysqlEnum("reviewStatus", ["pending", "false_positive", "confirmed", "escalated", "resolved"])
    .default("pending")
    .notNull(),
  reviewedBy: int("reviewedBy"),
  reviewedAt: timestamp("reviewedAt"),
  reviewNotes: text("reviewNotes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_anomaly_txn").on(table.transactionId),
  index("idx_anomaly_org").on(table.organizationId),
  index("idx_anomaly_score").on(table.anomalyScore),
  index("idx_anomaly_flagged").on(table.isFlagged),
  index("idx_anomaly_review").on(table.reviewStatus),
  index("idx_anomaly_method").on(table.detectionMethod),
]);

export type AnomalyScore = typeof anomalyScores.$inferSelect;
export type InsertAnomalyScore = typeof anomalyScores.$inferInsert;

export const detectionRules = mysqlTable("detection_rules", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  ruleName: varchar("ruleName", { length: 255 }).notNull(),
  ruleType: mysqlEnum("ruleType", [
    "amount_outlier",
    "time_pattern",
    "frequency_spike",
    "counterparty_anomaly",
    "description_suspicious",
    "velocity_check",
    "round_amount",
  ]).notNull(),
  threshold: decimal("threshold", { precision: 10, scale: 4 }).notNull(), // Rule-specific threshold
  isEnabled: boolean("isEnabled").default(true).notNull(),
  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]).default("medium").notNull(),
  ruleConfig: json("ruleConfig"), // Rule-specific parameters
  description: text("description"),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_rules_org").on(table.organizationId),
  index("idx_rules_type").on(table.ruleType),
  index("idx_rules_enabled").on(table.isEnabled),
]);

export type DetectionRule = typeof detectionRules.$inferSelect;
export type InsertDetectionRule = typeof detectionRules.$inferInsert;

// ─── Guest Sessions ───────────────────────────────────────────────────
export const guestSessions = mysqlTable("guest_sessions", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: varchar("sessionId", { length: 64 }).notNull().unique(),
  guestUserId: int("guestUserId").notNull(), // References users table
  guestOrganizationId: int("guestOrganizationId").notNull(), // References organizations table
  demoDataSeeded: boolean("demoDataSeeded").default(false).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_guest_sessions_expires").on(table.expiresAt),
  index("idx_guest_sessions_user").on(table.guestUserId),
]);

export type GuestSession = typeof guestSessions.$inferSelect;
export type InsertGuestSession = typeof guestSessions.$inferInsert;

// ─── Resolution Templates ────────────────────────────────────────────
// Single source of truth for template categories — the zod input enums in
// routers.ts and the seeder in seedResolutionTemplates.ts derive from this.
// Core reconciliation categories first, then the mobile money taxonomy
// (Nigeria: CBN/NIBSS — Uganda: BoU NPS framework).
export const RESOLUTION_TEMPLATE_CATEGORIES = [
  "unmatched",
  "missing_counterparty",
  "amount_mismatch",
  "timing_difference",
  "duplicate_transaction",
  "reversal_unmatched",
  "currency_mismatch",
  "fx_rate_variance",
  "format_error",
  // Mobile money — Nigeria
  "mm_failed_ussd_debit",
  "mm_reversal_not_credited",
  "mm_nip_settlement_shortfall",
  "mm_duplicate_credit",
  "mm_expired_session_debit",
  "mm_amount_mismatch",
  "mm_unmatched_nip_inflow",
  "mm_operator_fee_variance",
  // Mobile money — Uganda
  "mm_wallet_to_bank_failed",
  "mm_bank_to_wallet_failed",
  "mm_withdrawal_tax_variance",
  "mm_momo_settlement_shortfall",
  // Mobile money — Nigeria wallets (WS-8)
  "mm_wallet_credit_failed",
  "mm_wallet_debit_reversed",
  "mm_wallet_settlement_shortfall",
  // LAPO MFB multi-source integration (server/connectors/lapo/exceptions.ts)
  "lapo_ussd_debit_no_value",
  "lapo_nip_inward_not_credited",
  "lapo_nip_outward_debit_unsettled",
  "lapo_card_settlement_short",
  "lapo_agent_float_mismatch",
  "lapo_ledger_orphan",
  "lapo_channel_orphan",
  "lapo_cross_channel_duplicate",
  "lapo_settlement_timing_lag",
  "lapo_fee_commission_variance",
  // ═══ Nigerian Payment Channel Exceptions (server/exceptions/) ═══════════════
  // NIP (NIBSS Instant Payment)
  "nip_timeout_debit_no_credit",
  "nip_inward_credit_not_applied",
  "nip_duplicate_transfer",
  "nip_wrong_account_credit",
  "nip_name_enquiry_mismatch",
  "nip_settlement_reconciliation_break",
  "nip_beneficiary_bank_offline",
  "nip_dry_posting",
  // NEFT (NIBSS Electronic Funds Transfer)
  "neft_batch_rejection",
  "neft_return_item",
  "neft_stale_dated_item",
  "neft_settlement_shortfall",
  "neft_duplicate_batch_item",
  "neft_timing_difference",
  // RTGS (Real-Time Gross Settlement)
  "rtgs_insufficient_settlement_balance",
  "rtgs_queue_priority_delay",
  "rtgs_value_date_discrepancy",
  "rtgs_message_format_rejection",
  "rtgs_cut_off_time_breach",
  "rtgs_duplicate_instruction",
  // POS (Point of Sale)
  "pos_declined_but_debited",
  "pos_settlement_shortfall",
  "pos_chargeback",
  "pos_offline_batch_mismatch",
  "pos_terminal_id_mismatch",
  "pos_duplicate_transaction",
  "pos_merchant_not_settled",
  "pos_interchange_fee_variance",
  // ATM (Automated Teller Machine)
  "atm_dispense_error_on_us",
  "atm_dispense_error_not_on_us",
  "atm_short_dispense",
  "atm_journal_switch_mismatch",
  "atm_card_captured_transaction",
  "atm_cash_count_variance",
  "atm_biometric_fallback_debit",
  // QR Payments (NQR)
  "qr_expired_code_debit",
  "qr_amount_mismatch",
  "qr_merchant_not_settled",
  "qr_duplicate_scan_payment",
  "qr_wrong_merchant_credited",
  // Direct Debit / Standing Order
  "dd_mandate_expired_debit",
  "dd_insufficient_funds",
  "dd_disputed_unauthorized_debit",
  "dd_amount_exceeds_mandate",
  "dd_advance_notice_not_given",
  "dd_cancelled_mandate_debit",
  "dd_wrong_account_debited",
  // SWIFT / Correspondent Banking
  "swift_intermediary_charges_deduction",
  "swift_value_date_discrepancy",
  "swift_sanctions_screening_hold",
  "swift_nostro_vostro_mismatch",
  "swift_wrong_beneficiary_details",
  "swift_fx_rate_variance",
  "swift_duplicate_payment",
  "swift_inward_credit_not_applied",
  // IMTO / Remittance
  "imto_fx_rate_variance",
  "imto_beneficiary_not_paid",
  "imto_wrong_beneficiary_paid",
  "imto_kyc_rejection_funds_held",
  "imto_settlement_account_shortfall",
  "imto_duplicate_payout",
  // Fintech Payment Gateways
  "gateway_settlement_vs_transaction_mismatch",
  "gateway_delayed_settlement",
  "gateway_fee_discrepancy",
  "gateway_chargeback_deduction",
  "gateway_split_payment_variance",
  "gateway_webhook_notification_failure",
  "gateway_refund_not_reflected",
  "gateway_currency_conversion_variance",
  // Bill Payments (eBillsPay)
  "bill_customer_debited_biller_not_credited",
  "bill_duplicate_payment",
  "bill_wrong_biller_code",
  "bill_amount_mismatch",
  "bill_expired_bill_payment",
  "bill_biller_rejection_refund_delay",
  // Bulk / Salary Payments
  "bulk_partial_batch_failure",
  "bulk_duplicate_batch_upload",
  "bulk_invalid_account_in_batch",
  "bulk_insufficient_funds_for_batch",
  "bulk_amount_variance",
  "bulk_settlement_timing_lag",
  // CBN eTreasury / TSA
  "tsa_remittance_failure",
  "tsa_wrong_sub_account",
  "tsa_collection_shortfall",
  "tsa_duplicate_remittance",
  "tsa_fx_conversion_variance",
  // Mobile / USSD / Agent Banking
  "ussd_timeout_debit",
  "ussd_session_hijack_dispute",
  "mobile_app_transaction_not_posted",
  "agent_banking_float_reconciliation",
  "agent_cash_in_not_credited",
  "agent_cash_out_reversal",
  "mobile_duplicate_transfer",
  // ═══ Retail / E-Commerce Exceptions (SHOPLINE vertical) ═══════════════════
  "retail_chargeback_not_posted",
  "retail_chargeback_duplicate",
  "retail_gateway_fee_variance",
  "retail_fx_rate_mismatch",
  "retail_settlement_shortfall",
  "retail_settlement_delay",
  "retail_refund_not_settled",
  "retail_duplicate_authorisation",
  "retail_void_not_reversed",
  "retail_partial_capture_mismatch",
  "retail_currency_conversion_error",
  "retail_payout_delay",
  "retail_reserve_hold_unexplained",
  "retail_interchange_misclassification",
  // Retail expansion (research round 2): order↔payment integrity, COD, dispute
  // lifecycle, payout↔bank leg, platform economics, batch integrity, split tender
  "retail_order_payment_amount_mismatch",
  "retail_cod_remittance_variance",
  "retail_refund_duplicate",
  "retail_dispute_won_not_credited",
  "retail_dispute_fee_error",
  "retail_payout_bank_variance",
  "retail_tax_deduction_variance",
  "retail_platform_commission_variance",
  "retail_settlement_duplicate",
  "retail_settlement_batch_missing",
  "retail_gift_card_split_mismatch",
  // Uganda market pack (server/exceptions/uganda.ts) — BoU NPS framework
  "ug_trust_account_mismatch",
  "ug_suspense_aged_entry",
  "ug_momo_debit_no_credit",
  "ug_reversal_not_credited",
  "ug_agent_rail_settlement_variance",
  "ug_agent_float_trapped",
  "ug_interop_transfer_lag",
  "ug_uniss_settlement_break",
  "ug_ach_return_unprocessed",
  "ug_excise_duty_variance",
  "ug_card_switch_variance",
  "ug_wallet_liability_orphan",
  // Uganda round 2 — bill/utility, digital lending, aggregator, integrity
  "ug_bill_payment_no_token",
  "ug_airtime_data_not_delivered",
  "ug_digital_loan_disbursement_mismatch",
  "ug_digital_loan_repayment_unapplied",
  "ug_dormant_wallet_balance",
  "ug_duplicate_wallet_credit",
  "ug_orphan_reversal",
  "ug_aggregator_settlement_variance",
  "ug_agent_commission_variance",
  "ug_fx_settlement_variance",
  // Card Switching & Processors (Interswitch / UP / eTranzact)
  "card_switch_settlement_variance",
  "card_rrn_stan_mismatch",
  "card_stip_no_advice",
  "card_switch_timeout_reversal_missing",
  "card_partial_reversal_variance",
  "card_force_post_no_auth",
  "card_duplicate_presentment",
  "card_late_presentment",
  "card_ptsp_settlement_split_variance",
  "card_switch_fee_variance",
  // Card Schemes (Verve / AfriGO / Visa / Mastercard)
  "scheme_net_settlement_variance",
  "scheme_clearing_file_gap",
  "scheme_interchange_downgrade",
  "scheme_fee_assessment_variance",
  "scheme_fx_settlement_variance",
  "scheme_cutover_timing_break",
  "verve_domestic_settlement_break",
  "afrigo_settlement_break",
  "scheme_compliance_penalty_charge",
  // Card Disputes & Chargebacks
  "chargeback_inbound_acquirer",
  "chargeback_outbound_issuer_credit_pending",
  "chargeback_representment_deadline",
  "chargeback_pre_arbitration",
  "chargeback_arbitration_case",
  "chargeback_fraud_coded",
  "chargeback_won_credit_not_posted",
  "chargeback_right_expired",
  "dispute_good_faith_recovery",
  // Cheque clearing — NIBSS NACS / Cheque Truncation (server/exceptions/cheque.ts)
  "cheque_returned_credit_not_reversed",
  "cheque_duplicate_presentment",
  "cheque_dud_not_reported",
  "cheque_clearing_settlement_variance",
  "cheque_micr_ledger_mismatch",
  "cheque_value_limit_breach",
  "cheque_stale_or_postdated_paid",
  "cheque_outward_not_cleared",
  "cheque_unpresented_aged",
  // Non-interest (NIFI) banking — selected by organizations.bankingModel rather
  // than by channel, since it spans every rail (server/exceptions/non-interest.ts)
  "nifi_interest_bearing_entry",
  "nifi_commingling_breach",
  "nifi_non_permissible_income_unsegregated",
  "nifi_late_payment_charge_to_income",
  "nifi_profit_distribution_variance",
  "nifi_per_irr_movement_unapproved",
  "nifi_murabaha_profit_accrual_mismatch",
  "nifi_ijara_rental_unmatched",
  "nifi_salam_istisna_milestone_mismatch",
  "nifi_wakala_fee_variance",
] as const;
export type ResolutionTemplateCategory = (typeof RESOLUTION_TEMPLATE_CATEGORIES)[number];

export const resolutionTemplates = mysqlTable("resolution_templates", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  category: mysqlEnum("category", RESOLUTION_TEMPLATE_CATEGORIES).notNull(),
  templateText: text("templateText").notNull(),
  isDefault: boolean("isDefault").default(false).notNull(),
  createdBy: int("createdBy").notNull(), // References users table
  organizationId: int("organizationId"), // References organizations table
  // Dedupe guard for the seeded GLOBAL defaults only. Set to
  // `default:<category>:<name>` for org-less default rows, NULL for everything
  // else. A unique index on it makes seeding race-proof. A plain unique index on
  // organizationId+category+name would NOT work here: MySQL treats the NULL
  // organizationId of global defaults as always-distinct, so it would permit
  // duplicates. Multiple NULLs are allowed, so user/org templates stay unconstrained.
  dedupeKey: varchar("dedupe_key", { length: 191 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_resolution_templates_category").on(table.category),
  index("idx_resolution_templates_org").on(table.organizationId),
  uniqueIndex("uniq_resolution_template_dedupe").on(table.dedupeKey),
]);

export type ResolutionTemplate = typeof resolutionTemplates.$inferSelect;
export type InsertResolutionTemplate = typeof resolutionTemplates.$inferInsert;

// ─── Module Configurations ──────────────────────────────────────────
export const moduleConfigurations = mysqlTable("module_configurations", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  moduleType: mysqlEnum("moduleType", ["settlement", "account_level"]).notNull(),
  isEnabled: boolean("isEnabled").default(true).notNull(),
  configuration: json("configuration"), // Module-specific settings
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_module_config_org").on(table.organizationId),
  index("idx_module_config_type").on(table.moduleType),
  uniqueIndex("unique_org_module").on(table.organizationId, table.moduleType),
]);

export type ModuleConfiguration = typeof moduleConfigurations.$inferSelect;
export type InsertModuleConfiguration = typeof moduleConfigurations.$inferInsert;

// ─── Super Admin Module Overrides (per-institution control) ──────────────────
// Infinity AI staff can force-enable or force-disable a module for any org,
// overriding the org's own toggle. If no override exists, the org's own setting applies.
export const moduleOverrides = mysqlTable("module_overrides", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  moduleType: mysqlEnum("moduleType", ["settlement", "account_level"]).notNull(),
  isEnabled: boolean("isEnabled").notNull(), // super admin forced value
  reason: varchar("reason", { length: 500 }), // optional note from super admin
  setByUserId: int("setByUserId").notNull(), // super admin user id
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_module_override_org").on(table.organizationId),
  uniqueIndex("unique_org_module_override").on(table.organizationId, table.moduleType),
]);

export type ModuleOverride = typeof moduleOverrides.$inferSelect;
export type InsertModuleOverride = typeof moduleOverrides.$inferInsert;

// ─── Distributor Identity Registry ──────────────────────────────────
export const distributors = mysqlTable("distributors", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  canonicalId: varchar("canonicalId", { length: 32 }).notNull(), // e.g. DIST-0042
  canonicalName: varchar("canonicalName", { length: 255 }).notNull(),
  registeredBusinessName: varchar("registeredBusinessName", { length: 255 }),
  taxId: varchar("taxId", { length: 64 }),
  primaryBankAccount: varchar("primaryBankAccount", { length: 64 }),
  primaryBankName: varchar("primaryBankName", { length: 128 }),
  contactEmail: varchar("contactEmail", { length: 255 }),
  contactPhone: varchar("contactPhone", { length: 32 }),
  zone: varchar("zone", { length: 128 }), // e.g. Lagos Zone A
  status: mysqlEnum("status", ["active", "inactive", "pending_confirmation", "flagged"]).default("active").notNull(),
  nameVariants: json("nameVariants"), // string[] of known aliases
  totalPaymentsMatched: int("totalPaymentsMatched").default(0).notNull(),
  totalAmountMatched: decimal("totalAmountMatched", { precision: 18, scale: 2 }).default("0").notNull(),
  lastPaymentAt: timestamp("lastPaymentAt"),
  confirmedBy: int("confirmedBy"), // userId who last confirmed
  confirmedAt: timestamp("confirmedAt"),
  notes: text("notes"),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_distributors_org").on(table.organizationId),
  index("idx_distributors_status").on(table.status),
  uniqueIndex("unique_canonical_id_org").on(table.organizationId, table.canonicalId),
]);
export type Distributor = typeof distributors.$inferSelect;
export type InsertDistributor = typeof distributors.$inferInsert;

// ─── Super Agent: Action Draft Layer ────────────────────────────────
export const agentActionDrafts = mysqlTable("agent_action_drafts", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  exceptionId: int("exceptionId"),                   // FK to exceptions table (nullable for standalone)
  transactionRef: varchar("transactionRef", { length: 128 }),
  actionType: mysqlEnum("actionType", [
    "vendor_email",
    "credit_note_request",
    "journal_entry",
    "payment_allocation",
    "escalate_to_manager",
    "no_action",
  ]).notNull(),
  subject: varchar("subject", { length: 512 }).notNull(),
  body: text("body").notNull(),
  metadata: json("metadata"),                        // Record<string, string|number>
  status: mysqlEnum("status", [
    "pending_approval",
    "approved",
    "rejected",
    "executed",
    "modified",
  ]).default("pending_approval").notNull(),
  diagnosisCategory: varchar("diagnosisCategory", { length: 64 }),
  diagnosisConfidence: int("diagnosisConfidence"),
  shortfallAmount: decimal("shortfallAmount", { precision: 18, scale: 2 }),
  currency: varchar("currency", { length: 8 }).default("NGN").notNull(),
  createdByAgent: tinyint("createdByAgent").default(1).notNull(),  // 1 = AI generated
  approvedBy: int("approvedBy"),
  approvedAt: timestamp("approvedAt"),
  rejectedBy: int("rejectedBy"),
  rejectedAt: timestamp("rejectedAt"),
  rejectionReason: text("rejectionReason"),
  executedAt: timestamp("executedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_action_drafts_org").on(table.organizationId),
  index("idx_action_drafts_status").on(table.status),
  index("idx_action_drafts_exception").on(table.exceptionId),
]);
export type AgentActionDraft = typeof agentActionDrafts.$inferSelect;
export type InsertAgentActionDraft = typeof agentActionDrafts.$inferInsert;

// ─── Super Agent: Semantic Memory Layer ─────────────────────────────
export const agentMemory = mysqlTable("agent_memory", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  exceptionId: int("exceptionId"),
  exceptionCategory: varchar("exceptionCategory", { length: 64 }).notNull(),
  transactionRef: varchar("transactionRef", { length: 128 }),
  amountRange: mysqlEnum("amountRange", ["0-100k", "100k-1m", "1m+"]).notNull(),
  counterpartyType: varchar("counterpartyType", { length: 64 }).default("distributor").notNull(),
  deductionType: varchar("deductionType", { length: 64 }),
  resolution: text("resolution").notNull(),          // what action was taken
  outcome: mysqlEnum("outcome", ["resolved", "escalated", "rejected"]).default("resolved").notNull(),
  reasoning: text("reasoning").notNull(),            // why this resolution was chosen
  embeddingText: text("embeddingText").notNull(),    // tokenised text for similarity search
  resolvedBy: int("resolvedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_agent_memory_org").on(table.organizationId),
  index("idx_agent_memory_category").on(table.exceptionCategory),
]);
export type AgentMemoryRecord = typeof agentMemory.$inferSelect;
export type InsertAgentMemoryRecord = typeof agentMemory.$inferInsert;

// ─── Exception Intelligence Layer (anonymized network effect) ────────
// Shares only coarse, non-personal categorical PATTERN signatures — never
// transaction data, amounts, references, names, or free text. See
// docs/exception-intelligence-dpia.md and server/exceptionIntelligence.ts.

// An org's locally-derived pattern signatures (its contributions to the pool).
export const exceptionPatternSignatures = mysqlTable("exception_pattern_signatures", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  // Deterministic hash of the categorical tuple below (the shareable identity).
  signatureHash: varchar("signatureHash", { length: 64 }).notNull(),
  exceptionCategory: varchar("exceptionCategory", { length: 64 }).notNull(),
  amountBucket: mysqlEnum("amountBucket", ["0-100k", "100k-1m", "1m+"]).notNull(),
  counterpartyType: varchar("counterpartyType", { length: 64 }).notNull(),
  deductionType: varchar("deductionType", { length: 64 }),
  // Fixed enum action class — NOT the free-text resolution.
  resolutionActionClass: varchar("resolutionActionClass", { length: 48 }).notNull(),
  outcome: mysqlEnum("outcome", ["resolved", "escalated", "rejected"]).notNull(),
  // How many times this org has observed/resolved this pattern.
  observationCount: int("observationCount").default(1).notNull(),
  sharedAt: timestamp("sharedAt"), // null until contributed to the pool
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_eps_org").on(table.organizationId),
  index("idx_eps_sig").on(table.signatureHash),
  index("idx_eps_org_sig").on(table.organizationId, table.signatureHash),
]);
export type ExceptionPatternSignature = typeof exceptionPatternSignatures.$inferSelect;
export type InsertExceptionPatternSignature = typeof exceptionPatternSignatures.$inferInsert;

// Per-org opt-in/out for the intelligence layer (default ON).
export const exceptionIntelligenceSettings = mysqlTable("exception_intelligence_settings", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull().unique(),
  // Opt-in (default OFF). Contribution and consumption are coupled (reciprocity):
  // they are always equal — a bank benefits from the pool only if it also contributes.
  shareEnabled: boolean("shareEnabled").default(false).notNull(),   // contribute anonymized patterns
  consumeEnabled: boolean("consumeEnabled").default(false).notNull(), // benefit from the pool
  // Stable pseudonym for this contributor — the pool never sees the org id/name.
  contributorPseudonym: varchar("contributorPseudonym", { length: 64 }),
  lastSharedAt: timestamp("lastSharedAt"),
  lastConsumedAt: timestamp("lastConsumedAt"),
  // Consumption counters — power the internal "recommendations informed by
  // cross-institution patterns" KPI (gap-closure plan WS-5). requests = pool
  // lookups attempted while participating; hits = lookups that returned
  // k-anonymous patterns.
  consumeRequests: int("consumeRequests").default(0).notNull(),
  consumeHits: int("consumeHits").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_eis_org").on(table.organizationId),
]);
export type ExceptionIntelligenceSettings = typeof exceptionIntelligenceSettings.$inferSelect;
export type InsertExceptionIntelligenceSettings = typeof exceptionIntelligenceSettings.$inferInsert;

// Aggregated patterns received FROM the pool (consumed). In a multi-tenant cloud
// these mirror cross-org aggregates; in on-prem they are pulled from the
// EXCEPTION_INTEL_ENDPOINT. contributorCount is the k (distinct orgs) — only
// patterns meeting the k-anonymity threshold are stored/served.
export const sharedExceptionPatterns = mysqlTable("shared_exception_patterns", {
  id: int("id").autoincrement().primaryKey(),
  signatureHash: varchar("signatureHash", { length: 64 }).notNull().unique(),
  exceptionCategory: varchar("exceptionCategory", { length: 64 }).notNull(),
  amountBucket: mysqlEnum("amountBucket", ["0-100k", "100k-1m", "1m+"]).notNull(),
  counterpartyType: varchar("counterpartyType", { length: 64 }).notNull(),
  deductionType: varchar("deductionType", { length: 64 }),
  resolutionActionClass: varchar("resolutionActionClass", { length: 48 }).notNull(),
  outcome: mysqlEnum("outcome", ["resolved", "escalated", "rejected"]).notNull(),
  contributorCount: int("contributorCount").default(0).notNull(), // k — distinct orgs
  observationCount: int("observationCount").default(0).notNull(),  // total observations across orgs
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_sep_sig").on(table.signatureHash),
  index("idx_sep_category").on(table.exceptionCategory),
]);
export type SharedExceptionPattern = typeof sharedExceptionPatterns.$inferSelect;
export type InsertSharedExceptionPattern = typeof sharedExceptionPatterns.$inferInsert;

// ─── Guest Demo Tokens ───────────────────────────────────────────────
export const guestTokens = mysqlTable("guest_tokens", {
  id: int("id").autoincrement().primaryKey(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  createdBy: int("createdBy").notNull(),
  organizationId: int("organizationId"),
  label: varchar("label", { length: 128 }).default("Demo Link"),
  expiresAt: timestamp("expiresAt").notNull(),
  viewCount: int("viewCount").default(0).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_guest_tokens_token").on(table.token),
  index("idx_guest_tokens_created_by").on(table.createdBy),
]);
export type GuestToken = typeof guestTokens.$inferSelect;
export type InsertGuestToken = typeof guestTokens.$inferInsert;

// ─── Demo Request Leads ──────────────────────────────────────────────
export const demoRequests = mysqlTable("demo_requests", {
  id: int("id").autoincrement().primaryKey(),
  companyName: varchar("companyName", { length: 256 }).notNull(),
  contactEmail: varchar("contactEmail", { length: 256 }).notNull(),
  monthlyPaymentVolume: varchar("monthlyPaymentVolume", { length: 64 }),
  message: text("message"),
  source: varchar("source", { length: 64 }).default("corporate_b2b_landing"),
  status: mysqlEnum("status", ["new", "contacted", "qualified", "closed"]).default("new").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_demo_requests_status").on(table.status),
  index("idx_demo_requests_email").on(table.contactEmail),
]);
export type DemoRequest = typeof demoRequests.$inferSelect;
export type InsertDemoRequest = typeof demoRequests.$inferInsert;

// ─── Dashboard Stats Cache ───────────────────────────────────────────
// Pre-computed stats to avoid full table scans on 26M+ transaction rows
export const dashboardStatsCache = mysqlTable("dashboard_stats_cache", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  totalTransactions: bigint("totalTransactions", { mode: "number" }).default(0).notNull(),
  matchedTransactions: bigint("matchedTransactions", { mode: "number" }).default(0).notNull(),
  unmatchedTransactions: bigint("unmatchedTransactions", { mode: "number" }).default(0).notNull(),
  exceptionTransactions: bigint("exceptionTransactions", { mode: "number" }).default(0).notNull(),
  totalJobs: int("totalJobs").default(0).notNull(),
  completedJobs: int("completedJobs").default(0).notNull(),
  runningJobs: int("runningJobs").default(0).notNull(),
  avgMatchRate: decimal("avgMatchRate", { precision: 5, scale: 2 }).default("0.00").notNull(),
  totalExceptions: int("totalExceptions").default(0).notNull(),
  openExceptions: int("openExceptions").default(0).notNull(),
  inReviewExceptions: int("inReviewExceptions").default(0).notNull(),
  resolvedExceptions: int("resolvedExceptions").default(0).notNull(),
  lastUpdatedAt: timestamp("lastUpdatedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_stats_cache_org").on(table.organizationId),
]);
export type DashboardStatsCache = typeof dashboardStatsCache.$inferSelect;
export type InsertDashboardStatsCache = typeof dashboardStatsCache.$inferInsert;

// ─── Compliance Settings (NDPA/NDPR — NDA Clause 11) ────────────────
// Stores org-level data protection officer contact, retention policy,
// and compliance programme status as required by the LAPO MFB NDA.
export const complianceSettings = mysqlTable("compliance_settings", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  // DPO / Privacy Officer contact (Clause 11(a))
  dpoName: varchar("dpoName", { length: 255 }),
  dpoEmail: varchar("dpoEmail", { length: 320 }),
  dpoPhone: varchar("dpoPhone", { length: 50 }),
  // Data retention policy (Clause 2 & 7)
  retentionPeriodDays: int("retentionPeriodDays").default(1825).notNull(), // 5 years default
  autoDeleteEnabled: boolean("autoDeleteEnabled").default(false).notNull(),
  // Compliance programme status flags (Clause 11)
  ndpaCompliant: boolean("ndpaCompliant").default(false).notNull(),
  ndprCompliant: boolean("ndprCompliant").default(false).notNull(),
  ropaCompleted: boolean("ropaCompleted").default(false).notNull(), // Record of Processing Activities
  lastAuditDate: timestamp("lastAuditDate"),
  nextAuditDate: timestamp("nextAuditDate"),
  // Breach notification contact (Clause 12)
  breachNotificationEmail: varchar("breachNotificationEmail", { length: 320 }),
  // NITDA NDPR registration reference
  ndprRegistrationNumber: varchar("ndprRegistrationNumber", { length: 100 }),
  // Notes / programme documentation reference
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_compliance_org").on(table.organizationId),
]);
export type ComplianceSettings = typeof complianceSettings.$inferSelect;
export type InsertComplianceSettings = typeof complianceSettings.$inferInsert;

// ─── Data Deletion Requests (NDA Clause 7 — Return/Destruction) ──────
// Tracks requests to delete or return all Confidential Information,
// and stores the deletion certificate reference for audit purposes.
export const dataDeletionRequests = mysqlTable("data_deletion_requests", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  requestedByUserId: int("requestedByUserId").notNull(),
  requestedAt: timestamp("requestedAt").defaultNow().notNull(),
  scope: mysqlEnum("scope", ["all_transactions", "specific_channel", "specific_job", "all_data"]).default("all_data").notNull(),
  channelId: int("channelId"), // populated if scope = specific_channel
  jobId: int("jobId"),         // populated if scope = specific_job
  status: mysqlEnum("status", ["pending", "in_progress", "completed", "failed"]).default("pending").notNull(),
  completedAt: timestamp("completedAt"),
  recordsDeleted: bigint("recordsDeleted", { mode: "number" }).default(0),
  certificateText: text("certificateText"), // Signed deletion certificate content
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_deletion_org").on(table.organizationId),
  index("idx_deletion_status").on(table.status),
]);
export type DataDeletionRequest = typeof dataDeletionRequests.$inferSelect;
export type InsertDataDeletionRequest = typeof dataDeletionRequests.$inferInsert;

// ─── Security Incidents (NDA Clause 12 — Breach Notification) ────────
// Logs any security incident or unauthorised disclosure event,
// and tracks the notification sent to the counterparty.
export const securityIncidents = mysqlTable("security_incidents", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  reportedByUserId: int("reportedByUserId").notNull(),
  reportedAt: timestamp("reportedAt").defaultNow().notNull(),
  incidentType: mysqlEnum("incidentType", ["unauthorised_access", "data_breach", "unauthorised_disclosure", "system_compromise", "other"]).default("other").notNull(),
  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]).default("medium").notNull(),
  description: text("description").notNull(),
  affectedDataTypes: json("affectedDataTypes"), // e.g. ["transaction_data", "customer_pii"]
  estimatedRecordsAffected: int("estimatedRecordsAffected"),
  // Notification tracking (Clause 12 — immediate notification obligation)
  counterpartyNotifiedAt: timestamp("counterpartyNotifiedAt"),
  counterpartyNotifiedVia: varchar("counterpartyNotifiedVia", { length: 100 }), // email/phone/letter
  regulatorNotifiedAt: timestamp("regulatorNotifiedAt"), // NDPC notification if required
  // Resolution
  status: mysqlEnum("status", ["open", "investigating", "contained", "resolved"]).default("open").notNull(),
  resolvedAt: timestamp("resolvedAt"),
  resolutionNotes: text("resolutionNotes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_incidents_org").on(table.organizationId),
  index("idx_incidents_status").on(table.status),
  index("idx_incidents_severity").on(table.severity),
]);
export type SecurityIncident = typeof securityIncidents.$inferSelect;
export type InsertSecurityIncident = typeof securityIncidents.$inferInsert;

// ─── Compliance Readiness Assessments (Public Self-Assessment Tool) ──
export const complianceAssessments = mysqlTable("compliance_assessments", {
  id: int("id").autoincrement().primaryKey(),
  // Public share token — used to retrieve results without auth
  token: varchar("token", { length: 64 }).notNull().unique(),
  // Respondent info (collected at end of assessment)
  respondentName: varchar("respondentName", { length: 255 }),
  respondentEmail: varchar("respondentEmail", { length: 320 }),
  respondentRole: varchar("respondentRole", { length: 100 }),
  institutionName: varchar("institutionName", { length: 255 }),
  institutionType: mysqlEnum("institutionType", [
    "commercial_bank", "microfinance_bank", "fintech", "payment_processor", "corporate_b2b", "other"
  ]),
  // Assessment answers stored as JSON array of { questionId, answer, score }
  answers: json("answers").notNull(),
  // Scoring
  overallScore: int("overallScore").notNull(),          // 0–100
  riskLevel: mysqlEnum("riskLevel", ["critical", "high", "medium", "low"]).notNull(),
  // Category scores (JSON: { reconciliation, exception, reporting, regulatory, technology })
  categoryScores: json("categoryScores").notNull(),
  // AI-generated personalised narrative (1–2 paragraphs)
  aiNarrative: text("aiNarrative"),
  // Whether the respondent consented to be contacted
  consentToContact: boolean("consentToContact").default(false).notNull(),
  // Whether a follow-up email was sent to the respondent
  followUpEmailSent: boolean("followUpEmailSent").default(false).notNull(),
  // Whether a demo invitation email was sent by an admin
  demoInviteSent: boolean("demoInviteSent").default(false).notNull(),
  // Whether the respondent has opted out of further emails (NDPR compliance)
  emailOptedOut: boolean("emailOptedOut").default(false).notNull(),
  // CRM flag: manually set by sales team to track offline follow-up
  markedContacted: boolean("markedContacted").default(false).notNull(),
  // CRM notes: free-text memo field for sales team (inline editable in admin)
  adminNotes: text("adminNotes"),
  // CRM: timestamp auto-set when markedContacted is toggled on; cleared when toggled off
  lastContactedAt: timestamp("lastContactedAt"),
  // CRM: scheduled callback / follow-up date set by sales team; rows past this date surface as overdue
  followUpDueAt: timestamp("followUpDueAt"),
  // CRM: lead pipeline stage for funnel tracking
  pipelineStage: mysqlEnum("pipelineStage", ["new", "contacted", "demo_booked", "proposal_sent", "closed_won", "closed_lost"]).default("new").notNull(),
  // Optional: linked to a user account if they were logged in
  userId: int("userId"),
  completedAt: timestamp("completedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_assessments_token").on(table.token),
  index("idx_assessments_email").on(table.respondentEmail),
  index("idx_assessments_risk").on(table.riskLevel),
]);
export type ComplianceAssessment = typeof complianceAssessments.$inferSelect;
export type InsertComplianceAssessment = typeof complianceAssessments.$inferInsert;

// ─── CBN Compliance Report Module ─────────────────────────────────────────────
// Covers: AML/CFT, Prudential, Capital Adequacy, Liquidity, KYC/CDD,
//         Cybersecurity, IFRS 9, Consumer Protection reporting frameworks.

// Framework catalogue — seeded at startup, one row per CBN reporting area
export const cbnReportFrameworks = mysqlTable("cbnReportFrameworks", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(), // e.g. "AML_CFT"
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  regulatoryBasis: text("regulatoryBasis"), // e.g. "MLPPA 2022 / CBN AML/CFT Regulations 2022"
  frequency: mysqlEnum("frequency", ["daily", "weekly", "monthly", "quarterly", "semi_annual", "annual", "ad_hoc"]).notNull(),
  submissionDeadlineDays: int("submissionDeadlineDays").default(5), // days after period end
  isActive: boolean("isActive").default(true).notNull(),
  sortOrder: int("sortOrder").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type CbnReportFramework = typeof cbnReportFrameworks.$inferSelect;

// Individual report submissions — one per period per framework per org
export const cbnReportSubmissions = mysqlTable("cbnReportSubmissions", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  frameworkId: int("frameworkId").notNull(),
  // Period covered by this submission
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  reportingPeriodLabel: varchar("reportingPeriodLabel", { length: 64 }), // e.g. "Q1 2026", "Jan 2026"
  // Lifecycle status
  status: mysqlEnum("status", [
    "draft",        // being prepared
    "in_review",    // internal review
    "approved",     // approved by compliance officer
    "submitted",    // sent to CBN
    "acknowledged", // CBN acknowledged receipt
    "queried",      // CBN raised queries
    "closed",       // fully resolved
  ]).default("draft").notNull(),
  // Submission metadata
  submittedAt: timestamp("submittedAt"),
  submittedByUserId: int("submittedByUserId"),
  acknowledgedAt: timestamp("acknowledgedAt"),
  cbNReferenceNumber: varchar("cbNReferenceNumber", { length: 128 }), // CBN's own ref
  submissionChannel: mysqlEnum("submissionChannel", ["goAML", "FinA", "email", "portal", "manual"]).default("portal"),
  // Report content (structured JSON — section responses)
  reportData: json("reportData"), // { sectionKey: { value, narrative, attachments[] } }
  // Compliance score computed at submission time (0–100)
  complianceScore: int("complianceScore"),
  // AI-generated gap analysis narrative
  aiGapAnalysis: text("aiGapAnalysis"),
  aiGapGeneratedAt: timestamp("aiGapGeneratedAt"),
  // Internal notes
  internalNotes: text("internalNotes"),
  // Cryptographic signature (Ed25519) computed when the report is submitted/approved.
  // Makes the "timestamped, digitally signed" attestation literally true and tamper-evident.
  contentHash: varchar("contentHash", { length: 64 }),          // SHA-256 of the canonical signed payload
  signature: text("signature"),                                  // base64 Ed25519 signature over contentHash
  signingKeyFingerprint: varchar("signingKeyFingerprint", { length: 64 }), // SHA-256 fp of the public key
  signedByUserId: int("signedByUserId"),
  signedAt: timestamp("signedAt"),
  // Who created / last updated
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_cbn_submissions_org").on(table.organizationId),
  index("idx_cbn_submissions_framework").on(table.frameworkId),
  index("idx_cbn_submissions_status").on(table.status),
  index("idx_cbn_submissions_period").on(table.periodStart, table.periodEnd),
]);
export type CbnReportSubmission = typeof cbnReportSubmissions.$inferSelect;
export type InsertCbnReportSubmission = typeof cbnReportSubmissions.$inferInsert;

// Findings — regulatory gaps / deficiencies identified during preparation or CBN examination
export const cbnReportFindings = mysqlTable("cbnReportFindings", {
  id: int("id").autoincrement().primaryKey(),
  submissionId: int("submissionId"), // nullable — can be standalone
  frameworkId: int("frameworkId").notNull(),
  organizationId: int("organizationId"),
  // Finding details
  findingRef: varchar("findingRef", { length: 64 }), // e.g. "F-2026-001"
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  category: mysqlEnum("category", [
    "governance",
    "kyc_cdd",
    "aml_cft",
    "capital_adequacy",
    "liquidity",
    "credit_risk",
    "cybersecurity",
    "ifrs9",
    "consumer_protection",
    "reporting",
    "other",
  ]).default("other").notNull(),
  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]).default("medium").notNull(),
  source: mysqlEnum("source", ["self_assessment", "internal_audit", "cbn_examination", "external_audit", "ai_gap_analysis"]).default("self_assessment").notNull(),
  status: mysqlEnum("status", ["open", "in_progress", "resolved", "accepted_risk", "closed"]).default("open").notNull(),
  dueDate: timestamp("dueDate"),
  resolvedAt: timestamp("resolvedAt"),
  resolvedByUserId: int("resolvedByUserId"),
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_cbn_findings_org").on(table.organizationId),
  index("idx_cbn_findings_framework").on(table.frameworkId),
  index("idx_cbn_findings_status").on(table.status),
  index("idx_cbn_findings_severity").on(table.severity),
]);
export type CbnReportFinding = typeof cbnReportFindings.$inferSelect;
export type InsertCbnReportFinding = typeof cbnReportFindings.$inferInsert;

// Action plans — remediation steps linked to findings
export const cbnActionPlans = mysqlTable("cbnActionPlans", {
  id: int("id").autoincrement().primaryKey(),
  findingId: int("findingId").notNull(),
  organizationId: int("organizationId"),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  owner: varchar("owner", { length: 255 }), // person / team responsible
  priority: mysqlEnum("priority", ["low", "medium", "high", "critical"]).default("medium").notNull(),
  status: mysqlEnum("status", ["not_started", "in_progress", "completed", "deferred", "cancelled"]).default("not_started").notNull(),
  targetDate: timestamp("targetDate"),
  completedAt: timestamp("completedAt"),
  evidenceNotes: text("evidenceNotes"), // notes on evidence of completion
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_cbn_actions_finding").on(table.findingId),
  index("idx_cbn_actions_org").on(table.organizationId),
  index("idx_cbn_actions_status").on(table.status),
]);
export type CbnActionPlan = typeof cbnActionPlans.$inferSelect;
export type InsertCbnActionPlan = typeof cbnActionPlans.$inferInsert;

// Audit log — immutable record of every compliance action
export const cbnAuditLog = mysqlTable("cbnAuditLog", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  userId: int("userId"),
  userName: varchar("userName", { length: 255 }),
  action: varchar("action", { length: 128 }).notNull(), // e.g. "submission.created", "finding.resolved"
  entityType: varchar("entityType", { length: 64 }), // "submission" | "finding" | "action_plan"
  entityId: int("entityId"),
  entityLabel: varchar("entityLabel", { length: 255 }), // human-readable label
  details: json("details"), // before/after snapshot or extra context
  ipAddress: varchar("ipAddress", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_cbn_audit_org").on(table.organizationId),
  index("idx_cbn_audit_action").on(table.action),
  index("idx_cbn_audit_entity").on(table.entityType, table.entityId),
  index("idx_cbn_audit_created").on(table.createdAt),
]);
export type CbnAuditLog = typeof cbnAuditLog.$inferSelect;

// ─── CBN Deadline Submission Log ─────────────────────────────────────────────
// Lightweight record of when each regulatory framework deadline was submitted
export const cbnDeadlineSubmissions = mysqlTable("cbnDeadlineSubmissions", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  frameworkCode: varchar("frameworkCode", { length: 64 }).notNull(), // e.g. "AML_CFT"
  frameworkName: varchar("frameworkName", { length: 255 }).notNull(),
  periodLabel: varchar("periodLabel", { length: 64 }).notNull(),    // e.g. "May 2026", "Q2 2026"
  submittedAt: timestamp("submittedAt").notNull(),
  submittedByUserId: int("submittedByUserId"),
  submittedByName: varchar("submittedByName", { length: 255 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_cbn_deadline_org").on(table.organizationId),
  index("idx_cbn_deadline_code").on(table.frameworkCode),
  index("idx_cbn_deadline_period").on(table.frameworkCode, table.periodLabel),
]);
export type CbnDeadlineSubmission = typeof cbnDeadlineSubmissions.$inferSelect;
export type InsertCbnDeadlineSubmission = typeof cbnDeadlineSubmissions.$inferInsert;

// ─── CBN Report Module: per-institution profile (configurable, all customers) ─
// Header identity that appears on every CBN/NIBSS report + the monthly
// attestation. One row per organisation; created lazily with sensible defaults.
export const cbnReportSettings = mysqlTable("cbn_report_settings", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull().unique(),
  institutionName: varchar("institutionName", { length: 255 }),
  institutionType: mysqlEnum("institutionType", [
    "microfinance_bank", "commercial_bank", "payment_service_bank",
    "merchant_bank", "other_financial_institution", "fintech", "other",
  ]).default("microfinance_bank").notNull(),
  rcNumber: varchar("rcNumber", { length: 50 }),                 // CAC RC number
  cbnLicenseNumber: varchar("cbnLicenseNumber", { length: 100 }),
  cbnInstitutionCode: varchar("cbnInstitutionCode", { length: 50 }), // CBN/NIBSS institution/sort code
  address: varchar("address", { length: 500 }),
  // Officers named on reports + attestation
  preparedByName: varchar("preparedByName", { length: 255 }),
  preparedByTitle: varchar("preparedByTitle", { length: 150 }),
  attestingOfficerName: varchar("attestingOfficerName", { length: 255 }),   // CFO/CCO who signs the monthly attestation
  attestingOfficerTitle: varchar("attestingOfficerTitle", { length: 150 }),
  complianceContactEmail: varchar("complianceContactEmail", { length: 320 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_cbn_report_settings_org").on(table.organizationId),
]);
export type CbnReportSettings = typeof cbnReportSettings.$inferSelect;
export type InsertCbnReportSettings = typeof cbnReportSettings.$inferInsert;

// ─── CBN Report Module: generated report / attestation history ───────────────
// One row per generated report (audit of what was produced) and per signed
// monthly attestation (with its Ed25519 signature for later verification).
export const cbnReportRuns = mysqlTable("cbn_report_runs", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId"),
  reportType: varchar("reportType", { length: 48 }).notNull(),
  // daily_recon_summary | exception_log | counterparty_exposure |
  // interbank_settlement | monthly_attestation
  periodLabel: varchar("periodLabel", { length: 64 }),
  periodStart: timestamp("periodStart"),
  periodEnd: timestamp("periodEnd"),
  rowCount: int("rowCount").default(0).notNull(),
  summary: json("summary"), // headline figures snapshot for the run
  // Signature block — populated only for signed monthly attestations
  contentHash: varchar("contentHash", { length: 64 }),
  signature: text("signature"),
  signingKeyFingerprint: varchar("signingKeyFingerprint", { length: 64 }),
  signedAt: timestamp("signedAt"),
  attestingOfficerName: varchar("attestingOfficerName", { length: 255 }),
  attestingOfficerTitle: varchar("attestingOfficerTitle", { length: 150 }),
  generatedByUserId: int("generatedByUserId"),
  generatedByName: varchar("generatedByName", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_cbn_report_runs_org").on(table.organizationId),
  index("idx_cbn_report_runs_type").on(table.reportType),
]);
export type CbnReportRun = typeof cbnReportRuns.$inferSelect;
export type InsertCbnReportRun = typeof cbnReportRuns.$inferInsert;

// ─── Roadmap Access Requests ──────────────────────────────────────────────────
export const roadmapAccessRequests = mysqlTable("roadmapAccessRequests", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  company: varchar("company", { length: 255 }),
  reason: text("reason"),
  status: varchar("status", { length: 32 }).notNull().default("pending"), // pending | approved | rejected
  accessToken: varchar("accessToken", { length: 128 }),  // set on approval
  tokenExpiresAt: timestamp("tokenExpiresAt"),
  approvedAt: timestamp("approvedAt"),
  approvedByUserId: int("approvedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_roadmap_email").on(table.email),
  index("idx_roadmap_status").on(table.status),
  index("idx_roadmap_token").on(table.accessToken),
]);
export type RoadmapAccessRequest = typeof roadmapAccessRequests.$inferSelect;
export type InsertRoadmapAccessRequest = typeof roadmapAccessRequests.$inferInsert;

// ─── Shared Report Tokens ─────────────────────────────────────────────────────
export const sharedReportTokens = mysqlTable("sharedReportTokens", {
  id: int("id").autoincrement().primaryKey(),
  reportId: int("reportId").notNull(),
  token: varchar("token", { length: 128 }).notNull().unique(),
  createdByUserId: int("createdByUserId").notNull(),
  organizationId: int("organizationId"),
  recipientEmail: varchar("recipientEmail", { length: 255 }),
  recipientName: varchar("recipientName", { length: 255 }),
  note: text("note"),
  expiresAt: timestamp("expiresAt"),          // null = never expires
  revokedAt: timestamp("revokedAt"),           // null = still active
  viewCount: int("viewCount").default(0).notNull(),
  lastViewedAt: timestamp("lastViewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_shared_report_token").on(table.token),
  index("idx_shared_report_reportId").on(table.reportId),
  index("idx_shared_report_org").on(table.organizationId),
]);
export type SharedReportToken = typeof sharedReportTokens.$inferSelect;
export type InsertSharedReportToken = typeof sharedReportTokens.$inferInsert;

// ─── CFO Weekly Report Schedules ────────────────────────────────────
export const cfoReportSchedules = mysqlTable("cfo_report_schedules", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  organizationId: int("organizationId"),
  // Heartbeat cron task UID (null until first scheduled)
  scheduleCronTaskUid: varchar("scheduleCronTaskUid", { length: 65 }),
  isActive: boolean("isActive").default(true).notNull(),
  // Cron expression (6-field UTC): default Monday 08:00 UTC
  cronExpression: varchar("cronExpression", { length: 64 }).default("0 0 8 * * 1").notNull(),
  // Comma-separated list of recipient emails (stored as JSON array)
  recipients: json("recipients").notNull(), // string[]
  // Date range to include in the report ("7d" | "30d" | "mtd" | "quarterly" | "last_quarter")
  reportPeriod: varchar("reportPeriod", { length: 16 }).default("7d").notNull(),
  lastSentAt: timestamp("lastSentAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_cfo_schedule_user").on(table.userId),
  index("idx_cfo_schedule_org").on(table.organizationId),
  index("idx_cfo_schedule_task_uid").on(table.scheduleCronTaskUid),
]);
export type CfoReportSchedule = typeof cfoReportSchedules.$inferSelect;
export type InsertCfoReportSchedule = typeof cfoReportSchedules.$inferInsert;

// ─── Channel Alert Settings (per-channel thresholds) ─────────────────
export const channelAlertSettings = mysqlTable("channel_alert_settings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  organizationId: int("organizationId"),
  channelCode: varchar("channelCode", { length: 64 }).notNull(),
  // Match rate threshold (0-100). Alert fires when rate drops below this.
  threshold: decimal("threshold", { precision: 5, scale: 2 }).default("95.00").notNull(),
  alertEnabled: boolean("alertEnabled").default(true).notNull(),
  // Last time an alert was sent for this channel (to avoid spam)
  lastAlertSentAt: timestamp("lastAlertSentAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_channel_alert_user").on(table.userId),
  index("idx_channel_alert_org").on(table.organizationId),
  uniqueIndex("uq_channel_alert_user_channel").on(table.userId, table.channelCode),
]);
export type ChannelAlertSetting = typeof channelAlertSettings.$inferSelect;
export type InsertChannelAlertSetting = typeof channelAlertSettings.$inferInsert;

// ─── S3 CSV Export Tracking (for retention-based cleanup) ────────────
export const s3CsvExports = mysqlTable("s3_csv_exports", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  organizationId: int("organizationId"),
  // S3 key (relative path) — used by storageDelete
  s3Key: varchar("s3Key", { length: 512 }).notNull(),
  // Public URL returned by storagePut
  s3Url: text("s3Url").notNull(),
  // Human-readable filename for UI display
  filename: varchar("filename", { length: 255 }).notNull(),
  // Source module: "cbn" | "cfo" | "reconciliation"
  sourceModule: varchar("sourceModule", { length: 32 }).notNull(),
  // Optional reference ID (e.g. submissionId, jobId)
  sourceId: int("sourceId"),
  // File size in bytes (0 if unknown)
  sizeBytes: int("sizeBytes").default(0).notNull(),
  // Retention window in days — cleanup job deletes files older than this
  retentionDays: int("retentionDays").default(7).notNull(),
  // Set to true once storageDelete has been called successfully
  deleted: boolean("deleted").default(false).notNull(),
  deletedAt: timestamp("deletedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_s3csv_user").on(table.userId),
  index("idx_s3csv_org").on(table.organizationId),
  index("idx_s3csv_module").on(table.sourceModule),
  index("idx_s3csv_created").on(table.createdAt),
  index("idx_s3csv_deleted").on(table.deleted),
]);
export type S3CsvExport = typeof s3CsvExports.$inferSelect;
export type InsertS3CsvExport = typeof s3CsvExports.$inferInsert;

// ─── Magic Link Tokens (welcome email / passwordless login) ──────────
export const magicLinkTokens = mysqlTable("magic_link_tokens", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  token: varchar("token", { length: 128 }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_magic_link_token").on(table.token),
  index("idx_magic_link_user").on(table.userId),
  index("idx_magic_link_expires").on(table.expiresAt),
]);
export type MagicLinkToken = typeof magicLinkTokens.$inferSelect;
export type InsertMagicLinkToken = typeof magicLinkTokens.$inferInsert;

// ─── Platform Audit Log (Super Admin — cross-tenant events) ──────────────────
// Tracks platform-level events: org creation, user role changes, segment updates,
// and super_admin promotions. Only accessible via superAdminProcedure.
export const platformAuditLogs = mysqlTable("platform_audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  // Who performed the action (super_admin user id)
  actorId: int("actorId").notNull(),
  actorName: varchar("actorName", { length: 255 }),
  // What happened
  eventType: mysqlEnum("eventType", [
    "org_created",
    "org_segment_updated",
    "org_sso_updated",
    "org_ai_assistance_updated",
    // Conventional vs non-interest (NIFI). Worth its own event: it changes how
    // the platform characterises an institution's licence basis, and the
    // resulting findings are regulator-facing.
    "org_banking_model_updated",
    "user_role_updated",
    "user_promoted_super_admin",
    /**
     * An operator wrote tenant data from inside that tenant's portal.
     *
     * Portal scope lets a super admin act AS a tenant — necessary for support,
     * and the point at which "who did this" stops being answerable from the
     * row itself. A settlement import creates financial transactions in a
     * merchant's ledger; without this the only record is that the merchant's
     * own organisation received them.
     */
    "tenant_data_imported",
  ]).notNull(),
  // Target entity
  targetType: mysqlEnum("targetType", ["organization", "user"]).notNull(),
  targetId: int("targetId").notNull(),
  targetName: varchar("targetName", { length: 255 }),
  // Before/after values stored as JSON strings
  previousValue: text("previousValue"),
  newValue: text("newValue"),
  // Extra context (e.g. org name when updating a user)
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_pal_actor").on(table.actorId),
  index("idx_pal_event").on(table.eventType),
  index("idx_pal_target").on(table.targetType, table.targetId),
  index("idx_pal_created").on(table.createdAt),
]);
export type PlatformAuditLog = typeof platformAuditLogs.$inferSelect;
export type InsertPlatformAuditLog = typeof platformAuditLogs.$inferInsert;
