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
import { ShopifyEmbeddedAuthError, type ShopifyEmbeddedContext } from "./embeddedAuth";
import { ShopifyManagedInstallError } from "./managedInstall";
import { ShopifyManualSyncError } from "./manualSync";
import { ShopifyOnboardingError } from "./onboarding";
import { onboardingFailureReason } from "./onboardingFailure";
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
  | "installation_in_progress"
  | "required_permissions_not_granted"
  | "service_unavailable"
  | "sync_in_progress"
  | "store_action_required"
  | "order_sync_required"
  | "active_admin_required"
  | "invalid_request"
  // Onboarding refusals that no retry can clear. They are spelled exactly as
  // the legacy install reasons (`shared/shopifyInstall.ts`) so the client
  // renders them from the copy that already exists for the install error page,
  // rather than carrying a second wording of the same refusal.
  | "ownership_verification_required"
  | "email_already_registered"
  | "redaction_in_progress"
  | "missing_contact_email"
  | "store_identity_conflict";

export function appHomeError(code: TRPCError["code"], message: ShopifyAppHomeErrorMessage): TRPCError {
  return new TRPCError({ code, message });
}

/** A managed-install refusal rendered as a stable App Home error, never provider text. */
export function managedInstallFailure(error: unknown): TRPCError {
  if (error instanceof ShopifyEmbeddedAuthError) {
    return error.code === "CONFIG_UNAVAILABLE"
      ? appHomeError("SERVICE_UNAVAILABLE", "configuration_unavailable")
      : appHomeError("UNAUTHORIZED", "authentication_required");
  }
  if (error instanceof ShopifyManagedInstallError) {
    switch (error.code) {
      case "INSTALLATION_IN_PROGRESS":
        return appHomeError("CONFLICT", "installation_in_progress");
      case "REQUIRED_PERMISSIONS_NOT_GRANTED":
        return appHomeError("PRECONDITION_FAILED", "required_permissions_not_granted");
      case "ID_TOKEN_REJECTED":
        return appHomeError("UNAUTHORIZED", "authentication_required");
      case "DURABLE_QUEUE_UNAVAILABLE":
      case "TOKEN_EXCHANGE_RETRY":
      case "TOKEN_EXCHANGE_FAILED":
      case "SHOP_METADATA_UNAVAILABLE":
        return appHomeError("SERVICE_UNAVAILABLE", "service_unavailable");
    }
  }
  /**
   * An onboarding refusal is usually NOT transient, and saying
   * "service_unavailable" to one is actively harmful: the merchant retries, and
   * every retry re-runs the token exchange, which retires the offline token
   * pair Shopify issued for the previous attempt — while the shop still has no
   * contact email, or its email still belongs to another workspace, so the
   * attempt can never succeed. Classified by the same function the legacy
   * install page uses (onboardingFailure.ts).
   */
  if (error instanceof ShopifyOnboardingError) {
    const reason = onboardingFailureReason(error);
    switch (reason) {
      case "missing_contact_email":
      case "ownership_verification_required":
        return appHomeError("PRECONDITION_FAILED", reason);
      case "email_already_registered":
      case "redaction_in_progress":
      case "store_identity_conflict":
        return appHomeError("CONFLICT", reason);
      case "installation_in_progress":
        return appHomeError("CONFLICT", "installation_in_progress");
      default:
        // install_failed — transient (DB_UNAVAILABLE, TOKEN_STORE_FAILED).
        return appHomeError("SERVICE_UNAVAILABLE", "service_unavailable");
    }
  }
  return appHomeError("SERVICE_UNAVAILABLE", "service_unavailable");
}

/** The store and sync evidence the workspace shows; no id leaves the server. */
export async function loadAppHomeView(db: Db, context: ShopifyEmbeddedContext) {
  const requests = and(
    eq(shopifySyncRequests.storeId, context.storeId),
    eq(shopifySyncRequests.organizationId, context.organizationId),
  );
  // One transaction, so one snapshot (REPEATABLE READ, the default on MySQL and
  // TiDB): read separately, a run settling between the reads could pair a
  // request still queued in one with no pending request in the next, and the
  // page would stop waiting with the outcome unseen.
  const { cursor, latestRequest, pending, requestCount } = await db.transaction(async (tx) => {
    const [cursorRow] = await tx
      .select({
        lastSuccessfulAt: shopifySyncCursors.lastSuccessfulAt,
        lastErrorCode: shopifySyncCursors.lastErrorCode,
        lastErrorAt: shopifySyncCursors.lastErrorAt,
        requestCount: shopifySyncCursors.syncRequestCount,
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
    const [latestRow] = await tx
      .select({ status: shopifySyncRequests.status, answeredAt: shopifySyncRequests.answeredAt })
      .from(shopifySyncRequests)
      .where(requests)
      .orderBy(desc(shopifySyncRequests.id))
      .limit(1);
    const [pendingRow] = await tx
      .select({ requestedAt: shopifySyncRequests.requestedAt })
      .from(shopifySyncRequests)
      .where(and(requests, eq(shopifySyncRequests.status, "queued")))
      .orderBy(desc(shopifySyncRequests.id))
      .limit(1);
    return { cursor: cursorRow, latestRequest: latestRow, pending: pendingRow, requestCount: cursorRow?.requestCount ?? 0 };
  });
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
      /** How many requests this store has made: a page waits until this counts its own. */
      requestCount,
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
