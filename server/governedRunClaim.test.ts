/**
 * The claim that keeps a governed control single-writer.
 *
 * `loadGovernedPopulation` proves the approved batches still match their
 * manifests and reads their `unmatched` rows — then its transaction ENDS, long
 * before the worker saves any match. So nothing about that read stops a second
 * run reading the same rows. Two Start requests, or two instances behind the
 * same queue, could each create a job and each write matches for the same
 * transactions. Duplicate matches are the failure this platform can least
 * afford, and nothing downstream reports them.
 *
 * The claim therefore has to happen where the job is created, under the tenant
 * row lock `insertJobUnderTenantLock` already takes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: vi.fn(async () => state.db),
}));

import { scriptedDb } from "./connectors/shopify/scriptedDb.testkit";
import {
  assertGovernedBatchesNotInFlight,
  GovernedRunInFlightError,
} from "./controlRunAdmission";
import { insertJobUnderTenantLock } from "./db";

const organizationId = 42;
const JOBS = "reconciliation_jobs";

const sides = {
  settlement: { channelId: 11, manifestId: 701, uploadBatchId: 901 },
  register: { channelId: 12, manifestId: 702, uploadBatchId: 902 },
};

/** A job's stored snapshot, as the governed procedure writes it. */
function governedConfig(settlementBatch: number, registerBatch: number): string {
  return JSON.stringify({
    amountTolerance: 0.005,
    dateWindowDays: 1,
    governedDailyControl: {
      controlPeriod: "2026-10-09",
      settlement: { channelId: 11, manifestId: 701, uploadBatchId: settlementBatch },
      register: { channelId: 12, manifestId: 702, uploadBatchId: registerBatch },
    },
  });
}

function dbWith(jobs: unknown[]) {
  const fake = scriptedDb({ select: { [JOBS]: [jobs] } });
  state.db = fake.db;
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
});

describe("when no run is in flight", () => {
  it("should allow the admission", async () => {
    const fake = dbWith([]);

    await expect(
      assertGovernedBatchesNotInFlight(fake.db as never, organizationId, sides)
    ).resolves.toBeUndefined();
  });

  it("should ask only about this tenant, and only about active runs", async () => {
    // Scoped to the tenant because another tenant's run says nothing about
    // these batches; scoped to the active statuses because a completed or
    // failed run has released them and the day must stay re-runnable.
    const fake = dbWith([]);

    await assertGovernedBatchesNotInFlight(fake.db as never, organizationId, sides);

    const query = fake.ops.find(op => op.kind === "select" && op.table === JOBS);
    expect(query?.where?.params).toEqual(
      expect.arrayContaining([organizationId, "pending", "running"])
    );
    expect(query?.where?.params).not.toContain("completed");
    expect(query?.where?.params).not.toContain("failed");
  });
});

describe("when a run already holds one of the approved batches", () => {
  it("should refuse, naming the run that holds it", async () => {
    const fake = dbWith([{ id: 488, engineConfig: governedConfig(901, 902) }]);

    await expect(
      assertGovernedBatchesNotInFlight(fake.db as never, organizationId, sides)
    ).rejects.toBeInstanceOf(GovernedRunInFlightError);
  });

  it("should refuse on the register side alone, not just the settlement side", async () => {
    // Either batch being consumed is enough: the two runs would still both
    // write matches over one of the two populations.
    const fake = dbWith([{ id: 489, engineConfig: governedConfig(555, 902) }]);

    await expect(
      assertGovernedBatchesNotInFlight(fake.db as never, organizationId, sides)
    ).rejects.toMatchObject({ jobId: 489 });
  });

  it("should refuse a run admitted for another period that resolved to the same batch", async () => {
    // Keyed on the batch, not the control period, because the batch is the
    // resource two runs would actually collide over.
    const otherPeriod = JSON.stringify({
      governedDailyControl: {
        controlPeriod: "2026-09-30",
        settlement: { channelId: 11, manifestId: 777, uploadBatchId: 901 },
        register: { channelId: 12, manifestId: 778, uploadBatchId: 999 },
      },
    });
    const fake = dbWith([{ id: 490, engineConfig: otherPeriod }]);

    await expect(
      assertGovernedBatchesNotInFlight(fake.db as never, organizationId, sides)
    ).rejects.toMatchObject({ jobId: 490 });
  });
});

describe("when the tenant's in-flight runs are not governed ones", () => {
  it("should allow the admission", async () => {
    // An ordinary date-window run carries no governed snapshot. It is not
    // claimed by this check — see the note in the module about the residual
    // overlap between a governed run and an ad-hoc one.
    const fake = dbWith([
      { id: 491, engineConfig: JSON.stringify({ amountTolerance: 0.01 }) },
      { id: 492, engineConfig: null },
    ]);

    await expect(
      assertGovernedBatchesNotInFlight(fake.db as never, organizationId, sides)
    ).resolves.toBeUndefined();
  });

  it("should not let one unreadable snapshot block an unrelated control", async () => {
    // This reads every active job in the tenant, so a single malformed row
    // must not be able to stop a different day from starting. The run that
    // owns an unreadable config is refused by `loadGovernedPopulation`, where
    // it belongs.
    const fake = dbWith([
      { id: 493, engineConfig: "{not json" },
      { id: 494, engineConfig: JSON.stringify({ governedDailyControl: "nonsense" }) },
    ]);

    await expect(
      assertGovernedBatchesNotInFlight(fake.db as never, organizationId, sides)
    ).resolves.toBeUndefined();
  });
});

/**
 * The seam the claim rides on.
 *
 * These cases exist because removing `options.beforeInsert?.(tx)` from
 * `insertJobUnderTenantLock` broke nothing: the router's tests mock
 * `createReconciliationJob` and invoke the hook themselves, so every one of
 * them stayed green while the real insert stopped claiming anything. That is
 * the whole defect in miniature — the claim never runs in production and
 * nothing says so.
 */
describe("when a job insert carries a precondition hook", () => {
  const job = {
    userId: 1,
    organizationId,
    name: "Daily control",
    moduleType: "settlement" as const,
    sourceChannelId: 11,
    targetChannelId: 12,
    status: "pending" as const,
  };

  function insertDb() {
    const fake = scriptedDb({
      select: { organizations: [[{ id: organizationId }]] },
      insert: { reconciliation_jobs: [1] },
    });
    return fake;
  }

  it("should run the hook before the job row is inserted", async () => {
    const fake = insertDb();
    let insertsSeenByHook = -1;

    await insertJobUnderTenantLock(fake.db as never, job as never, {
      beforeInsert: async () => {
        insertsSeenByHook = fake.ops.filter(op => op.kind === "insert").length;
      },
    });

    // Zero, not "an insert happened earlier in the list": a claim checked
    // after the row exists would admit the second run and then refuse it.
    expect(insertsSeenByHook).toBe(0);
    expect(fake.ops.some(op => op.kind === "insert")).toBe(true);
  });

  it("should already hold the tenant row lock when the hook runs", async () => {
    // The lock is the entire reason this is atomic. Without it two callers
    // both pass the check and both insert.
    const fake = insertDb();
    let lockedReadsSeenByHook = 0;

    await insertJobUnderTenantLock(fake.db as never, job as never, {
      beforeInsert: async () => {
        lockedReadsSeenByHook = fake.ops.filter(
          op => op.kind === "select" && op.table === "organizations" && op.locked
        ).length;
      },
    });

    expect(lockedReadsSeenByHook).toBe(1);
  });

  it("should insert nothing when the hook refuses", async () => {
    const fake = insertDb();

    await expect(
      insertJobUnderTenantLock(fake.db as never, job as never, {
        beforeInsert: async () => {
          throw new GovernedRunInFlightError(488);
        },
      })
    ).rejects.toBeInstanceOf(GovernedRunInFlightError);

    expect(fake.committed().some(op => op.kind === "insert")).toBe(false);
  });

  it("should still insert when no hook is supplied", async () => {
    // Every other caller of this function passes no hook; the seam must not
    // have made the precondition mandatory.
    const fake = insertDb();

    await insertJobUnderTenantLock(fake.db as never, job as never, {});

    expect(fake.ops.some(op => op.kind === "insert")).toBe(true);
  });
});
