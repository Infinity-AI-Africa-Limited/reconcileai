/**
 * Multi-tenant hardening tables: per-tenant encryption keys and quotas.
 *
 * Kept in a separate schema file so tenant-infrastructure concerns are
 * reviewable in one place (and to avoid merge traffic on schema.ts).
 */
import {
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Per-tenant envelope encryption keys ─────────────────────────────────────
// Each organization gets its own Data Encryption Key (DEK). The DEK is never
// stored in plaintext — it is wrapped by a master key: AWS KMS in cloud
// deployments, or a local master key (TENANT_MASTER_KEY) for on-prem/air-gap.
// Tenant data encrypted under one org's DEK is cryptographically useless to
// another org even if a query-scoping bug ever leaked ciphertext.
export const tenantEncryptionKeys = mysqlTable(
  "tenant_encryption_keys",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull(),
    /** Which master-key provider wrapped this DEK. */
    provider: mysqlEnum("provider", ["local", "aws_kms"]).notNull(),
    /** Wrapped (encrypted) DEK, base64/hex — never the raw key. */
    wrappedDek: text("wrappedDek").notNull(),
    /** KMS key id/ARN when provider = aws_kms. */
    kmsKeyId: varchar("kmsKeyId", { length: 400 }),
    /** Increments on rotation; ciphertexts embed the version they used. */
    version: int("version").default(1).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    rotatedAt: timestamp("rotatedAt"),
  },
  (t) => [
    uniqueIndex("uq_tenant_key_org_version").on(t.organizationId, t.version),
    index("idx_tenant_key_org_active").on(t.organizationId, t.isActive),
  ],
);

export type TenantEncryptionKey = typeof tenantEncryptionKeys.$inferSelect;
export type InsertTenantEncryptionKey = typeof tenantEncryptionKeys.$inferInsert;

// ─── Per-tenant rate limits and resource quotas ──────────────────────────────
// One row per organization; created with platform defaults at provisioning.
// The rate limiter and job runners read these; super admins tune per tenant.
export const tenantQuotas = mysqlTable(
  "tenant_quotas",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull(),
    // Rate limits (per minute, per tenant)
    apiRequestsPerMin: int("apiRequestsPerMin").default(300).notNull(),
    // 1M txns/day ≈ 695/min sustained; default gives ~2× burst headroom.
    webhookEventsPerMin: int("webhookEventsPerMin").default(1500).notNull(),
    // Resource quotas
    maxConcurrentReconciliations: int("maxConcurrentReconciliations").default(2).notNull(),
    maxCsvImportRowsPerDay: int("maxCsvImportRowsPerDay").default(2_000_000).notNull(),
    /** Soft limit: exceeding alerts ops, never drops bank transactions. */
    dailyTransactionSoftLimit: int("dailyTransactionSoftLimit").default(1_000_000).notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [uniqueIndex("uq_tenant_quota_org").on(t.organizationId)],
);

export type TenantQuota = typeof tenantQuotas.$inferSelect;
export type InsertTenantQuota = typeof tenantQuotas.$inferInsert;
