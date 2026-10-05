import type { QueueStats } from "../../jobQueue";
import { loggableError } from "../../dbErrors";
import { verifyShopifyPrivacyQueue } from "./privacyQueue";
import { verifyShopifyOrderSyncQueue } from "./syncQueue";

export type ShopifyRuntimeQueueReadiness =
  | { status: "confirmed"; durable: true }
  | {
      status: "unavailable";
      durable: false;
      reason: "redis_not_configured" | "queue_unavailable" | "queue_timeout";
    };

/**
 * How long readiness may take before it is answered "unavailable".
 *
 * Without a deadline an unreachable Redis is not a failure but a wait without
 * end: BullMQ holds every command until the connection is ready, and its
 * default retry strategy never gives up, so a count read neither resolves nor
 * rejects. A merchant's install request would hang with it.
 */
export const SHOPIFY_QUEUE_READINESS_TIMEOUT_MS = 5_000;

/**
 * Establish non-merchant evidence that the two Shopify queues are actually
 * backed by BullMQ. It creates the live queues with their production handlers,
 * then asks Redis for queue counts; it never enqueues a job or reads merchant
 * data. Every Shopify admission path calls this before it can begin OAuth work.
 * Bounded: it answers within `timeoutMs`, whatever Redis does.
 */
export async function confirmShopifyRuntimeQueues(
  options: { timeoutMs?: number } = {},
): Promise<ShopifyRuntimeQueueReadiness> {
  if (!process.env.REDIS_URL?.trim()) {
    return {
      status: "unavailable",
      durable: false,
      reason: "redis_not_configured",
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs ?? SHOPIFY_QUEUE_READINESS_TIMEOUT_MS);
    // Never keep the process alive for a readiness answer.
    timer.unref?.();
  });
  try {
    // A read still pending when the deadline wins settles into the race's own
    // handler, so a late rejection is never unhandled.
    const outcome = await Promise.race([
      Promise.all([verifyShopifyOrderSyncQueue(), verifyShopifyPrivacyQueue()]),
      deadline,
    ]);
    if (outcome === "timeout") return { status: "unavailable", durable: false, reason: "queue_timeout" };
    return outcome.every(isConfirmedBullMqQueue)
      ? { status: "confirmed", durable: true }
      : { status: "unavailable", durable: false, reason: "queue_unavailable" };
  } catch {
    // The public install route deliberately gives no dependency details to a
    // merchant. `/api/health` retains the queue snapshot for operators.
    return {
      status: "unavailable",
      durable: false,
      reason: "queue_unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Boot: build the Shopify queues and read their counts, so `/api/health` has
 * evidence on a Redis-configured instance, WITHOUT holding up startup.
 *
 * It returns nothing to wait on, by design: the server must listen, and
 * `/api/healthz` answer, whatever Redis is doing. Nothing depends on the
 * result being in before traffic: the OAuth routes check readiness themselves
 * on every request.
 */
export function startShopifyQueueEvidence(
  probe: () => Promise<ShopifyRuntimeQueueReadiness> = confirmShopifyRuntimeQueues,
): void {
  if (!process.env.REDIS_URL?.trim()) return;
  void probe().then(
    (readiness) => {
      if (readiness.durable) {
        console.log("[boot] Shopify durable queues confirmed");
      } else {
        console.error("[boot] Shopify durable queues unavailable", {
          code: "shopify_durable_queue_unavailable",
          reason: readiness.reason,
        });
      }
    },
    (error: unknown) => {
      console.error("[boot] Shopify durable queue readiness failed", {
        code: "shopify_durable_queue_readiness_failed",
        ...loggableError(error),
      });
    },
  );
}

function isConfirmedBullMqQueue(stats: QueueStats): boolean {
  return stats.backend === "bullmq" && stats.durable && !stats.error;
}
