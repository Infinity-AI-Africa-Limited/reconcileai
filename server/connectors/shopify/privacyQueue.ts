import { createQueue, type JobQueue } from "../../jobQueue";
import {
  cleanupExpiredShopifyPrivacyArtifacts,
  dispatchShopifyPrivacyOutbox,
  handleShopifyPrivacyJob,
  type ShopifyPrivacyQueuePayload,
} from "./privacyCompletion";
import { handleShopifyCustomerRedactionJob } from "./customerRedaction";
import { handleShopifyShopRedactionJob } from "./shopRedaction";

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

/** Redis receives only `{ kind, jobId }`; authoritative scope stays in MySQL. */
export async function enqueueShopifyPrivacyJob(payload: ShopifyPrivacyQueuePayload): Promise<void> {
  const durable = await queue();
  const prefix = payload.kind === "customer_request"
    ? "privacy-request"
    : payload.kind === "customer_redact"
      ? "privacy-redact"
      : "privacy-shop-redact";
  const name = `${prefix}-${payload.jobId}`;
  // BullMQ retains failed jobs for inspection. Re-adding the same deterministic
  // id would return that failed row without running it, stranding DB-retryable
  // work. Remove any non-active prior entry first; an active job refuses removal
  // and leaves the outbox retryable until the next scanner pass.
  await durable.remove?.(name);
  await durable.enqueue(name, payload);
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
