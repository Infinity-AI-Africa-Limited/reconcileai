/**
 * Multi-channel fan-out — partial-failure behaviour.
 *
 * `createMultiChannel` creates one child reconciliation job per target channel
 * and enqueues each. Creating and enqueueing in the SAME loop iteration made a
 * mid-fan-out enqueue failure genuinely dangerous:
 *
 *   - targets 1..N-1 had already been persisted AND enqueued, so they were
 *     running;
 *   - only target N was marked failed;
 *   - the error carried neither the `multiRunId` nor the ids of the jobs still
 *     in flight, so the caller's only visible recovery was to retry — starting
 *     a SECOND fan-out over the same source, targets and date range, overlapping
 *     the runs already executing.
 *
 * Reconciliation runs are not free of side effects (they write matches,
 * exceptions and transaction statuses), so two overlapping runs over one date
 * range is a correctness problem, not just wasted compute.
 *
 * Asserted against the source because the procedure needs a tRPC context, a
 * database and a live queue to execute, and the local .env points at the shared
 * production TiDB — which no test may touch.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SOURCE = fs.readFileSync(path.join(__dirname, "reconciliation.ts"), "utf8");

function section(startAnchor: string, endAnchor: string): string {
  const start = SOURCE.indexOf(startAnchor);
  expect(start, `anchor missing: ${startAnchor}`).toBeGreaterThan(-1);
  const end = SOURCE.indexOf(endAnchor, start);
  expect(end, `anchor missing after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("when a multi-channel fan-out fails partway through enqueueing", () => {
  const proc = section("createMultiChannel: operationsProcedure", "getMultiRun: protectedProcedure");

  it("should persist every child job before enqueueing any of them", () => {
    // Two phases, in this order. Interleaved, a failure on target N leaves
    // 1..N-1 already running with no record of the rest.
    const createLoop = proc.indexOf("db.createReconciliationJob({");
    const enqueueLoop = proc.indexOf("await enqueueReconciliationRun({");
    expect(createLoop).toBeGreaterThan(-1);
    expect(enqueueLoop).toBeGreaterThan(createLoop);
    // The enqueue must not sit inside the creation loop any more.
    expect(section("// ── Phase 1", "// ── Phase 2")).not.toContain("enqueueReconciliationRun");
  });

  it("should tell the caller which runs are still in flight, and under which multiRunId", () => {
    // Without these the caller cannot observe the partial run at all, and a
    // retry is the only obvious move — which duplicates it.
    // Without these the caller cannot observe the partial run at all, and a
    // retry is the only obvious move — which duplicates it.
    expect(proc).toContain("// PARTIAL FAILURE.");
    const message = section("Failed to queue multi-channel reconciliation processing.", "cause: error,");
    expect(message).toContain("multiRunId ${multiRunId}");
    expect(message).toContain("stillRunning.join");
    expect(message).toContain("rather than retrying");
  });

  it("should fail every job it did not enqueue, not only the one that threw", () => {
    // The rest would otherwise sit "pending" — indistinguishable from queued —
    // until the two-hour boot sweep abandons them.
    expect(proc).toContain("const neverAttempted = created.filter(");
    // The ambiguous job is settled separately, by the database, because it is
    // the only one a worker could be racing us for.
    expect(proc).toContain("abandonUnstartedReconciliationJob(ambiguous, failedAt)");
  });

  it("should record the audit entry even when the fan-out later fails", () => {
    // A partial multi-run still has to be attributable to whoever started it.
    const audit = proc.indexOf('logAudit(ctx.user.id, "create_multichannel_reconciliation"');
    const enqueue = proc.indexOf("await enqueueReconciliationRun({");
    expect(audit).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(audit);
  });

  it("should abandon the never-attempted jobs outright — nothing can be racing them", () => {
    // The loop never reached them, so no queue entry exists anywhere and an
    // unconditional abandonment is correct.
    expect(proc).toContain("const neverAttempted = created.filter(");
    expect(proc).toContain("for (const c of neverAttempted) {");
    expect(proc).toContain("abandonedAt: failedAt");
  });

  it("should let the DATABASE settle the ambiguous job rather than guessing", () => {
    // A rejected enqueue does not prove non-acceptance, so caller and worker
    // can both believe they own the job. abandonUnstartedReconciliationJob only
    // applies while the row is still "pending"; a worker that already claimed
    // it has moved it to "running" and wins instead.
    expect(proc).toContain("const abandonedAmbiguous = await db.abandonUnstartedReconciliationJob(ambiguous, failedAt);");
  });

  it("should report the ambiguous job as RUNNING when the worker won the race", () => {
    // Reporting it as failed while it proceeds is the precise defect this
    // resolution exists to prevent.
    expect(proc).toContain("const stillRunning = abandonedAmbiguous ? enqueued : [...enqueued, ambiguous];");
    expect(proc).toContain("had already been picked up by a worker and is running");
  });

});

describe("when a single-channel run fails to enqueue", () => {
  const proc = section("create: operationsProcedure", "createMultiChannel: operationsProcedure");

  it("should use the same contended abandonment, not an unconditional one", () => {
    // Same ambiguity, same resolution — the class, not just the multi-channel
    // instance that was flagged.
    expect(proc).toContain("await db.abandonUnstartedReconciliationJob(jobId, new Date());");
    expect(proc).toContain("had already been picked up by a worker and is running");
  });
});
