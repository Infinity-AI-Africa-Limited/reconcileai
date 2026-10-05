import { createQueue, type JobQueue, type QueueStats } from "../../jobQueue";
import { singleFlight } from "../../singleFlight";
import { loggableError } from "../../dbErrors";
import {
  cleanupExpiredShopifyPrivacyArtifacts,
  dispatchShopifyPrivacyOutbox,
  handleShopifyPrivacyJob,
  type ShopifyPrivacyQueuePayload,
} from "./privacyCompletion";
import { handleShopifyCustomerRedactionJob } from "./customerRedaction";
import { handleShopifyShopRedactionJob } from "./shopRedaction";

/** Queue-name prefix per job kind: a job id is unique only within its own table. */
export function shopifyPrivacyJobPrefix(kind: ShopifyPrivacyQueuePayload["kind"]): string {
  switch (kind) {
    case "customer_request":
      return "privacy-request";
    case "customer_redact":
      return "privacy-redact";
    case "shop_redact":
      return "privacy-shop-redact";
  }
}

let queuePromise: Promise<JobQueue<ShopifyPrivacyQueuePayload>> | null = null;

function queue(): Promise<JobQueue<ShopifyPrivacyQueuePayload>> {
  if (!queuePromise) {
    queuePromise = createQueue<ShopifyPrivacyQueuePayload>(
      "shopify-privacy",
      async (job) => {
        if (job.data.kind === "customer_redact") {
          return handleShopifyCustomerRedactionJob(job.data.jobId);
        }
        if (job.data.kind === "shop_redact") {
          return handleShopifyShopRedactionJob(job.data.jobId);
        }
        return handleShopifyPrivacyJob(job.data);
      },
      {
        attempts: 6,
        backoffMs: 30_000,
        requireDurable: true,
        uniqueJobNames: true,
      },
    ).catch((error) => {
      queuePromise = null;
      throw error;
    });
  }
  return queuePromise;
}

/**
 * Build the production privacy queue and read its BullMQ counts without adding
 * a request. This is non-merchant runtime evidence only; privacy work still
 * enters through the transactional outbox after its database commit.
 */
export async function verifyShopifyPrivacyQueue(): Promise<QueueStats> {
  return (await queue()).stats();
}

/**
 * Redis receives only `{ kind, jobId }`; authoritative scope stays in MySQL.
 *
 * The queue id is unique per dispatch. A later database re-dispatch must not be
 * swallowed by a settled BullMQ entry for the same job; the database lease keeps
 * duplicate worker delivery harmless.
 */
export async function enqueueShopifyPrivacyJob(
  payload: ShopifyPrivacyQueuePayload,
  dispatchAttempt = 1,
): Promise<void> {
  const durable = await queue();
  await durable.enqueue(`${shopifyPrivacyJobPrefix(payload.kind)}-${payload.jobId}-d${dispatchAttempt}`, payload);
}

/**
 * Replays the transactional outbox. This is safe after any crash boundary and
 * deliberately fails when Redis/BullMQ is unavailable rather than pretending
 * accepted requests have reached an operational queue.
 */
export async function recoverShopifyPrivacyOutbox(): Promise<void> {
  await dispatchShopifyPrivacyOutbox({ enqueue: enqueueShopifyPrivacyJob });
}

let recoveryTimer: NodeJS.Timeout | null = null;

/**
 * One recovery sweep: re-dispatch the outbox, then clean expired artifacts.
 * Each half contains its own failure so one outage does not stall the other.
 * Exported for tests; production runs it from the loop below.
 */
export async function runShopifyPrivacyRecoverySweep(deps: {
  recover?: () => Promise<unknown>;
  cleanup?: () => Promise<unknown>;
} = {}): Promise<void> {
  try {
    await (deps.recover ?? recoverShopifyPrivacyOutbox)();
  } catch (error) {
    console.error("[shopify-privacy] durable dispatch unavailable", { code: "durable_queue_unavailable", ...loggableError(error) });
  }
  try {
    await (deps.cleanup ?? cleanupExpiredShopifyPrivacyArtifacts)();
  } catch (error) {
    console.error("[shopify-privacy] artifact cleanup unavailable", { code: "artifact_cleanup_failed", ...loggableError(error) });
  }
}

/** Start one process-local DB recovery scanner; correctness remains in the DB claims. */
export function startShopifyPrivacyRecoveryLoop(intervalMs = 30_000): void {
  if (recoveryTimer) return;
  const sweep = singleFlight(() => runShopifyPrivacyRecoverySweep());
  void sweep();
  recoveryTimer = setInterval(() => void sweep(), intervalMs);
  recoveryTimer.unref?.();
}
