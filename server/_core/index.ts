import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { assertResidencyStartupConfig, describeResidencyPosture } from "./egress";
import { getLlmProviderInfo } from "./llm";
import { authorizeSyncRequest, describeSyncAuthFailure, expectedSyncSecret } from "./syncAuth";
import { verifyGitHubOidcToken, describeOidcFailure } from "./githubOidc";
import { getDb } from "../db";
import { seedDefaultResolutionTemplates, seedNigerianExceptionDefaults } from "../seedResolutionTemplates";
import { sql } from "drizzle-orm";
import { storagePut, storageGet, storageDelete } from "../storage";
import { sdk } from "./sdk";
import { ENV } from "./env";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // Data residency: log the enforced posture and fail fast if on-premise mode is
  // misconfigured in a way that would leak data off-box (e.g. Forge enabled).
  const posture = describeResidencyPosture();
  console.log(
    `[residency] mode=${posture.mode}` +
      (posture.enforced
        ? ` (enforced; egress allowlist: ${posture.egressAllowlist.length ? posture.egressAllowlist.join(", ") : "none"})`
        : ""),
  );
  assertResidencyStartupConfig();

  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads.
  // `verify` captures the raw body bytes so webhook HMAC signatures can be
  // checked against exactly what was sent (JSON re-serialization is not
  // byte-stable and would break signature verification).
  app.use(
    express.json({
      limit: "50mb",
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // ── Liveness probe ─────────────────────────────────────────────────────────
  // GET /api/healthz — returns 200 whenever the process is alive. Used as the
  // platform healthcheck (e.g. Railway) so a degraded dependency (storage, LLM)
  // never causes an endless deploy/restart loop. Deep readiness is /api/health.
  app.get("/api/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", uptime: Math.floor(process.uptime()) });
  });
  // ── Health check ─────────────────────────────────────────────────────────
  // GET /api/health
  // Returns DB connectivity, LLM provider mode/model, and app version.
  // Useful for Rocket.new deployment verification and uptime monitoring.
  app.get("/api/health", async (_req, res) => {
    const startedAt = Date.now();
    const checks: Record<string, unknown> = {};

    // 1. Database connectivity
    try {
      const db = await getDb();
      if (!db) throw new Error("Database connection unavailable");
      await db.execute(sql`SELECT 1`);
      checks.database = { status: "ok", latencyMs: Date.now() - startedAt };
    } catch (err) {
      checks.database = {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 2. Storage (S3) — write a tiny probe file then verify a download URL is returned
    try {
      const probeKey = `health-checks/probe-${Date.now()}.txt`;
      const probeData = `reconcileai-health-probe ${new Date().toISOString()}`;
      const uploadStart = Date.now();
      const { key, url: uploadedUrl } = await storagePut(probeKey, probeData, "text/plain");
      const uploadMs = Date.now() - uploadStart;

      const downloadStart = Date.now();
      const { url: downloadUrl } = await storageGet(key);
      const downloadMs = Date.now() - downloadStart;

      // Clean up probe file — fire-and-forget, never fail the health check over it
      storageDelete(key).catch(() => undefined);

      checks.storage = {
        status: "ok",
        uploadMs,
        downloadMs,
      };
    } catch (err) {
      checks.storage = {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 3. LLM provider
    try {
      const llm = getLlmProviderInfo();
      checks.llm = { status: "ok", ...llm };
    } catch (err) {
      checks.llm = {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 3. App metadata
    const allOk = Object.values(checks).every(
      (c) => (c as { status: string }).status === "ok"
    );

    const body = {
      status: allOk ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV ?? "unknown",
      version: process.env.npm_package_version ?? "unknown",
      checks,
    };

    res.status(allOk ? 200 : 503).json(body);
  });

  // ── Scheduled: weekly assessment digest ─────────────────────────────────
  app.post("/api/scheduled/weeklyAssessmentDigest", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const { complianceAssessments } = await import("../../drizzle/schema");
      const { sql: drizzleSql } = await import("drizzle-orm");
      const { notifyOwner } = await import("./notification");

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Fetch all assessments from the past 7 days
      const recent = await db
        .select()
        .from(complianceAssessments)
        .where(drizzleSql`${complianceAssessments.createdAt} >= ${sevenDaysAgo}`);

      const total = recent.length;
      const avgScore = total > 0
        ? Math.round(recent.reduce((s, r) => s + (r.overallScore ?? 0), 0) / total)
        : 0;
      const highRisk = recent.filter(r => r.riskLevel === "critical" || r.riskLevel === "high").length;
      const pendingInvites = recent.filter(r => r.consentToContact && !r.demoInviteSent).length;

      if (total === 0) {
        return res.json({ ok: true, skipped: "no assessments this week" });
      }

      const content = [
        `**Weekly Compliance Assessment Digest — ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}**`,
        "",
        `📊 **New assessments this week:** ${total}`,
        `📈 **Average score:** ${avgScore}/100`,
        `🚨 **High/Critical risk:** ${highRisk} institution${highRisk !== 1 ? "s" : ""}`,
        `📧 **Pending demo invites:** ${pendingInvites} (consented but not yet invited)`,
        "",
        "View all assessments at reconcileai.vip/admin/assessments",
      ].join("\n");

      await notifyOwner({
        title: `ReconcileAI Weekly Digest — ${total} new assessment${total !== 1 ? "s" : ""}`,
        content,
      });

      res.json({ ok: true, total, avgScore, highRisk, pendingInvites });
    } catch (err) {
      console.error("[weeklyAssessmentDigest] error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── Scheduled: weekly CFO channel metrics report ──────────────────────────
  app.post("/api/scheduled/weeklyChannelReport", async (req, res) => {
    try {
      // Authenticate the cron caller via task UID header (no §5c patches needed)
      const taskUid = req.headers["x-manus-cron-task-uid"] as string | undefined;
      if (!taskUid) return res.status(403).json({ error: "cron-only" });

      // Look up the schedule row by task UID
      const schedule = await (await import("../db")).getCfoReportScheduleByTaskUid(taskUid);
      if (!schedule) return res.json({ ok: true, skipped: "orphan" });
      if (!schedule.isActive) return res.json({ ok: true, skipped: "inactive" });

      const { sendWeeklyChannelReport } = await import("../cfoReportService");
      const result = await sendWeeklyChannelReport(schedule.userId, schedule.reportPeriod);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[weeklyChannelReport] error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        context: { url: req.url, taskUid: req.headers["x-manus-cron-task-uid"] },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── Scheduled: daily threshold breach check ─────────────────────────────
  app.post("/api/scheduled/channelThresholdCheck", async (req, res) => {
    try {
      const taskUid = req.headers["x-manus-cron-task-uid"] as string | undefined;
      if (!taskUid) return res.status(403).json({ error: "cron-only" });

      // Run for all users who have alert settings configured
      const dbModule = await import("../db");
      const users = await dbModule.getAllUsers();
      const { checkChannelThresholdBreaches } = await import("../cfoReportService");

      let totalBreaches = 0;
      let totalAlerts = 0;
      for (const user of users) {
        const result = await checkChannelThresholdBreaches(user.id);
        totalBreaches += result.breachesFound;
        totalAlerts += result.alertsSent;
      }

      res.json({ ok: true, totalBreaches, totalAlerts, usersChecked: users.length });
    } catch (err) {
      console.error("[channelThresholdCheck] error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        context: { url: req.url, taskUid: req.headers["x-manus-cron-task-uid"] },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── Scheduled: daily S3 CSV export cleanup ──────────────────────────────
  // Heartbeat cron: runs daily (e.g. "0 0 2 * * *" — 02:00 UTC)
  // Deletes CSV files from S3 whose age exceeds their configured retentionDays.
  app.post("/api/scheduled/s3CsvCleanup", async (req, res) => {
    try {
      const taskUid = req.headers["x-manus-cron-task-uid"] as string | undefined;
      if (!taskUid) return res.status(403).json({ error: "cron-only" });

      const { purgeExpiredCsvExports } = await import("../s3CleanupService");
      const result = await purgeExpiredCsvExports();

      console.log(`[s3CsvCleanup] checked=${result.checked} deleted=${result.deleted} failed=${result.failed}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[s3CsvCleanup] error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        context: { url: req.url, taskUid: req.headers["x-manus-cron-task-uid"] },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── Magic-link login ─────────────────────────────────────────────────────
  // GET /api/magic-login?token=<hex>
  // Consumes a single-use welcome token, creates a session cookie, and
  // redirects the user to the dashboard. On error, redirects to /?error=...
  // PCI remediation (WS-2): per-IP throttle — tokens are high-entropy and
  // single-use, but auth endpoints must still be rate-limited.
  const { createRateLimiter } = await import("../rateLimiter");
  const magicLoginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 20 });
  app.get("/api/magic-login", async (req, res) => {
    const reqIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    if (!magicLoginLimiter.check(`ip:${reqIp}`).allowed) {
      return res.status(429).send("Too many attempts. Please try again in a few minutes.");
    }
    const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!token) {
      return res.redirect(302, "/?error=invalid_magic_link");
    }
    try {
      const { consumeMagicLinkToken } = await import("../magicLinkService");
      const { getUserById, upsertUser, createAuditLog } = await import("../db");
      const { COOKIE_NAME, ONE_YEAR_MS } = await import("@shared/const");

      const userId = await consumeMagicLinkToken(token);
      if (!userId) {
        return res.redirect(302, "/?error=expired_magic_link");
      }

      const user = await getUserById(userId);
      if (!user || !user.isActive) {
        return res.redirect(302, "/?error=account_inactive");
      }

      // Tenant gate: members of a deactivated organization cannot sign in.
      const { isOrgLoginAllowed } = await import("./tenancy");
      if (!(await isOrgLoginAllowed(user.organizationId))) {
        return res.redirect(302, "/login?error=org_suspended");
      }

      // Create a JWT session token using the user's openId (same as OAuth flow)
      const sessionToken = await sdk.createSessionToken(user.openId, {
        name: user.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      // Update lastSignedIn
      await upsertUser({ openId: user.openId, lastSignedIn: new Date() });

      // Audit log
      try {
        const ip =
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
          req.socket?.remoteAddress ||
          "unknown";
        await createAuditLog({
          userId: user.id,
          organizationId: user.organizationId ?? null,
          action: "magic_link_login",
          entityType: "user_session",
          details: JSON.stringify({ email: user.email }),
          ipAddress: ip,
          userAgent: (req.headers["user-agent"] || "unknown").substring(0, 500),
        });
      } catch (_) { /* audit logging must never crash the login flow */ }

      const { getSessionCookieOptions } = await import("./cookies");
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      return res.redirect(302, "/dashboard");
    } catch (err) {
      console.error("[magic-login] error:", err);
      return res.redirect(302, "/?error=login_failed");
    }
  });

  // ── Woodcore live → mirror sync ────────────────────────────────────────────
  // POST /api/woodcore/sync  — start a full mirror refresh (async; poll GET for progress)
  // GET  /api/woodcore/sync  — current sync state
  // Guarded by a shared secret (header x-sync-secret == CRON_SECRET, falling back
  // to JWT_SECRET). Lets a scheduler (Railway Cron) or an operator trigger it
  // without an authenticated session.
  // Constant-time, and it LOGS why it refused. A bare 403 cannot distinguish a
  // drifted caller secret from a server with no secret configured at all — that
  // ambiguity is what left the Woodcore mirror sync failing silently for three
  // days after the 2026-08-02 rotation. The response stays a uniform 403; only
  // the log says which. See _core/syncAuth.ts.
  //
  // Two accepted paths, OIDC preferred: a `Authorization: Bearer <github oidc
  // jwt>` minted per workflow run, or the legacy `x-sync-secret`. The secret
  // stays because on-premise mode blocks the egress OIDC verification needs and
  // Railway Cron cannot mint a token at all. See _core/githubOidc.ts.
  const syncAuthorized = async (req: import("express").Request) => {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || null;
    const result = await authorizeSyncRequest(
      {
        bearerToken: bearer,
        secretHeader: req.headers["x-sync-secret"] as string | undefined,
      },
      {
        expectedSecret: expectedSyncSecret(),
        verifyOidc: async (token) => {
          const outcome = await verifyGitHubOidcToken(token, {
            audience: ENV.githubOidcAudience,
            allowedRepositories: ENV.githubOidcRepositories.split(",").map((s) => s.trim()).filter(Boolean),
            allowedRefs: ENV.githubOidcRefs.split(",").map((s) => s.trim()).filter(Boolean),
          });
          return outcome.ok
            ? { ok: true as const, repository: outcome.repository }
            : { ok: false as const, reason: outcome.reason, detail: describeOidcFailure(outcome.reason, outcome.detail) };
        },
      },
    );
    if (result.ok) {
      // The rollout signal. Until this says github_oidc for the scheduled runs,
      // OIDC is not carrying anything and the GitHub secrets cannot be deleted.
      console.log(
        `[syncAuth] authorized ${req.method} ${req.path} via ${result.via}${result.detail ? ` (${result.detail})` : ""}`,
      );
    } else {
      console.warn(
        `[syncAuth] refused ${req.method} ${req.path}: ${describeSyncAuthFailure(result.reason)}` +
          (result.oidcDetail ? ` | oidc: ${result.oidcDetail}` : ""),
      );
    }
    return result.ok;
  };
  app.post("/api/woodcore/sync", async (req, res) => {
    if (!(await syncAuthorized(req))) return res.status(403).json({ error: "forbidden" });
    const { syncWoodcoreMirror, syncState } = await import("../woodcoreSync");
    if (syncState.running) return res.status(409).json({ error: "already running", state: syncState });
    syncWoodcoreMirror().catch((e) => console.error("[woodcoreSync] trigger error:", e));
    res.status(202).json({ started: true });
  });
  app.get("/api/woodcore/sync", async (req, res) => {
    if (!(await syncAuthorized(req))) return res.status(403).json({ error: "forbidden" });
    const { syncState } = await import("../woodcoreSync");
    res.json(syncState);
  });

  // ── CBS connector: inbound webhooks (all core-banking platforms) ──────────
  // POST /api/webhooks/cbs/:configId       — canonical path (any CBS type)
  // POST /api/webhooks/woodcore/:configId  — kept alias (pre-multi-CBS)
  // Real-time transaction ingestion. HMAC-verified against the raw body;
  // idempotent on event id; failures are dead-lettered (we own the retry, so
  // the CBS always gets a fast 2xx once the signature checks out).
  const cbsWebhookHandler = async (req: express.Request, res: express.Response) => {
    try {
      const configId = parseInt(req.params.configId, 10);
      if (!Number.isFinite(configId) || configId <= 0) {
        return res.status(400).json({ ok: false, status: "bad_config_id" });
      }
      const rawBody =
        (req as express.Request & { rawBody?: Buffer }).rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}));
      const { handleWoodcoreWebhook } = await import("../connectors/woodcore/webhooks");
      const result = await handleWoodcoreWebhook({
        configId,
        rawBody,
        headers: req.headers,
      });
      res.status(result.httpStatus).json(result.body);
    } catch (err) {
      console.error("[cbs-webhook] error:", err);
      res.status(500).json({ ok: false, status: "internal_error" });
    }
  };
  app.post("/api/webhooks/cbs/:configId", cbsWebhookHandler);
  app.post("/api/webhooks/woodcore/:configId", cbsWebhookHandler);

  // ── Developer REST API (gap-closure plan WS-4) ─────────────────────────────
  // /api/v1/* — X-API-Key auth, rate-limited, request-logged; translates REST
  // onto the existing tRPC procedures (server/api/gateway.ts). /developers
  // serves the interactive API reference (Redoc over docs/openapi.yaml).
  app.use("/api/v1", async (req, res, next) => {
    try {
      const { getApiGateway } = await import("../api/gateway");
      getApiGateway()(req, res, next);
    } catch (err) {
      console.error("[api-gateway] mount error:", err);
      res.status(500).json({ code: "INTERNAL", message: "API unavailable" });
    }
  });
  app.get("/developers", async (_req, res) => {
    const { developerDocsHtml } = await import("../api/developerDocs");
    res.type("html").send(developerDocsHtml());
  });

  // ── WoodCore connector: scheduled tick (daily batch sync + DLQ retries) ───
  // POST /api/scheduled/woodcoreConnectorSync — guarded by x-sync-secret, same
  // scheme as /api/woodcore/sync. Point a Railway/host cron at this hourly;
  // each connector's own batchSyncHourUtc decides when it actually pulls.
  app.post("/api/scheduled/woodcoreConnectorSync", async (req, res) => {
    if (!(await syncAuthorized(req))) return res.status(403).json({ error: "forbidden" });
    try {
      const { runConnectorTick } = await import("../connectors/woodcore");
      const result = await runConnectorTick();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[woodcoreConnectorSync] error:", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Inbound email (Tier A email-forward ingestion) ──────────────────────────
  // Resend posts `email.received` here. Verification, address resolution and
  // the sender allow-list all live in handleInboundEmail; only a SIGNATURE
  // failure returns non-2xx, because Resend retries non-2xx for hours and a
  // business rejection will never succeed on retry. Answering 200 also refuses
  // to reveal whether an address exists, so this cannot be probed.
  app.post("/api/webhooks/email/inbound", async (req, res) => {
    try {
      const rawBody =
        (req as express.Request & { rawBody?: Buffer }).rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
      const { handleInboundEmail } = await import("../ingest/emailIngestionService");
      const result = await handleInboundEmail(rawBody, {
        id: req.headers["svix-id"],
        timestamp: req.headers["svix-timestamp"],
        signature: req.headers["svix-signature"],
      });
      if (result.status === 401) {
        console.warn(`[emailIngestion] rejected delivery: ${result.reason}`);
        return res.status(401).json({ error: "invalid signature" });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      // Still 200: an unhandled fault here must not trigger a retry storm.
      console.error("[emailIngestion] handler threw:", err);
      return res.status(200).json({ ok: true });
    }
  });

  // ── SHOPLINE Scheduled Sync Handlers ────────────────────────────────────────
  // POST /api/scheduled/shoplineSyncCycle — 15-min incremental sync for all stores
  app.post("/api/scheduled/shoplineSyncCycle", async (req, res) => {
    if (!(await syncAuthorized(req))) return res.status(403).json({ error: "forbidden" });
    const { handleShoplineSyncCycle } = await import("../connectors/shopline/scheduledSync");
    return handleShoplineSyncCycle(req, res);
  });
  // POST /api/scheduled/shoplineDailyBatch — daily full 24h reconciliation
  app.post("/api/scheduled/shoplineDailyBatch", async (req, res) => {
    if (!(await syncAuthorized(req))) return res.status(403).json({ error: "forbidden" });
    const { handleShoplineDailyBatch } = await import("../connectors/shopline/scheduledSync");
    return handleShoplineDailyBatch(req, res);
  });
  // POST /api/scheduled/shoplineWebhookReconciler — daily webhook health check
  app.post("/api/scheduled/shoplineWebhookReconciler", async (req, res) => {
    if (!(await syncAuthorized(req))) return res.status(403).json({ error: "forbidden" });
    const { handleShoplineWebhookReconciler } = await import("../connectors/shopline/scheduledSync");
    return handleShoplineWebhookReconciler(req, res);
  });

  // ── Live monitoring stream (SSE) ───────────────────────────────────────────
  // GET /api/monitoring/stream — relays reconciliation job-progress events to the
  // dashboard in real time (replaces timer polling). Auth via session cookie.
  app.get("/api/monitoring/stream", async (req, res) => {
    try {
      await sdk.authenticateRequest(req);
    } catch {
      res.status(401).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // don't let any proxy buffer the stream
    });
    res.write("retry: 5000\n\n");
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    const { jobEvents } = await import("../jobEvents");
    const onProgress = (payload: unknown) => {
      res.write(`data: ${JSON.stringify({ type: "progress", ...(payload as object) })}\n\n`);
    };
    jobEvents.on("progress", onProgress);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      jobEvents.off("progress", onProgress);
      res.end();
    });
  });

  // Storage proxy — serves /manus-storage/* assets via signed S3 URLs
  registerStorageProxy(app);
  // Legacy Manus OAuth callback under /api/oauth/callback (redirects to /login)
  registerOAuthRoutes(app);
  // Enterprise SSO: Google OAuth2 + Microsoft Entra ID
  // (/api/oauth/{google|microsoft}/{start|callback})
  const { registerSsoRoutes } = await import("./sso");
  registerSsoRoutes(app);
  // SHOPLINE App Store connector routes (OAuth install, webhooks, GDPR)
  const { createShoplineRouter } = await import("../connectors/shopline/routes");
  app.use(createShoplineRouter());

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Boot sweep: mark reconciliation jobs stuck in pending/running >2h as
  // failed — crash orphans from the pre-queue era or in-process restarts
  // (fire-and-forget; see server/reconciliationQueue.ts).
  import("../reconciliationQueue")
    .then((q) => q.recoverStuckReconciliationJobs())
    .catch((e) => console.error("[boot] stuck-job sweep failed:", e instanceof Error ? e.message : e));

  // Seed global default resolution templates (idempotent; fire-and-forget so a
  // DB hiccup never blocks startup or the healthcheck).
  seedDefaultResolutionTemplates()
    .then((r) => { if (r.inserted > 0) console.log(`[seed] inserted ${r.inserted} default resolution template(s)`); })
    .catch((e) => console.error("[seed] resolution templates failed:", e instanceof Error ? e.message : e));

  // Seed Nigerian payment channel exception templates (idempotent; fire-and-forget).
  seedNigerianExceptionDefaults()
    .then((r) => { if (r.inserted > 0) console.log(`[seed] inserted ${r.inserted} Nigerian channel exception template(s)`); })
    .catch((e) => console.error("[seed] Nigerian exception templates failed:", e instanceof Error ? e.message : e));

  // Seed retail / e-commerce (SHOPLINE vertical) exception templates (idempotent).
  import("../seedResolutionTemplates")
    .then((m) => m.seedRetailExceptionDefaults())
    .then((r) => { if (r.inserted > 0) console.log(`[seed] inserted ${r.inserted} retail exception template(s)`); })
    .catch((e) => console.error("[seed] retail exception templates failed:", e instanceof Error ? e.message : e));

  // Seed Uganda market-pack exception templates (BoU framework; idempotent).
  import("../seedResolutionTemplates")
    .then((m) => m.seedUgandaExceptionDefaults())
    .then((r) => { if (r.inserted > 0) console.log(`[seed] inserted ${r.inserted} Uganda exception template(s)`); })
    .catch((e) => console.error("[seed] Uganda exception templates failed:", e instanceof Error ? e.message : e));

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
