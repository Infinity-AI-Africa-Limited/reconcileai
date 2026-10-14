/**
 * The webhook destination guard on the real chain — a REAL MySQL, CI's
 * database only, gated like the other *.db.test.ts files because the local
 * .env names production and this suite writes rows.
 *
 * Greptile #196: once webhooks fired, an admin could register
 * `http://127.0.0.1:<port>/`, subscribe to "*", upload a file, and the server
 * would POST to its own loopback. This is that scenario, with the real guard:
 * registration through the API, and rows stored before the guard existed,
 * fired by a real upload through the real worker. A local server counts every
 * connection made to it; the guard's claim is that the count stays at zero.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditChainLocks,
  auditLogs,
  channels,
  organizations,
  transactions,
  uploadBatches,
  users,
  webhookDeliveries,
  webhooks,
} from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { classifyDatabaseTarget } from "./dbTarget";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
const TIMEOUT_MS = 60_000;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Caller = ReturnType<(typeof import("./routers"))["appRouter"]["createCaller"]>;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.runIf(localDatabase)("when a webhook points inside the platform's network", () => {
  let db: Db;
  let server: http.Server;
  let port = 0;
  let connections = 0;
  let tenant = 0;
  let userId = 0;
  let channelCode = "";
  let caller: Caller;
  const legacy = { plain: 0, tls: 0 };
  const runTag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  const insertedId = (result: unknown): number => {
    const id = Number((result as { insertId?: number }).insertId);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("insert returned no id");
    return id;
  };

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;

    server = http.createServer((_req, res) => res.writeHead(200).end("ok"));
    server.on("connection", () => connections++);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    tenant = insertedId((await db.insert(organizations).values({
      name: `Webhook destination proof ${runTag}`,
      code: `WHDEST_${runTag}`,
      segment: "financial_services",
      isDemo: true,
    }))[0]);
    userId = insertedId((await db.insert(users).values({
      openId: `webhook-destination-${runTag}`,
      name: "Webhook destination admin",
      email: `admin-${runTag}@example.invalid`,
      loginMethod: "email",
      role: "admin",
      organizationId: tenant,
    }))[0]);
    channelCode = `WHDEST_${runTag}`.slice(0, 50);
    await db.insert(channels).values({ name: "Webhook destination proof", code: channelCode, channelType: "bank_core", organizationId: tenant });

    // As if registered before the guard: one plain http, one https, both on loopback.
    const legacyRow = (path: string, scheme: string) => ({
      organizationId: tenant,
      userId,
      name: `Before the guard (${scheme})`,
      url: `${scheme}://127.0.0.1:${port}/${path}?token=secret-in-the-url`,
      secret: "legacy",
      events: ["*"],
      isActive: true,
    });
    legacy.plain = insertedId((await db.insert(webhooks).values(legacyRow("plain", "http")))[0]);
    legacy.tls = insertedId((await db.insert(webhooks).values(legacyRow("tls", "https")))[0]);

    const { appRouter } = await import("./routers");
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    caller = appRouter.createCaller({
      user,
      req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1" } as unknown as TrpcContext["req"],
      res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
    });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    if (!db || !tenant) return;
    const steps: Array<() => Promise<unknown>> = [
      () => db.delete(webhookDeliveries).where(inArray(webhookDeliveries.webhookId, [legacy.plain, legacy.tls].filter(Boolean))),
      () => db.delete(webhooks).where(eq(webhooks.organizationId, tenant)),
      () => db.delete(uploadBatches).where(eq(uploadBatches.organizationId, tenant)),
      () => db.delete(transactions).where(and(isNull(transactions.organizationId), eq(transactions.userId, userId))),
      () => db.delete(channels).where(eq(channels.organizationId, tenant)),
      () => db.delete(auditLogs).where(eq(auditLogs.organizationId, tenant)),
      () => db.delete(auditChainLocks).where(eq(auditChainLocks.chainKey, tenant)),
      () => db.delete(users).where(eq(users.id, userId)),
      () => db.delete(organizations).where(eq(organizations.id, tenant)),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.error("[webhookDestination.db.test] cleanup step failed:", error);
      }
    }
  });

  it.each([
    [`https://127.0.0.1:{port}/hook`, "127.0.0.1 is a private or internal address"],
    [`http://127.0.0.1:{port}/hook`, "only https destinations are allowed"],
    ["https://169.254.169.254/latest/meta-data/", "169.254.169.254 is a reserved or link-local address"],
    ["https://localhost/hook", "localhost is an internal host name"],
  ])("should refuse to register %s, storing nothing", async (template, reason) => {
    const target = template.replace("{port}", String(port));
    await expect(caller.webhooks.create({ name: "Inside", url: target, events: ["*"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: `Webhook URL refused: ${reason}`,
    });
    const stored = await db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.url, target));
    expect(stored).toEqual([]);
  });

  it(
    "should send nothing to a loopback webhook stored before the guard, and record why",
    async () => {
      const upload = await caller.upload.createBatch({
        channelCode,
        fileName: "destination-proof.csv",
        transactions: [{ amount: "10.00", transactionDate: "2026-09-15T10:00:00.000Z", currency: "NGN", debitCredit: "credit" }],
      });
      expect(upload.batchId).toBeGreaterThan(0);

      // Dispatch runs after the procedure returns; wait for its records.
      const deadline = Date.now() + TIMEOUT_MS - 5_000;
      let records: Array<{ webhookId: number; status: string; lastError: string | null }> = [];
      while (Date.now() < deadline) {
        records = await db
          .select({ webhookId: webhookDeliveries.webhookId, status: webhookDeliveries.status, lastError: webhookDeliveries.lastError })
          .from(webhookDeliveries)
          .where(inArray(webhookDeliveries.webhookId, [legacy.plain, legacy.tls]));
        if (records.length >= 2) break;
        await sleep(100);
      }
      await sleep(1_000); // anything misdirected gets its chance to connect

      expect(connections).toBe(0);
      const byWebhook = Object.fromEntries(records.map(r => [r.webhookId, r]));
      expect(byWebhook[legacy.plain]).toMatchObject({
        status: "failed",
        lastError: "Destination refused: only https destinations are allowed",
      });
      expect(byWebhook[legacy.tls]).toMatchObject({
        status: "failed",
        lastError: "Destination refused: 127.0.0.1 is a private or internal address",
      });
      for (const record of records) expect(record.lastError).not.toContain("secret-in-the-url");
    },
    TIMEOUT_MS,
  );
});
