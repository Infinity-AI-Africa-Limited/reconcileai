import { and, eq, sql } from "drizzle-orm";
import {
  shopifyConnectorStores,
  shopifyPrivacyCustomerRedactionJobs,
  shopifyPrivacyDataRequestJobs,
  shopifyPrivacyQueueOutbox,
  shopifyPrivacyRequestSelectors,
  shopifyPrivacyRequests,
  shopifyWebhookEvents,
  type ShopifyConnectorStore,
} from "../../../drizzle/shopify_schema";
import { blindIndexForTenant, encryptForTenant } from "../../_core/tenantKeys";
import type { DbTransaction } from "../../db";
import { affectedRows } from "./tokenStore";

export type ShopifyCustomerPrivacyTopic = "customers/data_request" | "customers/redact";
export type ShopifyPrivacyResourceType = "customer" | "order";

interface CustomerPrivacyBody {
  shop_id?: unknown;
  shop_domain?: unknown;
  data_request?: { id?: unknown } | null;
  customer?: { id?: unknown } | null;
  orders_requested?: unknown;
  orders_to_redact?: unknown;
}

interface ValidatedSelector {
  resourceType: ShopifyPrivacyResourceType;
  position: number;
  externalId: string;
}

export type CustomerPrivacyValidation =
  | { ok: true; selectors: ValidatedSelector[] }
  | { ok: false; errorCode: string };

export interface PreparedPrivacySelector {
  resourceType: ShopifyPrivacyResourceType;
  position: number;
  externalIdEnc: string;
  externalIdHmac: string;
}

const MAX_ORDER_SELECTORS = 10_000;

/**
 * Shopify's REST webhook identifiers are positive decimal integers. JSON numbers
 * above Number.MAX_SAFE_INTEGER have already lost information, so they are
 * refused instead of persisting a selector that could target the wrong record.
 */
function canonicalProviderId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[1-9]\d*$/.test(trimmed) ? trimmed : null;
}

function storedShopIdMatches(storedShopId: string, webhookShopId: string): boolean {
  if (storedShopId === webhookShopId) return true;
  return storedShopId === `gid://shopify/Shop/${webhookShopId}`;
}

/** Validate only the topic-specific fields needed for later scoped fulfilment. */
export function validateCustomerPrivacySelectors(
  topic: ShopifyCustomerPrivacyTopic,
  body: CustomerPrivacyBody | null,
  store: Pick<ShopifyConnectorStore, "shopId" | "shopDomain">,
): CustomerPrivacyValidation {
  if (!body || body.shop_domain !== store.shopDomain) {
    return { ok: false, errorCode: "invalid_shop_domain" };
  }

  const webhookShopId = canonicalProviderId(body.shop_id);
  if (!webhookShopId || !storedShopIdMatches(store.shopId, webhookShopId)) {
    return { ok: false, errorCode: "invalid_shop_id" };
  }

  if (topic === "customers/data_request" && !canonicalProviderId(body.data_request?.id)) {
    return { ok: false, errorCode: "invalid_data_request_id" };
  }

  const customerId = canonicalProviderId(body.customer?.id);
  if (!customerId) return { ok: false, errorCode: "invalid_customer_id" };

  const rawOrders = topic === "customers/data_request" ? body.orders_requested : body.orders_to_redact;
  if (rawOrders !== undefined && !Array.isArray(rawOrders)) {
    return { ok: false, errorCode: "invalid_order_selectors" };
  }
  const orderValues = (rawOrders ?? []) as unknown[];
  if (orderValues.length > MAX_ORDER_SELECTORS) {
    return { ok: false, errorCode: "too_many_order_selectors" };
  }

  const orderIds: string[] = [];
  const seen = new Set<string>();
  for (const rawOrderId of orderValues) {
    const orderId = canonicalProviderId(rawOrderId);
    if (!orderId || seen.has(orderId)) {
      return { ok: false, errorCode: "invalid_order_selectors" };
    }
    seen.add(orderId);
    orderIds.push(orderId);
  }

  return {
    ok: true,
    selectors: [
      { resourceType: "customer", position: 0, externalId: customerId },
      ...orderIds.map((externalId, position) => ({ resourceType: "order" as const, position, externalId })),
    ],
  };
}

/** Encrypt and blind-index validated IDs before opening the admission transaction. */
export async function protectCustomerPrivacySelectors(
  organizationId: number,
  storeId: number,
  selectors: ValidatedSelector[],
): Promise<PreparedPrivacySelector[]> {
  return Promise.all(
    selectors.map(async ({ resourceType, position, externalId }) => {
      const context = `shopify:privacy-selector:${storeId}:${resourceType}`;
      const [externalIdEnc, externalIdHmac] = await Promise.all([
        encryptForTenant(organizationId, externalId),
        blindIndexForTenant(organizationId, context, externalId),
      ]);
      return { resourceType, position, externalIdEnc, externalIdHmac };
    }),
  );
}

/**
 * Durably admit a customer privacy request and its selectors as one unit. This
 * records work for a future processor; it never fulfils or completes a request.
 */
export async function admitShopifyCustomerPrivacyRequest(
  tx: DbTransaction,
  params: {
    store: Pick<ShopifyConnectorStore, "id" | "organizationId">;
    topic: ShopifyCustomerPrivacyTopic;
    requestHash: string;
    webhookId: string;
    validation: CustomerPrivacyValidation;
    selectors: PreparedPrivacySelector[];
  },
): Promise<"received" | "manual_review"> {
  const status = params.validation.ok ? "received" : "manual_review";
  const admissionErrorCode = params.validation.ok ? null : params.validation.errorCode;

  await tx
    .insert(shopifyPrivacyRequests)
    .values({
      storeId: params.store.id,
      organizationId: params.store.organizationId,
      topic: params.topic,
      requestHash: params.requestHash,
      subjectHash: null,
      status,
      admissionErrorCode,
    })
    .onDuplicateKeyUpdate({ set: { requestHash: sql`${shopifyPrivacyRequests.requestHash}` } });

  if (params.validation.ok) {
    const [request] = await tx
      .select({ id: shopifyPrivacyRequests.id, status: shopifyPrivacyRequests.status })
      .from(shopifyPrivacyRequests)
      .where(
        and(
          eq(shopifyPrivacyRequests.storeId, params.store.id),
          eq(shopifyPrivacyRequests.organizationId, params.store.organizationId),
          eq(shopifyPrivacyRequests.topic, params.topic),
          eq(shopifyPrivacyRequests.requestHash, params.requestHash),
        ),
      )
      .limit(1)
      .for("update");
    if (!request) throw new Error("Admitted Shopify privacy request could not be resolved");

    // Shopify can redeliver the same semantic privacy request with a distinct
    // webhook id. A completed request has already destroyed its selectors and
    // restored its write fence; replaying admission must settle only the new
    // receipt and must never resurrect selectors, a job, an outbox row, or a
    // store fence.
    if (request.status === "completed") {
      await tx
        .update(shopifyConnectorStores)
        .set({ lastWebhookAt: new Date() })
        .where(
          and(
            eq(shopifyConnectorStores.id, params.store.id),
            eq(shopifyConnectorStores.organizationId, params.store.organizationId),
          ),
        );
      await tx
        .update(shopifyWebhookEvents)
        .set({ status: "processed", errorCode: null, processedAt: new Date() })
        .where(eq(shopifyWebhookEvents.webhookId, params.webhookId));
      return "received";
    }

    if (params.selectors.length > 0) {
      await tx
        .insert(shopifyPrivacyRequestSelectors)
        .values(
          params.selectors.map((selector) => ({
            requestId: request.id,
            organizationId: params.store.organizationId,
            ...selector,
          })),
        )
        .onDuplicateKeyUpdate({
          set: { externalIdHmac: sql`${shopifyPrivacyRequestSelectors.externalIdHmac}` },
        });
    }

    if (params.topic === "customers/data_request") {
      // The execution state and queue intent commit with admission. A crash after
      // this transaction can delay dispatch, but cannot make the request vanish.
      await tx
        .insert(shopifyPrivacyDataRequestJobs)
        .values({
          requestId: request.id,
          organizationId: params.store.organizationId,
          storeId: params.store.id,
          status: "received",
          lastCheckpoint: "admitted",
          manifestVersion: 1,
        })
        .onDuplicateKeyUpdate({ set: { requestId: sql`${shopifyPrivacyDataRequestJobs.requestId}` } });
      await tx
        .insert(shopifyPrivacyQueueOutbox)
        .values({ kind: "customer_request", jobId: request.id, status: "pending" })
        .onDuplicateKeyUpdate({ set: { jobId: sql`${shopifyPrivacyQueueOutbox.jobId}` } });
    } else {
      // The request, encrypted selectors, execution state, dispatch intent, and
      // write fence are one admission commit. Therefore a Shopify 2xx can never
      // exist without recoverable database work or while sync remains writable.
      const [storeState] = await tx
        .select({
          status: shopifyConnectorStores.status,
          privacyRedactionState: shopifyConnectorStores.privacyRedactionState,
          privacyRedactionRequestId: shopifyConnectorStores.privacyRedactionRequestId,
        })
        .from(shopifyConnectorStores)
        .where(
          and(
            eq(shopifyConnectorStores.id, params.store.id),
            eq(shopifyConnectorStores.organizationId, params.store.organizationId),
          ),
        )
        .limit(1)
        .for("update");
      const alreadyFencedForThisRequest =
        storeState?.privacyRedactionState === "customer_redacting" &&
        storeState.privacyRedactionRequestId === request.id;
      if (!storeState || storeState.status !== "active" ||
          (storeState.privacyRedactionState !== "active" && !alreadyFencedForThisRequest)) {
        throw new Error("Shopify customer redaction store fence unavailable");
      }
      if (!alreadyFencedForThisRequest) {
        const fenced = await tx
          .update(shopifyConnectorStores)
          .set({ privacyRedactionState: "customer_redacting", privacyRedactionRequestId: request.id })
          .where(
            and(
              eq(shopifyConnectorStores.id, params.store.id),
              eq(shopifyConnectorStores.organizationId, params.store.organizationId),
              eq(shopifyConnectorStores.status, "active"),
              eq(shopifyConnectorStores.privacyRedactionState, "active"),
            ),
          );
        if (affectedRows(fenced) !== 1) throw new Error("Shopify customer redaction fence lost");
      }
      await tx
        .insert(shopifyPrivacyCustomerRedactionJobs)
        .values({
          requestId: request.id,
          organizationId: params.store.organizationId,
          storeId: params.store.id,
          status: "received",
          lastCheckpoint: "admitted",
          manifestVersion: 1,
        })
        .onDuplicateKeyUpdate({ set: { requestId: sql`${shopifyPrivacyCustomerRedactionJobs.requestId}` } });
      await tx
        .insert(shopifyPrivacyQueueOutbox)
        .values({ kind: "customer_redact", jobId: request.id, status: "pending" })
        .onDuplicateKeyUpdate({ set: { jobId: sql`${shopifyPrivacyQueueOutbox.jobId}` } });
    }
  }

  await tx
    .update(shopifyConnectorStores)
    .set({ lastWebhookAt: new Date() })
    .where(
      and(
        eq(shopifyConnectorStores.id, params.store.id),
        eq(shopifyConnectorStores.organizationId, params.store.organizationId),
      ),
    );
  await tx
    .update(shopifyWebhookEvents)
    .set({
      status: "processed",
      errorCode: params.validation.ok ? null : "invalid_privacy_selectors",
      processedAt: new Date(),
    })
    .where(eq(shopifyWebhookEvents.webhookId, params.webhookId));

  return status;
}
