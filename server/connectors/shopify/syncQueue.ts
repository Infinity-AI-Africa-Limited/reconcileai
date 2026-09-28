import { createQueue, type JobQueue } from "../../jobQueue";
import { handleShopifyWebhookSync, markShopifyWebhookSyncFailed } from "./syncOrchestrator";
import {
  handleShopifyManualSync,
  markShopifyManualSyncFailed,
  type ShopifyManualSyncPayload,
} from "./manualSync";

export interface ShopifyOrderSyncPayload {
  storeId: number;
  organizationId: number;
  webhookId: string;
}

let queuePromise: Promise<JobQueue<ShopifyOrderSyncPayload>> | null = null;

function queue(): Promise<JobQueue<ShopifyOrderSyncPayload>> {
  if (!queuePromise) {
    queuePromise = createQueue<ShopifyOrderSyncPayload>(
      "shopify-order-sync",
      async (job) => handleShopifyWebhookSync(job.data),
      {
        attempts: 6,
        backoffMs: 30_000,
        requireDurable: true,
        uniqueJobNames: true,
        onFinalFailure: async (job) => markShopifyWebhookSyncFailed(job.data),
        replaceFailedOnEnqueue: true,
      },
    ).catch((error) => {
      queuePromise = null;
      throw error;
    });
  }
  return queuePromise;
}

export async function enqueueShopifyOrderSync(payload: ShopifyOrderSyncPayload): Promise<void> {
  const durable = await queue();
  await durable.enqueue(`webhook-${payload.webhookId}`, payload);
}

/**
 * Manual ("refresh now") syncs. A separate queue from webhook syncs, and
 * deliberately NOT durable-only: a webhook-triggered sync is owed for a delivery
 * Shopify was told succeeded, so losing it loses data, whereas a manual sync
 * lost on restart loses nothing — the watermark has not moved, the page shows
 * the request as stalled, and the merchant asks again. With REDIS_URL set this
 * is BullMQ like everything else.
 *
 * One attempt: `runShopifyOrderSync` already retries Shopify's transient
 * failures page by page, and a failure the merchant can see beats one retried
 * out of sight for minutes. Per-store coalescing (see coalesceKey) means
 * repeated clicks cost at most one running sync and one follow-up, never two
 * syncs of one store at once; the worker runs a few stores in parallel so one
 * store's 60-day backfill does not hold every other store's refresh behind it.
 */
const MANUAL_SYNC_CONCURRENCY = 4;
let manualQueuePromise: Promise<JobQueue<ShopifyManualSyncPayload>> | null = null;

function manualQueue(): Promise<JobQueue<ShopifyManualSyncPayload>> {
  if (!manualQueuePromise) {
    manualQueuePromise = createQueue<ShopifyManualSyncPayload>(
      "shopify-manual-sync",
      async (job) => handleShopifyManualSync(job.data),
      {
        attempts: 1,
        backoffMs: 30_000,
        concurrency: MANUAL_SYNC_CONCURRENCY,
        onFinalFailure: async (job) => markShopifyManualSyncFailed(job.data),
      },
    ).catch((error) => {
      manualQueuePromise = null;
      throw error;
    });
  }
  return manualQueuePromise;
}

export async function enqueueShopifyManualSync(payload: ShopifyManualSyncPayload): Promise<void> {
  const queue = await manualQueue();
  await queue.enqueue(`manual-${payload.storeId}`, payload, {
    coalesceKey: `shopify-manual-sync:${payload.organizationId}:${payload.storeId}`,
  });
}
