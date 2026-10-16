import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "./scriptedDb.testkit";
import {
  purgeExpiredShopifyScopeAEvidence,
  resetShopifyScopeAEvidenceRetentionScheduleForTest,
  runShopifyScopeAEvidenceRetentionIfDue,
  SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
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
const MATCHES = "matches";
const EXCEPTIONS = "exceptions";
const WORKFLOWS = "exception_workflows";
const WORKFLOW_EVENTS = "exception_workflow_events";
const ACTION_DRAFTS = "agent_action_drafts";
const MEMORY = "agent_memory";
const ANOMALIES = "anomaly_scores";
const JOBS = "reconciliation_jobs";
const REPORTS = "reconciliation_reports";
const BATCHES = "upload_batches";
const WEBHOOK_EVENTS = "shopify_webhook_events";

function retentionFixture() {
  return scriptedDb({
    standing: {
      organizations: [{ deletionState: "active" }],
      [STORES]: [{ id: STORE_ID, organizationId: ORG_ID, status: "active" }],
      // First select: stale scope-A transactions. The control's query itself
      // must exclude active exception/workflow records with NOT EXISTS.
      [TRANSACTIONS]: [{ id: 801 }],
      [MATCHES]: [{ id: 901 }],
      // First exception read is the deferred count; second is the linked
      // terminal exception that can be removed with stale evidence.
      [EXCEPTIONS]: [{ id: 701 }],
      // First workflow read is the deferred count; second is the terminal
      // workflow attached to the removable exception.
      [WORKFLOWS]: [{ id: 601 }],
      [JOBS]: [{ id: 501 }],
      [REPORTS]: [],
      audit_chain_locks: [],
      audit_logs: [],
    },
  });
}

describe("Shopify Scope A evidence retention", () => {
  beforeEach(() => resetShopifyScopeAEvidenceRetentionScheduleForTest());

  it("should calculate the selected 90-day cutoff exactly", () => {
    expect(shopifyScopeAEvidenceRetentionCutoff(NOW)).toEqual(
      new Date("2026-07-18T12:00:00.000Z")
    );
  });

  it("should delete only expired terminal evidence, preserve live controls, and leave a de-identified receipt", async () => {
    const fake = retentionFixture();
    const audit = vi.fn(async () => undefined);

    const report = await purgeExpiredShopifyScopeAEvidence({
      db: fake.db as never,
      now: () => NOW,
      audit: audit as never,
    });

    expect(report.storesConsidered).toBe(1);
    expect(report.storesCompleted).toBe(1);
    // The fixture makes the count reads return one active exception/workflow.
    // Those counts appear in the receipt rather than causing an unsafe delete.
    expect(report.deferredActiveExceptions).toBe(1);
    expect(report.deferredActiveWorkflows).toBe(1);
    expect(fake.writes("delete", MATCHES)).toHaveLength(1);
    expect(fake.writes("delete", EXCEPTIONS)).toHaveLength(1);
    expect(fake.writes("delete", WORKFLOWS)).toHaveLength(1);
    expect(fake.writes("delete", WORKFLOW_EVENTS)).toHaveLength(1);
    expect(fake.writes("delete", ACTION_DRAFTS)).toHaveLength(1);
    expect(fake.writes("delete", MEMORY)).toHaveLength(1);
    expect(fake.writes("delete", ANOMALIES)).toHaveLength(1);
    expect(fake.writes("delete", TRANSACTIONS)).toHaveLength(1);
    expect(fake.writes("delete", REPORTS)).toHaveLength(1);
    expect(fake.writes("delete", JOBS)).toHaveLength(1);
    expect(fake.writes("delete", BATCHES)).toHaveLength(1);
    expect(fake.writes("delete", WEBHOOK_EVENTS)).toHaveLength(1);

    const staleTransactionQuery = fake.ops.find(
      op => op.kind === "select" && op.table === TRANSACTIONS && op.locked
    );
    expect(staleTransactionQuery?.where?.sql).toMatch(/not exists/i);
    expect(staleTransactionQuery?.where?.sql).toMatch(
      /`exceptions`\.`status` in/i
    );
    expect(staleTransactionQuery?.where?.sql).toMatch(
      /`exception_workflows`\.`status` in/i
    );
    expect(staleTransactionQuery?.where?.params).toEqual(
      expect.arrayContaining(["open", "in_review", "escalated"])
    );

    const receipt = fake.writes("insert", RECEIPTS)[0];
    expect(receipt?.data).toMatchObject({
      organizationId: ORG_ID,
      storeId: STORE_ID,
      retentionDays: SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
      cutoffAt: new Date("2026-07-18T12:00:00.000Z"),
      completedAt: NOW,
    });
    const summary = (receipt?.data as { summary?: Record<string, unknown> })
      ?.summary;
    expect(summary).toMatchObject({
      deferredActiveExceptions: 1,
      deferredActiveWorkflows: 1,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /order|domain|shop|amount|reference|url|user/i
    );

    // The receipt and its audit event must have been written inside the same
    // transaction as the deletion actions, with no raw test identifiers.
    const committed = fake.committed();
    expect(
      committed
        .filter(op => op.table === RECEIPTS)
        .every(op => op.txId !== null)
    ).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      action: "shopify_scope_a_retention_sweep",
      entityType: "shopify_evidence_retention",
    });
    expect(fake.committedJson()).not.toMatch(
      /customer@example\.invalid|gid:\/\/shopify|order-\d+/i
    );
  });

  it("should skip a fenced tenant without creating a retention receipt", async () => {
    const fake = scriptedDb({
      standing: {
        // The candidate query includes active tenants, then the lock confirms
        // the safe state before every write in case redaction races it.
        organizations: [{ deletionState: "redacting" }],
      },
    });

    const report = await purgeExpiredShopifyScopeAEvidence({
      db: fake.db as never,
      now: () => NOW,
    });

    expect(report.storesConsidered).toBe(0);
    expect(fake.writes("insert", RECEIPTS)).toEqual([]);
  });

  it("should run at most daily after success and retry a partial sweep hourly", async () => {
    const fake = retentionFixture();
    const audit = vi.fn(async () => undefined);
    const first = await runShopifyScopeAEvidenceRetentionIfDue({
      db: fake.db as never,
      now: () => NOW,
      audit: audit as never,
    });
    expect(first.ran).toBe(true);
    expect(first.retryAt).toEqual(
      new Date(NOW.getTime() + SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS)
    );

    const sameDay = await runShopifyScopeAEvidenceRetentionIfDue({
      db: fake.db as never,
      now: () => new Date(NOW.getTime() + 1_000),
      audit: audit as never,
    });
    expect(sameDay).toEqual({ ran: false, retryAt: first.retryAt });

    resetShopifyScopeAEvidenceRetentionScheduleForTest();
    const failedDb = scriptedDb({
      standing: { [STORES]: [{ id: STORE_ID, organizationId: ORG_ID }] },
      select: { organizations: [new Error("database unavailable")] },
    });
    const partial = await runShopifyScopeAEvidenceRetentionIfDue({
      db: failedDb.db as never,
      now: () => NOW,
    });
    expect(partial.ran).toBe(true);
    expect(partial.report?.storesFailed).toBe(1);
    expect(partial.retryAt).toEqual(
      new Date(NOW.getTime() + SHOPIFY_SCOPE_A_RETENTION_RETRY_INTERVAL_MS)
    );
  });
});
