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
import {
  shopifyPrivacyCustomerRedactionJobs,
  shopifyPrivacyDataRequestJobs,
} from "../../../drizzle/shopify_schema";

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
      lte(shopifyPrivacyDataRequestJobs.leaseExpiresAt, now),
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
      lte(shopifyPrivacyCustomerRedactionJobs.leaseExpiresAt, now),
    ),
  );
}
