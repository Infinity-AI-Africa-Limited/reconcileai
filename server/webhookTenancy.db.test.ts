/**
 * Webhook tenancy against a REAL MySQL — CI's database only, gated like the
 * other *.db.test.ts files because the local .env names production and this
 * suite writes rows.
 *
 * Until 2026-10-14 dispatch selected every active webhook on the platform, so
 * every tenant's events reached every tenant's webhooks: a user at bank B could
 * subscribe to "*" and receive bank A's run results and exception activity.
 *
 * This runs the chain a bank would: webhooks registered through the API, a
 * real reconciliation through the real queue and worker, delivery over real
 * HTTP to a local receiver. Each tenant's endpoint records what it heard, and
 * the assertions are about who heard what.
 *
 * The receiver is on loopback, which the real destination guard refuses (it
 * is exactly what a server-side request forgery would target). So this file
 * swaps in a policy that permits http to 127.0.0.1 and nothing else; the real
 * guard on the same chain is webhookDestination.db.test.ts.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentMemory,
  auditChainLocks,
  auditLogs,
  channels,
  exceptionPatternSignatures,
  exceptions,
  jobProgressEvents,
  matches,
  organizations,
  reconciliationJobs,
  transactions,
  uploadBatches,
  users,
  webhookDeliveries,
  webhooks,
} from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { getDb, updateException } from "./db";
import { classifyDatabaseTarget } from "./dbTarget";

vi.mock("./outboundDestination", async importOriginal => {
  const real = await importOriginal<typeof import("./outboundDestination")>();
  const loopbackOnly: import("./outboundDestination").DestinationPolicy = {
    name: "test-loopback",
    urlProblem: (target) => (target.protocol === "http:" ? null : "test policy: http only"),
    addressProblem: (address) => (address === "127.0.0.1" ? null : `test policy: ${address} refused`),
  };
  return { ...real, destinationPolicy: () => loopbackOnly };
});

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

const RUN_TIMEOUT_MS = 60_000;
/** After the expected deliveries land, how long anything misdirected gets to arrive too. */
const STRAGGLER_GRACE_MS = 1_500;
const ON_THE_DAY = new Date("2026-09-15T10:00:00Z");

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Caller = ReturnType<(typeof import("./routers"))["appRouter"]["createCaller"]>;
type Heard = { endpoint: string; event: string; payload: Record<string, unknown> };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.runIf(localDatabase)("when two tenants' webhooks meet a real database", () => {
  // Auto-increment ids, not chosen ones: importing the router starts the demo
  // prewarm, whose own organisations take the next id after any explicit one.
  // Everything filed under these two is removed after.
  let tenantA = 0;
  let tenantB = 0;
  const tenants: number[] = [];
  const runTag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  let db: Db;
  let server: http.Server;
  let base = "";
  const heard: Heard[] = [];
  const callers = {} as Record<"a" | "b", Caller>;
  const user = { a: 0, b: 0 };
  const channel = { aSource: 0, aTarget: 0, b: 0 };
  const webhook = { a: 0, b: 0, legacy: 0, aString: 0 };
  let jobId = 0;

  const insertedId = (result: unknown): number => {
    const id = Number((result as { insertId?: number }).insertId);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("insert returned no id");
    return id;
  };

  const heardAt = (endpoint: string) => heard.filter(h => h.endpoint === endpoint);

  async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const deadline = Date.now() + RUN_TIMEOUT_MS - 5_000;
    for (;;) {
      const found = await probe();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  async function deliveriesTo(webhookId: number): Promise<number> {
    const rows = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, webhookId));
    return rows.length;
  }

  async function insertTxn(batchId: number, channelId: number, ref: string, amount: string): Promise<void> {
    await db.insert(transactions).values({
      batchId,
      channelId,
      userId: user.a,
      organizationId: tenantA,
      transactionRef: ref,
      amount,
      currency: "NGN",
      transactionDate: ON_THE_DAY,
      debitCredit: "credit",
      status: "unmatched",
    });
  }

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;

    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { event: string; payload: Record<string, unknown> };
          heard.push({ endpoint: req.url ?? "", event: parsed.event, payload: parsed.payload });
        } catch {
          heard.push({ endpoint: req.url ?? "", event: "<unparseable>", payload: {} });
        }
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const newTenant = async (key: string) =>
      insertedId((await db.insert(organizations).values({
        name: `Webhook tenancy proof ${key} ${runTag}`,
        code: `WHTEN_${key}_${runTag}`,
        segment: "financial_services",
        isDemo: true,
      }))[0]);
    tenantA = await newTenant("A");
    tenants.push(tenantA);
    tenantB = await newTenant("B");
    tenants.push(tenantB);

    const { appRouter } = await import("./routers");
    for (const [key, organizationId] of [["a", tenantA], ["b", tenantB]] as const) {
      const [inserted] = await db.insert(users).values({
        openId: `webhook-tenancy-${organizationId}`,
        name: `Webhook tenancy operator ${key}`,
        email: `operator-${organizationId}@example.invalid`,
        loginMethod: "email",
        // Admin: only an admin registers webhooks. Admins may also run and
        // resolve, which the rest of this suite does.
        role: "admin",
        organizationId,
      });
      user[key] = insertedId(inserted);
      const [row] = await db.select().from(users).where(eq(users.id, user[key]));
      const ctx: TrpcContext = {
        user: row,
        req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1" } as unknown as TrpcContext["req"],
        res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
      };
      callers[key] = appRouter.createCaller(ctx);
    }

    const newChannel = async (code: string, organizationId: number) =>
      insertedId((await db.insert(channels).values({
        name: `Webhook proof ${code}`,
        code: `${code}_${organizationId}`,
        channelType: "bank_core",
        organizationId,
      }))[0]);
    channel.aSource = await newChannel("WH_SRC", tenantA);
    channel.aTarget = await newChannel("WH_TGT", tenantA);
    channel.b = await newChannel("WH_B", tenantB);

    // Tenant A's data: one pair that matches, one row that does not — so its
    // run raises reconciliation.completed, exception.created and a KPI breach.
    const [batch] = await db.insert(uploadBatches).values({
      userId: user.a,
      organizationId: tenantA,
      channelId: channel.aSource,
      fileName: "webhook-proof.csv",
      status: "completed",
    });
    const batchId = insertedId(batch);
    await insertTxn(batchId, channel.aSource, "WH-1", "100.00");
    await insertTxn(batchId, channel.aTarget, "WH-1", "100.00");
    await insertTxn(batchId, channel.aSource, "WH-2", "50.00");

    // Registered through the API, as each bank would. B subscribes to
    // everything — the subscription the leak paid out on.
    webhook.a = Number((await callers.a.webhooks.create({ name: "A ops", url: `${base}/a`, events: ["*"] })).id);
    webhook.b = Number((await callers.b.webhooks.create({ name: "B everything", url: `${base}/b`, events: ["*"] })).id);

    // Rows the old code could leave behind: one with no organisation, and one
    // whose events the old create path stored as a JSON string.
    webhook.legacy = insertedId((await db.insert(webhooks).values({
      userId: user.b,
      name: "Legacy, no organisation",
      url: `${base}/legacy`,
      secret: "legacy",
      events: ["*"],
      isActive: true,
    }))[0]);
    webhook.aString = insertedId((await db.insert(webhooks).values({
      organizationId: tenantA,
      userId: user.a,
      name: "Old create path",
      url: `${base}/a-string`,
      secret: "old",
      events: JSON.stringify(["*"]),
      isActive: true,
    }))[0]);
  }, RUN_TIMEOUT_MS);

  afterAll(async () => {
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    if (!db) return;
    const webhookIds = Object.values(webhook).filter(id => id > 0);
    const steps: Array<() => Promise<unknown>> = [
      () => webhookIds.length > 0
        ? db.delete(webhookDeliveries).where(inArray(webhookDeliveries.webhookId, webhookIds))
        : Promise.resolve(),
      () => db.delete(webhooks).where(or(inArray(webhooks.organizationId, tenants), inArray(webhooks.userId, [user.a, user.b]))),
      () => db.delete(matches).where(inArray(matches.organizationId, tenants)),
      () => db.delete(exceptions).where(inArray(exceptions.organizationId, tenants)),
      () => jobId > 0 ? db.delete(jobProgressEvents).where(eq(jobProgressEvents.jobId, jobId)) : Promise.resolve(),
      () => db.delete(reconciliationJobs).where(inArray(reconciliationJobs.organizationId, tenants)),
      () => db.delete(transactions).where(inArray(transactions.organizationId, tenants)),
      () => db.delete(uploadBatches).where(inArray(uploadBatches.organizationId, tenants)),
      () => db.delete(transactions).where(and(isNull(transactions.organizationId), eq(transactions.channelId, channel.b))),
      () => db.delete(channels).where(inArray(channels.organizationId, tenants)),
      // exceptions.resolve's learning capture writes these for the resolving tenant.
      () => db.delete(agentMemory).where(inArray(agentMemory.organizationId, tenants)),
      () => db.delete(exceptionPatternSignatures).where(inArray(exceptionPatternSignatures.organizationId, tenants)),
      () => db.delete(auditLogs).where(inArray(auditLogs.organizationId, tenants)),
      () => db.delete(auditChainLocks).where(inArray(auditChainLocks.chainKey, tenants)),
      () => db.delete(users).where(inArray(users.organizationId, tenants)),
      () => db.delete(organizations).where(inArray(organizations.id, tenants)),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.error("[webhookTenancy.db.test] cleanup step failed:", error);
      }
    }
  });

  describe("when a webhook is registered", () => {
    it("should file it under the creator's organisation, subscribed by a real JSON array", async () => {
      const [row] = await db
        .select({ organizationId: webhooks.organizationId, type: sql<string>`JSON_TYPE(${webhooks.events})` })
        .from(webhooks)
        .where(eq(webhooks.id, webhook.a));
      expect(row).toEqual({ organizationId: tenantA, type: "ARRAY" });
    });

    it("should refuse an account with no organisation, and store nothing", async () => {
      const { appRouter } = await import("./routers");
      const [row] = await db.select().from(users).where(eq(users.id, user.b));
      const orgless = appRouter.createCaller({
        user: { ...row, organizationId: null },
        req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1" } as unknown as TrpcContext["req"],
        res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
      });
      await expect(
        orgless.webhooks.create({ name: "Nobody's", url: `${base}/orgless`, events: ["*"] }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      const stored = await db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.url, `${base}/orgless`));
      expect(stored).toEqual([]);
    });
  });

  describe("when a tenant lists or deletes webhooks", () => {
    it("should list only its own organisation's webhooks, and never a signing secret", async () => {
      const listed = await callers.a.webhooks.list();
      const ids = listed.map(w => w.id);
      expect(ids).toContain(webhook.a);
      expect(ids).not.toContain(webhook.b);
      expect(ids).not.toContain(webhook.legacy);
      for (const w of listed) expect(w).not.toHaveProperty("secret");
    });

    it("should not let another tenant delete it", async () => {
      await expect(callers.b.webhooks.delete({ id: webhook.a })).rejects.toMatchObject({ code: "NOT_FOUND" });
      const [row] = await db.select({ isActive: webhooks.isActive }).from(webhooks).where(eq(webhooks.id, webhook.a));
      expect(row.isActive).toBe(true);
    });
  });

  describe("when tenant A runs a reconciliation", () => {
    it(
      "should deliver A's events to A's webhook, and nothing to B's, the org-less one, or a string-subscribed one",
      async () => {
        const created = await callers.a.reconciliation.create({
          name: "Webhook tenancy proof",
          moduleType: "settlement",
          sourceChannelId: channel.aSource,
          targetChannelId: channel.aTarget,
          dateFrom: "2026-09-14T00:00:00.000Z",
          dateTo: "2026-09-16T23:59:59.000Z",
          dateWindowDays: 1,
        });
        jobId = created.jobId;
        expect(jobId).toBeGreaterThan(0);

        // The positive control: A hears all three of its run's events.
        const ownEvents = ["reconciliation.completed", "exception.created", "kpi.threshold.breached"];
        await waitFor("tenant A's three run events", () => {
          const got = heardAt("/a").filter(h => h.payload.jobId === jobId).map(h => h.event);
          return ownEvents.every(e => got.includes(e)) ? got : undefined;
        });
        await sleep(STRAGGLER_GRACE_MS);

        expect(heardAt("/b")).toEqual([]);
        expect(heardAt("/legacy")).toEqual([]);
        expect(heardAt("/a-string")).toEqual([]);
        // Not merely undelivered: never addressed. No delivery row was made.
        expect(await deliveriesTo(webhook.b)).toBe(0);
        expect(await deliveriesTo(webhook.legacy)).toBe(0);
        expect(await deliveriesTo(webhook.aString)).toBe(0);
        expect(await deliveriesTo(webhook.a)).toBeGreaterThanOrEqual(3);
      },
      RUN_TIMEOUT_MS,
    );
  });

  describe("when tenant B uploads a file", () => {
    it("should file the batch under B and announce it to B alone", async () => {
      const upload = await callers.b.upload.createBatch({
        channelCode: `WH_B_${tenantB}`,
        fileName: "b-upload.csv",
        transactions: [{ amount: "10.00", transactionDate: "2026-09-15T10:00:00.000Z", currency: "NGN", debitCredit: "credit" }],
      });
      const batchId = upload.batchId;

      const [batch] = await db.select({ organizationId: uploadBatches.organizationId }).from(uploadBatches).where(eq(uploadBatches.id, batchId));
      expect(batch.organizationId).toBe(tenantB);

      await waitFor("B's upload event", () =>
        heardAt("/b").find(h => h.event === "upload.completed" && h.payload.batchId === batchId),
      );
      await sleep(STRAGGLER_GRACE_MS);
      expect(heardAt("/a").filter(h => h.event === "upload.completed")).toEqual([]);
    });
  });

  describe("when an exception is resolved", () => {
    async function oneOfAsExceptions(): Promise<number> {
      const [row] = await db
        .select({ id: exceptions.id })
        .from(exceptions)
        .where(and(eq(exceptions.organizationId, tenantA), eq(exceptions.jobId, jobId)))
        .limit(1);
      if (!row) throw new Error("tenant A's run produced no exception");
      return row.id;
    }

    it("should neither change nor announce A's exception when B names its id", async () => {
      const exceptionId = await oneOfAsExceptions();
      await expect(
        callers.b.exceptions.resolve({ id: exceptionId, status: "resolved", resolutionNotes: "not mine" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await sleep(STRAGGLER_GRACE_MS);

      const [row] = await db.select({ status: exceptions.status }).from(exceptions).where(eq(exceptions.id, exceptionId));
      expect(row.status).toBe("open");
      expect(heard.filter(h => h.event === "exception.resolved")).toEqual([]);
    });

    it("should announce it to A when A resolves it, and to no one else", async () => {
      const exceptionId = await oneOfAsExceptions();
      await callers.a.exceptions.resolve({ id: exceptionId, status: "resolved" });

      await waitFor("A's resolution event", () =>
        heardAt("/a").find(h => h.event === "exception.resolved" && h.payload.exceptionId === exceptionId),
      );
      await sleep(STRAGGLER_GRACE_MS);
      expect(heardAt("/b").filter(h => h.event === "exception.resolved")).toEqual([]);
      expect(heardAt("/legacy")).toEqual([]);
    });

    it("should count a matched row even when nothing in it changes, and no row for another tenant", async () => {
      // The resolve gate keys on this count. mysql2 asks for FOUND rows, so an
      // identical repeat still reports its one row; a different tenant, none.
      const exceptionId = await oneOfAsExceptions();
      expect(await updateException(exceptionId, tenantA, { status: "escalated" })).toBe(1);
      expect(await updateException(exceptionId, tenantA, { status: "escalated" })).toBe(1);
      expect(await updateException(exceptionId, tenantB, { status: "escalated" })).toBe(0);
    });
  });
});
