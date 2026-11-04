/**
 * Closing duplicate retail exceptions against a REAL MySQL — CI's database
 * only, gated like the other *.db.test.ts files because the local .env names
 * production and this suite writes rows.
 *
 * What only a real engine can show: the duplicate grouping and the joins that
 * find work linked to a copy, that measuring changes no row, that a copy someone
 * touches between the plan and the commit is skipped under the lock, and that
 * the change and its audit record land together in the tenant's own chain.
 * Every call names its own synthetic tenants, so parallel suites sharing the
 * database are never touched.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentMemory,
  auditChainLocks,
  auditLogs,
  exceptionPatternSignatures,
  exceptions,
  exceptionWorkflows,
  organizations,
  transactions,
} from "../drizzle/schema";
import { getDb } from "./db";
import { classifyDatabaseTarget } from "./dbTarget";
import {
  closeTenantDuplicates,
  DUPLICATE_AUDIT_ACTION,
  DuplicatesStillBeingFiledError,
  measureTenantDuplicates,
  tenantsWithDuplicateRetailExceptions,
} from "./duplicateRetailExceptions";
import { appRouter } from "./routers";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
const DAY = 24 * 60 * 60_000;
const CATEGORY = "retail_settlement_shortfall";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe.runIf(localDatabase)("when duplicate retail exceptions are handled on a real database", () => {
  // Synthetic job and transaction ids no real row has (no foreign keys).
  const base = 910_000_000 + Math.floor(Math.random() * 1_000_000);
  // Organisation ids are assigned by the database, never chosen here. Importing
  // the router starts its boot services, and the demo pre-warm creates an
  // organisation with an auto-increment id while these are inserted. An
  // explicit id N moves AUTO_INCREMENT to N+1, so that insert took the next
  // chosen id and the suite failed on a duplicate key.
  const ORG_KEYS = ["main", "other", "fresh", "race", "closedKeeper", "memoryBefore", "memoryDuring"] as const;
  const org = {} as Record<(typeof ORG_KEYS)[number], number>;
  const orgIds = () => Object.values(org);
  // Transaction ids no real row has: no job or transaction owns these rows.
  const txn = (n: number) => base + n;
  const filed = new Date(Date.now() - 3 * DAY);
  let db: Db;

  const insertedId = (result: unknown) => Number((result as { insertId?: number }).insertId);

  async function file(
    organizationId: number,
    transactionId: number,
    overrides: Partial<typeof exceptions.$inferInsert> = {},
  ): Promise<number> {
    const [result] = await db.insert(exceptions).values({
      organizationId,
      jobId: 0,
      transactionId,
      category: "unmatched",
      subCategory: CATEGORY,
      severity: "medium",
      status: "open",
      createdAt: filed,
      ...overrides,
    });
    return insertedId(result);
  }

  async function enroll(organizationId: number, exceptionId: number) {
    await db.insert(exceptionWorkflows).values({
      organizationId,
      exceptionId,
      attemptNumber: 1,
      ownerUserId: 1,
      startedByUserId: 1,
      dueAt: new Date(Date.now() + 2 * DAY),
    });
  }

  /** A real transaction row: `superAgent.addMemory` joins an exception to it. */
  async function transactionOf(organizationId: number): Promise<number> {
    const [result] = await db.insert(transactions).values({
      organizationId,
      batchId: base,
      channelId: base,
      userId: 1,
      amount: "10.00",
      transactionDate: filed,
      debitCredit: "credit",
      counterparty: "Stripe",
    });
    return insertedId(result);
  }

  /** An operations user of the tenant, calling the real procedure. */
  function operator(organizationId: number) {
    return appRouter.createCaller({
      user: {
        id: 9101,
        openId: `dup-proof-${organizationId}`,
        name: "Operator",
        email: "operator@example.invalid",
        role: "operations",
        organizationId,
        isGuest: false,
      },
      req: { headers: {}, ip: "127.0.0.1" },
      res: { cookie: () => {}, clearCookie: () => {} },
    } as never);
  }

  const memoryFor = (exceptionId: number) => ({
    exceptionId,
    exceptionCategory: CATEGORY,
    amountRange: "0-100k" as const,
    resolution: "Matched by hand",
    outcome: "resolved" as const,
    reasoning: "synthetic",
    embeddingText: "synthetic",
  });

  async function rows(ids: number[]) {
    const found = await db.select().from(exceptions).where(inArray(exceptions.id, ids));
    return new Map(found.map((row) => [row.id, row]));
  }

  async function auditRecords(organizationId: number) {
    return db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, DUPLICATE_AUDIT_ACTION)));
  }

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;
    for (const key of ORG_KEYS) {
      const [result] = await db
        .insert(organizations)
        .values({ name: `Duplicate proof ${base} ${key}`, code: `DUPPROOF_${base}_${key}`, isDemo: true });
      org[key] = insertedId(result);
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(exceptionWorkflows).where(inArray(exceptionWorkflows.organizationId, orgIds()));
    await db.delete(agentMemory).where(inArray(agentMemory.organizationId, orgIds()));
    await db.delete(exceptionPatternSignatures).where(inArray(exceptionPatternSignatures.organizationId, orgIds()));
    await db.delete(exceptions).where(inArray(exceptions.organizationId, orgIds()));
    await db.delete(transactions).where(inArray(transactions.organizationId, orgIds()));
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgIds()));
    await db.delete(auditChainLocks).where(inArray(auditChainLocks.chainKey, orgIds()));
    await db.delete(organizations).where(inArray(organizations.id, orgIds()));
  });

  describe("when a tenant holds every kind of duplicate group", () => {
    const ids: Record<string, number> = {};

    beforeAll(async () => {
      // A: three untouched copies.
      ids.a1 = await file(org.main, txn(1));
      ids.a2 = await file(org.main, txn(1));
      ids.a3 = await file(org.main, txn(1));
      // B: an untouched copy, and a later one enrolled in a governed workflow.
      ids.b1 = await file(org.main, txn(2));
      ids.b2 = await file(org.main, txn(2));
      await enroll(org.main, ids.b2);
      // C: a copy a person resolved, and an open one.
      ids.c1 = await file(org.main, txn(3), { status: "resolved", resolvedBy: 5, resolvedAt: filed });
      ids.c2 = await file(org.main, txn(3));
      // D: two copies that each carry work.
      ids.d1 = await file(org.main, txn(4), { assignedTo: 5 });
      ids.d2 = await file(org.main, txn(4), { aiAnalysis: "diagnosed" });
      // Not duplicates: one copy alone; copies a job filed; another tenant's copy of A's case.
      ids.single = await file(org.main, txn(5));
      ids.job1 = await file(org.main, txn(6), { jobId: base });
      ids.job2 = await file(org.main, txn(6), { jobId: base });
      ids.other1 = await file(org.other, txn(1));
      ids.other2 = await file(org.other, txn(1));
    });

    it("should measure every group without changing a row", async () => {
      const before = await rows(Object.values(ids));
      const { summary } = await measureTenantDuplicates(db, org.main);

      expect(summary).toMatchObject({ organizationId: org.main, groups: 4, toClose: 3, needPerson: 1, decidedBesideOpen: 1 });
      expect(await rows(Object.values(ids))).toEqual(before);
      expect(await tenantsWithDuplicateRetailExceptions(db)).toEqual(expect.arrayContaining([org.main, org.other]));
    });

    it("should dismiss only the untouched copies, naming the copy each duplicates, and audit them", async () => {
      const result = await closeTenantDuplicates(db, org.main);
      expect(result).toEqual({ organizationId: org.main, closed: 3, skipped: 0, needPerson: 1, decidedBesideOpen: 1 });

      const after = await rows(Object.values(ids));
      for (const [id, keeper] of [[ids.a2, ids.a1], [ids.a3, ids.a1], [ids.b1, ids.b2]]) {
        const row = after.get(id);
        expect(row?.status).toBe("dismissed");
        expect(row?.resolvedBy).toBeNull();
        expect(row?.resolvedAt).toBeInstanceOf(Date);
        expect(row?.resolutionNotes).toContain(`Duplicate of exception #${keeper}`);
      }
      for (const id of [ids.a1, ids.b2, ids.c2, ids.d1, ids.d2, ids.single, ids.job1, ids.job2, ids.other1, ids.other2]) {
        expect(after.get(id)?.status, `exception ${id}`).toBe("open");
      }
      expect(after.get(ids.c1)?.status).toBe("resolved");

      const [audit, ...more] = await auditRecords(org.main);
      expect(more).toHaveLength(0);
      expect(audit.userId).toBeNull();
      expect(audit.recordHash).toMatch(/^[0-9a-f]{64}$/);
      const details = JSON.parse(String(audit.details));
      expect(details.dismissed).toEqual(
        expect.arrayContaining([
          { id: ids.a2, keeperId: ids.a1 },
          { id: ids.a3, keeperId: ids.a1 },
          { id: ids.b1, keeperId: ids.b2 },
        ]),
      );
      expect(await auditRecords(org.other)).toHaveLength(0);
    });

    it("should change nothing, and audit nothing, when run again", async () => {
      const before = await rows(Object.values(ids));
      // What is still outstanding, not its own work: C needs a decision, D a person.
      const { summary } = await measureTenantDuplicates(db, org.main);
      expect(summary).toMatchObject({ groups: 2, toClose: 0, needPerson: 1, decidedBesideOpen: 1 });
      await expect(closeTenantDuplicates(db, org.main)).resolves.toMatchObject({ closed: 0, skipped: 0 });
      expect(await rows(Object.values(ids))).toEqual(before);
      expect(await auditRecords(org.main)).toHaveLength(1);
    });
  });

  describe("when duplicates are still being filed", () => {
    it("should refuse and change nothing, because the next sync would undo it", async () => {
      const first = await file(org.fresh, txn(1), { createdAt: new Date() });
      const second = await file(org.fresh, txn(1), { createdAt: new Date() });

      await expect(closeTenantDuplicates(db, org.fresh)).rejects.toBeInstanceOf(DuplicatesStillBeingFiledError);
      const after = await rows([first, second]);
      expect([after.get(first)?.status, after.get(second)?.status]).toEqual(["open", "open"]);
      expect(await auditRecords(org.fresh)).toHaveLength(0);
    });
  });

  describe("when someone acts on a copy between the plan and the commit", () => {
    it("should skip the copies they touched, and dismiss the rest", async () => {
      const keeper = await file(org.race, txn(1));
      const assigned = await file(org.race, txn(1));
      const enrolled = await file(org.race, txn(1));
      const untouched = await file(org.race, txn(1));

      const result = await closeTenantDuplicates(db, org.race, {
        afterPlan: async (plans) => {
          expect(plans[0]?.close).toEqual([assigned, enrolled, untouched]);
          await db.update(exceptions).set({ assignedTo: 5 }).where(eq(exceptions.id, assigned));
          await enroll(org.race, enrolled);
        },
      });

      expect(result).toMatchObject({ closed: 1, skipped: 2 });
      const after = await rows([keeper, assigned, enrolled, untouched]);
      expect(after.get(untouched)?.status).toBe("dismissed");
      expect(after.get(assigned)).toMatchObject({ status: "open", assignedTo: 5 });
      expect(after.get(enrolled)?.status).toBe("open");
      expect(after.get(keeper)?.status).toBe("open");
    });
  });

  describe("when a person closes the kept copy between the plan and the commit", () => {
    it("should leave the other copy open, as a fresh plan would (Greptile, #222)", async () => {
      const keeper = await file(org.closedKeeper, txn(1));
      const copy = await file(org.closedKeeper, txn(1));

      const result = await closeTenantDuplicates(db, org.closedKeeper, {
        afterPlan: async (plans) => {
          expect(plans[0]).toMatchObject({ keeperId: keeper, close: [copy] });
          await db
            .update(exceptions)
            .set({ status: "resolved", resolvedBy: 5, resolvedAt: new Date() })
            .where(eq(exceptions.id, keeper));
        },
      });

      expect(result).toMatchObject({ closed: 0, skipped: 1 });
      expect((await rows([copy])).get(copy)?.status).toBe("open");
      expect(await auditRecords(org.closedKeeper)).toHaveLength(0);
    });
  });

  describe("when someone saves a memory against a copy", () => {
    it("should skip a copy whose memory was saved before the batch locked it", async () => {
      const transactionId = await transactionOf(org.memoryBefore);
      await file(org.memoryBefore, transactionId);
      const copy = await file(org.memoryBefore, transactionId);

      const result = await closeTenantDuplicates(db, org.memoryBefore, {
        afterPlan: async () => {
          await operator(org.memoryBefore).superAgent.addMemory(memoryFor(copy));
        },
      });

      expect(result).toMatchObject({ closed: 0, skipped: 1 });
      expect((await rows([copy])).get(copy)?.status).toBe("open");
    });

    it("should make a memory saved during the batch wait for it, so the batch never decides on stale work (Greptile, #222)", async () => {
      const transactionId = await transactionOf(org.memoryDuring);
      const keeper = await file(org.memoryDuring, transactionId);
      const copy = await file(org.memoryDuring, transactionId);
      let saving: Promise<unknown> | undefined;
      let settledInsideBatch = false;

      const result = await closeTenantDuplicates(db, org.memoryDuring, {
        afterLock: async () => {
          saving = operator(org.memoryDuring).superAgent.addMemory(memoryFor(copy));
          saving.then(
            () => { settledInsideBatch = true; },
            () => { settledInsideBatch = true; },
          );
          // Long enough for an unlocked insert to commit many times over.
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(settledInsideBatch, "addMemory finished while the batch held the copy's lock").toBe(false);
        },
      });
      await saving;

      // In order: the copy was dismissed, then the memory was saved against it.
      expect(result).toMatchObject({ closed: 1, skipped: 0 });
      const after = await rows([keeper, copy]);
      expect(after.get(copy)?.status).toBe("dismissed");
      expect(after.get(keeper)?.status).toBe("open");
      const memories = await db.select().from(agentMemory).where(eq(agentMemory.exceptionId, copy));
      expect(memories).toHaveLength(1);
    });
  });
});
