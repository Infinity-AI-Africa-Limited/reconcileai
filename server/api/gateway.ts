/**
 * ReconcileAI Developer API — REST gateway (gap-closure plan WS-4, Phase 2).
 *
 * A translation layer, not a re-implementation: authenticated requests act as
 * the API key's owner and execute the EXISTING tRPC procedures via
 * appRouter.createCaller — business logic, role guards, audit logging, and
 * webhooks all behave exactly as they do for the dashboard.
 *
 * Surface (docs/openapi.yaml is the contract; served at /api/v1/openapi.yaml):
 *   /reconciliation  /exceptions  /templates  /intelligence  /kpi
 *   /sandbox (keyless, deterministic synthetic data)  /health
 *
 * Cross-cutting: X-API-Key auth (validateApiKey), 60 req/min per key
 * (shared limiter, applied before key validation), request logging into
 * api_ingestion_logs, TRPCError → HTTP status mapping.
 *
 * Also the programmatic path into on-prem deployments: a bank's internal
 * systems trigger runs and pull exceptions without dashboard logins.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "../routers";
import { validateApiKey } from "../apiIngestionService";
import { publicApiLimiter, publicApiRateKey, createRateLimiter } from "../rateLimiter";
import { getDb, getUserById } from "../db";
import { apiIngestionLogs, reconciliationJobs, exceptions as exceptionsTable } from "../../drizzle/schema";
import { runSandboxReconciliation } from "./sandbox";

type ApiAuth = { organizationId: number | null; apiKeyId: number; userId: number };

// Express request augmentation without global declaration noise.
interface ApiRequest extends Request {
  apiAuth?: ApiAuth;
}

const TRPC_HTTP: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
};

function sendError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ code, message });
}

function handleError(res: Response, err: unknown) {
  if (err instanceof TRPCError) {
    const status = TRPC_HTTP[err.code] ?? 500;
    return sendError(res, status, err.code, err.message);
  }
  console.error("[api-gateway] unhandled error:", err);
  return sendError(res, 500, "INTERNAL", "Internal error");
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/** 60 req/min per API key (IP fallback) — before key validation, so key
 *  brute-forcing is throttled too. Shared instance with the tRPC public API. */
function rateLimit(req: ApiRequest, res: Response, next: NextFunction) {
  const key = (req.headers["x-api-key"] as string) || undefined;
  const result = publicApiLimiter.check(publicApiRateKey(key, req.ip));
  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.retryAfterSec));
    return sendError(res, 429, "RATE_LIMITED", `Rate limit exceeded (60 requests/minute). Retry in ${result.retryAfterSec}s.`);
  }
  next();
}

async function requireApiKey(req: ApiRequest, res: Response, next: NextFunction) {
  try {
    const key = (req.headers["x-api-key"] as string) || "";
    if (!key) return sendError(res, 401, "UNAUTHORIZED", "Missing X-API-Key header");
    const v = await validateApiKey(key);
    if (!v.valid || !v.apiKeyId || !v.userId) {
      return sendError(res, 401, "UNAUTHORIZED", v.error || "Invalid API key");
    }
    req.apiAuth = { organizationId: v.organizationId ?? null, apiKeyId: v.apiKeyId, userId: v.userId };
    next();
  } catch (err) {
    handleError(res, err);
  }
}

/** Request log into api_ingestion_logs (fire-and-forget on response finish). */
function logRequests(req: ApiRequest, res: Response, next: NextFunction) {
  const startedAt = Date.now();
  res.on("finish", () => {
    void (async () => {
      try {
        const db = await getDb();
        if (!db) return;
        await db.insert(apiIngestionLogs).values({
          organizationId: req.apiAuth?.organizationId ?? null,
          apiKeyId: req.apiAuth?.apiKeyId ?? null,
          endpoint: `/api/v1${req.path}`.slice(0, 255),
          method: req.method,
          status: res.statusCode < 400 ? "success" : "failed",
          statusCode: res.statusCode,
          processingTimeMs: Date.now() - startedAt,
        });
      } catch { /* logging must never affect the response */ }
    })();
  });
  next();
}

/** The API acts as the key's owner: same role guards, audit trail, webhooks. */
async function callerFor(req: ApiRequest, res: Response) {
  const auth = req.apiAuth!;
  const user = await getUserById(auth.userId);
  if (!user || !user.isActive) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "API key owner is inactive" });
  }
  return appRouter.createCaller({ req: req as any, res: res as any, user });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createApiGateway(): express.Router {
  const api = express.Router();
  api.use(express.json({ limit: "25mb" }));

  // ── System (no auth) ────────────────────────────────────────────────────────
  api.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), version: "1.0.0" });
  });

  api.get("/openapi.yaml", async (_req, res) => {
    try {
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const spec = await readFile(path.resolve(process.cwd(), "docs/openapi.yaml"), "utf8");
      res.type("text/yaml").send(spec);
    } catch {
      sendError(res, 404, "NOT_FOUND", "Spec not bundled in this deployment");
    }
  });

  // ── Sandbox (keyless; own tighter IP limit) ─────────────────────────────────
  const sandboxLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
  const sandboxLimit = (req: Request, res: Response, next: NextFunction) => {
    const r = sandboxLimiter.check(`ip:${req.ip || "unknown"}`);
    if (!r.allowed) {
      res.setHeader("Retry-After", String(r.retryAfterSec));
      return sendError(res, 429, "RATE_LIMITED", `Sandbox rate limit exceeded. Retry in ${r.retryAfterSec}s.`);
    }
    next();
  };

  api.get("/sandbox", sandboxLimit, (_req, res) => {
    res.json({
      sandbox: true,
      message: "POST /api/v1/sandbox/reconciliation/runs to run the real matching engine on deterministic synthetic data. No API key required.",
      docs: "/developers",
    });
  });
  api.post("/sandbox/reconciliation/runs", sandboxLimit, (_req, res) => {
    res.status(200).json(runSandboxReconciliation());
  });

  // ── Authenticated surface ───────────────────────────────────────────────────
  api.use(rateLimit, requireApiKey, logRequests);

  // /reconciliation
  api.post("/reconciliation/runs", async (req: ApiRequest, res) => {
    try {
      const caller = await callerFor(req, res);
      const b = req.body ?? {};
      const created = await caller.reconciliation.create({
        name: b.name ?? `API run ${new Date().toISOString().slice(0, 16)}`,
        moduleType: b.module === "account_level" ? "account_level" : "settlement",
        sourceChannelId: Number(b.sourceChannelId),
        targetChannelId: Number(b.targetChannelId),
        dateFrom: String(b.dateFrom ?? ""),
        dateTo: String(b.dateTo ?? ""),
        ...(b.amountTolerance != null ? { amountTolerance: Number(b.amountTolerance) } : {}),
        ...(b.dateWindowDays != null ? { dateWindowDays: Number(b.dateWindowDays) } : {}),
      } as any);
      res.status(202).json({ runId: (created as any).jobId ?? (created as any).id, status: "pending" });
    } catch (err) { handleError(res, err); }
  });

  api.get("/reconciliation/runs", async (req: ApiRequest, res) => {
    try {
      const caller = await callerFor(req, res);
      const jobs = await caller.reconciliation.list();
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Number(req.query.offset) || 0;
      const rows = (jobs as any[]).slice(offset, offset + limit).map((j) => ({
        runId: j.id,
        name: j.name,
        module: j.moduleType,
        status: j.status,
        currency: j.currency ?? "NGN",
        matchedCount: j.matchedCount,
        exceptionCount: j.exceptionCount,
        matchRate: j.matchRate != null ? parseFloat(String(j.matchRate)) : null,
        createdAt: j.createdAt,
        completedAt: j.completedAt ?? null,
      }));
      res.json({ data: rows, total: (jobs as any[]).length });
    } catch (err) { handleError(res, err); }
  });

  api.get("/reconciliation/runs/:runId", async (req: ApiRequest, res) => {
    try {
      const caller = await callerFor(req, res);
      const runId = Number(req.params.runId);
      if (!Number.isInteger(runId) || runId <= 0) return sendError(res, 400, "BAD_REQUEST", "runId must be a positive integer");
      const detail = await caller.reconciliation.get({ id: runId });
      const j: any = (detail as any).job;
      res.json({
        runId: j.id,
        name: j.name,
        module: j.moduleType,
        status: j.status,
        currency: j.currency ?? "NGN",
        matchedCount: j.matchedCount,
        exceptionCount: j.exceptionCount,
        unmatchedCount: j.unmatchedCount,
        matchRate: j.matchRate != null ? parseFloat(String(j.matchRate)) : null,
        processingTimeMs: j.processingTimeMs ?? null,
        createdAt: j.createdAt,
        completedAt: j.completedAt ?? null,
        exceptions: (detail as any).exceptions?.slice(0, 200) ?? [],
      });
    } catch (err) { handleError(res, err); }
  });

  // ERP journal-entry export (WS-7): natively-importable files, content inline.
  api.get("/reconciliation/runs/:runId/erp-export", async (req: ApiRequest, res) => {
    try {
      const runId = Number(req.params.runId);
      if (!Number.isInteger(runId) || runId <= 0) return sendError(res, 400, "BAD_REQUEST", "runId must be a positive integer");
      const { ERP_TARGETS, loadJournalEntriesForJob, renderErpExport } = await import("../erpExport");
      const target = String(req.query.target ?? "");
      if (!(ERP_TARGETS as readonly string[]).includes(target)) {
        return sendError(res, 400, "BAD_REQUEST", `target must be one of: ${ERP_TARGETS.join(", ")}`);
      }
      const loaded = await loadJournalEntriesForJob(runId, req.apiAuth!.organizationId);
      if (!loaded) return sendError(res, 404, "NOT_FOUND", "Run not found");
      const files = loaded.entries.length > 0
        ? renderErpExport(target as any, loaded.entries, runId)
        : [];
      res.json({
        runId,
        target,
        entryCount: loaded.entries.length,
        files, // [{ filename, content }] — journal CSVs are small; content is inline
      });
    } catch (err) { handleError(res, err); }
  });

  // /exceptions
  api.get("/exceptions", async (req: ApiRequest, res) => {
    try {
      const caller = await callerFor(req, res);
      const q = req.query;
      const result = await caller.exceptions.list({
        ...(q.runId ? { jobId: Number(q.runId) } : {}),
        ...(q.status ? { status: String(q.status) } : {}),
        ...(q.category ? { category: String(q.category) } : {}),
        ...(q.severity ? { severity: String(q.severity) } : {}),
        limit: Math.min(Number(q.limit) || 50, 200),
        offset: Number(q.offset) || 0,
      });
      res.json(result);
    } catch (err) { handleError(res, err); }
  });

  api.patch("/exceptions/:exceptionId", async (req: ApiRequest, res) => {
    try {
      const caller = await callerFor(req, res);
      const id = Number(req.params.exceptionId);
      if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, "BAD_REQUEST", "exceptionId must be a positive integer");
      const status = String(req.body?.status ?? "");
      if (status !== "resolved" && status !== "dismissed") {
        return sendError(res, 400, "BAD_REQUEST", 'status must be "resolved" or "dismissed"');
      }
      await caller.exceptions.resolve({
        id,
        status: status as "resolved" | "dismissed",
        ...(req.body?.resolutionNote ? { resolutionNotes: String(req.body.resolutionNote).slice(0, 2000) } : {}),
      });
      res.json({ id, status });
    } catch (err) { handleError(res, err); }
  });

  // /templates
  api.get("/templates", async (req: ApiRequest, res) => {
    try {
      const caller = await callerFor(req, res);
      const category = req.query.category ? String(req.query.category) : undefined;
      const rows = await caller.resolutionTemplates.list(category ? ({ category } as any) : undefined);
      res.json((rows as any[]).map((t) => ({
        id: t.id,
        category: t.category,
        name: t.name,
        templateText: t.templateText,
        isDefault: t.isDefault,
      })));
    } catch (err) { handleError(res, err); }
  });

  // /intelligence
  api.get("/intelligence/recommendations", async (req: ApiRequest, res) => {
    try {
      const auth = req.apiAuth!;
      const category = String(req.query.category ?? "");
      if (!category) return sendError(res, 400, "BAD_REQUEST", "category query parameter is required");
      if (!auth.organizationId) return sendError(res, 403, "FORBIDDEN", "API key has no organization scope");

      const db = await getDb();
      const ei = await import("../exceptionIntelligence");

      // Institutional: this org's own resolution patterns for the category.
      let institutional: Array<{ resolutionActionClass: string; outcome: string; observationCount: number }> = [];
      if (db) {
        const { exceptionPatternSignatures } = await import("../../drizzle/schema");
        const rows = await db
          .select({
            resolutionActionClass: exceptionPatternSignatures.resolutionActionClass,
            outcome: exceptionPatternSignatures.outcome,
            observationCount: sql<number>`sum(${exceptionPatternSignatures.observationCount})`,
          })
          .from(exceptionPatternSignatures)
          .where(and(
            eq(exceptionPatternSignatures.organizationId, auth.organizationId),
            eq(exceptionPatternSignatures.exceptionCategory, category),
          ))
          .groupBy(exceptionPatternSignatures.resolutionActionClass, exceptionPatternSignatures.outcome)
          .orderBy(desc(sql`sum(${exceptionPatternSignatures.observationCount})`))
          .limit(5);
        institutional = rows.map((r) => ({ ...r, observationCount: Number(r.observationCount || 0) }));
      }

      // Network: k-anonymous cross-institution pool (reciprocity-gated inside).
      const network = await ei.getSharedRecommendations(auth.organizationId, category);
      res.json({ institutional, network });
    } catch (err) { handleError(res, err); }
  });

  api.post("/intelligence/diagnose", async (req: ApiRequest, res) => {
    try {
      const b = req.body ?? {};
      const category = String(b.category ?? "");
      const amount = Number(b.amount);
      if (!category || !Number.isFinite(amount)) {
        return sendError(res, 400, "BAD_REQUEST", "category and numeric amount are required");
      }
      const currency = typeof b.currency === "string" && b.currency.length === 3 ? b.currency.toUpperCase() : "NGN";

      const { getAIAnalysis } = await import("../reconciliationEngine");
      const learning = await import("../institutionalLearning");
      const ei = await import("../exceptionIntelligence");

      // Network guidance (also counts toward the informed-rate KPI).
      let networkGuidance = "";
      if (req.apiAuth?.organizationId) {
        try {
          const recs = await ei.getSharedRecommendations(req.apiAuth.organizationId, category);
          networkGuidance = learning.formatNetworkGuidance(recs);
        } catch { /* best-effort */ }
      }

      const analysis = await getAIAnalysis(
        { category, description: String(b.description ?? `${category} of ${currency} ${amount}`) },
        {
          transactionRef: b.reference ? String(b.reference) : null,
          amount: String(amount),
          currency,
          transactionDate: new Date(),
          channelId: 0,
          counterparty: b.counterparty ? String(b.counterparty) : null,
          debitCredit: "credit",
        } as any,
        networkGuidance ? { networkGuidance } : undefined,
      );
      res.json({ category, currency, amount, analysis, networkInformed: networkGuidance.length > 0 });
    } catch (err) { handleError(res, err); }
  });

  // /kpi — org reconciliation KPIs from the last 20 completed jobs.
  api.get("/kpi", async (req: ApiRequest, res) => {
    try {
      const auth = req.apiAuth!;
      if (!auth.organizationId) return sendError(res, 403, "FORBIDDEN", "API key has no organization scope");
      const db = await getDb();
      if (!db) return sendError(res, 500, "INTERNAL", "Database unavailable");

      const jobs = await db
        .select()
        .from(reconciliationJobs)
        .where(and(eq(reconciliationJobs.organizationId, auth.organizationId), eq(reconciliationJobs.status, "completed")))
        .orderBy(desc(reconciliationJobs.createdAt))
        .limit(20);

      const trend = [...jobs].reverse()
        .map((j) => (j.matchRate != null ? parseFloat(String(j.matchRate)) : null))
        .filter((v): v is number => v !== null);
      const avgMatchRate = trend.length > 0 ? Math.round((trend.reduce((a, b) => a + b, 0) / trend.length) * 100) / 100 : null;

      let resolutionRate: number | null = null;
      let openExceptions = 0;
      if (jobs.length > 0) {
        const jobIds = jobs.map((j) => j.id);
        const [agg] = await db
          .select({
            total: sql<number>`count(*)`,
            terminal: sql<number>`coalesce(sum(case when ${exceptionsTable.status} in ('resolved','dismissed','escalated') then 1 else 0 end), 0)`,
            open: sql<number>`coalesce(sum(case when ${exceptionsTable.status} in ('open','in_review') then 1 else 0 end), 0)`,
          })
          .from(exceptionsTable)
          .where(inArray(exceptionsTable.jobId, jobIds));
        const total = Number(agg?.total || 0);
        resolutionRate = total > 0 ? Math.round((Number(agg?.terminal || 0) / total) * 10000) / 100 : null;
        openExceptions = Number(agg?.open || 0);
      }

      res.json({
        computedAt: new Date().toISOString(),
        runCount: jobs.length,
        metrics: [
          { key: "autoMatchRate", label: "Auto-Match Rate", value: avgMatchRate, unit: "%", target: 95, floor: 85, higherIsBetter: true, status: statusFor(avgMatchRate, 95, 85, true), trend },
          { key: "exceptionResolutionRate", label: "Resolution Progress Rate", value: resolutionRate, unit: "%", target: 80, floor: 60, higherIsBetter: true, status: statusFor(resolutionRate, 80, 60, true), trend: [] },
          { key: "openExceptions", label: "Open Exceptions", value: openExceptions, unit: "count", target: 0, floor: 0, higherIsBetter: false, status: "no_data", trend: [] },
        ],
      });
    } catch (err) { handleError(res, err); }
  });

  // Unknown /api/v1 path → structured 404 (not the SPA fallback).
  api.use((_req, res) => sendError(res, 404, "NOT_FOUND", "Unknown endpoint — see /developers for the API reference"));

  return api;
}

function statusFor(value: number | null, target: number, floor: number, higherIsBetter: boolean): string {
  if (value === null) return "no_data";
  if (higherIsBetter) return value >= target ? "above_target" : value >= floor ? "between" : "below_floor";
  return value <= target ? "above_target" : value <= floor ? "between" : "below_floor";
}

// Lazy singleton for the _core mount point.
let gateway: express.Router | null = null;
export function getApiGateway(): express.Router {
  if (!gateway) gateway = createApiGateway();
  return gateway;
}
