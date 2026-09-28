/**
 * Shopify App Home — the embedded workspace's server logic, kept out of the
 * tRPC router (server/routers/shopifyAppHome.ts) so the router stays a thin
 * boundary: authenticate, call one of these, shape the answer.
 *
 * Every answer here is an allow-list. The embedded page runs inside Shopify
 * Admin for any staff member the store owner lets open the app, so nothing
 * internal — ids, batch numbers, row data, operational error text — may reach it.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { shopifySyncCursors, shopifySyncRequests } from "../../../drizzle/shopify_schema";
import type { getDb } from "../../db";
import type { ShopifyEmbeddedContext } from "./embeddedAuth";
import { ShopifyManualSyncError } from "./manualSync";
import { ShopifySettlementEvidenceError, type ShopifySettlementEvidenceResult } from "./settlementEvidence";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const settlementField = z.enum(["orderRef", "gatewayRef", "amount", "currency", "settledAt", "fee", "description"]);

/**
 * The only fields a browser may send. z.object strips anything else, so a
 * store, tenant or channel identifier can neither be accepted nor forwarded:
 * the only authority is the verified App Bridge context.
 */
export const settlementEvidenceInput = z.object({
  fileName: z.string().min(1).max(255),
  content: z.string().min(1).max(14_000_000),
  contentEncoding: z.enum(["utf8", "base64"]),
  sourceLabel: z.string().min(1).max(80),
  /**
   * The merchant-confirmed mapping; absent means detect. `partialRecord`, not
   * `record`: under zod 4 a record keyed by an enum is EXHAUSTIVE, so it would
   * refuse every mapping that leaves a field out — which is every real one.
   */
  columnMapping: z.partialRecord(settlementField, z.string().min(1).max(200)).optional(),
  dryRun: z.boolean(),
});

export const SHOPIFY_APP_HOME_CAPABILITIES = Object.freeze({
  scope: "read_orders" as const,
  readOrders: true,
  manualSync: true,
  shopifyPayments: false,
  mutations: false,
});

/**
 * Stable, machine-readable error messages. The client maps these, never
 * free text, and none of them carries operational detail.
 */
export type ShopifyAppHomeErrorMessage =
  | "configuration_unavailable"
  | "authentication_required"
  | "service_unavailable"
  | "sync_in_progress"
  | "store_action_required"
  | "order_sync_required"
  | "active_admin_required"
  | "invalid_request";

export function appHomeError(code: TRPCError["code"], message: ShopifyAppHomeErrorMessage): TRPCError {
  return new TRPCError({ code, message });
}

/** The store and sync evidence the workspace shows; no id leaves the server. */
export async function loadAppHomeView(db: Db, context: ShopifyEmbeddedContext) {
  const [cursor] = await db
    .select({
      lastSuccessfulAt: shopifySyncCursors.lastSuccessfulAt,
      lastErrorCode: shopifySyncCursors.lastErrorCode,
      lastErrorAt: shopifySyncCursors.lastErrorAt,
    })
    .from(shopifySyncCursors)
    .where(
      and(
        eq(shopifySyncCursors.storeId, context.storeId),
        eq(shopifySyncCursors.organizationId, context.organizationId),
        eq(shopifySyncCursors.resource, "orders"),
      ),
    )
    .limit(1);
  const requests = and(
    eq(shopifySyncRequests.storeId, context.storeId),
    eq(shopifySyncRequests.organizationId, context.organizationId),
  );
  const [latestRequest] = await db
    .select({ status: shopifySyncRequests.status, answeredAt: shopifySyncRequests.answeredAt })
    .from(shopifySyncRequests)
    .where(requests)
    .orderBy(desc(shopifySyncRequests.id))
    .limit(1);
  const [pending] = await db
    .select({ requestedAt: shopifySyncRequests.requestedAt })
    .from(shopifySyncRequests)
    .where(and(requests, eq(shopifySyncRequests.status, "queued")))
    .orderBy(desc(shopifySyncRequests.id))
    .limit(1);
  return {
    store: { shopDomain: context.shopDomain, displayName: context.displayName, currency: context.currency },
    sync: {
      lastSuccessfulAt: cursor?.lastSuccessfulAt?.toISOString() ?? null,
      lastErrorCode: cursor?.lastErrorCode ?? null,
      lastErrorAt: cursor?.lastErrorAt?.toISOString() ?? null,
      /** The newest manual request, settled or not. */
      latestRequest: latestRequest
        ? { status: latestRequest.status, answeredAt: latestRequest.answeredAt?.toISOString() ?? null }
        : null,
      /** When the newest request still queued was made, or null when none is. */
      pendingSince: pending?.requestedAt.toISOString() ?? null,
    },
    capabilities: { ...SHOPIFY_APP_HOME_CAPABILITIES },
  };
}


export function safeSettlementEvidenceResult(result: ShopifySettlementEvidenceResult) {
  if (result.committed) {
    return {
      committed: true as const,
      mapping: result.mapping,
      totalRows: result.totalRows,
      imported: result.imported,
      duplicates: result.duplicates,
      failed: result.failed,
      matchedCount: result.matchedCount,
      exceptionCount: result.exceptionCount,
      unalignedRows: result.unalignedRows,
    };
  }
  return {
    committed: false as const,
    headers: result.headers,
    mapping: result.mapping,
    missingRequired: result.missingRequired,
    totalRows: result.totalRows,
    parseErrors: result.parseErrors,
    unalignedRows: result.unalignedRows,
  };
}

/**
 * A manual sync that could not be QUEUED, as the merchant may see it. A sync
 * that fails once running is reported through `context` instead.
 */
export function manualSyncFailure(error: unknown): TRPCError {
  if (error instanceof ShopifyManualSyncError && error.code === "STORE_UNAVAILABLE") {
    return appHomeError("PRECONDITION_FAILED", "store_action_required");
  }
  return appHomeError("SERVICE_UNAVAILABLE", "service_unavailable");
}

/** A refused settlement import, as the merchant may see it. */
export function settlementEvidenceFailure(error: unknown): TRPCError {
  if (error instanceof ShopifySettlementEvidenceError) {
    switch (error.code) {
      case "INVALID_REQUEST":
        return appHomeError("BAD_REQUEST", "invalid_request");
      case "ORDER_SYNC_REQUIRED":
        return appHomeError("PRECONDITION_FAILED", "order_sync_required");
      case "ACTOR_UNAVAILABLE":
        return appHomeError("FORBIDDEN", "active_admin_required");
      case "STORE_UNAVAILABLE":
        return appHomeError("PRECONDITION_FAILED", "store_action_required");
      case "SERVICE_UNAVAILABLE":
        break;
    }
  }
  return appHomeError("SERVICE_UNAVAILABLE", "service_unavailable");
}
