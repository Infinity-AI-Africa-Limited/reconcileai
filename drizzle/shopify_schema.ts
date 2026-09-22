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

/**
 * Shopify connector state. These tables are deliberately separate from the
 * SHOPLINE connector: OAuth formats, API behavior, and deletion requirements
 * are provider-specific and must not be coupled by a generic credential table.
 */
export const shopifyConnectorStores = mysqlTable(
  "shopify_connector_stores",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull(),
    /** Normalized, verified `*.myshopify.com` domain. */
    shopDomain: varchar("shopDomain", { length: 253 }).notNull(),
    shopId: varchar("shopId", { length: 64 }).notNull(),
    displayName: varchar("displayName", { length: 255 }).notNull(),
    primaryDomain: varchar("primaryDomain", { length: 253 }),
    currency: varchar("currency", { length: 8 }),
    ianaTimezone: varchar("ianaTimezone", { length: 64 }),
    /** Exact read scopes returned by Shopify at token issuance. */
    grantedScopes: text("grantedScopes").notNull(),
    /** Read-only Order-led foundation; future scope changes must be explicit. */
    requestedScopes: text("requestedScopes").notNull(),
    apiVersion: varchar("apiVersion", { length: 16 }).default("2026-07").notNull(),
    status: mysqlEnum("status", ["pending_claim", "active", "reauthorization_required", "uninstalled"])
      .default("pending_claim")
      .notNull(),
    /**
     * Why the store left `active` (see SHOPIFY_STATUS_REASONS); NULL while active.
     * A connection that fails closed must say why, or "reauthorization required"
     * is indistinguishable across an ownership change, a rejected refresh and a
     * failed credential write — each of which needs a different response.
     */
    statusReason: varchar("statusReason", { length: 64 }),
    /** An authorised ReconcileAI administrator who claimed the merchant workspace. */
    claimedByUserId: int("claimedByUserId"),
    claimedAt: timestamp("claimedAt"),
    lastWebhookAt: timestamp("lastWebhookAt"),
    uninstalledAt: timestamp("uninstalledAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_shopify_store_domain").on(t.shopDomain),
    uniqueIndex("uq_shopify_store_shop_id").on(t.shopId),
    index("idx_shopify_store_org_status").on(t.organizationId, t.status),
  ],
);
export type ShopifyConnectorStore = typeof shopifyConnectorStores.$inferSelect;
export type InsertShopifyConnectorStore = typeof shopifyConnectorStores.$inferInsert;

/**
 * Expiring offline OAuth tokens. Both token values are encrypted with the
 * organisation's envelope-encryption key and never leave the server process.
 */
export const shopifyConnectorTokens = mysqlTable(
  "shopify_connector_tokens",
  {
    id: int("id").autoincrement().primaryKey(),
    storeId: int("storeId").notNull(),
    organizationId: int("organizationId").notNull(),
    accessTokenEnc: text("accessTokenEnc").notNull(),
    refreshTokenEnc: text("refreshTokenEnc").notNull(),
    accessExpiresAt: timestamp("accessExpiresAt").notNull(),
    refreshExpiresAt: timestamp("refreshExpiresAt"),
    /** Serialises refresh-token rotation across workers without holding a DB transaction across HTTP. */
    refreshLeaseId: varchar("refreshLeaseId", { length: 64 }),
    refreshLeaseExpiresAt: timestamp("refreshLeaseExpiresAt"),
    rotationVersion: int("rotationVersion").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_shopify_token_store").on(t.storeId),
    index("idx_shopify_token_org_expiry").on(t.organizationId, t.accessExpiresAt),
  ],
);
export type ShopifyConnectorToken = typeof shopifyConnectorTokens.$inferSelect;
export type InsertShopifyConnectorToken = typeof shopifyConnectorTokens.$inferInsert;

/**
 * Hash-only OAuth states. A state may be consumed exactly once; raw state values
 * live only in the browser's short-lived, signed flow cookie.
 */
export const shopifyOauthStates = mysqlTable(
  "shopify_oauth_states",
  {
    id: int("id").autoincrement().primaryKey(),
    shopDomain: varchar("shopDomain", { length: 253 }).notNull(),
    stateHash: varchar("stateHash", { length: 64 }).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_shopify_oauth_state_hash").on(t.stateHash),
    index("idx_shopify_oauth_state_expiry").on(t.expiresAt),
  ],
);
export type ShopifyOauthState = typeof shopifyOauthStates.$inferSelect;

/**
 * Durable, idempotent webhook admission ledger. The raw provider payload is not
 * retained in this first release because the connector is field-minimal; only a
 * digest, topic and processing evidence are stored.
 */
export const shopifyWebhookEvents = mysqlTable(
  "shopify_webhook_events",
  {
    id: int("id").autoincrement().primaryKey(),
    storeId: int("storeId"),
    organizationId: int("organizationId"),
    webhookId: varchar("webhookId", { length: 128 }).notNull(),
    topic: varchar("topic", { length: 100 }).notNull(),
    payloadSha256: varchar("payloadSha256", { length: 64 }).notNull(),
    apiVersion: varchar("apiVersion", { length: 16 }),
    status: mysqlEnum("status", ["received", "processed", "failed", "ignored"])
      .default("received")
      .notNull(),
    errorCode: varchar("errorCode", { length: 80 }),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    processedAt: timestamp("processedAt"),
  },
  (t) => [
    uniqueIndex("uq_shopify_webhook_id").on(t.webhookId),
    index("idx_shopify_webhook_store_status").on(t.storeId, t.status),
    index("idx_shopify_webhook_org_received").on(t.organizationId, t.receivedAt),
  ],
);
export type ShopifyWebhookEvent = typeof shopifyWebhookEvents.$inferSelect;

/**
 * Minimal, non-identifying evidence for Shopify's required privacy requests.
 * Subject values are hashed at admission; raw customer email, phone, address and
 * order payloads are never written to this ledger.
 */
export const shopifyPrivacyRequests = mysqlTable(
  "shopify_privacy_requests",
  {
    id: int("id").autoincrement().primaryKey(),
    storeId: int("storeId"),
    organizationId: int("organizationId"),
    topic: mysqlEnum("topic", ["customers/data_request", "customers/redact", "shop/redact"]).notNull(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    subjectHash: varchar("subjectHash", { length: 64 }),
    status: mysqlEnum("status", ["received", "completed", "blocked_legal_retention", "failed"])
      .default("received")
      .notNull(),
    recordsAffected: int("recordsAffected").default(0).notNull(),
    completionNote: text("completionNote"),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (t) => [
    uniqueIndex("uq_shopify_privacy_request").on(t.topic, t.requestHash),
    index("idx_shopify_privacy_org_status").on(t.organizationId, t.status),
    index("idx_shopify_privacy_store_topic").on(t.storeId, t.topic),
  ],
);
export type ShopifyPrivacyRequest = typeof shopifyPrivacyRequests.$inferSelect;

/**
 * Versioned sync cursor/evidence reserved for the next order-led sync phase.
 * Creating this small record now means the future corrective-sync job has a
 * tenant-owned, auditable cursor rather than inferring progress from webhooks.
 */
export const shopifySyncCursors = mysqlTable(
  "shopify_sync_cursors",
  {
    id: int("id").autoincrement().primaryKey(),
    storeId: int("storeId").notNull(),
    organizationId: int("organizationId").notNull(),
    resource: mysqlEnum("resource", ["orders"]).default("orders").notNull(),
    cursor: varchar("cursor", { length: 512 }),
    watermarkUpdatedAt: timestamp("watermarkUpdatedAt"),
    lastSuccessfulAt: timestamp("lastSuccessfulAt"),
    lastErrorCode: varchar("lastErrorCode", { length: 80 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_shopify_sync_cursor").on(t.storeId, t.resource),
    index("idx_shopify_sync_org").on(t.organizationId),
  ],
);
export type ShopifySyncCursor = typeof shopifySyncCursors.$inferSelect;

/** Every value `shopify_connector_stores.statusReason` may hold. */
export const SHOPIFY_STATUS_REASONS = [
  /** The shop's current contact email matches no active administrator of the owning workspace. */
  "ownership_unverified",
  /** Shopify rejected the stored refresh token (401). */
  "refresh_rejected",
  /** The stored refresh token could not be decrypted. */
  "refresh_token_unreadable",
  /** A fresh authorization could not be encrypted or persisted. */
  "token_store_failed",
  /** Shopify reported the app uninstalled. */
  "uninstalled",
] as const;
export type ShopifyStatusReason = (typeof SHOPIFY_STATUS_REASONS)[number];

export const SHOPIFY_ORDER_LED_SCOPES = ["read_orders"] as const;
export const SHOPIFY_API_VERSION = "2026-07";
export const SHOPIFY_OAUTH_STATE_TTL_MS = 10 * 60_000;
export const SHOPIFY_ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
export const SHOPIFY_REFRESH_LEASE_MS = 60_000;
