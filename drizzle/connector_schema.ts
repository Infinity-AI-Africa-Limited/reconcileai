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

// ─────────────────────────────────────────────────────────────────────────────
// SHOPLINE Connector Schema
// Three tables mirror the WoodCore connector pattern:
//   sl_connector_stores        — one row per installed SHOPLINE store (tenant-scoped)
//   sl_connector_tokens        — encrypted OAuth tokens (10h TTL, HMAC refresh)
//   sl_connector_webhook_events — idempotent webhook event log + DLQ linkage
// ─────────────────────────────────────────────────────────────────────────────

export const slConnectorStores = mysqlTable(
  "sl_connector_stores",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull(),
    /** SHOPLINE store handle (subdomain, e.g. "mystore") */
    storeHandle: varchar("storeHandle", { length: 128 }).notNull(),
    /** SHOPLINE-assigned store ID */
    storeId: varchar("storeId", { length: 64 }).notNull(),
    /** SHOPLINE-assigned merchant ID */
    merchantId: varchar("merchantId", { length: 64 }),
    /** Primary domain of the store */
    domain: varchar("domain", { length: 255 }),
    /** ISO 4217 store currency (e.g. "NGN", "USD") */
    currency: varchar("currency", { length: 8 }),
    /** IANA timezone (e.g. "Africa/Lagos") */
    ianaTimezone: varchar("ianaTimezone", { length: 64 }),
    /** Comma-separated list of granted OAuth scopes */
    grantedScopes: text("grantedScopes"),
    /** API version used at install time (e.g. "v20260601") */
    apiVersion: varchar("apiVersion", { length: 16 }).default("v20260601").notNull(),
    /** Install status */
    status: mysqlEnum("status", ["active", "suspended", "uninstalled"]).default("active").notNull(),
    installedAt: timestamp("installedAt").defaultNow().notNull(),
    uninstalledAt: timestamp("uninstalledAt"),
    lastSyncAt: timestamp("lastSyncAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_sl_store_org_handle").on(t.organizationId, t.storeHandle),
    index("idx_sl_store_status").on(t.status),
  ],
);
export type SlConnectorStore = typeof slConnectorStores.$inferSelect;
export type InsertSlConnectorStore = typeof slConnectorStores.$inferInsert;

export const slConnectorTokens = mysqlTable(
  "sl_connector_tokens",
  {
    id: int("id").autoincrement().primaryKey(),
    /** FK to sl_connector_stores.id */
    slStoreId: int("slStoreId").notNull(),
    organizationId: int("organizationId").notNull(),
    /**
     * Encrypted access token using tenant envelope encryption (tk1: format).
     * Tokens expire after 10 hours; refresh is authenticated by app-secret HMAC.
     */
    encryptedToken: text("encryptedToken").notNull(),
    /** UTC expiry timestamp (installedAt + 10h, refreshed on each rotation) */
    expiresAt: timestamp("expiresAt").notNull(),
    refreshedAt: timestamp("refreshedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_sl_token_store").on(t.slStoreId),
    index("idx_sl_token_expires").on(t.expiresAt),
  ],
);
export type SlConnectorToken = typeof slConnectorTokens.$inferSelect;
export type InsertSlConnectorToken = typeof slConnectorTokens.$inferInsert;

export const slConnectorWebhookEvents = mysqlTable(
  "sl_connector_webhook_events",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull(),
    slStoreId: int("slStoreId").notNull(),
    /** SHOPLINE webhook ID (idempotency key — from X-Shopline-Webhook-Id header) */
    webhookId: varchar("webhookId", { length: 64 }).notNull(),
    /** Webhook topic (e.g. "orders/paid", "refunds/create") */
    topic: varchar("topic", { length: 64 }).notNull(),
    /** Raw payload stored as JSON for replay */
    payloadJson: json("payloadJson"),
    /** Processing status */
    status: mysqlEnum("status", ["pending", "processed", "failed", "dlq"]).default("pending").notNull(),
    /** Number of processing attempts */
    attempts: int("attempts").default(0).notNull(),
    /** Error message if failed */
    errorMessage: text("errorMessage"),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    processedAt: timestamp("processedAt"),
  },
  (t) => [
    uniqueIndex("idx_sl_webhook_id").on(t.webhookId),
    index("idx_sl_webhook_org_status").on(t.organizationId, t.status),
    index("idx_sl_webhook_topic").on(t.topic),
  ],
);
export type SlConnectorWebhookEvent = typeof slConnectorWebhookEvents.$inferSelect;
export type InsertSlConnectorWebhookEvent = typeof slConnectorWebhookEvents.$inferInsert;

// ─── SHOPLINE App Store Subscription State ──────────────────────────────────
// Tracks the billing lifecycle for each store's ReconcileAI subscription.
// Updated by billing webhooks (app_plan/activated, app_plan/expired,
// billing_attempts/succeed, billing_attempts/fail).
export const slConnectorSubscriptions = mysqlTable(
  "sl_connector_subscriptions",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull(),
    slStoreId: int("slStoreId").notNull(),
    /** SHOPLINE subscription/charge ID (from webhook payload) */
    shoplineSubscriptionId: varchar("shoplineSubscriptionId", { length: 128 }),
    /** Our plan spuKey (starter, growth, professional, enterprise, enterprise_plus) */
    planId: varchar("planId", { length: 32 }).notNull(),
    /** Subscription status */
    status: mysqlEnum("status", [
      "trialing",
      "active",
      "past_due",
      "cancelled",
      "expired",
    ]).default("trialing").notNull(),
    /** Trial start (set on app_plan/activated with trial) */
    trialStartedAt: timestamp("trialStartedAt"),
    /** Trial end (trialStartedAt + 7 days) */
    trialEndsAt: timestamp("trialEndsAt"),
    /** When the paid subscription activated (first billing_attempts/succeed) */
    activatedAt: timestamp("activatedAt"),
    /** Current billing period start */
    currentPeriodStart: timestamp("currentPeriodStart"),
    /** Current billing period end */
    currentPeriodEnd: timestamp("currentPeriodEnd"),
    /** When the subscription was cancelled or expired */
    cancelledAt: timestamp("cancelledAt"),
    /** Number of consecutive failed billing attempts */
    failedBillingAttempts: int("failedBillingAttempts").default(0).notNull(),
    /** Last billing failure reason */
    lastFailureReason: text("lastFailureReason"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_sl_sub_store").on(t.slStoreId),
    index("idx_sl_sub_org_status").on(t.organizationId, t.status),
  ],
);
export type SlConnectorSubscription = typeof slConnectorSubscriptions.$inferSelect;
export type InsertSlConnectorSubscription = typeof slConnectorSubscriptions.$inferInsert;

// ─── SHOPLINE GDPR / Mandatory Compliance Requests ──────────────────────────
// Auditable trail of SHOPLINE's mandatory GDPR webhooks (customer data request,
// customer redact, shop redact). Required for App Store review and the "respond
// 200, complete within 30 days" obligation — each row records the request and
// the action taken so the compliance state is queryable. organizationId is
// nullable because a request may arrive for a shop we can't resolve to a tenant
// (already uninstalled); such rows are still retained for audit.
export const slConnectorGdprRequests = mysqlTable(
  "sl_connector_gdpr_requests",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId"),
    slStoreId: int("slStoreId"),
    /** SHOPLINE topic: customers/data_request | customers/redact | shop/redact | merchants/redact */
    topic: varchar("topic", { length: 64 }).notNull(),
    /** Store domain from the request payload. */
    shopDomain: varchar("shopDomain", { length: 255 }),
    /**
     * SHA-256 of the data subject's identifier (customer id, or shop domain for
     * shop requests). Hashed so this audit table never itself stores a raw
     * customer identifier.
     */
    subjectHash: varchar("subjectHash", { length: 64 }),
    status: mysqlEnum("status", ["received", "completed", "failed", "unresolved_store"])
      .default("received")
      .notNull(),
    /** How many stored records were scrubbed/affected by the action. */
    recordsAffected: int("recordsAffected").default(0).notNull(),
    note: text("note"),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (t) => [
    index("idx_sl_gdpr_org").on(t.organizationId),
    index("idx_sl_gdpr_topic").on(t.topic),
    index("idx_sl_gdpr_shop").on(t.shopDomain),
  ],
);
export type SlConnectorGdprRequest = typeof slConnectorGdprRequests.$inferSelect;
export type InsertSlConnectorGdprRequest = typeof slConnectorGdprRequests.$inferInsert;
