/**
 * Tenant-specific rate limiting and resource quotas.
 *
 * Fixed-window counters keyed by (organizationId, bucket), with per-tenant
 * limits loaded from tenant_quotas (60s cache) and platform defaults for
 * tenants without a row. In-process by design: reconciliation currently runs
 * in one process (BullMQ/Redis is the tracked scale-out step); the store is
 * behind an interface so a Redis store drops in without touching call sites.
 *
 * Noisy-neighbour goal: one tenant hammering webhooks/CSV/API cannot starve
 * the other tenants' reconciliation work.
 */
import { eq } from "drizzle-orm";
import { tenantQuotas, type TenantQuota } from "../../drizzle/tenant_schema";
import { getDb } from "../db";

export type RateBucket = "api" | "webhook" | "csv_import" | "sync_trigger";

export interface TenantLimits {
  apiRequestsPerMin: number;
  webhookEventsPerMin: number;
  maxConcurrentReconciliations: number;
  maxCsvImportRowsPerDay: number;
  dailyTransactionSoftLimit: number;
}

// 1M txns/day ≈ 695/min sustained — webhook headroom is ~2× that so bursts
// (end-of-day CBS posting runs) don't throttle a tenant at target volume.
export const DEFAULT_LIMITS: TenantLimits = {
  apiRequestsPerMin: 300,
  webhookEventsPerMin: 1500,
  maxConcurrentReconciliations: 2,
  maxCsvImportRowsPerDay: 2_000_000,
  dailyTransactionSoftLimit: 1_000_000,
};

/** Per-bucket per-minute limit selector. */
function limitFor(bucket: RateBucket, limits: TenantLimits): number {
  switch (bucket) {
    case "api":
      return limits.apiRequestsPerMin;
    case "webhook":
      return limits.webhookEventsPerMin;
    case "csv_import":
      return 10; // uploads per minute — row volume is quota'd separately
    case "sync_trigger":
      return 6; // manual syncs per minute
    default: {
      const exhaustive: never = bucket;
      return exhaustive;
    }
  }
}

// ─── Quota cache (60s) ───────────────────────────────────────────────────────
const quotaCache = new Map<number, { limits: TenantLimits; expiresAt: number }>();
const QUOTA_CACHE_MS = 60_000;

export async function getTenantLimits(organizationId: number): Promise<TenantLimits> {
  const cached = quotaCache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.limits;
  let limits = DEFAULT_LIMITS;
  try {
    const db = await getDb();
    if (db) {
      const [row] = await db
        .select()
        .from(tenantQuotas)
        .where(eq(tenantQuotas.organizationId, organizationId))
        .limit(1);
      if (row) limits = toLimits(row);
    }
  } catch (err) {
    console.error("[rateLimit] quota lookup failed; using defaults:", err);
  }
  quotaCache.set(organizationId, { limits, expiresAt: Date.now() + QUOTA_CACHE_MS });
  return limits;
}

function toLimits(row: TenantQuota): TenantLimits {
  return {
    apiRequestsPerMin: row.apiRequestsPerMin,
    webhookEventsPerMin: row.webhookEventsPerMin,
    maxConcurrentReconciliations: row.maxConcurrentReconciliations,
    maxCsvImportRowsPerDay: row.maxCsvImportRowsPerDay,
    dailyTransactionSoftLimit: row.dailyTransactionSoftLimit,
  };
}

/** Test-only. */
export function clearRateLimitStateForTests(): void {
  quotaCache.clear();
  windows.clear();
}

// ─── Fixed-window counter store (swap for Redis at scale-out) ────────────────
const windows = new Map<string, { windowStart: number; count: number }>();
const WINDOW_MS = 60_000;

export interface RateCheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets (for Retry-After). */
  retryAfterSec: number;
}

/**
 * Count one hit against (org, bucket) and say whether it's within limits.
 * Pure math around an injectable clock — deterministic in tests.
 */
export function checkWindow(
  key: string,
  limit: number,
  now: number = Date.now(),
): RateCheckResult {
  const w = windows.get(key);
  if (!w || now - w.windowStart >= WINDOW_MS) {
    windows.set(key, { windowStart: now, count: 1 });
    return { allowed: true, limit, remaining: limit - 1, retryAfterSec: 0 };
  }
  w.count++;
  const retryAfterSec = Math.ceil((w.windowStart + WINDOW_MS - now) / 1000);
  if (w.count > limit) {
    return { allowed: false, limit, remaining: 0, retryAfterSec };
  }
  return { allowed: true, limit, remaining: limit - w.count, retryAfterSec: 0 };
}

/** Tenant-aware rate check for a bucket. */
export async function checkTenantRate(
  organizationId: number,
  bucket: RateBucket,
  now: number = Date.now(),
): Promise<RateCheckResult> {
  const limits = await getTenantLimits(organizationId);
  return checkWindow(`${organizationId}:${bucket}`, limitFor(bucket, limits), now);
}

// Periodic sweep so idle tenants don't accumulate stale windows.
setInterval(() => {
  const cutoff = Date.now() - 2 * WINDOW_MS;
  for (const [k, w] of Array.from(windows.entries())) {
    if (w.windowStart < cutoff) windows.delete(k);
  }
}, 5 * WINDOW_MS).unref();

// ─── Concurrency quota: reconciliations per tenant ───────────────────────────
const runningJobs = new Map<number, number>();

/**
 * Try to occupy a reconciliation slot for a tenant. Returns a release
 * function, or null when the tenant is at its concurrency quota.
 */
export async function acquireReconciliationSlot(
  organizationId: number,
): Promise<(() => void) | null> {
  const limits = await getTenantLimits(organizationId);
  const current = runningJobs.get(organizationId) ?? 0;
  if (current >= limits.maxConcurrentReconciliations) return null;
  runningJobs.set(organizationId, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = runningJobs.get(organizationId) ?? 1;
    if (n <= 1) runningJobs.delete(organizationId);
    else runningJobs.set(organizationId, n - 1);
  };
}
