import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "./scriptedDb.testkit";
import {
  deletableAfterPairing,
  purgeExpiredShopifyScopeAEvidence,
  resetShopifyScopeAEvidenceRetentionScheduleForTest,
  runShopifyScopeAEvidenceRetentionIfDue,
  scopeAEvidenceHolds,
  sumBatchDeletions,
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
function oneCandidate(
  locked: { exceptions?: unknown[]; workflows?: unknown[]; anomalies?: unknown[]; auditTrail?: unknown[] } = {}
) {
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
      // What the receipt reads back: the batch entries the audit wrote. The
      // audit itself is a stub here, so a test that needs them scripts them.
      audit_logs: locked.auditTrail ?? [],
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

  it("should skip a store another sweep finished today, rechecked under the store lock", async () => {
    // The store list leaves out stores with a receipt today; this is the race
    // where a receipt landed after the list was read.
    const fake = scriptedDb({
      standing: {
        organizations: [{ deletionState: "active" }],
        [STORES]: [{ id: STORE_ID, organizationId: ORG_ID, status: "active" }],
        [RECEIPTS]: [{ completedAt: new Date(NOW.getTime() - 60 * 60 * 1_000) }],
      },
    });
    const report = await sweep(fake);
    expect(report).toMatchObject({ storesSkipped: 1, storesCompleted: 0 });
    expect(fake.writes("insert", RECEIPTS)).toEqual([]);
    expect(fake.committed().filter(op => op.kind === "delete")).toEqual([]);
  });

  it("should leave stores finished today out of the list it spends its budget on", async () => {
    const fake = scriptedDb();
    await sweep(fake);
    const list = fake.ops.find(op => op.kind === "select" && op.table === STORES);
    expect(list?.where?.sql).toMatch(
      /not exists \(select .* from `shopify_evidence_retention_receipts` where .*`shopify_evidence_retention_receipts`\.`completedAt` > /i
    );
    // A day before now, as the driver will receive it.
    const params = (list?.where?.params ?? []).map(value => (value instanceof Date ? value.toISOString() : String(value)));
    expect(params.some(value => /^2026-10-15[ T]12:00:00/.test(value))).toBe(true);
  });

  describe("when a receipt adds up the batches that came before it", () => {
    it("should count only this store's entries and only their deletion counts", () => {
      expect(
        sumBatchDeletions(
          [
            { storeId: STORE_ID, transactionsDeleted: 2, matchesDeleted: 1, phase: "evidence" },
            { storeId: STORE_ID, transactionsDeleted: 3, deferredPairedTransactions: 9 },
            { storeId: STORE_ID + 1, transactionsDeleted: 100 },
            JSON.stringify({ storeId: STORE_ID, jobsDeleted: 4 }),
          ],
          STORE_ID
        )
      ).toEqual({ transactionsDeleted: 5, matchesDeleted: 1, jobsDeleted: 4 });
    });

    it("should ignore entries it cannot trust instead of failing the receipt", () => {
      expect(
        sumBatchDeletions(
          [
            null,
            "not json",
            { storeId: String(STORE_ID), transactionsDeleted: 1 },
            { storeId: STORE_ID, transactionsDeleted: -4, matchesDeleted: Number.NaN, jobsDeleted: "7" },
          ],
          STORE_ID
        )
      ).toEqual({});
    });
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
    const fake = oneCandidate({
      auditTrail: [{ details: { phase: "evidence", storeId: STORE_ID, transactionsDeleted: 1 } }],
    });
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

  it("should take the tenant's audit-chain lock before it reads any audit row under lock", async () => {
    // Every audit write takes the chain lock and then locks the newest row. A
    // receipt that locked rows first could hold that row while waiting for the
    // chain: each side holding what the other needs.
    const fake = oneCandidate({
      auditTrail: [{ details: { phase: "evidence", storeId: STORE_ID, transactionsDeleted: 1 } }],
    });
    await sweep(fake);
    const receiptTx = fake.writes("insert", RECEIPTS)[0]?.txId;
    expect(receiptTx).toBeDefined();
    const inReceiptTx = fake.ops.filter(op => op.txId === receiptTx && op.kind === "select" && op.locked);
    const chain = inReceiptTx.findIndex(op => op.table === "audit_chain_locks");
    const firstAuditRow = inReceiptTx.findIndex(op => op.table === "audit_logs");
    expect(chain).toBeGreaterThanOrEqual(0);
    expect(firstAuditRow).toBeGreaterThan(chain);
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

describe("when unresolved customer privacy requests hold normal evidence retention", () => {
  beforeEach(() => resetShopifyScopeAEvidenceRetentionScheduleForTest());

  it.each([
    ["customers/data_request", STORE_ID],
    ["customers/redact", STORE_ID],
    ["customers/redact", null],
  ])("should keep evidence for %s in store scope %s under the locked recheck and aggregate query", async (topic, storeId) => {
    const fake = scriptedDb({
      standing: {
        organizations: [{ deletionState: "active" }],
        [STORES]: [{ id: STORE_ID, organizationId: ORG_ID, status: "active" }],
        [RECEIPTS]: [], [TRANSACTIONS]: [], [PRIVACY_REQUESTS]: [],
        audit_chain_locks: [], audit_logs: [],
      },
      select: {
        [PRIVACY_REQUESTS]: [
          [{ id: 3, topic, storeId, organizationId: ORG_ID, status: "manual_review" }],
          [{ id: 3, topic, storeId, organizationId: ORG_ID, status: "manual_review" }],
          [{ n: 1 }],
        ],
      },
    });

    const report = await sweep(fake);

    expect(fake.committed().filter((op) => op.kind === "delete")).toEqual([]);
    expect(fake.ops.some((op) => op.kind === "select" && op.table === TRANSACTIONS && op.locked)).toBe(false);
    expect(report.deferredPrivacyRequests).toBe(1);
    const privacyReads = fake.ops.filter((op) => op.kind === "select" && op.table === PRIVACY_REQUESTS);
    expect(privacyReads).toHaveLength(3);
    expect(privacyReads[0]?.locked).toBe(true);
    expect(privacyReads[0]?.limit).toBe(1);
    expect(privacyReads[1]?.locked).toBe(true);
    expect(privacyReads[0]?.where).toEqual(privacyReads[2]?.where);
    expect(privacyReads[0]?.where?.params).toEqual([
      ORG_ID, STORE_ID, "customers/data_request", "customers/redact", "completed",
    ]);
    // Exact tenant AND (same store OR unassigned store) isolates even null-store
    // requests: another tenant or a different non-null store cannot hold these rows.
    expect(privacyReads[0]?.where?.sql).toMatch(
      /`shopify_privacy_requests`\.`organizationId` = \? and \(`shopify_privacy_requests`\.`storeId` = \? or `shopify_privacy_requests`\.`storeId` is null\)/i,
    );
    expect(privacyReads[0]?.where?.sql).toMatch(/`topic` in \(\?, \?\).*`status` not in \(\?\)/i);
    expect(privacyReads[0]?.where?.params).not.toContain("manual_review");
  });

  it("should leave completed requests outside the hold and preserve finished-evidence deletion", async () => {
    // Script the SQL-filtered result: completed is the only excluded status.
    // This mock does not execute SQL; the exact rendered predicate is pinned too.
    const fake = oneCandidate();

    const report = await sweep(fake);

    expect(report.storesCompleted).toBe(1);
    expect(fake.writes("delete", TRANSACTIONS)).toHaveLength(1);
    const privacyRead = fake.ops.find((op) => op.kind === "select" && op.table === PRIVACY_REQUESTS && op.locked);
    expect(privacyRead?.where?.params).toEqual([
      ORG_ID, STORE_ID, "customers/data_request", "customers/redact", "completed",
    ]);
    expect(privacyRead?.where?.sql).toMatch(/`status` not in \(\?\)/i);
  });

  it("should keep the separate shop-redaction fence authoritative without reading or weakening the customer hold", async () => {
    const fake = scriptedDb({
      standing: {
        organizations: [{ deletionState: "active" }],
        [STORES]: [{ id: STORE_ID, organizationId: ORG_ID, status: "redacting" }],
      },
    });

    const report = await sweep(fake);

    expect(report.storesSkipped).toBe(1);
    expect(fake.ops.some((op) => op.kind === "select" && op.table === PRIVACY_REQUESTS)).toBe(false);
    expect(fake.committed().filter((op) => op.kind === "delete")).toEqual([]);
    expect(fake.writes("insert", RECEIPTS)).toEqual([]);
  });
});

describe("when customer privacy holds must protect independently purgeable later-phase evidence", () => {
  beforeEach(() => resetShopifyScopeAEvidenceRetentionScheduleForTest());

  const JOBS = "reconciliation_jobs";
  const REPORTS = "reconciliation_reports";
  const SHARES = "shared_report_tokens";
  const UPLOADS = "upload_batches";
  const WEBHOOKS = "shopify_webhook_events";
  const old = new Date("2026-01-01T00:00:00.000Z");
  const job = { id: 901, organizationId: ORG_ID, sourceChannelId: 71, targetChannelId: 72, status: "completed", dateTo: old, createdAt: old, completedAt: old };
  // Null file is not null evidence: ordinary report generation stores summary/title.
  const report = { id: 902, jobId: 901, organizationId: ORG_ID, fileUrl: null, title: "Persisted reconciliation evidence", summary: { transactions: 12, unresolved: 2 } };
  const share = { id: 903, reportId: 902, organizationId: ORG_ID, recipientEmail: "synthetic@example.invalid" };
  const upload = { id: 904, organizationId: ORG_ID, channelId: 71, status: "completed", fileUrl: null, createdAt: old, completedAt: old };
  const webhook = { id: 905, organizationId: ORG_ID, storeId: STORE_ID, status: "processed", receivedAt: old };

  type CustomerRequest = { id: number; organizationId: number; storeId: number | null; topic: string; status: string };

  /** Evaluate ONLY the pinned customer-hold predicate over synthetic rows.
   * The rest of the DB remains scripted; this is not a general SQL emulator. */
  function customerRows(fake: ReturnType<typeof scriptedDb>, requests: CustomerRequest[]) {
    const wrap = (handle: Record<string, (...args: any[]) => any>): typeof handle => new Proxy(handle, {
      get(target, property: string) {
        if (property === "transaction") return (fn: (tx: typeof handle) => Promise<unknown>) => target.transaction((tx: typeof handle) => fn(wrap(tx)));
        if (property !== "select") return target[property];
        return (fields?: Record<string, unknown>) => {
          const query = target.select(fields);
          let table = "";
          let condition: ReturnType<typeof render> | undefined;
          const proxy: typeof query = new Proxy(query, {
            get(builder, method: string) {
              if (method === "then") return (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => builder.then((rows: unknown[]) => {
                if (table !== PRIVACY_REQUESTS) return resolve(rows);
                expect(condition?.sql).toMatch(/`organizationId` = \? and \(.*`storeId` = \? or .*`storeId` is null\).*`topic` in \(\?, \?\).*`status` not in \(\?\)/i);
                const [org, store, dataTopic, redactTopic, completed] = condition!.params;
                const matched = requests.filter(row => row.organizationId === org && (row.storeId === store || row.storeId === null) && [dataTopic, redactTopic].includes(row.topic) && row.status !== completed);
                return resolve(fields?.n ? [{ n: String(matched.length) }] : matched.slice(0, 1));
              }, reject);
              return (...args: unknown[]) => {
                if (method === "from") table = getTableName(args[0] as Table);
                if (method === "where") condition = render(args[0] as SQL);
                builder[method](...args);
                return proxy;
              };
            },
          });
          return proxy;
        };
      },
    });
    return { ...fake, db: wrap(fake.db as Record<string, (...args: any[]) => any>) };
  }

  function populated(privacyReads: unknown[][]) {
    return scriptedDb({
      standing: {
        organizations: [{ deletionState: "active" }],
        [STORES]: [{ id: STORE_ID, organizationId: ORG_ID, status: "active" }],
        channels: [{ id: 71 }, { id: 72 }],
        [RECEIPTS]: [], [TRANSACTIONS]: [], [PRIVACY_REQUESTS]: [],
        matches: [], exceptions: [], audit_chain_locks: [], audit_logs: [],
        [SHARES]: [share], job_progress_events: [{ id: 906, jobId: 901 }],
      },
      select: {
        [PRIVACY_REQUESTS]: privacyReads,
        [JOBS]: [[job]], [REPORTS]: [[report]], [UPLOADS]: [[upload]], [WEBHOOKS]: [[webhook]],
      },
    });
  }

  function expectNoLaterLoss(fake: ReturnType<typeof scriptedDb>) {
    expect(fake.committed().filter(op => op.kind === "delete")).toEqual([]);
    expect(fake.ops.some(op => op.kind === "select" && op.locked && [JOBS, REPORTS, UPLOADS, WEBHOOKS].includes(op.table))).toBe(false);
  }

  it.each([
    ["customers/data_request", STORE_ID], ["customers/redact", STORE_ID], ["customers/redact", null],
  ])("should protect a terminal job, null-file persisted JSON report/share/progress, upload and webhook for unresolved %s at store %s", async (topic, storeId) => {
    const request = { id: 3, topic, storeId, organizationId: ORG_ID, status: "manual_review" };
    const fake = customerRows(populated([]), [request, { ...request, id: 4 }]);
    const audit = vi.fn(async () => undefined);

    const result = await sweep(fake, audit);

    expectNoLaterLoss(fake);
    expect(result).toMatchObject({ storesCompleted: 1, storesSkipped: 0, storesFailed: 0, deferredPrivacyRequests: 2, transactionsDeleted: 0, jobsDeleted: 0, reportsDeleted: 0, reportShareLinksDeleted: 0, batchesDeleted: 0, webhookEventsDeleted: 0 });
    const receipt = fake.writes("insert", RECEIPTS)[0];
    expect((receipt?.data as { summary: { deferredPrivacyRequests: number } }).summary.deferredPrivacyRequests).toBe(2);
    expect(audit).toHaveBeenCalledTimes(1); // Aggregate receipt only, no deletion audit.
    const gate = fake.ops.find(op => op.table === PRIVACY_REQUESTS && op.locked);
    const beforeGate = fake.ops.filter(op => op.txId === gate?.txId && op.locked).map(op => op.table);
    expect(beforeGate).toEqual(["organizations", STORES, RECEIPTS, PRIVACY_REQUESTS]);
    expect(gate?.where?.params).toEqual([ORG_ID, STORE_ID, "customers/data_request", "customers/redact", "completed"]);
  });

  it.each([
    ["completed", ORG_ID, STORE_ID],
    ["manual_review", ORG_ID + 1, STORE_ID],
    ["manual_review", ORG_ID + 1, null],
    ["manual_review", ORG_ID, STORE_ID + 1],
  ])("should preserve later-phase deletion for excluded status %s org %s store %s", async (status, organizationId, storeId) => {
    const fake = customerRows(populated([]), [{ id: 3, status, organizationId, storeId, topic: "customers/redact" }]);
    const result = await sweep(fake);
    expect(result).toMatchObject({ storesCompleted: 1, deferredPrivacyRequests: 0, jobsDeleted: 1, reportsDeleted: 1, reportShareLinksDeleted: 1, batchesDeleted: 1, webhookEventsDeleted: 1 });
    expect(fake.writes("delete", "job_progress_events")).toHaveLength(1);
    const privacyReads = fake.ops.filter(op => op.table === PRIVACY_REQUESTS);
    expect(privacyReads).toHaveLength(6); // Four phases, receipt guard, aggregate.
    for (const read of privacyReads) {
      expect(read.where?.params).toEqual([ORG_ID, STORE_ID, "customers/data_request", "customers/redact", "completed"]);
      expect(read.where?.sql).toMatch(/`organizationId` = \? and \(.*`storeId` = \? or .*`storeId` is null\).*`status` not in \(\?\)/i);
    }
    const jobsRead = fake.ops.find(op => op.table === JOBS && op.locked);
    expect(jobsRead?.where?.params).toEqual(expect.arrayContaining([ORG_ID, 71, 72, "completed", "failed", "cancelled"]));
    expect(jobsRead?.where?.sql).toMatch(/not exists \(select .* from `matches`.*not exists \(select .* from `exceptions`/i);
    expect(fake.ops.find(op => op.table === REPORTS && op.locked)?.fields).toEqual(["id", "jobId", "organizationId", "fileUrl"]);
  });

  it.each([
    ["jobs", STORE_ID], ["jobs", null],
    ["uploads", STORE_ID], ["uploads", null],
    ["webhooks", STORE_ID], ["webhooks", null],
  ])("should apply the hold before resumed %s nonzero cursor work for unresolved redaction store %s", async (phase, storeId) => {
    const targetTable = phase === "jobs" ? JOBS : phase === "uploads" ? UPLOADS : WEBHOOKS;
    const first = scriptedDb({
      standing: {
        organizations: [{ deletionState: "active" }],
        [STORES]: [{ id: STORE_ID, organizationId: ORG_ID, status: "active" }],
        channels: [{ id: 71 }, { id: 72 }], [RECEIPTS]: [], [PRIVACY_REQUESTS]: [],
      },
      select: {
        // Nonzero cursor. File-backed first job/upload remains held by the
        // independent file guard; webhooks use their ten-row batch ceiling.
        [JOBS]: phase === "jobs" ? [[{ id: 800 }]] : [[]],
        [REPORTS]: [[{ id: 799, jobId: 800, organizationId: ORG_ID, fileUrl: "synthetic-file" }]],
        [UPLOADS]: phase === "uploads" ? [[{ id: 800, fileUrl: "synthetic-file" }]] : [[]],
        [WEBHOOKS]: [Array.from({ length: 10 }, (_, index) => ({ id: 791 + index }))],
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const partial = await purgeExpiredShopifyScopeAEvidence({
        db: first.db as never, now: () => NOW, audit: vi.fn(async () => undefined) as never,
        batchSize: 1, budgetMs: 100,
        elapsed: () => first.ops.some(op => op.table === targetTable && op.kind === "select" && op.locked) ? 100 : 0,
      });
      expect(partial).toMatchObject({ storesIncomplete: 1, storesCompleted: 0 });
      expect(first.writes("insert", RECEIPTS)).toEqual([]);
      const request = { id: 3, organizationId: ORG_ID, storeId, topic: "customers/redact", status: "manual_review" };
      const resumed = customerRows(populated([]), [request]);
      const result = await purgeExpiredShopifyScopeAEvidence({ db: resumed.db as never, now: () => new Date(NOW.getTime() + 60_000), audit: vi.fn(async () => undefined) as never });
      expectNoLaterLoss(resumed);
      expect(result).toMatchObject({ storesCompleted: 1, storesIncomplete: 0, deferredPrivacyRequests: 1, jobsDeleted: 0, reportsDeleted: 0, reportShareLinksDeleted: 0, batchesDeleted: 0, webhookEventsDeleted: 0 });
      expect(resumed.ops.some(op => op.table === TRANSACTIONS && op.locked)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("should recheck holds between batches even after an earlier phase found no candidates", async () => {
    const request = { id: 3, organizationId: ORG_ID, storeId: STORE_ID, topic: "customers/redact", status: "received" };
    const fake = populated([[], [request], [request], [{ n: 1 }]]);
    const result = await sweep(fake);
    expectNoLaterLoss(fake);
    expect(fake.ops.some(op => op.table === TRANSACTIONS && op.locked)).toBe(true); // First evidence phase exhausted.
    expect(result.deferredPrivacyRequests).toBe(1);
    expect(fake.ops.filter(op => op.table === PRIVACY_REQUESTS && op.locked)).toHaveLength(3);
  });
});
