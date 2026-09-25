import express, { type NextFunction, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { shopifySyncCursors } from "../../../drizzle/shopify_schema";
import { ENV } from "../../_core/env";
import { getDb } from "../../db";
import {
  authenticateShopifyEmbeddedRequest,
  ShopifyEmbeddedAuthError,
  shopifyEmbeddedAuthHttpStatus,
  type ShopifyEmbeddedContext,
} from "./embeddedAuth";
import { ShopifyOrderApiError } from "./orders";
import {
  importShopifySettlementEvidence,
  ShopifySettlementEvidenceError,
  type ShopifySettlementEvidenceInput,
  type ShopifySettlementEvidenceResult,
} from "./settlementEvidence";
import { runShopifyOrderSync, type ShopifyOrderSyncReport } from "./syncOrchestrator";
import { ShopifyTokenUnavailableError } from "./tokenStore";

export const SHOPIFY_APP_FRAME_ANCESTORS =
  "frame-ancestors https://admin.shopify.com https://*.myshopify.com";

/** Apply an embed policy only to App Home documents, never to the global SPA. */
export function shopifyAppFrameHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", SHOPIFY_APP_FRAME_ANCESTORS);
  // Some hosting layers set this before application middleware. Shopify Admin
  // framing relies on CSP; a legacy DENY/SAMEORIGIN value would override it.
  res.removeHeader("X-Frame-Options");
  next();
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Authenticate = (authorization: Request["headers"]["authorization"]) => Promise<ShopifyEmbeddedContext>;
type RunSync = typeof runShopifyOrderSync;
type ImportSettlementEvidence = (
  context: ShopifyEmbeddedContext,
  input: ShopifySettlementEvidenceInput,
  db: Db,
) => Promise<ShopifySettlementEvidenceResult>;

export interface ShopifyAppHomeRouteDeps {
  clientId?: () => string;
  authenticate?: Authenticate;
  getDatabase?: () => Promise<Db | null>;
  runSync?: RunSync;
  importSettlementEvidence?: ImportSettlementEvidence;
}

const settlementField = z.enum([
  "orderRef",
  "gatewayRef",
  "amount",
  "currency",
  "settledAt",
  "fee",
  "description",
]);

const settlementEvidenceBody = z.object({
  fileName: z.string().min(1).max(255),
  content: z.string().min(1).max(14_000_000),
  contentEncoding: z.enum(["utf8", "base64"]),
  sourceLabel: z.string().min(1).max(80),
  columnOverrides: z.record(settlementField, z.string().min(1).max(200)).optional(),
  dryRun: z.boolean(),
});

const capabilities = Object.freeze({
  scope: "read_orders" as const,
  readOrders: true,
  manualSync: true,
  shopifyPayments: false,
  mutations: false,
});

function authFailure(res: Response, error: ShopifyEmbeddedAuthError): void {
  const status = shopifyEmbeddedAuthHttpStatus(error);
  res.status(status).json({
    error: { code: status === 401 ? "authentication_required" : "service_unavailable" },
  });
}

async function authenticated(
  req: Request,
  res: Response,
  authenticate: Authenticate,
): Promise<ShopifyEmbeddedContext | null> {
  try {
    return await authenticate(req.headers.authorization);
  } catch (error) {
    if (error instanceof ShopifyEmbeddedAuthError) {
      authFailure(res, error);
      return null;
    }
    console.error("[shopify-app-home] authentication service failed");
    res.status(503).json({ error: { code: "service_unavailable" } });
    return null;
  }
}

function safeSyncReport(report: ShopifyOrderSyncReport) {
  return {
    success: report.success,
    window: {
      from: report.window.from.toISOString(),
      to: report.window.to.toISOString(),
    },
    fetched: report.fetched,
    inserted: report.inserted,
    updated: report.updated,
    unchanged: report.unchanged,
  };
}

function safeSettlementEvidenceResult(result: ShopifySettlementEvidenceResult) {
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
    };
  }
  return {
    committed: false as const,
    headers: result.headers,
    mapping: result.mapping,
    missingRequired: result.missingRequired,
    totalRows: result.totalRows,
    parseErrors: result.parseErrors,
  };
}

function syncFailureStatus(error: unknown): 409 | 422 | 503 {
  if (error instanceof ShopifyTokenUnavailableError) {
    if (error.reason === "refresh_in_progress") return 409;
    if (error.reason === "refresh_retry") return 503;
    return 422;
  }
  if (error instanceof ShopifyOrderApiError) {
    return error.code === "HTTP_ERROR" ? 503 : 422;
  }
  return 503;
}

/**
 * Public configuration plus ID-token protected embedded endpoints. Dependency
 * seams keep tests local; production defaults never accept a tenant or store id
 * from request parameters or JSON.
 */
export function createShopifyAppHomeRouter(deps: ShopifyAppHomeRouteDeps = {}): express.Router {
  const router = express.Router();
  const clientId = deps.clientId ?? (() => ENV.shopifyClientId);
  const authenticate = deps.authenticate ?? authenticateShopifyEmbeddedRequest;
  const getDatabase = deps.getDatabase ?? getDb;
  const runSync = deps.runSync ?? runShopifyOrderSync;
  const importSettlementEvidence = deps.importSettlementEvidence ?? importShopifySettlementEvidence;

  router.use("/shopify/app", shopifyAppFrameHeaders);

  router.get("/api/shopify/app-home/config", (_req, res) => {
    const apiKey = clientId().trim();
    if (!apiKey) return res.status(503).json({ error: { code: "configuration_unavailable" } });
    return res.json({ apiKey });
  });

  router.get("/api/shopify/app-home/context", async (req, res) => {
    const context = await authenticated(req, res, authenticate);
    if (!context) return;

    try {
      const db = await getDatabase();
      if (!db) return res.status(503).json({ error: { code: "service_unavailable" } });
      const [cursor] = await db
        .select({
          lastSuccessfulAt: shopifySyncCursors.lastSuccessfulAt,
          lastErrorCode: shopifySyncCursors.lastErrorCode,
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
      return res.json({
        store: {
          shopDomain: context.shopDomain,
          displayName: context.displayName,
          currency: context.currency,
        },
        sync: {
          lastSuccessfulAt: cursor?.lastSuccessfulAt?.toISOString() ?? null,
          lastErrorCode: cursor?.lastErrorCode ?? null,
        },
        capabilities,
      });
    } catch {
      console.error("[shopify-app-home] context lookup failed", {
        storeId: context.storeId,
        organizationId: context.organizationId,
      });
      return res.status(503).json({ error: { code: "service_unavailable" } });
    }
  });

  router.post("/api/shopify/app-home/sync", async (req, res) => {
    const context = await authenticated(req, res, authenticate);
    if (!context) return;

    try {
      const report = await runSync({
        storeId: context.storeId,
        organizationId: context.organizationId,
        trigger: "manual",
      });
      return res.json(safeSyncReport(report));
    } catch (error) {
      const status = syncFailureStatus(error);
      console.error("[shopify-app-home] manual sync failed", {
        storeId: context.storeId,
        organizationId: context.organizationId,
        category: status === 409 ? "conflict" : status === 422 ? "action_required" : "unavailable",
      });
      const code = status === 409 ? "sync_in_progress" : status === 422 ? "store_action_required" : "service_unavailable";
      return res.status(status).json({ error: { code } });
    }
  });

  router.post("/api/shopify/app-home/settlement-evidence", async (req, res) => {
    const context = await authenticated(req, res, authenticate);
    if (!context) return;

    // z.object intentionally strips unknown browser fields. A store, tenant or
    // channel identifier can therefore neither be accepted nor forwarded; the
    // only authority is the verified App Bridge context above.
    const parsed = settlementEvidenceBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "invalid_request" } });

    try {
      const db = await getDatabase();
      if (!db) return res.status(503).json({ error: { code: "service_unavailable" } });
      const result = await importSettlementEvidence(context, parsed.data, db);
      return res.json(safeSettlementEvidenceResult(result));
    } catch (error) {
      if (error instanceof ShopifySettlementEvidenceError) {
        if (error.code === "INVALID_REQUEST") {
          return res.status(400).json({ error: { code: "invalid_request" } });
        }
        if (error.code === "ORDER_SYNC_REQUIRED") {
          return res.status(422).json({ error: { code: "order_sync_required" } });
        }
        if (error.code === "ACTOR_UNAVAILABLE") {
          return res.status(403).json({ error: { code: "active_admin_required" } });
        }
      }
      console.error("[shopify-app-home] settlement evidence import failed", {
        storeId: context.storeId,
        organizationId: context.organizationId,
      });
      return res.status(503).json({ error: { code: "service_unavailable" } });
    }
  });

  return router;
}
