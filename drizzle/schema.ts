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
  moduleType: mysqlEnum("moduleType", ["transaction_integrity", "settlement", "account_level"])
    .default("transaction_integrity")
    .notNull(),
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
  index("idx_jobs_module").on(table.moduleType),
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
  assignedAt: timestamp("assignedAt"),
  assignedBy: int("assignedBy"),
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
export const resolutionTemplates = mysqlTable("resolution_templates", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  category: mysqlEnum("category", [
    "unmatched",
    "missing_counterparty",
    "amount_mismatch",
    "timing_difference",
    "duplicate_transaction",
    "reversal_unmatched",
    "currency_mismatch",
    "format_error",
  ]).notNull(),
  templateText: text("templateText").notNull(),
  isDefault: boolean("isDefault").default(false).notNull(),
  createdBy: int("createdBy").notNull(), // References users table
  organizationId: int("organizationId"), // References organizations table
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_resolution_templates_category").on(table.category),
  index("idx_resolution_templates_org").on(table.organizationId),
]);

export type ResolutionTemplate = typeof resolutionTemplates.$inferSelect;
export type InsertResolutionTemplate = typeof resolutionTemplates.$inferInsert;

// ─── Module Configurations ──────────────────────────────────────────
export const moduleConfigurations = mysqlTable("module_configurations", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  moduleType: mysqlEnum("moduleType", ["transaction_integrity", "settlement", "account_level"]).notNull(),
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
