/**
 * Durable reconciliation queue — Unit Tests
 *
 * Uses injected fakes ONLY (makeRunHandler deps) — the local .env points at
 * the live shared TiDB, so nothing here may touch the real database.
 */
import { describe, it, expect } from "vitest";
import { makeRunHandler, type RunHandlerDeps, type ReconciliationRunPayload } from "./reconciliationQueue";

const PAYLOAD: ReconciliationRunPayload = {
  jobId: 7,
  sourceChannelId: 1,
  targetChannelId: 2,
  dateFromIso: "2026-06-01T00:00:00.000Z",
  dateToIso: "2026-06-30T00:00:00.000Z",
  config: { amountTolerance: 0.005, dateWindowDays: 3 },
  userId: 99,
};

function makeDeps(overrides: Partial<RunHandlerDeps> & { statuses?: string[] } = {}) {
  const calls = { reset: 0, run: 0, runnerArgs: [] as unknown[] };
  const statuses = overrides.statuses ?? ["pending", "completed"];
  let statusIdx = 0;
  const deps: RunHandlerDeps = {
    loadJobStatus: overrides.loadJobStatus ?? (async () => statuses[Math.min(statusIdx++, statuses.length - 1)]),
    resetArtifacts: overrides.resetArtifacts ?? (async () => { calls.reset += 1; }),
    getRunner: overrides.getRunner ?? (() => async (...args: unknown[]) => {
      calls.run += 1;
      calls.runnerArgs = args;
    }),
  };
  return { deps, calls };
}

describe("makeRunHandler", () => {
  it("resets artifacts, runs the runner with deserialized dates, and finishes cleanly on success", async () => {
    const { deps, calls } = makeDeps({ statuses: ["pending", "completed"] });
    const handle = makeRunHandler(deps);
    await handle({ data: PAYLOAD, attempt: 1 });
    expect(calls.reset).toBe(1);
    expect(calls.run).toBe(1);
    expect(calls.runnerArgs[0]).toBe(7);
    expect(calls.runnerArgs[3]).toBeInstanceOf(Date);
    expect((calls.runnerArgs[3] as Date).toISOString()).toBe(PAYLOAD.dateFromIso);
  });

  it("skips completed jobs entirely (idempotency guard)", async () => {
    const { deps, calls } = makeDeps({ statuses: ["completed"] });
    await makeRunHandler(deps)({ data: PAYLOAD, attempt: 2 });
    expect(calls.reset).toBe(0);
    expect(calls.run).toBe(0);
  });

  it("skips deleted jobs (status null)", async () => {
    const { deps, calls } = makeDeps({ loadJobStatus: async () => null });
    await makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 });
    expect(calls.run).toBe(0);
  });

  it("throws to trigger a retry when the runner left the job failed (non-final attempt)", async () => {
    const { deps } = makeDeps({ statuses: ["running", "failed"] });
    await expect(makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 })).rejects.toThrow(/retrying/);
  });

  it("does NOT throw on the final attempt — the job stays failed without queue noise", async () => {
    const { deps } = makeDeps({ statuses: ["running", "failed"] });
    await expect(makeRunHandler(deps)({ data: PAYLOAD, attempt: 3 })).resolves.toBeUndefined();
  });

  it("throws when no runner is registered", async () => {
    const { deps } = makeDeps({ getRunner: () => null });
    await expect(makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 })).rejects.toThrow(/not registered/);
  });

  it("resets artifacts on every attempt, including retries", async () => {
    const { deps, calls } = makeDeps({ statuses: ["failed", "completed"] });
    await makeRunHandler(deps)({ data: PAYLOAD, attempt: 2 });
    expect(calls.reset).toBe(1);
    expect(calls.run).toBe(1);
  });
});
