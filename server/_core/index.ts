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
import { getLlmProviderInfo } from "./llm";
import { getDb } from "../db";
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
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
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
  app.get("/api/magic-login", async (req, res) => {
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
  const syncSecret = () => ENV.cronSecret || ENV.cookieSecret;
  const syncAuthorized = (req: import("express").Request) => {
    const secret = syncSecret();
    const provided = (req.headers["x-sync-secret"] as string) || "";
    return Boolean(secret) && provided === secret;
  };
  app.post("/api/woodcore/sync", async (req, res) => {
    if (!syncAuthorized(req)) return res.status(403).json({ error: "forbidden" });
    const { syncWoodcoreMirror, syncState } = await import("../woodcoreSync");
    if (syncState.running) return res.status(409).json({ error: "already running", state: syncState });
    syncWoodcoreMirror().catch((e) => console.error("[woodcoreSync] trigger error:", e));
    res.status(202).json({ started: true });
  });
  app.get("/api/woodcore/sync", async (req, res) => {
    if (!syncAuthorized(req)) return res.status(403).json({ error: "forbidden" });
    const { syncState } = await import("../woodcoreSync");
    res.json(syncState);
  });

  // Storage proxy — serves /manus-storage/* assets via signed S3 URLs
  registerStorageProxy(app);
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
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
