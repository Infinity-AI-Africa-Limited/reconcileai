/**
 * A governed daily control run against a REAL MySQL — CI's database only,
 * gated like the other *.db.test.ts files because the local .env names
 * production and this suite writes rows.
 *
 * Every other governed-control test runs against a scripted executor. This one
 * executes the SQL: the population aggregate (COUNT, the off-channel and
 * not-unmatched CASE sums, SUM over DECIMAL), the batch-scoped load, the job +
 * audit transaction, and the real queue and worker. The evidence is recorded
 * through the same procedures an operator uses.
 *
 * The decoy is what makes the run's result mean something: a row on the
 * register channel, on the same business day, in ANOTHER batch, that the old
 * date-window loader would have matched to an approved settlement row.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditChainLocks,
  auditLogs,
  channels,
  controlBatchManifests,
  controlSourceContracts,
  exceptions,
  jobProgressEvents,
  matches,
  organizations,
  reconciliationJobs,
  transactions,
  uploadBatches,
  users,
} from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { createReconciliationJob, getDb } from "./db";
import { classifyDatabaseTarget } from "./dbTarget";
import { enqueueReconciliationRun } from "./reconciliationQueue";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

const PERIOD = "2026-09-15";
/** 11:00 in Lagos on the control day: inside its business-day window. */
const ON_THE_DAY = new Date("2026-09-15T10:00:00Z");
/** 21:00 in Lagos, before the contracts' 23:00 cut-off. */
const RECEIVED_AT = "2026-09-15T20:00:00.000Z";
const RUN_TIMEOUT_MS = 60_000;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Caller = ReturnType<(typeof import("./routers"))["appRouter"]["createCaller"]>;
type Job = typeof reconciliationJobs.$inferSelect;

describe.runIf(localDatabase)("when a governed daily control runs against a real database", () => {
  // An id no real tenant uses; everything filed under it is removed after.
  const organizationId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  let db: Db;
  let caller: Caller;
  let userId = 0;
  const channel = { settlement: 0, register: 0 };
  const batch = { settlement: 0, register: 0, decoy: 0 };
  const row = { s1: 0, s2: 0, r1: 0, r9: 0, decoy: 0 };
  const jobIds: number[] = [];

  const insertedId = (result: unknown): number => {
    const id = Number((result as { insertId?: number }).insertId);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("insert returned no id");
    return id;
  };

  async function insertTxn(batchId: number, channelId: number, ref: string, amount: string): Promise<number> {
    const [result] = await db.insert(transactions).values({
      batchId,
      channelId,
      userId,
      organizationId,
      transactionRef: ref,
      amount,
      currency: "NGN",
      transactionDate: ON_THE_DAY,
      debitCredit: "credit",
      status: "unmatched",
    });
    return insertedId(result);
  }

  async function insertBatch(channelId: number, fileName: string): Promise<number> {
    const [result] = await db.insert(uploadBatches).values({
      userId,
      organizationId,
      channelId,
      fileName,
      status: "completed",
    });
    return insertedId(result);
  }

  async function jobsForTenant(): Promise<number> {
    const found = await db
      .select({ id: reconciliationJobs.id })
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.organizationId, organizationId));
    return found.length;
  }

  async function waitForJob(jobId: number): Promise<Job> {
    const deadline = Date.now() + RUN_TIMEOUT_MS - 5_000;
    for (;;) {
      const [job] = await db.select().from(reconciliationJobs).where(eq(reconciliationJobs.id, jobId));
      if (job && (job.status === "completed" || job.status === "failed")) return job;
      if (Date.now() > deadline) throw new Error(`job ${jobId} still ${job?.status ?? "missing"}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;

    await db.insert(organizations).values({
      id: organizationId,
      name: `Governed control proof ${organizationId}`,
      code: `GOVCTL_${organizationId}`,
      segment: "financial_services",
      isDemo: true,
    });
    const [userInsert] = await db.insert(users).values({
      openId: `governed-control-${organizationId}`,
      name: "Governed control operator",
      email: `operator-${organizationId}@example.invalid`,
      loginMethod: "email",
      role: "operations",
      organizationId,
    });
    userId = insertedId(userInsert);
    const [user] = await db.select().from(users).where(eq(users.id, userId));

    for (const side of ["settlement", "register"] as const) {
      const [result] = await db.insert(channels).values({
        name: `Governed ${side} ${organizationId}`,
        code: `GOV_${side.toUpperCase()}_${organizationId}`,
        channelType: "bank_core",
        organizationId,
      });
      channel[side] = insertedId(result);
    }
    batch.settlement = await insertBatch(channel.settlement, "switch-settlement-2026-09-15.csv");
    batch.register = await insertBatch(channel.register, "settlement-register-2026-09-15.csv");
    batch.decoy = await insertBatch(channel.register, "settlement-register-late-import.csv");

    row.s1 = await insertTxn(batch.settlement, channel.settlement, "GOV-S1", "1000.00");
    row.s2 = await insertTxn(batch.settlement, channel.settlement, "GOV-S2", "250.10");
    row.r1 = await insertTxn(batch.register, channel.register, "GOV-S1", "1000.00");
    row.r9 = await insertTxn(batch.register, channel.register, "GOV-R9", "75.00");
    // Same channel, same day, same reference and amount as an approved
    // settlement row — but no manifest approved its batch.
    row.decoy = await insertTxn(batch.decoy, channel.register, "GOV-S2", "250.10");

    const { appRouter } = await import("./routers");
    const ctx: TrpcContext = {
      user,
      req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1" } as unknown as TrpcContext["req"],
      res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
    };
    caller = appRouter.createCaller(ctx);

    const sources = [
      { side: "settlement", role: "settlement", count: 2, total: "1250.10" },
      { side: "register", role: "internal_register", count: 2, total: "1075.00" },
    ] as const;
    for (const source of sources) {
      const contract = await caller.controlEvidence.createSourceContract({
        channelId: channel[source.side],
        sourceKey: `governed-${source.side}-${organizationId}`,
        version: 1,
        role: source.role,
        displayName: `Governed ${source.side}`,
        systemName: "Proof fixture",
        controlPurpose: "Prove a governed run reconciles exactly its approved batches.",
        accountableOwner: "Operations",
        escalationOwner: "Finance",
        deliveryRoute: "sftp",
        timeZone: "Africa/Lagos",
        cutoffMinutes: 23 * 60,
        schemaVersion: "v1",
        controlTotalRequired: true,
        expectedCurrency: "NGN",
        status: "approved",
        approvalReference: "CAB-PROOF-1",
        effectiveAt: "2026-09-01T00:00:00.000Z",
      });
      await caller.controlEvidence.recordBatchManifest({
        sourceContractId: contract.id,
        controlPeriod: PERIOD,
        deliveryIdentity: `governed-${source.side}-${organizationId}-${PERIOD}`,
        uploadBatchId: batch[source.side],
        receivedAt: RECEIVED_AT,
        mappingVersion: "m1",
        reconciliationPolicyVersion: "settlement-ledger-v1",
        schemaState: "accepted",
        duplicateDelivery: "none",
        invalidRowCount: 0,
        expectedRecordCount: source.count,
        expectedMonetaryTotal: source.total,
        expectedCurrency: "NGN",
        receivedRecordCount: source.count,
        receivedMonetaryTotal: source.total,
        receivedCurrency: "NGN",
      });
    }
  }, RUN_TIMEOUT_MS);

  afterAll(async () => {
    if (!db) return;
    // Best-effort and never throwing: a cleanup failure must not hide the result.
    const steps: Array<() => Promise<unknown>> = [
      () => db.delete(matches).where(eq(matches.organizationId, organizationId)),
      () => db.delete(exceptions).where(eq(exceptions.organizationId, organizationId)),
      () =>
        jobIds.length > 0
          ? db.delete(jobProgressEvents).where(inArray(jobProgressEvents.jobId, jobIds))
          : Promise.resolve(),
      () => db.delete(reconciliationJobs).where(eq(reconciliationJobs.organizationId, organizationId)),
      () => db.delete(transactions).where(eq(transactions.organizationId, organizationId)),
      () => db.delete(uploadBatches).where(eq(uploadBatches.organizationId, organizationId)),
      () => db.delete(controlBatchManifests).where(eq(controlBatchManifests.organizationId, organizationId)),
      () => db.delete(controlSourceContracts).where(eq(controlSourceContracts.organizationId, organizationId)),
      () => db.delete(channels).where(eq(channels.organizationId, organizationId)),
      () => db.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId)),
      () => db.delete(auditChainLocks).where(eq(auditChainLocks.chainKey, organizationId)),
      () => db.delete(users).where(eq(users.organizationId, organizationId)),
      () => db.delete(organizations).where(eq(organizations.id, organizationId)),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.error("[governedDailyControl.db.test] cleanup step failed:", error);
      }
    }
  });

  it("should report the approved day admissible in the readiness preflight", async () => {
    const readiness = await caller.controlEvidence.assessReadiness({ controlPeriod: PERIOD });

    expect(readiness.status).toBe("ready_to_reconcile");
    expect(readiness.governedAdmission).toEqual({ admissible: true, reasons: [] });
  });

  describe("when the approved batch no longer agrees with its manifest", () => {
    // Each drift is applied, judged by the real aggregate query, and undone.
    it.each<[string, () => Promise<() => Promise<unknown>>, string[]]>([
      [
        "a row added to the batch after its manifest",
        async () => {
          const late = await insertTxn(batch.settlement, channel.settlement, "GOV-LATE", "10.00");
          return () => db.delete(transactions).where(eq(transactions.id, late));
        },
        ["population_count_mismatch", "population_total_mismatch"],
      ],
      [
        "an approved row one kobo out",
        async () => {
          await db.update(transactions).set({ amount: "250.11" }).where(eq(transactions.id, row.s2));
          return () => db.update(transactions).set({ amount: "250.10" }).where(eq(transactions.id, row.s2));
        },
        ["population_total_mismatch"],
      ],
      [
        "an approved row in another currency",
        async () => {
          await db.update(transactions).set({ currency: "USD" }).where(eq(transactions.id, row.s2));
          return () => db.update(transactions).set({ currency: "NGN" }).where(eq(transactions.id, row.s2));
        },
        ["population_currency_mismatch"],
      ],
      [
        "an approved row already matched",
        async () => {
          await db.update(transactions).set({ status: "matched" }).where(eq(transactions.id, row.s2));
          return () => db.update(transactions).set({ status: "unmatched" }).where(eq(transactions.id, row.s2));
        },
        ["population_not_unmatched"],
      ],
      [
        "an approved row moved to another channel",
        async () => {
          await db.update(transactions).set({ channelId: channel.register }).where(eq(transactions.id, row.s2));
          return () =>
            db.update(transactions).set({ channelId: channel.settlement }).where(eq(transactions.id, row.s2));
        },
        ["population_off_channel"],
      ],
    ])("should name %s in the preflight and admit no run", async (_label, drift, reasons) => {
      const undo = await drift();
      try {
        const readiness = await caller.controlEvidence.assessReadiness({ controlPeriod: PERIOD });
        expect(readiness.governedAdmission).toEqual({ admissible: false, reasons });

        await expect(
          caller.reconciliation.createGovernedDailyControl({ controlPeriod: PERIOD })
        ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
        expect(await jobsForTenant()).toBe(0);
      } finally {
        await undo();
      }
    });
  });

  it(
    "should reconcile exactly the approved batches, leaving another batch's row on the same day untouched",
    async () => {
      const { jobId } = await caller.reconciliation.createGovernedDailyControl({ controlPeriod: PERIOD });
      jobIds.push(jobId);
      const job = await waitForJob(jobId);

      expect(job.status).toBe("completed");
      // The decoy sits inside the run's window, so a date-window run would have
      // loaded it, and matched it to GOV-S2.
      expect(job.dateFrom.getTime()).toBeLessThanOrEqual(ON_THE_DAY.getTime());
      expect(job.dateTo.getTime()).toBeGreaterThanOrEqual(ON_THE_DAY.getTime());
      expect(job).toMatchObject({ totalSourceTxns: 2, totalTargetTxns: 2, matchedCount: 1 });

      const jobMatches = await db
        .select({ source: matches.sourceTransactionId, target: matches.targetTransactionId })
        .from(matches)
        .where(eq(matches.jobId, jobId));
      expect(jobMatches).toEqual([{ source: row.s1, target: row.r1 }]);

      const jobExceptions = await db
        .select({ transactionId: exceptions.transactionId })
        .from(exceptions)
        .where(eq(exceptions.jobId, jobId));
      expect(jobExceptions.map(found => found.transactionId).sort((a, b) => a - b)).toEqual(
        [row.s2, row.r9].sort((a, b) => a - b)
      );

      const [decoy] = await db
        .select({ status: transactions.status })
        .from(transactions)
        .where(eq(transactions.id, row.decoy));
      expect(decoy).toEqual({ status: "unmatched" });

      // The admission event committed with the job.
      const audit = await db
        .select({ entityId: auditLogs.entityId })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            eq(auditLogs.action, "create_governed_daily_control_run")
          )
        );
      expect(audit).toEqual([{ entityId: jobId }]);
    },
    RUN_TIMEOUT_MS
  );

  it(
    "should fail a governed run in the worker, writing nothing, once its approved rows have moved on",
    async () => {
      // The run above matched or excepted every approved row, so the batches no
      // longer agree with their manifests and admission would refuse. This job
      // is queued directly — as one admitted just before the change would be —
      // so it is the worker's own re-check that is under test.
      const [admitted] = await db.select().from(reconciliationJobs).where(eq(reconciliationJobs.id, jobIds[0]));
      expect(admitted, "the end-to-end run must have created its job first").toBeDefined();
      const jobId = await createReconciliationJob({
        userId,
        organizationId,
        name: "Daily control — re-run after the population moved on",
        moduleType: "settlement",
        sourceChannelId: admitted.sourceChannelId,
        targetChannelId: admitted.targetChannelId,
        dateFrom: admitted.dateFrom,
        dateTo: admitted.dateTo,
        amountTolerance: admitted.amountTolerance,
        dateWindowDays: 0,
        engineConfig: admitted.engineConfig,
        status: "pending",
      });
      if (!jobId) throw new Error("no job id");
      jobIds.push(jobId);
      await enqueueReconciliationRun({
        jobId,
        sourceChannelId: admitted.sourceChannelId,
        targetChannelId: admitted.targetChannelId,
        dateFromIso: admitted.dateFrom.toISOString(),
        dateToIso: admitted.dateTo.toISOString(),
        config: { amountTolerance: Number(admitted.amountTolerance), dateWindowDays: 0 },
        userId,
      });

      const job = await waitForJob(jobId);
      expect(job.status).toBe("failed");
      expect(await db.select().from(matches).where(eq(matches.jobId, jobId))).toEqual([]);
      expect(await db.select().from(exceptions).where(eq(exceptions.jobId, jobId))).toEqual([]);
      const [failure] = await db
        .select({ message: jobProgressEvents.message })
        .from(jobProgressEvents)
        .where(and(eq(jobProgressEvents.jobId, jobId), eq(jobProgressEvents.phase, "failed")));
      expect(failure?.message).toContain("population_not_unmatched");
    },
    RUN_TIMEOUT_MS
  );
});
