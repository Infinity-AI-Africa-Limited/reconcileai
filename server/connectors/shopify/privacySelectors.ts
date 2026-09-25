import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/mysql-core";
import {
  shopifyConnectorStores,
  shopifyPrivacyDataRequestJobs,
  shopifyPrivacyQueueOutbox,
  shopifyPrivacyRequestSelectors,
  shopifyPrivacyRequests,
  shopifyWebhookEvents,
  type ShopifyConnectorStore,
} from "../../../drizzle/shopify_schema";
import { blindIndexForTenant, encryptForTenant, getTenantDek } from "../../_core/tenantKeys";
import type { DbTransaction } from "../../db";

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

/** Selectors protected per turn — bounds the work one large delivery does at once. */
export const PROTECT_SELECTOR_CHUNK = 250;

/** Encrypt and blind-index validated IDs before opening the admission transaction. */
export async function protectCustomerPrivacySelectors(
  organizationId: number,
  storeId: number,
  selectors: ValidatedSelector[],
): Promise<PreparedPrivacySelector[]> {
  // Resolve the tenant key ONCE, before any selector. The key cache does not
  // coalesce concurrent misses, so a cold process protecting a 10,000-order
  // delivery all at once started one key lookup — or a racing provisioning
  // attempt — per operation: about 20,000. After this every call is a cache hit.
  await getTenantDek(organizationId);

  const prepared: PreparedPrivacySelector[] = [];
  for (let start = 0; start < selectors.length; start += PROTECT_SELECTOR_CHUNK) {
    if (start > 0) await new Promise<void>((resolve) => setImmediate(resolve)); // let other requests run
    const chunk = selectors.slice(start, start + PROTECT_SELECTOR_CHUNK);
    prepared.push(
      ...(await Promise.all(
        chunk.map(async ({ resourceType, position, externalId }) => {
          const context = `shopify:privacy-selector:${storeId}:${resourceType}`;
          const [externalIdEnc, externalIdHmac] = await Promise.all([
            encryptForTenant(organizationId, externalId),
            blindIndexForTenant(organizationId, context, externalId),
          ]);
          return { resourceType, position, externalIdEnc, externalIdHmac };
        }),
      )),
    );
  }
  return prepared;
}

const CUSTOMER_PRIVACY_TOPICS: ShopifyCustomerPrivacyTopic[] = ["customers/data_request", "customers/redact"];

/**
 * Repeatable repair: a customer request that is `received` but has NO selector
 * rows was written by the pre-selector handler — during the deploy cutover, say
 * — and cannot be fulfilled. A valid customer request always has at least the
 * customer's own selector, so this state is unambiguous. It is moved to manual
 * review rather than left looking like a fully admitted request.
 *
 * Idempotent; runs inside every customer admission for its store, and is
 * exported for the processor to run before it claims work.
 */
export async function quarantineSelectorlessCustomerRequests(
  tx: DbTransaction,
  store: Pick<ShopifyConnectorStore, "id" | "organizationId">,
): Promise<void> {
  await tx
    .update(shopifyPrivacyRequests)
    .set({ status: "manual_review", admissionErrorCode: "selectors_unavailable" })
    .where(
      and(
        eq(shopifyPrivacyRequests.organizationId, store.organizationId),
        eq(shopifyPrivacyRequests.storeId, store.id),
        inArray(shopifyPrivacyRequests.topic, CUSTOMER_PRIVACY_TOPICS),
        eq(shopifyPrivacyRequests.status, "received"),
        notExists(
          // Built with the standalone builder, as tokenStore does: a subquery is
          // SQL, not something to execute, so it must not depend on the executor.
          new QueryBuilder()
            .select({ one: sql`1` })
            .from(shopifyPrivacyRequestSelectors)
            .where(eq(shopifyPrivacyRequestSelectors.requestId, shopifyPrivacyRequests.id)),
        ),
      ),
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
): Promise<"received" | "manual_review" | "fenced"> {
  // Authoritative fence check, under the same store-row lock redaction
  // admission takes: a customer delivery racing a shop/redact either commits
  // before the fence or sees it. A fenced tenant takes no new data at all.
  const [current] = await tx
    .select({ status: shopifyConnectorStores.status })
    .from(shopifyConnectorStores)
    .where(and(eq(shopifyConnectorStores.id, params.store.id), eq(shopifyConnectorStores.organizationId, params.store.organizationId)))
    .limit(1)
    .for("update");
  if (!current || current.status === "redacting") return "fenced";

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
      .select({ id: shopifyPrivacyRequests.id })
      .from(shopifyPrivacyRequests)
      .where(
        and(
          eq(shopifyPrivacyRequests.storeId, params.store.id),
          eq(shopifyPrivacyRequests.organizationId, params.store.organizationId),
          eq(shopifyPrivacyRequests.topic, params.topic),
          eq(shopifyPrivacyRequests.requestHash, params.requestHash),
        ),
      )
      .limit(1);
    if (!request) throw new Error("Admitted Shopify privacy request could not be resolved");

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

    // The insert above is a no-op on a replay, so a request first parked for
    // manual review — before the store's shop id was known, say — would keep
    // that status and error even once a replay validates and stores its
    // selectors. Promote it. Only `manual_review` moves; a request further
    // along is never regressed.
    await tx
      .update(shopifyPrivacyRequests)
      .set({ status: "received", admissionErrorCode: null })
      .where(
        and(
          eq(shopifyPrivacyRequests.id, request.id),
          eq(shopifyPrivacyRequests.organizationId, params.store.organizationId),
          eq(shopifyPrivacyRequests.status, "manual_review"),
        ),
      );

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
    }
  }

  // After this request's own selectors are in place, so it cannot catch itself.
  await quarantineSelectorlessCustomerRequests(tx, params.store);

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
