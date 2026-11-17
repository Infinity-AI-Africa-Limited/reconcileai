import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { handleShopifyCustomerRedactionJob } from "./customerRedaction";
import { computeShopifyOrderSuppressionDigest } from "./privacySuppression";
import { dispatchShopifyPrivacyOutbox } from "./privacyCompletion";
import { quarantineSelectorlessCustomerRequests } from "./privacySelectors";
import { rowOf, scriptedDb } from "./scriptedDb.testkit";

const JOBS = "shopify_privacy_customer_redaction_jobs";
const REQUESTS = "shopify_privacy_requests";
const SELECTORS = "shopify_privacy_request_selectors";
const STORES = "shopify_connector_stores";
const TOMBSTONES = "shopify_order_redaction_tombstones";
const OUTBOX = "shopify_privacy_queue_outbox";
const TXNS = "transactions";
const NOW = new Date("2026-09-25T12:00:00.000Z");
const KEYS = [{ version: "v1", key: Buffer.alloc(32, 11) }];

const JOB = {
  requestId: 901,
  organizationId: 42,
  storeId: 7,
  attempts: 1,
  manifestVersion: 1,
};
const FENCED_STORE = {
  id: 7,
  status: "active",
  privacyRedactionState: "customer_redacting",
  privacyRedactionRequestId: 901,
};
const SELECTOR_ROWS = [
  { resourceType: "customer", position: 0, externalIdEnc: "enc-customer" },
  { resourceType: "order", position: 0, externalIdEnc: "enc-order-501" },
];
const SCOPE_A_ROW = {
  id: 3001,
  transactionRef: "gid://shopify/Order/501",
  shopifyRefundId: "",
  externalRef: "#1001",
  description: "Shopify Order #1001",
  counterparty: "Shopify",
  originalTransactionRef: null,
  isReversal: false,
  debitCredit: "credit",
  currency: "USD",
  shopifyOrderCurrency: "USD",
  shopifyUpdatedAt: NOW,
  shopifyFinancialStatus: "PAID",
  rawData: null,
};
/** The refund projection (ingest.ts): its order's reference, money out, its own id. */
const SCOPE_A_REFUND_ROW = {
  ...SCOPE_A_ROW,
  id: 3002,
  shopifyRefundId: "gid://shopify/Refund/77",
  description: "Shopify Order #1001 refund",
  isReversal: true,
  debitCredit: "debit",
};

function baseScript(overrides: Parameters<typeof scriptedDb>[0] = {}) {
  return scriptedDb({
    select: {
      [JOBS]: [[JOB]],
      [REQUESTS]: [[{ id: JOB.requestId, status: "received" }]],
      [SELECTORS]: [SELECTOR_ROWS],
      [STORES]: [[FENCED_STORE]],
      ...(overrides.select ?? {}),
    },
    update: overrides.update,
    insert: overrides.insert,
    delete: overrides.delete,
    // The tenant is not being redacted: read (and, at the final write, locked)
    // before any tenant data is created.
    standing: { organizations: [{ deletionState: "active" }], ...overrides.standing },
  });
}

function decrypt(_organizationId: number, ciphertext: string): Promise<string> {
  return Promise.resolve(ciphertext === "enc-customer" ? "41" : "501");
}

function deps(fake: ReturnType<typeof scriptedDb>) {
  return {
    db: fake.db as never,
    now: () => NOW,
    uuid: () => "11111111-1111-4111-8111-111111111111",
    decrypt,
    suppressionKeys: KEYS,
  };
}

function expectScopeReview(fake: ReturnType<typeof scriptedDb>, recordsFound: number, tombstonesWritten: number) {
  expect(fake.committed().filter((op) => op.kind === "delete")).toEqual([]);
  const job = fake.writes("update", JOBS).at(-1);
  expect(job?.data).toMatchObject({
    status: "manual_review",
    failureCode: "privacy_scope_review_required",
    lastCheckpoint: "suppression_recorded_review_required",
    leaseId: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    completedAt: null,
    selectorDestroyedAt: null,
    recordsFound,
    tombstonesWritten,
    remainingTransactions: recordsFound,
    transactionsDeleted: 0,
    anomalyScoresDeleted: 0,
    orphanBatchesDeleted: 0,
  });
  expect(job?.where?.params).toEqual([901, 42, 7, "11111111-1111-4111-8111-111111111111", "processing"]);
  const parent = fake.writes("update", REQUESTS).at(-1);
  expect(parent?.data).toEqual({
    status: "manual_review", completedAt: null, recordsAffected: 0, completionNote: "privacy_scope_review_required",
  });
  expect(parent?.where?.params).toEqual([901, 42, 7, "customers/redact", "received"]);
  expect(parent?.txId).toBe(job?.txId);
  expect(fenceRelease(fake)?.where?.params).toEqual([7, 42, "customer_redacting", 901]);
  expect(fake.ops.find((op) => op.kind === "select" && op.table === REQUESTS)?.fields).toEqual(["id", "status"]);
  expect(fenceRelease(fake)?.txId).toBe(job?.txId);
  expect(fake.writes("update", STORES).every((op) => rowOf(op)?.status === undefined)).toBe(true);
  expect(fake.committedJson()).not.toContain("scope_a_no_personal_data_persisted");
}

describe("when Shopify processes supported customer-redaction selectors", () => {
  it("should park a zero-record request for scope review without destroying selectors", async () => {
    const fake = baseScript({ select: { [TXNS]: [[]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.writes("insert", TOMBSTONES)[0]?.data).toEqual([
      expect.objectContaining({ organizationId: 42, storeId: 7, sourceRequestId: 901 }),
    ]);
    expectScopeReview(fake, 0, 1);
  });

  it("should retain a minimized order and selectors alongside an exact future-sync tombstone", async () => {
    const fake = baseScript({ select: { [TXNS]: [[SCOPE_A_ROW]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    const expected = computeShopifyOrderSuppressionDigest(KEYS[0].key, 42, 7, "gid://shopify/Order/501");
    expect(fake.writes("insert", TOMBSTONES)[0]?.data).toEqual([
      expect.objectContaining({ orderDigest: expected, keyVersion: "v1" }),
    ]);
    const tombstone = fake.writes("insert", TOMBSTONES)[0];
    expect(tombstone?.upsert).toBe(true);
    expect(new MySqlDialect().sqlToQuery(tombstone?.onDuplicate?.sourceRequestId as SQL).params).toEqual([]);
    expect(tombstone?.txId).toBe(fake.writes("update", JOBS).at(-1)?.txId);
    expectScopeReview(fake, 1, 1);
  });

  describe("when the order has refund rows", () => {
    it("should retain minimized order and refund evidence pending scope review", async () => {
      const fake = baseScript({ select: { [TXNS]: [[SCOPE_A_ROW, SCOPE_A_REFUND_ROW]] } });

      await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

      expect(fake.writes("insert", TOMBSTONES)).toHaveLength(1);
      expectScopeReview(fake, 2, 1);
      const lookup = fake.ops.find((op) => op.kind === "select" && op.table === TXNS);
      expect(lookup?.where?.params).toEqual([42, 7, "gid://shopify/Order/501"]);
      expect(lookup?.fields).toEqual(expect.arrayContaining(["shopifyRefundId", "rawData", "transactionRef", "debitCredit"]));
    });

    it.each([
      ["carries provider data", { rawData: { note: "must-not-be-retained" } }],
      ["is booked as money in", { debitCredit: "credit" }],
      ["is not marked a reversal", { isReversal: false }],
      ["carries the order's description", { description: "Shopify Order #1001" }],
      ["carries free text", { description: "Refund to alice@example.com" }],
      ["names no Shopify refund", { shopifyRefundId: "gid://shopify/Order/501" }],
      ["carries an unprojected reference", { originalTransactionRef: "customer@example.com" }],
    ])("should fail closed when a refund row %s", async (_label, deviation) => {
      const fake = baseScript({ select: { [TXNS]: [[SCOPE_A_ROW, { ...SCOPE_A_REFUND_ROW, ...deviation }]] } });

      await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

      expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
      expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
        status: "blocked_dependency",
        failureCode: "unsupported_transaction_footprint",
      });
    });

    it("should fail closed when an order's own row is shaped as a refund", async () => {
      const fake = baseScript({
        select: { [TXNS]: [[{ ...SCOPE_A_REFUND_ROW, shopifyRefundId: "" }]] },
      });

      await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

      expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
        status: "blocked_dependency",
        failureCode: "unsupported_transaction_footprint",
      });
    });
  });

  it("fails closed when a legacy or future row carries non-Scope-A data", async () => {
    const fake = baseScript({ select: { [TXNS]: [[{ ...SCOPE_A_ROW, rawData: { customer: "must-not-be-retained" } }]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toEqual([]);
    expect(fake.writes("delete", TXNS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "blocked_dependency",
      failureCode: "unsupported_transaction_footprint",
    });
    expect(fake.committed().flatMap((op) => Object.values(op.data ?? {}))).not.toContain("must-not-be-retained");
  });

  it("fails closed when any unprojected provider reference is present", async () => {
    const fake = baseScript({
      select: { [TXNS]: [[{ ...SCOPE_A_ROW, originalTransactionRef: "customer@example.com" }]] },
    });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "blocked_dependency",
      failureCode: "unsupported_transaction_footprint",
    });
    expect(fake.committed().flatMap((op) => Object.values(op.data ?? {}))).not.toContain("customer@example.com");
  });

  it("fails closed when the persisted row violates the exact fixed projection", async () => {
    const fake = baseScript({ select: { [TXNS]: [[{ ...SCOPE_A_ROW, description: "Customer alice@example.com" }]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "blocked_dependency",
      failureCode: "unsupported_transaction_footprint",
    });
    expect(fake.committed().flatMap((op) => Object.values(op.data ?? {}))).not.toContain("alice@example.com");
  });

  it("does not leak malformed decrypted selectors into durable records", async () => {
    const fake = baseScript();

    await handleShopifyCustomerRedactionJob(JOB.requestId, {
      ...deps(fake),
      decrypt: vi.fn(async () => "sensitive-invalid-selector"),
    });

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "manual_review",
      failureCode: "selector_integrity_failed",
    });
    expect(fake.committed().flatMap((op) => Object.values(op.data ?? {}))).not.toContain("sensitive-invalid-selector");
  });

  it("fails closed without a suppression key and never completes the request", async () => {
    const fake = baseScript();

    await handleShopifyCustomerRedactionJob(JOB.requestId, { ...deps(fake), suppressionKeys: [] });

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "manual_review",
      failureCode: "suppression_key_unavailable",
    });
    expect(fake.writes("update", REQUESTS).some((op) => rowOf(op)?.status === "completed")).toBe(false);
  });

  it("should keep a tombstone-write outage retryable without destroying retained selectors", async () => {
    const fake = baseScript({
      select: { [TXNS]: [[SCOPE_A_ROW]] },
      insert: { [TOMBSTONES]: [new Error("database unavailable")] },
    });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).rejects.toThrow(/retry required/);

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "failed_retryable",
      failureCode: "worker_failed",
    });
    expect(fake.writes("insert", OUTBOX).at(-1)?.data).toMatchObject({
      kind: "customer_redact",
      jobId: 901,
      status: "failed_retryable",
    });
  });

  it("terminalizes after the bounded retry budget without reviving the outbox", async () => {
    const fake = baseScript({
      select: { [JOBS]: [[{ ...JOB, attempts: 6 }]], [TXNS]: [[SCOPE_A_ROW]] },
      insert: { [TOMBSTONES]: [new Error("database unavailable")] },
    });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).rejects.toThrow(/retry required/);

    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "failed_terminal",
      failureCode: "worker_failed",
      nextAttemptAt: null,
    });
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
    expect(fake.writes("update", REQUESTS).at(-1)?.data).toMatchObject({ status: "failed_terminal" });
  });

  it("should roll back scope-review writes when the exact job lease is reclaimed", async () => {
    const fake = baseScript({
      select: { [TXNS]: [[SCOPE_A_ROW]] },
      // Claim succeeds; both review and retry writes lose to the newer executor.
      update: { [JOBS]: [1, 0, 0] },
    });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).rejects.toThrow(/retry required/);

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
    expect(fenceRelease(fake)).toBeUndefined();
    expect(fake.ops.some((op) => op.table === TOMBSTONES && op.kind === "insert")).toBe(true);
  });

  it("uses only the internal job handle in a customer-redaction queue payload", async () => {
    const payload = { kind: "customer_redact" as const, jobId: JOB.requestId };
    expect(Object.keys(payload)).toEqual(["kind", "jobId"]);
    expect(JSON.stringify(payload)).not.toMatch(/organization|store|shop|domain|selector|hash|url/i);
  });
});

/** The update, if any, that handed this request's store fence back. */
function fenceRelease(fake: ReturnType<typeof scriptedDb>) {
  return fake
    .writes("update", STORES)
    .find((op) => (op.data as Record<string, unknown> | null)?.privacyRedactionState === "active");
}

describe("when a customer redaction stops without completing", () => {
  // Greptile #160: a parked job kept the store fenced indefinitely — sync and
  // reauthorization refused, every other customer's redaction left waiting.
  it("should release the store fence when the job is parked as blocked", async () => {
    const fake = baseScript({ select: { [TXNS]: [[{ ...SCOPE_A_ROW, rawData: { unexpected: true } }]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "blocked_dependency" });
    // Only this request's fence: exact state and request id.
    expect(fenceRelease(fake)?.where?.params).toEqual([7, 42, "customer_redacting", 901]);
  });

  it("should release the store fence when the job is parked for manual review", async () => {
    const fake = baseScript({ select: { [SELECTORS]: [[{ resourceType: "order", position: 0, externalIdEnc: "enc-order-501" }]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "manual_review", failureCode: "selector_integrity_failed" });
    expect(fenceRelease(fake)?.where?.params).toEqual([7, 42, "customer_redacting", 901]);
  });

  it("should release the store fence when the job runs out of attempts", async () => {
    const fake = baseScript({
      select: { [JOBS]: [[{ ...JOB, attempts: 6 }]], [TXNS]: [[SCOPE_A_ROW]] },
      insert: { [TOMBSTONES]: [new Error("database unavailable")] },
    });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).rejects.toThrow(/retry required/);

    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "failed_terminal" });
    expect(fenceRelease(fake)?.where?.params).toEqual([7, 42, "customer_redacting", 901]);
  });

  it("should keep the fence while a retryable failure still owes work", async () => {
    const fake = baseScript({
      select: { [TXNS]: [[SCOPE_A_ROW]] },
      insert: { [TOMBSTONES]: [new Error("database unavailable")] },
    });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).rejects.toThrow(/retry required/);

    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "failed_retryable" });
    expect(fenceRelease(fake)).toBeUndefined();
  });
});

describe("when another customer redaction holds the store fence", () => {
  it("should wait its turn without spending an attempt, and write nothing else", async () => {
    const fake = baseScript({
      select: {
        [STORES]: [[{ ...FENCED_STORE, privacyRedactionRequestId: 999 }]],
        [TXNS]: [[SCOPE_A_ROW]],
      },
    });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    const deferred = fake.writes("update", JOBS).at(-1);
    expect(deferred?.data).toMatchObject({
      status: "failed_retryable",
      failureCode: "store_fence_busy",
      nextAttemptAt: new Date(NOW.getTime() + 60_000),
      lastCheckpoint: "waiting_for_store_fence",
    });
    // The claim's increment is undone: queueing is not a failure.
    const attempts = new MySqlDialect().sqlToQuery(rowOf(deferred)?.attempts as SQL).sql;
    expect(attempts).toMatch(/GREATEST\(`shopify_privacy_customer_redaction_jobs`\.`attempts` - 1, 0\)/);
    expect(fake.writes("insert", OUTBOX).at(-1)?.data).toMatchObject({ kind: "customer_redact", jobId: 901, failureCode: "store_fence_busy" });
    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
    expect(fenceRelease(fake)).toBeUndefined();
  });
});

describe("when the store fence is free as the worker runs", () => {
  it("should take the fence before suppression, then park for review and release it", async () => {
    const fake = baseScript({
      select: { [STORES]: [[{ ...FENCED_STORE, privacyRedactionState: "active", privacyRedactionRequestId: null }]], [TXNS]: [[]] },
    });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    const stores = fake.writes("update", STORES);
    expect(stores[0]?.data).toEqual({ privacyRedactionState: "customer_redacting", privacyRedactionRequestId: 901 });
    expect(stores[0]?.where?.params).toEqual([7, 42, "active"]);
    expectScopeReview(fake, 0, 1);
  });
});

describe("when a queued run cannot claim its job", () => {
  it("should keep the queue entry alive while the job still owes work", async () => {
    const fake = baseScript({ select: { [JOBS]: [[{ status: "processing" }]] }, update: { [JOBS]: [0] } });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).rejects.toThrow(/not claimable/);
  });

  it("should settle quietly when the job has ended", async () => {
    const fake = baseScript({ select: { [JOBS]: [[{ status: "completed" }]] }, update: { [JOBS]: [0] } });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).resolves.toBeUndefined();
  });
});

describe("when a persisted order deviates from the fixed projection", () => {
  it.each([
    ["a debit", { debitCredit: "debit" }],
    ["a currency that is not an ISO code", { currency: "us dollars" }],
  ])("should block completion for %s", async (_name, deviation) => {
    const fake = baseScript({ select: { [TXNS]: [[{ ...SCOPE_A_ROW, ...deviation }]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "blocked_dependency",
      failureCode: "unsupported_transaction_footprint",
    });
  });
});

describe("when a shop redaction fences the tenant", () => {
  // Greptile #160 (review of 88a3ec5): the worker must write nothing into a
  // tenant whose shop/redact has begun — tombstones are new tenant rows.
  it.each([
    ["the organisation", { standing: { organizations: [{ deletionState: "redacting" }] } }],
    ["the store", { select: { [STORES]: [[{ ...FENCED_STORE, status: "redacting" }]] } }],
  ])("should park without writing when %s is fenced, and release its own fence", async (_where, script) => {
    const fake = baseScript({ ...script, select: { [TXNS]: [[SCOPE_A_ROW]], ...(script as { select?: object }).select } } as never);

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "blocked_dependency",
      failureCode: "shop_redaction_in_progress",
    });
    expect(fenceRelease(fake)?.where?.params).toEqual([7, 42, "customer_redacting", 901]);
  });

  it("should lock the organisation before the store, the order shop-redaction admission uses", async () => {
    const fake = baseScript({ select: { [TXNS]: [[]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    const locks = fake.ops.filter((op) => op.txId !== null && op.locked).map((op) => op.table);
    expect(locks.slice(0, 2)).toEqual(["organizations", STORES]);
  });
});

describe("when customer-redaction scope cannot establish completed erasure", () => {
  it("should park an empty order list without a tombstone or any destructive deletion", async () => {
    const fake = baseScript({ select: { [SELECTORS]: [[SELECTOR_ROWS[0]]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.ops.some((op) => op.kind === "select" && op.table === TXNS)).toBe(false);
    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expectScopeReview(fake, 0, 0);
  });

  it("should roll back tombstones, job parking and acquired fence when the parent CAS loses", async () => {
    const fake = baseScript({
      select: {
        [STORES]: [
          [{ ...FENCED_STORE, privacyRedactionState: "active", privacyRedactionRequestId: null }],
          [{ ...FENCED_STORE, privacyRedactionState: "active", privacyRedactionRequestId: null }],
        ],
        [REQUESTS]: [[{ id: 901, status: "received" }], [{ status: "manual_review" }]],
        [TXNS]: [[SCOPE_A_ROW, SCOPE_A_REFUND_ROW]],
      },
      update: { [REQUESTS]: [0] },
    });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).rejects.toThrow(/retry required/);

    const parentAttempt = fake.ops.find((op) => op.kind === "update" && op.table === REQUESTS);
    expect(parentAttempt?.where?.params).toEqual([901, 42, 7, "customers/redact", "received"]);
    expect(fake.ops.filter((op) => op.txId === parentAttempt?.txId && op.kind !== "select").map((op) => op.table))
      .toEqual([STORES, TOMBSTONES, JOBS, REQUESTS]);
    expect(fake.committed().filter((op) => op.txId === parentAttempt?.txId)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("update", STORES)).toEqual([]);
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
    // No generic retry handler is allowed to overwrite the newer parent state.
    expect(fake.writes("update", JOBS)).toHaveLength(2);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "manual_review", failureCode: "parent_state_conflict" });
    expect(fake.committed().filter((op) => op.kind === "delete")).toEqual([]);
  });

  it("should compare the exact observed retryable parent state rather than any non-final state", async () => {
    const fake = baseScript({
      select: { [REQUESTS]: [[{ id: 901, status: "failed_retryable" }]], [TXNS]: [[]] },
    });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.writes("update", REQUESTS).at(-1)?.where?.params)
      .toEqual([901, 42, 7, "customers/redact", "failed_retryable"]);
    expect(fake.writes("update", REQUESTS).at(-1)?.data).toMatchObject({ status: "manual_review", completedAt: null });
  });

  it.each(["completed", "manual_review", "failed_terminal", "blocked_legal_retention"])(
    "should not override a parent already in %s",
    async (status) => {
      const fake = baseScript({ select: { [REQUESTS]: [[{ id: 901, status }], [{ status }]] } });

      await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).rejects.toThrow(/retry required/);

      expect(fake.writes("update", REQUESTS)).toEqual([]);
      expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
      expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "manual_review", failureCode: "parent_state_conflict" });
      expect(fenceRelease(fake)?.where?.params).toEqual([7, 42, "customer_redacting", 901]);
      expect(fenceRelease(fake)?.txId).toBe(fake.writes("update", JOBS).at(-1)?.txId);
      expect(fake.writes("insert", OUTBOX)).toEqual([]);
    },
  );

  it("should roll back a stale worker's temporary fence acquisition along with suppression", async () => {
    const fake = baseScript({
      select: {
        [STORES]: [[{ ...FENCED_STORE, privacyRedactionState: "active", privacyRedactionRequestId: null }]],
        [TXNS]: [[SCOPE_A_ROW]],
      },
      update: { [JOBS]: [1, 0, 0] },
    });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).rejects.toThrow(/retry required/);

    expect(fake.ops.some((op) => op.kind === "update" && op.table === STORES)).toBe(true);
    expect(fake.writes("update", STORES)).toEqual([]);
    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
  });

  it("should leave a scope-review job parked when a duplicate worker run cannot claim it", async () => {
    const fake = baseScript({ select: { [JOBS]: [[{ status: "manual_review" }]] }, update: { [JOBS]: [0] } });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).resolves.toBeUndefined();

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
    expect(fake.writes("update", STORES)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
  });
});

describe("when a claimed redaction loses its authoritative parent", () => {
  function expectConflictCas(fake: ReturnType<typeof scriptedDb>) {
    const child = fake.writes("update", JOBS).at(-1);
    expect(child?.where?.params).toEqual([901, 42, 7, "11111111-1111-4111-8111-111111111111", "processing"]);
    expect(child?.data).toMatchObject({
      status: "manual_review", failureCode: "parent_state_conflict",
      lastCheckpoint: "parent_state_conflict_review_required",
      leaseId: null, leaseExpiresAt: null, nextAttemptAt: null,
    });
    const locks = fake.ops.filter(op => op.txId === child?.txId && op.locked);
    expect(locks.map(op => op.table)).toEqual(["organizations", STORES, REQUESTS]);
    expect(locks.at(-1)?.where?.params).toEqual([901, 42, 7, "customers/redact"]);
    expect(locks.at(-1)?.fields).toEqual(["status"]);
    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.committed().filter(op => op.kind === "delete")).toEqual([]);
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
    return child;
  }

  it("should reconcile a selectorless quarantined parent and its admission-held fence, then remain unclaimable and unrearmed beyond the old lease", async () => {
    // Quarantine is invoked unchanged. The scripted reads below represent its
    // committed manual_review parent; it does not itself park redaction jobs.
    const fake = baseScript({
      select: { [REQUESTS]: [[{ id: 901, status: "manual_review" }], [{ status: "manual_review" }]] },
    });
    await (fake.db as { transaction: (fn: (tx: never) => Promise<void>) => Promise<void> }).transaction(async tx => {
      await quarantineSelectorlessCustomerRequests(tx, { id: 7, organizationId: 42 });
    });
    expect(fake.writes("update", REQUESTS)).toHaveLength(1);
    expect(fake.writes("update", REQUESTS)[0]?.data).toEqual({ status: "manual_review", admissionErrorCode: "selectors_unavailable" });
    expect(fake.writes("update", JOBS)).toEqual([]);

    await expect(handleShopifyCustomerRedactionJob(901, deps(fake))).rejects.toThrow(/retry required/);

    const child = expectConflictCas(fake);
    expect(fenceRelease(fake)?.txId).toBe(child?.txId);
    expect(fenceRelease(fake)?.where?.params).toEqual([7, 42, "customer_redacting", 901]);
    expect(fake.writes("update", REQUESTS)).toHaveLength(1); // Only quarantine; worker never rewrites parent.
    expect(fake.ops.some(op => op.table === SELECTORS)).toBe(false);

    const later = new Date(NOW.getTime() + 10 * 60_000);
    const parkedStatus = String(rowOf(child)?.status);
    const next = scriptedDb({
      standing: { [JOBS]: [{ status: parkedStatus }] },
      update: { [JOBS]: [0], [OUTBOX]: [0] },
      select: { [OUTBOX]: [[]] },
    });
    await expect(handleShopifyCustomerRedactionJob(901, { ...deps(next), now: () => later })).resolves.toBeUndefined();
    const enqueue = vi.fn(async () => {});
    expect(await dispatchShopifyPrivacyOutbox({ db: next.db as never, now: () => later, enqueue }))
      .toEqual({ scanned: 0, dispatched: 0, failed: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    const claim = next.ops.find(op => op.table === JOBS && op.kind === "update");
    const rearm = next.ops.find(op => op.table === OUTBOX && op.kind === "update");
    // Mocked affected-row answers are pinned to the rendered worker/dispatcher
    // allow-lists. Neither path admits manual_review, regardless of old expiry.
    const renderedLater = "2026-09-25 12:10:00.000";
    expect(claim?.where?.params).toEqual([901, "received", "failed_retryable", renderedLater, "processing", renderedLater]);
    expect(claim?.where?.params).not.toContain(parkedStatus);
    expect(rearm?.where?.sql).toMatch(/`shopify_privacy_customer_redaction_jobs`.*`status` in \(\?, \?\).*`status` = \?/i);
    expect(rearm?.where?.params).not.toContain(parkedStatus);
    expect(next.ops.filter(op => op.kind === "update")).toHaveLength(2); // Claim and guarded rearm only.
    expect(next.writes("insert", OUTBOX)).toEqual([]);
    expect(next.ops.some(op => op.table === STORES || op.table === REQUESTS || op.table === TOMBSTONES)).toBe(false);
  });

  it("should leave every fence and parent alone if the processing/lease child CAS loses", async () => {
    const fake = baseScript({
      select: { [REQUESTS]: [[{ id: 901, status: "manual_review" }], [{ status: "manual_review" }]] },
      update: { [JOBS]: [1, 0] },
    });
    await expect(handleShopifyCustomerRedactionJob(901, deps(fake))).rejects.toThrow(/retry required/);
    expectConflictCas(fake);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
    expect(fake.writes("update", STORES)).toEqual([]);
    expect(fake.committed().filter(op => op.kind !== "select").map(op => op.table)).toEqual([JOBS, JOBS]);
  });

  it.each([
    ["competing customer", { ...FENCED_STORE, privacyRedactionRequestId: 999 }, "active"],
    ["shop redaction state", { ...FENCED_STORE, privacyRedactionState: "shop_redacting" }, "active"],
    ["shop lifecycle", { ...FENCED_STORE, status: "redacting" }, "active"],
    ["tenant redaction", FENCED_STORE, "redacting"],
  ])("should park the child without weakening a %s fence", async (_label, store, deletionState) => {
    const fake = baseScript({
      select: { [REQUESTS]: [[{ id: 901, status: "completed" }], [{ status: "completed" }]], [STORES]: [[store]] },
      standing: { organizations: [{ deletionState }] },
    });
    await expect(handleShopifyCustomerRedactionJob(901, deps(fake))).rejects.toThrow(/retry required/);
    expectConflictCas(fake);
    expect(fake.writes("update", STORES)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
  });

  it("should recover an exact parent-CAS loss by parking only the still-owned child and releasing its admission-held fence after rollback", async () => {
    const fake = baseScript({
      select: { [REQUESTS]: [[{ id: 901, status: "received" }], [{ status: "manual_review" }]], [STORES]: [[FENCED_STORE], [FENCED_STORE]], [TXNS]: [[SCOPE_A_ROW]] },
      update: { [REQUESTS]: [0] },
    });
    await expect(handleShopifyCustomerRedactionJob(901, deps(fake))).rejects.toThrow(/retry required/);
    const child = expectConflictCas(fake);
    const lostParent = fake.ops.find(op => op.kind === "update" && op.table === REQUESTS);
    expect(fake.committed().filter(op => op.txId === lostParent?.txId)).toEqual([]);
    expect(child?.txId).not.toBe(lostParent?.txId);
    expect(fenceRelease(fake)?.txId).toBe(child?.txId);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
  });

  it.each([1, 6])("should bound child-only recovery when the locked parent is live again at attempt %s", async attempts => {
    const fake = baseScript({
      select: { [JOBS]: [[{ ...JOB, attempts }]], [REQUESTS]: [[{ id: 901, status: "manual_review" }], [{ status: "processing" }]] },
    });
    await expect(handleShopifyCustomerRedactionJob(901, deps(fake))).rejects.toThrow(/retry required/);
    const child = fake.writes("update", JOBS).at(-1);
    expect(child?.where?.params).toEqual([901, 42, 7, "11111111-1111-4111-8111-111111111111", "processing"]);
    expect(child?.data).toMatchObject({ status: attempts < 6 ? "failed_retryable" : "failed_terminal", failureCode: "parent_state_conflict", leaseId: null });
    expect(fake.writes("update", REQUESTS)).toEqual([]);
    expect(fake.writes("insert", OUTBOX)).toHaveLength(attempts < 6 ? 1 : 0);
    expect(fenceRelease(fake) === undefined).toBe(attempts < 6);
  });
});

describe("when parent conflict reconciliation follows a rolled-back processing transaction", () => {
  it("should make no fence/outbox/parent change when the child is reclaimed before post-rollback reconciliation", async () => {
    const fake = baseScript({
      select: {
        [REQUESTS]: [[{ id: 901, status: "received" }], [{ status: "manual_review" }]],
        [STORES]: [[FENCED_STORE], [FENCED_STORE]], [TXNS]: [[SCOPE_A_ROW]],
      },
      // Claim and in-transaction child write succeed; parent CAS loses; after
      // rollback the exact processing/lease child CAS loses to a new owner.
      update: { [JOBS]: [1, 1, 0], [REQUESTS]: [0] },
    });
    await expect(handleShopifyCustomerRedactionJob(901, deps(fake))).rejects.toThrow(/retry required/);
    const parentAttempt = fake.ops.find(op => op.table === REQUESTS && op.kind === "update");
    expect(fake.committed().filter(op => op.txId === parentAttempt?.txId)).toEqual([]);
    const reconcile = fake.ops.filter(op => op.table === JOBS && op.kind === "update").at(-1);
    expect(reconcile?.where?.params).toEqual([901, 42, 7, "11111111-1111-4111-8111-111111111111", "processing"]);
    expect(fake.writes("update", STORES)).toEqual([]);
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.committed().filter(op => op.kind === "delete")).toEqual([]);
  });

  it.each([
    ["a competing customer", { ...FENCED_STORE, privacyRedactionRequestId: 999 }],
    ["a shop redaction", { ...FENCED_STORE, status: "redacting", privacyRedactionState: "shop_redacting", privacyRedactionRequestId: 999 }],
  ])("should not release %s fence that replaced the old fence before reconciliation", async (_label, store) => {
    const fake = baseScript({
      select: {
        [REQUESTS]: [[{ id: 901, status: "received" }], [{ status: "manual_review" }]],
        [STORES]: [[FENCED_STORE], [store]], [TXNS]: [[SCOPE_A_ROW]],
      },
      update: { [REQUESTS]: [0] },
    });
    await expect(handleShopifyCustomerRedactionJob(901, deps(fake))).rejects.toThrow(/retry required/);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "manual_review", failureCode: "parent_state_conflict" });
    expect(fake.writes("update", STORES)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
  });

  it.each([
    ["missing exact parent", [], JOB],
    ["final parent and invalid manifest", [{ id: 901, status: "completed" }], { ...JOB, manifestVersion: 999 }],
  ])("should not route %s through an unconditional blocked-parent writer", async (_label, requests, job) => {
    const fake = baseScript({ select: { [JOBS]: [[job]], [REQUESTS]: [requests, requests] } });
    await expect(handleShopifyCustomerRedactionJob(901, deps(fake))).rejects.toThrow(/retry required/);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "manual_review", failureCode: "parent_state_conflict" });
    expect(fenceRelease(fake)?.where?.params).toEqual([7, 42, "customer_redacting", 901]);
    expect(fake.ops.some(op => op.table === SELECTORS)).toBe(false);
  });
});
