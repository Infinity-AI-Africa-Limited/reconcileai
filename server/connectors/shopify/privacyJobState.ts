/**
 * The job-state rules every Shopify privacy worker shares, in one place.
 *
 * The queue is a trigger; the job row is the truth. Each worker claims by the
 * predicates below, and the outbox dispatcher re-arms a dispatch whose job the
 * database still says is claimable. Both must use the SAME predicate per job
 * kind — a dispatcher that re-arms by one rule while a worker claims by another
 * strands work (a dispatch nobody re-sends, or one no worker can take).
 */
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import {
  shopifyPrivacyCustomerRedactionJobs,
  shopifyPrivacyDataRequestJobs,
  shopifyShopRedactionJobs,
} from "../../../drizzle/shopify_schema";

/**
 * A `processing` row is reclaimable once its lease has expired — and a row
 * carrying NO lease counts as expired.
 *
 * `leaseExpiresAt` is nullable, and `NULL <= now` is NULL rather than true, so
 * a bare `lte` would make such a row unclaimable for ever while
 * `isLivePrivacyJobStatus` still calls it live — the outbox would re-arm a
 * dispatch no worker can ever take. Every writer sets the lease in the same
 * UPDATE as the status, so this state should not arise; it is admitted here so
 * that if it ever does (a backfill, a manual edit, a writer added later) the
 * job is recovered rather than stranded in silence.
 */
export function leaseExpired(column: MySqlColumn, now: Date) {
  return or(isNull(column), lte(column, now));
}

/** Job states that still owe work. Anything else is terminal or awaiting a person. */
export const LIVE_PRIVACY_JOB_STATUSES = ["received", "failed_retryable", "processing"] as const;

export function isLivePrivacyJobStatus(status: string | null | undefined): boolean {
  return (LIVE_PRIVACY_JOB_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * A queued run found the job live but not claimable yet — typically still
 * leased by a worker that died. Thrown so the durable queue keeps the entry
 * scheduled; returning quietly would settle it while the job still owes work.
 */
export class ShopifyPrivacyJobNotClaimableError extends Error {
  constructor() {
    super("Shopify privacy job is live but not claimable yet");
    this.name = "ShopifyPrivacyJobNotClaimableError";
  }
}

export function claimableDataRequestJob(now: Date) {
  return or(
    and(
      inArray(shopifyPrivacyDataRequestJobs.status, ["received", "failed_retryable"]),
      or(isNull(shopifyPrivacyDataRequestJobs.nextAttemptAt), lte(shopifyPrivacyDataRequestJobs.nextAttemptAt, now)),
    ),
    and(
      eq(shopifyPrivacyDataRequestJobs.status, "processing"),
      leaseExpired(shopifyPrivacyDataRequestJobs.leaseExpiresAt, now),
    ),
  );
}

/** Shop-redaction jobs start `admitted`, not `received`; otherwise the same rules. */
export const LIVE_SHOP_REDACTION_JOB_STATUSES = ["admitted", "failed_retryable", "processing"] as const;

export function isLiveShopRedactionJobStatus(status: string | null | undefined): boolean {
  return (LIVE_SHOP_REDACTION_JOB_STATUSES as readonly string[]).includes(status ?? "");
}

export function claimableShopRedactionJob(now: Date) {
  return or(
    and(
      inArray(shopifyShopRedactionJobs.status, ["admitted", "failed_retryable"]),
      or(isNull(shopifyShopRedactionJobs.nextAttemptAt), lte(shopifyShopRedactionJobs.nextAttemptAt, now)),
    ),
    and(
      eq(shopifyShopRedactionJobs.status, "processing"),
      leaseExpired(shopifyShopRedactionJobs.leaseExpiresAt, now),
    ),
  );
}

export function claimableCustomerRedactionJob(now: Date) {
  return or(
    and(
      inArray(shopifyPrivacyCustomerRedactionJobs.status, ["received", "failed_retryable"]),
      or(
        isNull(shopifyPrivacyCustomerRedactionJobs.nextAttemptAt),
        lte(shopifyPrivacyCustomerRedactionJobs.nextAttemptAt, now),
      ),
    ),
    and(
      eq(shopifyPrivacyCustomerRedactionJobs.status, "processing"),
      leaseExpired(shopifyPrivacyCustomerRedactionJobs.leaseExpiresAt, now),
    ),
  );
}
