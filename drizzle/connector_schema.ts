/**
 * WoodCore CBS Connector — production connector tables.
 *
 * These tables back the WoodCore API connector (server/connectors/woodcore/):
 * per-org connection config, sync run bookkeeping, inbound webhook events,
 * the DB-backed dead-letter queue, and versioned field-mapping overrides.
 *
 * NOTE: the wc_* Fineract MIRROR tables live in woodcore_schema.ts (read-only).
 * Everything here is ReconcileAI-owned state, prefixed wc_connector_*.
 */
import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Connector configuration (one per organization) ─────────────────────────
export const wcConnectorConfigs = mysqlTable(
  "wc_connector_configs",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull(),
    // Which core banking system this connector talks to. Profiles (default
    // endpoints, auth, field mappings) live in server/connectors/cbs/registry.ts.
    // Values: woodcore | t24 | mambu | flexcube (varchar so new CBSs are data).
    cbsType: varchar("cbsType", { length: 20 }).default("woodcore").notNull(),
    name: varchar("name", { length: 255 }).default("WoodCore Core Banking").notNull(),
    // Base URL of the CBS API, e.g. https://<host>/fineract-provider/api/v1
    baseUrl: varchar("baseUrl", { length: 500 }).notNull(),
    // Fineract-Platform-TenantId header value (Fineract multi-tenancy)
    tenantId: varchar("tenantId", { length: 100 }).default("default").notNull(),
    // Authentication: primary mode + fallback. Secrets are AES-256-GCM encrypted.
    authMode: mysqlEnum("authMode", ["oauth2", "api_key", "basic"]).default("oauth2").notNull(),
    oauthClientId: varchar("oauthClientId", { length: 255 }),
    oauthClientSecretEnc: text("oauthClientSecretEnc"),
    oauthTokenUrl: varchar("oauthTokenUrl", { length: 500 }), // default: <baseUrl>/oauth/token
    oauthScope: varchar("oauthScope", { length: 255 }),
    apiKeyEnc: text("apiKeyEnc"),
    apiKeyHeader: varchar("apiKeyHeader", { length: 100 }).default("x-api-key").notNull(),
    basicUsername: varchar("basicUsername", { length: 255 }),
    basicPasswordEnc: text("basicPasswordEnc"),
    // Inbound webhook verification (HMAC-SHA256 of the raw body)
    webhookSecretEnc: text("webhookSecretEnc"),
    webhookEnabled: boolean("webhookEnabled").default(true).notNull(),
    // Daily batch sync fallback
    batchSyncEnabled: boolean("batchSyncEnabled").default(true).notNull(),
    batchSyncHourUtc: int("batchSyncHourUtc").default(2).notNull(), // 0–23
    // Bidirectional write-back (resolution notes pushed to WoodCore). Off until
    // the real WoodCore write API is confirmed.
    writeBackEnabled: boolean("writeBackEnabled").default(false).notNull(),
    // API paging + retry tuning
    pageSize: int("pageSize").default(500).notNull(),
    maxRetries: int("maxRetries").default(3).notNull(),
    requestTimeoutMs: int("requestTimeoutMs").default(30000).notNull(),
    // Endpoint path overrides — WoodCore's real paths may differ from the
    // Fineract defaults; when their API docs arrive only this JSON changes.
    // { savingsTransactions, loanTransactions, journalEntries, tokenUrl, ping, writeBack }
    endpointsJson: json("endpointsJson"),
    isEnabled: boolean("isEnabled").default(false).notNull(),
    lastHealthStatus: mysqlEnum("lastHealthStatus", ["ok", "degraded", "down", "unknown"])
      .default("unknown")
      .notNull(),
    lastHealthCheckAt: timestamp("lastHealthCheckAt"),
    lastHealthDetail: text("lastHealthDetail"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [uniqueIndex("uq_wc_conn_org").on(t.organizationId)],
);

export type WcConnectorConfig = typeof wcConnectorConfigs.$inferSelect;
export type InsertWcConnectorConfig = typeof wcConnectorConfigs.$inferInsert;

// ─── Sync runs (batch pulls: scheduled daily, manual, or webhook-gap) ────────
export const wcConnectorSyncRuns = mysqlTable(
  "wc_connector_sync_runs",
  {
    id: int("id").autoincrement().primaryKey(),
    configId: int("configId").notNull(),
    organizationId: int("organizationId").notNull(),
    trigger: mysqlEnum("trigger", ["scheduled", "manual", "webhook_gap", "backfill"]).notNull(),
    scope: mysqlEnum("scope", ["savings", "loans", "gl", "all"]).default("all").notNull(),
    windowFrom: timestamp("windowFrom").notNull(),
    windowTo: timestamp("windowTo").notNull(),
    status: mysqlEnum("status", ["running", "completed", "partial", "failed"])
      .default("running")
      .notNull(),
    fetched: int("fetched").default(0).notNull(),
    inserted: int("inserted").default(0).notNull(),
    duplicates: int("duplicates").default(0).notNull(),
    failed: int("failed").default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    finishedAt: timestamp("finishedAt"),
    durationMs: int("durationMs"),
  },
  (t) => [
    index("idx_wc_sync_config").on(t.configId),
    index("idx_wc_sync_status").on(t.status),
    index("idx_wc_sync_started").on(t.startedAt),
  ],
);

export type WcConnectorSyncRun = typeof wcConnectorSyncRuns.$inferSelect;
export type InsertWcConnectorSyncRun = typeof wcConnectorSyncRuns.$inferInsert;

// ─── Inbound webhook events (idempotency ledger + audit trail) ───────────────
export const wcConnectorWebhookEvents = mysqlTable(
  "wc_connector_webhook_events",
  {
    id: int("id").autoincrement().primaryKey(),
    configId: int("configId").notNull(),
    organizationId: int("organizationId").notNull(),
    // Provider event id (header or payload). Falls back to SHA-256 of the raw body,
    // so replays of an identical body are always detected.
    eventId: varchar("eventId", { length: 191 }).notNull(),
    eventType: varchar("eventType", { length: 100 }),
    entity: varchar("entity", { length: 50 }), // savings_transaction | loan_transaction | journal_entry
    payload: json("payload"),
    signatureValid: boolean("signatureValid").default(false).notNull(),
    status: mysqlEnum("status", ["received", "processed", "failed", "duplicate", "quarantined"])
      .default("received")
      .notNull(),
    error: text("error"),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    processedAt: timestamp("processedAt"),
  },
  (t) => [
    uniqueIndex("uq_wc_webhook_event").on(t.configId, t.eventId),
    index("idx_wc_webhook_status").on(t.status),
    index("idx_wc_webhook_received").on(t.receivedAt),
  ],
);

export type WcConnectorWebhookEvent = typeof wcConnectorWebhookEvents.$inferSelect;
export type InsertWcConnectorWebhookEvent = typeof wcConnectorWebhookEvents.$inferInsert;

// ─── Dead-letter queue (DB-backed; no Redis dependency) ─────────────────────
export const wcConnectorDeadLetters = mysqlTable(
  "wc_connector_dead_letters",
  {
    id: int("id").autoincrement().primaryKey(),
    configId: int("configId").notNull(),
    organizationId: int("organizationId").notNull(),
    source: mysqlEnum("source", ["webhook", "batch_sync", "mapping", "api_call", "write_back"]).notNull(),
    // What failed — e.g. refType "savings_transaction", refId "12345"
    refType: varchar("refType", { length: 100 }),
    refId: varchar("refId", { length: 191 }),
    payload: json("payload"),
    error: text("error").notNull(),
    attempts: int("attempts").default(0).notNull(),
    maxAttempts: int("maxAttempts").default(5).notNull(),
    nextRetryAt: timestamp("nextRetryAt"),
    lastAttemptAt: timestamp("lastAttemptAt"),
    status: mysqlEnum("status", ["pending", "retrying", "resolved", "exhausted", "discarded"])
      .default("pending")
      .notNull(),
    resolutionNote: text("resolutionNote"),
    resolvedAt: timestamp("resolvedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    index("idx_wc_dlq_due").on(t.status, t.nextRetryAt),
    index("idx_wc_dlq_config").on(t.configId),
    index("idx_wc_dlq_created").on(t.createdAt),
  ],
);

export type WcConnectorDeadLetter = typeof wcConnectorDeadLetters.$inferSelect;
export type InsertWcConnectorDeadLetter = typeof wcConnectorDeadLetters.$inferInsert;

// ─── Field-mapping overrides (versioned; defaults live in code) ─────────────
export const wcConnectorFieldMappings = mysqlTable(
  "wc_connector_field_mappings",
  {
    id: int("id").autoincrement().primaryKey(),
    configId: int("configId").notNull(),
    organizationId: int("organizationId").notNull(),
    entity: mysqlEnum("entity", ["savings_transaction", "loan_transaction", "journal_entry"]).notNull(),
    version: int("version").default(1).notNull(),
    // Array of MappingRule (see server/connectors/woodcore/mapping.ts)
    rulesJson: json("rulesJson").notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    notes: text("notes"),
    createdBy: int("createdBy"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    index("idx_wc_map_config_entity").on(t.configId, t.entity),
    index("idx_wc_map_active").on(t.isActive),
  ],
);

export type WcConnectorFieldMapping = typeof wcConnectorFieldMappings.$inferSelect;
export type InsertWcConnectorFieldMapping = typeof wcConnectorFieldMappings.$inferInsert;
