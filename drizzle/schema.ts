import {
  int,
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
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  organizationId: int("organizationId"),
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
  name: varchar("name", { length: 255 }).notNull(),
  sourceChannelId: int("sourceChannelId").notNull(),
  targetChannelId: int("targetChannelId").notNull(),
  dateFrom: timestamp("dateFrom").notNull(),
  dateTo: timestamp("dateTo").notNull(),
  amountTolerance: decimal("amountTolerance", { precision: 5, scale: 4 }).default("0.005").notNull(),
  dateWindowDays: int("dateWindowDays").default(3).notNull(),
  // Engine configuration snapshot
  engineConfig: json("engineConfig"), // Frozen config at run time
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
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_jobs_user").on(table.userId),
  index("idx_jobs_org").on(table.organizationId),
  index("idx_jobs_status").on(table.status),
  index("idx_jobs_source").on(table.sourceChannelId),
  index("idx_jobs_target").on(table.targetChannelId),
  index("idx_jobs_created").on(table.createdAt),
]);

export type ReconciliationJob = typeof reconciliationJobs.$inferSelect;
export type InsertReconciliationJob = typeof reconciliationJobs.$inferInsert;

// ─── Matches ─────────────────────────────────────────────────────────
export const matches = mysqlTable("matches", {
  id: int("id").autoincrement().primaryKey(),
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
    "format_error",
  ]).notNull(),
  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"])
    .default("medium")
    .notNull(),
  description: text("description"),
  suggestedResolution: text("suggestedResolution"),
  aiAnalysis: text("aiAnalysis"),
  status: mysqlEnum("status", ["open", "in_review", "resolved", "dismissed", "escalated"])
    .default("open")
    .notNull(),
  assignedTo: int("assignedTo"),
  resolvedBy: int("resolvedBy"),
  resolvedAt: timestamp("resolvedAt"),
  resolutionNotes: text("resolutionNotes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_audit_user").on(table.userId),
  index("idx_audit_org").on(table.organizationId),
  index("idx_audit_entity").on(table.entityType, table.entityId),
  index("idx_audit_action").on(table.action),
  index("idx_audit_created").on(table.createdAt),
]);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

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
