import { createQueue, type JobQueue } from "../../jobQueue";
import {
  cleanupExpiredShopifyPrivacyArtifacts,
  dispatchShopifyPrivacyOutbox,
  handleShopifyPrivacyJob,
  type ShopifyPrivacyQueuePayload,
} from "./privacyCompletion";

let queuePromise: Promise<JobQueue<ShopifyPrivacyQueuePayload>> | null = null;

function queue(): Promise<JobQueue<ShopifyPrivacyQueuePayload>> {
  if (!queuePromise) {
    queuePromise = createQueue<ShopifyPrivacyQueuePayload>(
      "shopify-privacy",
      async (job) => handleShopifyPrivacyJob(job.data),
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

/** Redis receives only `{ kind, jobId }`; authoritative scope stays in MySQL. */
export async function enqueueShopifyPrivacyJob(payload: ShopifyPrivacyQueuePayload): Promise<void> {
  const durable = await queue();
  await durable.enqueue(`privacy-request-${payload.jobId}`, payload);
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

/** Start one process-local DB recovery scanner; correctness remains in the DB claims. */
export function startShopifyPrivacyRecoveryLoop(intervalMs = 30_000): void {
  if (recoveryTimer) return;
  const sweep = async () => {
    try {
      await recoverShopifyPrivacyOutbox();
    } catch (error) {
      console.error("[shopify-privacy] durable dispatch unavailable", { code: "durable_queue_unavailable" });
    }
    try {
      await cleanupExpiredShopifyPrivacyArtifacts();
    } catch {
      console.error("[shopify-privacy] artifact cleanup unavailable", { code: "artifact_cleanup_failed" });
    }
  };
  void sweep();
  recoveryTimer = setInterval(() => void sweep(), intervalMs);
  recoveryTimer.unref?.();
}
