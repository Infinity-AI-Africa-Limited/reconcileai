import type { QueueStats } from "../../jobQueue";
import { verifyShopifyPrivacyQueue } from "./privacyQueue";
import { verifyShopifyOrderSyncQueue } from "./syncQueue";

export type ShopifyRuntimeQueueReadiness =
  | { status: "confirmed"; durable: true }
  | {
      status: "unavailable";
      durable: false;
      reason: "redis_not_configured" | "queue_unavailable";
    };

/**
 * Establish non-merchant evidence that the two Shopify queues are actually
 * backed by BullMQ. It creates the live queues with their production handlers,
 * then asks Redis for queue counts; it never enqueues a job or reads merchant
 * data. Every Shopify admission path calls this before it can begin OAuth work.
 */
export async function confirmShopifyRuntimeQueues(): Promise<ShopifyRuntimeQueueReadiness> {
  if (!process.env.REDIS_URL?.trim()) {
    return {
      status: "unavailable",
      durable: false,
      reason: "redis_not_configured",
    };
  }

  try {
    const stats = await Promise.all([
      verifyShopifyOrderSyncQueue(),
      verifyShopifyPrivacyQueue(),
    ]);
    return stats.every(isConfirmedBullMqQueue)
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
  }
}

function isConfirmedBullMqQueue(stats: QueueStats): boolean {
  return stats.backend === "bullmq" && stats.durable && !stats.error;
}
