import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { getLlmProviderInfo } from "./llm";
import { getDb } from "../db";
import { sql } from "drizzle-orm";
import { storagePut, storageGet, storageDelete } from "../storage";

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
