import { createQueue, type JobQueue } from "../../jobQueue";
import { handleShopifyWebhookSync, markShopifyWebhookSyncFailed } from "./syncOrchestrator";

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
