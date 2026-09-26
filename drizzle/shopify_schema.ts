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
    status: mysqlEnum("status", ["pending_claim", "active", "reauthorization_required", "uninstalled", "redacting"])
      .default("pending_claim")
      .notNull(),
    /**
     * Store-local fence for a customer redaction. This is deliberately separate
     * from `status`: uninstall and shop-redact may change lifecycle state while
     * the privacy fence remains active, and completion must never overwrite them.
     */
    privacyRedactionState: mysqlEnum("privacyRedactionState", ["active", "customer_redacting"])
      .default("active")
      .notNull(),
    /** The internal request currently owning the temporary privacy fence. */
    privacyRedactionRequestId: int("privacyRedactionRequestId"),
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
 * Ledger of CONSUMED OAuth states, hash-only. A state is self-verifying (signed
 * and shop-bound, see signOAuthState), so no row exists until its callback has
 * passed both Shopify's HMAC and our signature; the unique `stateHash` then
 * makes each state usable exactly once. Raw state values live only in the
 * browser's short-lived flow cookie.
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
 * One installation in flight per shop. A callback takes the shop's lease BEFORE
 * exchanging its authorization code and holds it through onboarding.
 *
 * Every authorization-code grant retires the refresh tokens the store held, and
 * the moment it does so is not observable from here. Two callbacks exchanging
 * concurrently can therefore each retire the other's credentials, and no
 * after-the-fact fence can tell which pair survived. Serializing the exchanges
 * removes the question: a callback that cannot take the lease is refused before
 * it exchanges, so its grant never happens and retires nothing.
 */
export const shopifyInstallLeases = mysqlTable("shopify_install_leases", {
  shopDomain: varchar("shopDomain", { length: 253 }).primaryKey(),
  leaseId: varchar("leaseId", { length: 64 }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

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
 * Raw customer email, phone, address, selector IDs and order payloads are never
 * written to this parent ledger.
 */
export const shopifyPrivacyRequests = mysqlTable(
  "shopify_privacy_requests",
  {
    id: int("id").autoincrement().primaryKey(),
    storeId: int("storeId"),
    organizationId: int("organizationId"),
    topic: mysqlEnum("topic", ["customers/data_request", "customers/redact", "shop/redact"]).notNull(),
    // Domain-separated HMAC of the webhook body, not a raw SHA-256. The legacy
    // database name is retained to avoid a risky rename of an active ledger.
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    subjectHash: varchar("subjectHash", { length: 64 }),
    status: mysqlEnum("status", [
      "received",
      "processing",
      "awaiting_delivery",
      "manual_review",
      "blocked_dependency",
      "blocked_legal_retention",
      "failed_retryable",
      "failed_terminal",
      "completed",
      // Legacy value retained so the enum migration cannot invalidate an older row.
      "failed",
    ])
      .default("received")
      .notNull(),
    /** Bounded validation code only; never a payload value or free-form provider error. */
    admissionErrorCode: varchar("admissionErrorCode", { length: 80 }),
    recordsAffected: int("recordsAffected").default(0).notNull(),
    completionNote: text("completionNote"),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (t) => [
    uniqueIndex("uq_shopify_privacy_request_scoped").on(t.organizationId, t.storeId, t.topic, t.requestHash),
    index("idx_shopify_privacy_org_status").on(t.organizationId, t.status),
    index("idx_shopify_privacy_store_topic").on(t.storeId, t.topic),
  ],
);
export type ShopifyPrivacyRequest = typeof shopifyPrivacyRequests.$inferSelect;

/**
 * Fulfilment selectors for customer privacy topics. Provider identifiers are
 * retained only as tenant-encrypted ciphertext plus a versioned tenant-keyed
 * blind index. `position` preserves Shopify's order-selector sequence while the
 * unique request/type/position tuple makes a redelivery safe to replay.
 */
export const shopifyPrivacyRequestSelectors = mysqlTable(
  "shopify_privacy_request_selectors",
  {
    id: int("id").autoincrement().primaryKey(),
    requestId: int("requestId").notNull(),
    organizationId: int("organizationId").notNull(),
    resourceType: mysqlEnum("resourceType", ["customer", "order"]).notNull(),
    position: int("position").notNull(),
    externalIdEnc: text("externalIdEnc").notNull(),
    externalIdHmac: varchar("externalIdHmac", { length: 80 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_shopify_privacy_selector_position").on(t.requestId, t.resourceType, t.position),
    index("idx_shopify_privacy_selector_org_request").on(t.organizationId, t.requestId),
    index("idx_shopify_privacy_selector_lookup").on(t.organizationId, t.resourceType, t.externalIdHmac),
  ],
);
export type ShopifyPrivacyRequestSelector = typeof shopifyPrivacyRequestSelectors.$inferSelect;

/**
 * One-to-one execution state for `customers/data_request`. The request id is the
 * internal job id, so no provider/store/customer identifier ever has to cross
 * the durable queue boundary. A DB lease, not BullMQ de-duplication, arbitrates
 * concurrent or recovered workers.
 */
export const shopifyPrivacyDataRequestJobs = mysqlTable(
  "shopify_privacy_data_request_jobs",
  {
    requestId: int("requestId").primaryKey(),
    organizationId: int("organizationId").notNull(),
    storeId: int("storeId").notNull(),
    status: mysqlEnum("status", [
      "received",
      "processing",
      "awaiting_delivery",
      "manual_review",
      "blocked_dependency",
      "blocked_legal_retention",
      "failed_retryable",
      "failed_terminal",
      "completed",
    ])
      .default("received")
      .notNull(),
    attempts: int("attempts").default(0).notNull(),
    leaseId: varchar("leaseId", { length: 36 }),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    nextAttemptAt: timestamp("nextAttemptAt"),
    lastCheckpoint: varchar("lastCheckpoint", { length: 80 }),
    /** Bounded machine code only; never free text or a provider/customer value. */
    failureCode: varchar("failureCode", { length: 80 }),
    manifestVersion: int("manifestVersion").default(1).notNull(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    artifactId: int("artifactId"),
    recordsFound: int("recordsFound").default(0).notNull(),
    recordsAffected: int("recordsAffected").default(0).notNull(),
    selectorDestroyedAt: timestamp("selectorDestroyedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    index("idx_shopify_privacy_data_job_org_status").on(t.organizationId, t.status),
    index("idx_shopify_privacy_data_job_claim").on(t.status, t.nextAttemptAt, t.leaseExpiresAt),
  ],
);
export type ShopifyPrivacyDataRequestJob = typeof shopifyPrivacyDataRequestJobs.$inferSelect;

/**
 * One-to-one execution state for `customers/redact`. Selectors remain in the
 * encrypted request child table until the deletion postcondition succeeds; this
 * job stores only internal scope, bounded machine state and aggregate evidence.
 */
export const shopifyPrivacyCustomerRedactionJobs = mysqlTable(
  "shopify_privacy_customer_redaction_jobs",
  {
    requestId: int("requestId").primaryKey(),
    organizationId: int("organizationId").notNull(),
    storeId: int("storeId").notNull(),
    status: mysqlEnum("status", [
      "received",
      "processing",
      "manual_review",
      "blocked_dependency",
      "failed_retryable",
      "failed_terminal",
      "completed",
    ])
      .default("received")
      .notNull(),
    attempts: int("attempts").default(0).notNull(),
    leaseId: varchar("leaseId", { length: 36 }),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    nextAttemptAt: timestamp("nextAttemptAt"),
    lastCheckpoint: varchar("lastCheckpoint", { length: 80 }),
    /** Bounded machine code only; never a selector, GID, payload or free text. */
    failureCode: varchar("failureCode", { length: 80 }),
    manifestVersion: int("manifestVersion").default(1).notNull(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    recordsFound: int("recordsFound").default(0).notNull(),
    tombstonesWritten: int("tombstonesWritten").default(0).notNull(),
    transactionsDeleted: int("transactionsDeleted").default(0).notNull(),
    anomalyScoresDeleted: int("anomalyScoresDeleted").default(0).notNull(),
    orphanBatchesDeleted: int("orphanBatchesDeleted").default(0).notNull(),
    remainingTransactions: int("remainingTransactions").default(0).notNull(),
    selectorDestroyedAt: timestamp("selectorDestroyedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    index("idx_shopify_privacy_redact_job_org_status").on(t.organizationId, t.status),
    index("idx_shopify_privacy_redact_job_store_status").on(t.storeId, t.status),
    index("idx_shopify_privacy_redact_job_claim").on(t.status, t.nextAttemptAt, t.leaseExpiresAt),
  ],
);
export type ShopifyPrivacyCustomerRedactionJob = typeof shopifyPrivacyCustomerRedactionJobs.$inferSelect;

/**
 * Permanent re-import barrier for an exact Shopify order. No order identifier,
 * selector ciphertext or provider payload is retained: only a tenant/store
 * scoped HMAC digest and the non-secret key generation used to derive it.
 */
export const shopifyOrderRedactionTombstones = mysqlTable(
  "shopify_order_redaction_tombstones",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull(),
    storeId: int("storeId").notNull(),
    keyVersion: varchar("keyVersion", { length: 32 }).notNull(),
    orderDigest: varchar("orderDigest", { length: 64 }).notNull(),
    sourceRequestId: int("sourceRequestId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_shopify_order_redaction_digest").on(
      t.organizationId,
      t.storeId,
      t.keyVersion,
      t.orderDigest,
    ),
    index("idx_shopify_order_redaction_store_version").on(t.organizationId, t.storeId, t.keyVersion),
    index("idx_shopify_order_redaction_request").on(t.organizationId, t.sourceRequestId),
  ],
);
export type ShopifyOrderRedactionTombstone = typeof shopifyOrderRedactionTombstones.$inferSelect;

/**
 * Transactional queue outbox. Deliberately contains only a kind and internal
 * job id plus dispatch mechanics: Redis inspection and dispatcher diagnostics
 * cannot reveal tenant, store, request hashes or selectors.
 */
export const shopifyPrivacyQueueOutbox = mysqlTable(
  "shopify_privacy_queue_outbox",
  {
    id: int("id").autoincrement().primaryKey(),
    kind: mysqlEnum("kind", ["customer_request", "customer_redact"]).notNull(),
    jobId: int("jobId").notNull(),
    status: mysqlEnum("status", ["pending", "dispatching", "failed_retryable", "failed_terminal", "dispatched"])
      .default("pending")
      .notNull(),
    attempts: int("attempts").default(0).notNull(),
    leaseId: varchar("leaseId", { length: 36 }),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    nextAttemptAt: timestamp("nextAttemptAt"),
    failureCode: varchar("failureCode", { length: 80 }),
    dispatchedAt: timestamp("dispatchedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_shopify_privacy_outbox_job").on(t.kind, t.jobId),
    index("idx_shopify_privacy_outbox_dispatch").on(t.status, t.nextAttemptAt, t.leaseExpiresAt),
  ],
);
export type ShopifyPrivacyQueueOutboxRow = typeof shopifyPrivacyQueueOutbox.$inferSelect;

/**
 * Dedicated private object metadata for a data-request export or zero-record
 * attestation. Presigned URLs are intentionally absent. `publicId` is a random
 * routing handle; authorization still re-proves the active store claimant.
 */
export const shopifyPrivacyArtifacts = mysqlTable(
  "shopify_privacy_artifacts",
  {
    /** One artifact per request; also the internal artifact id held by the job. */
    requestId: int("requestId").primaryKey(),
    organizationId: int("organizationId").notNull(),
    storeId: int("storeId").notNull(),
    publicId: varchar("publicId", { length: 36 }).notNull(),
    schemaVersion: int("schemaVersion").default(1).notNull(),
    artifactKind: mysqlEnum("artifactKind", ["order_evidence", "zero_record_attestation"]).notNull(),
    objectKey: varchar("objectKey", { length: 768 }).notNull(),
    /** Null only while `status = writing`; mandatory before delivery. */
    sha256: varchar("sha256", { length: 64 }),
    sizeBytes: int("sizeBytes"),
    recordsFound: int("recordsFound").default(0).notNull(),
    zeroReasonCode: varchar("zeroReasonCode", { length: 80 }),
    status: mysqlEnum("status", ["writing", "ready", "deleted"]).default("writing").notNull(),
    recipientUserId: int("recipientUserId").notNull(),
    deliveryChannel: mysqlEnum("deliveryChannel", ["authenticated_portal"])
      .default("authenticated_portal")
      .notNull(),
    deliveryStatus: mysqlEnum("deliveryStatus", ["pending", "acknowledged"])
      .default("pending")
      .notNull(),
    deliveryAcceptedAt: timestamp("deliveryAcceptedAt"),
    generatedAt: timestamp("generatedAt").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    downloadedAt: timestamp("downloadedAt"),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_shopify_privacy_artifact_public").on(t.publicId),
    index("idx_shopify_privacy_artifact_recipient").on(t.organizationId, t.recipientUserId, t.status),
    index("idx_shopify_privacy_artifact_expiry").on(t.status, t.expiresAt),
  ],
);
export type ShopifyPrivacyArtifact = typeof shopifyPrivacyArtifacts.$inferSelect;

/**
 * Durable, short-lived admission record for a `shop/redact` request. It exists
 * only while the processor removes the tenant. Completion must remove the
 * merchant-identifying job and leave, at most, a separately reviewed,
 * de-identified receipt.
 */
export const shopifyShopRedactionJobs = mysqlTable(
  "shopify_shop_redaction_jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    runId: varchar("runId", { length: 36 }).notNull(),
    organizationId: int("organizationId").notNull(),
    storeId: int("storeId").notNull(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    webhookId: varchar("webhookId", { length: 128 }).notNull(),
    status: mysqlEnum("status", ["admitted", "redacting", "failed", "completed"])
      .default("admitted")
      .notNull(),
    attempts: int("attempts").default(0).notNull(),
    lastCheckpoint: varchar("lastCheckpoint", { length: 80 }),
    failureCode: varchar("failureCode", { length: 80 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_shopify_redaction_request").on(t.requestHash),
    uniqueIndex("uq_shopify_redaction_run").on(t.runId),
    uniqueIndex("uq_shopify_redaction_store").on(t.storeId),
    index("idx_shopify_redaction_org_status").on(t.organizationId, t.status),
  ],
);
export type ShopifyShopRedactionJob = typeof shopifyShopRedactionJobs.$inferSelect;

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
  /** A reauthorization is under way: set before the code exchange retires the stored tokens. */
  "reauthorization_pending",
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
  /** Shopify issued a `shop/redact` request and the tenant is deletion-fenced. */
  "shop_redact_requested",
] as const;
export type ShopifyStatusReason = (typeof SHOPIFY_STATUS_REASONS)[number];

export const SHOPIFY_ORDER_LED_SCOPES = ["read_orders"] as const;
export const SHOPIFY_API_VERSION = "2026-07";
export const SHOPIFY_OAUTH_STATE_TTL_MS = 10 * 60_000;
export const SHOPIFY_ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
export const SHOPIFY_REFRESH_LEASE_MS = 60_000;
/**
 * How long an install lease is held at most. Everything done under it is
 * bounded — the code exchange and metadata lookup each time out at 30s — so a
 * healthy callback finishes far inside this; the TTL only frees a shop whose
 * callback crashed mid-install.
 */
export const SHOPIFY_INSTALL_LEASE_MS = 5 * 60_000;
