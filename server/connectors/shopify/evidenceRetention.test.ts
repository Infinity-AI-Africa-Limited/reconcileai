import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "./scriptedDb.testkit";
import {
  deletableAfterPairing,
  purgeExpiredShopifyScopeAEvidence,
  resetShopifyScopeAEvidenceRetentionScheduleForTest,
  runShopifyScopeAEvidenceRetentionIfDue,
  scopeAEvidenceHolds,
  SHOPIFY_SCOPE_A_RETENTION_CONTINUE_INTERVAL_MS,
  SHOPIFY_SCOPE_A_RETENTION_RETRY_INTERVAL_MS,
  SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS,
  shopifyScopeAEvidenceRetentionCutoff,
} from "./evidenceRetention";

const STORE_ID = 41;
const ORG_ID = 42;
const NOW = new Date("2026-10-16T12:00:00.000Z");
const RECEIPTS = "shopify_evidence_retention_receipts";
const STORES = "shopify_connector_stores";
const TRANSACTIONS = "transactions";
const PRIVACY_REQUESTS = "shopify_privacy_requests";

const dialect = new MySqlDialect();
const render = (condition: Parameters<MySqlDialect["sqlToQuery"]>[0]) => dialect.sqlToQuery(condition);

/**
 * One expired, unlinked transaction (id 801) that the SQL filter admitted.
 * `locked` is what the batch's second pass reads back under its locks.
 */
function oneCandidate(locked: { exceptions?: unknown[]; workflows?: unknown[]; anomalies?: unknown[] } = {}) {
  return scriptedDb({
    standing: {
      organizations: [{ deletionState: "active" }],
      [STORES]: [{ id: STORE_ID, organizationId: ORG_ID, status: "active" }],
      [RECEIPTS]: [],
      [PRIVACY_REQUESTS]: [],
      [TRANSACTIONS]: [],
      matches: [],
      exceptions: locked.exceptions ?? [],
      exception_workflows: locked.workflows ?? [],
      anomaly_scores: locked.anomalies ?? [],
      audit_chain_locks: [],
      audit_logs: [],
    },
    // The batch's seeds, then the rows whose matchId points at them.
    select: { [TRANSACTIONS]: [[{ id: 801, matchId: null }], []] },
  });
}

const sweep = (fake: ReturnType<typeof scriptedDb>, audit = vi.fn(async () => undefined)) =>
  purgeExpiredShopifyScopeAEvidence({ db: fake.db as never, now: () => NOW, audit: audit as never });

describe("when Shopify Scope A evidence reaches its retention cutoff", () => {
  beforeEach(() => resetShopifyScopeAEvidenceRetentionScheduleForTest());

  it("should calculate the selected 90-day cutoff exactly", () => {
    expect(shopifyScopeAEvidenceRetentionCutoff(NOW)).toEqual(new Date("2026-07-18T12:00:00.000Z"));
  });

  describe("when deciding which linked transactions may go", () => {
    it("should delete a pair only when both of its halves are eligible", () => {
      expect(deletableAfterPairing({ eligible: [1, 2], held: [], links: [[1, 2]] })).toEqual([1, 2]);
      expect(deletableAfterPairing({ eligible: [1], held: [2], links: [[1, 2]] })).toEqual([]);
    });

    it("should keep a whole chain when any transaction in it is held", () => {
      // 1–2–3 is one group: 3 is held, so 1 is kept although it touches only 2.
      expect(
        deletableAfterPairing({ eligible: [1, 2, 4], held: [3], links: [[1, 2], [2, 3]] })
      ).toEqual([4]);
    });

    it("should keep a group whose linked transaction nobody classified", () => {
      expect(deletableAfterPairing({ eligible: [1], held: [], links: [[1, 99]] })).toEqual([]);
    });

    it("should let a held mark win over eligibility for the same transaction", () => {
      expect(deletableAfterPairing({ eligible: [1, 2], held: [2], links: [] })).toEqual([1]);
    });
  });

  describe("when deciding which records still hold their evidence", () => {
    const holds = scopeAEvidenceHolds(ORG_ID);

    it("should hold for an exception or a governed attempt that is not in a finished state", () => {
      const { sql, params } = render(holds.investigation);
      expect(sql).toMatch(/`exceptions`\.`status` not in/i);
      expect(sql).toMatch(/`exception_workflows`\.`status` <>/i);
      expect(params).toEqual(expect.arrayContaining(["resolved", "dismissed", "closed"]));
      expect(params).not.toContain("open");
    });

    it("should hold for a match on either side until it is confirmed or rejected", () => {
      const { sql, params } = render(holds.matchReview);
      expect(sql).toMatch(/`matches`\.`sourceTransactionId` = `transactions`\.`id`/);
      expect(sql).toMatch(/`matches`\.`targetTransactionId` = `transactions`\.`id`/);
      expect(sql).toMatch(/`matches`\.`status` not in/i);
      expect(params).toEqual(expect.arrayContaining(["confirmed", "rejected"]));
      expect(params).not.toContain("pending_review");
    });

    it("should hold for a flagged anomaly until it is reviewed", () => {
      const { sql, params } = render(holds.anomalyReview);
      expect(sql).toMatch(/`anomaly_scores`\.`isFlagged` = /);
      expect(sql).toMatch(/`anomaly_scores`\.`reviewStatus` not in/i);
      expect(params).toEqual(expect.arrayContaining(["false_positive", "confirmed", "resolved"]));
      expect(params).not.toContain("pending");
    });

    it("should hold for any run of the tenant that reads the row's channel and has not finished", () => {
      const { sql, params } = render(holds.queuedRun);
      expect(sql).toMatch(/`reconciliation_jobs`\.`organizationId` = /);
      expect(sql).toMatch(/`reconciliation_jobs`\.`status` not in/i);
      expect(sql).toMatch(/`reconciliation_jobs`\.`sourceChannelId` = `transactions`\.`channelId`/);
      expect(sql).toMatch(/`reconciliation_jobs`\.`targetChannelId` = `transactions`\.`channelId`/);
      expect(params).toEqual(expect.arrayContaining([ORG_ID, "completed", "failed", "cancelled"]));
      expect(params).not.toContain("pending");
    });

    it("should hold for an upload a governed control manifest names", () => {
      const { sql, params } = render(holds.governedControl);
      expect(sql).toMatch(/`control_batch_manifests`\.`uploadBatchId` = `transactions`\.`batchId`/);
      expect(params).toContain(ORG_ID);
    });
  });

  describe("when a batch re-checks its candidates under lock", () => {
    it("should delete a candidate whose locked records are all finished", async () => {
      const fake = oneCandidate({
        anomalies: [{ id: 5, organizationId: ORG_ID, transactionId: 801, isFlagged: true, reviewStatus: "resolved" }],
      });
      const report = await sweep(fake);
      expect(report.storesCompleted).toBe(1);
      expect(fake.writes("delete", TRANSACTIONS)).toHaveLength(1);
      expect(fake.writes("delete", "anomaly_scores")).toHaveLength(1);
    });

    it("should keep a candidate whose anomaly was flagged for review after the filter ran", async () => {
      const fake = oneCandidate({
        anomalies: [{ id: 5, organizationId: ORG_ID, transactionId: 801, isFlagged: true, reviewStatus: "pending" }],
      });
      await sweep(fake);
      expect(fake.writes("delete", TRANSACTIONS)).toEqual([]);
      expect(fake.writes("delete", "anomaly_scores")).toEqual([]);
    });

    it("should keep a candidate whose exception was reopened after the filter ran", async () => {
      const fake = oneCandidate({
        exceptions: [{ id: 7, organizationId: ORG_ID, transactionId: 801, status: "open" }],
      });
      await sweep(fake);
      expect(fake.writes("delete", TRANSACTIONS)).toEqual([]);
      expect(fake.writes("delete", "exceptions")).toEqual([]);
    });

    it("should keep a candidate whose governed attempt is still open", async () => {
      const fake = oneCandidate({
        exceptions: [{ id: 7, organizationId: ORG_ID, transactionId: 801, status: "resolved" }],
        workflows: [{ id: 9, organizationId: ORG_ID, exceptionId: 7, status: "decision_recorded" }],
      });
      await sweep(fake);
      expect(fake.writes("delete", TRANSACTIONS)).toEqual([]);
    });

    it("should record each batch's deletions in an audit entry written in the batch's own transaction", async () => {
      const fake = oneCandidate();
      const audit = vi.fn(async () => undefined);
      await sweep(fake, audit);
      const calls = audit.mock.calls as unknown as Array<[{ action: string }, unknown]>;
      const batchAudit = calls.find(([entry]) => entry.action === "shopify_scope_a_retention_batch");
      expect(batchAudit?.[0]).toMatchObject({ details: { phase: "evidence", transactionsDeleted: 1 } });
      // The second argument is the transaction handle: the entry commits with the delete.
      expect(batchAudit?.[1]).toBeDefined();
      const deleteOp = fake.writes("delete", TRANSACTIONS)[0];
      expect(deleteOp?.txId).not.toBeNull();
    });
  });

  it("should leave every transaction while a customer data request for the store is unanswered", async () => {
    const held = scriptedDb({
      standing: {
        organizations: [{ deletionState: "active" }],
        [STORES]: [{ id: STORE_ID, organizationId: ORG_ID, status: "active" }],
        [RECEIPTS]: [],
        [PRIVACY_REQUESTS]: [{ id: 3 }],
        [TRANSACTIONS]: [],
        audit_chain_locks: [],
        audit_logs: [],
      },
    });
    const report = await sweep(held);
    expect(report.storesCompleted).toBe(1);
    // The batch never selected candidates: the privacy read ended it first.
    expect(held.ops.some(op => op.kind === "select" && op.table === TRANSACTIONS && op.locked)).toBe(false);
    expect(held.writes("delete", TRANSACTIONS)).toEqual([]);
    const privacyRead = held.ops.find(op => op.kind === "select" && op.table === PRIVACY_REQUESTS && op.locked);
    expect(privacyRead?.where?.params).toEqual(expect.arrayContaining(["customers/data_request", "completed"]));
    expect(privacyRead?.where?.sql).toMatch(/`status` not in/i);
  });

  it("should skip a fenced tenant without writing a receipt", async () => {
    const fake = scriptedDb({
      standing: {
        [STORES]: [{ id: STORE_ID, organizationId: ORG_ID }],
        // The candidate query admitted the tenant; the lock then sees redaction.
        organizations: [{ deletionState: "redacting" }],
      },
    });
    const report = await sweep(fake);
    expect(report).toMatchObject({ storesConsidered: 1, storesSkipped: 1, storesCompleted: 0 });
    expect(fake.writes("insert", RECEIPTS)).toEqual([]);
    expect(fake.committed().filter(op => op.kind === "delete")).toEqual([]);
  });

  it("should write an aggregate-only receipt when a store completes", async () => {
    const fake = oneCandidate();
    const audit = vi.fn(async () => undefined);
    await sweep(fake, audit);
    const receipt = fake.writes("insert", RECEIPTS)[0];
    expect(receipt?.data).toMatchObject({
      organizationId: ORG_ID,
      storeId: STORE_ID,
      cutoffAt: new Date("2026-07-18T12:00:00.000Z"),
      completedAt: NOW,
    });
    const summary = (receipt?.data as { summary?: Record<string, unknown> })?.summary;
    expect(summary).toMatchObject({ transactionsDeleted: 1 });
    expect(JSON.stringify(summary)).not.toMatch(/order|domain|shop|amount|reference|url|user/i);
    expect(receipt?.txId).not.toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "shopify_scope_a_retention_sweep" }),
      expect.anything()
    );
  });

  describe("when scheduling the sweep", () => {
    it("should run at most daily after a sweep that finished", async () => {
      const first = await runShopifyScopeAEvidenceRetentionIfDue({
        db: oneCandidate().db as never,
        now: () => NOW,
        audit: vi.fn(async () => undefined) as never,
      });
      expect(first.ran).toBe(true);
      expect(first.retryAt).toEqual(new Date(NOW.getTime() + SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS));

      const sameDay = await runShopifyScopeAEvidenceRetentionIfDue({
        db: oneCandidate().db as never,
        now: () => new Date(NOW.getTime() + 1_000),
      });
      expect(sameDay).toEqual({ ran: false, retryAt: first.retryAt });
    });

    it("should retry hourly when a store's sweep failed", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const failing = scriptedDb({
        standing: { [STORES]: [{ id: STORE_ID, organizationId: ORG_ID }] },
        select: { organizations: [new Error("database unavailable")] },
      });
      const partial = await runShopifyScopeAEvidenceRetentionIfDue({ db: failing.db as never, now: () => NOW });
      expect(partial.report?.storesFailed).toBe(1);
      expect(partial.retryAt).toEqual(new Date(NOW.getTime() + SHOPIFY_SCOPE_A_RETENTION_RETRY_INTERVAL_MS));
      expect(error.mock.calls[0]?.[1]).toMatchObject({ code: "shopify_scope_a_retention_sweep_failed" });
      error.mockRestore();
    });

    it("should back off for an hour when the sweep fails before reaching any store", async () => {
      const unreadable = scriptedDb({ select: { [STORES]: [new Error("database unavailable")] } });
      await expect(
        runShopifyScopeAEvidenceRetentionIfDue({ db: unreadable.db as never, now: () => NOW })
      ).rejects.toThrow("database unavailable");

      // The next privacy-loop tick, 30 seconds later, must not run it again.
      const nextTick = await runShopifyScopeAEvidenceRetentionIfDue({
        db: oneCandidate().db as never,
        now: () => new Date(NOW.getTime() + 30_000),
      });
      expect(nextTick).toEqual({
        ran: false,
        retryAt: new Date(NOW.getTime() + SHOPIFY_SCOPE_A_RETENTION_RETRY_INTERVAL_MS),
      });
    });

    it("should continue within a minute when the time budget stopped the sweep", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await runShopifyScopeAEvidenceRetentionIfDue({
        db: oneCandidate().db as never,
        now: () => NOW,
        budgetMs: 0,
      });
      expect(result.report).toMatchObject({ storesIncomplete: 1, transactionsDeleted: 0 });
      expect(result.retryAt).toEqual(new Date(NOW.getTime() + SHOPIFY_SCOPE_A_RETENTION_CONTINUE_INTERVAL_MS));
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ code: "shopify_scope_a_retention_incomplete" });
      warn.mockRestore();
    });
  });
});
