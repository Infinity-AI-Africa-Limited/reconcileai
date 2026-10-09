/**
 * The boot sweep's queue cleanup when Redis does not answer.
 *
 * The sweep marks stuck runs abandoned, then removes their queue entries one by
 * one. The rows are the guard; the entries are only capacity. So a removal
 * Redis does not answer must neither hold the sweep nor make it wait out the
 * same deadline once per entry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "./connectors/shopify/scriptedDb.testkit";

const state = vi.hoisted(() => ({
  db: null as unknown,
  remove: null as null | ((name: string) => Promise<void>),
}));

vi.mock("./db", () => ({ getDb: async () => state.db }));
vi.mock("./jobQueue", async importOriginal => ({
  ...(await importOriginal<typeof import("./jobQueue")>()),
  createQueue: vi.fn(async () => ({
    backend: "bullmq",
    enqueue: async () => {},
    stats: async () => ({ backend: "bullmq", durable: true }),
    close: async () => {},
    remove: (name: string) => state.remove!(name),
  })),
}));

import { QueueOperationTimeoutError } from "./jobQueue";
import { recoverStuckReconciliationJobs } from "./reconciliationQueue";

const JOBS = "reconciliation_jobs";
const stuck = [{ id: 1 }, { id: 2 }, { id: 3 }];

function sweepDb() {
  // The stuck read, then the abandoned read; the update abandons all three.
  return scriptedDb({ select: { [JOBS]: [stuck, stuck] }, update: { [JOBS]: [3] } }).db;
}

afterEach(() => vi.restoreAllMocks());

describe("when Redis does not answer the sweep's first removal", () => {
  it("should stop removing, since every further removal would wait out the same deadline", async () => {
    state.db = sweepDb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.remove = vi.fn(async () => {
      throw new QueueOperationTimeoutError("reconciliation-runs", "remove", 3_000);
    });

    const result = await recoverStuckReconciliationJobs();

    // The rows are still abandoned: that is the guard, and it stands.
    expect(result).toEqual({ recovered: 3 });
    expect(state.remove).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not remove queue entry job-1"),
      expect.anything()
    );
  });
});

describe("when one removal fails for another reason", () => {
  it("should still try the remaining entries", async () => {
    // An entry that is currently active cannot be removed; the next one can.
    state.db = sweepDb();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.remove = vi
      .fn<(name: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Job job-1 could not be removed because it is locked by another worker"))
      .mockResolvedValue(undefined);

    const result = await recoverStuckReconciliationJobs();

    expect(result).toEqual({ recovered: 3 });
    expect(state.remove).toHaveBeenCalledTimes(3);
  });
});
