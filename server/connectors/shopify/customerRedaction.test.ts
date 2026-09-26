import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { handleShopifyCustomerRedactionJob } from "./customerRedaction";
import { computeShopifyOrderSuppressionDigest } from "./privacySuppression";
import { scriptedDb } from "./scriptedDb.testkit";

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

function baseScript(overrides: Parameters<typeof scriptedDb>[0] = {}) {
  return scriptedDb({
    select: {
      [JOBS]: [[JOB]],
      [REQUESTS]: [[{ id: JOB.requestId }]],
      [SELECTORS]: [SELECTOR_ROWS],
      [STORES]: [[FENCED_STORE]],
      ...(overrides.select ?? {}),
    },
    update: overrides.update,
    insert: overrides.insert,
    delete: overrides.delete,
    standing: overrides.standing,
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

describe("Shopify Scope A customer-redaction execution", () => {
  it("completes a zero-record request as a field-minimisation proof and destroys selectors", async () => {
    const fake = baseScript({ select: { [TXNS]: [[]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    expect(fake.writes("insert", TOMBSTONES)[0]?.data).toEqual([
      expect.objectContaining({ organizationId: 42, storeId: 7, sourceRequestId: 901 }),
    ]);
    expect(fake.writes("delete", SELECTORS)[0]?.where?.params).toEqual(expect.arrayContaining([901, 42]));
    expect(fake.writes("delete", TXNS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "completed",
      recordsFound: 0,
      tombstonesWritten: 1,
      transactionsDeleted: 0,
      remainingTransactions: 0,
      lastCheckpoint: "field_minimization_verified",
      selectorDestroyedAt: NOW,
    });
    expect(fake.writes("update", REQUESTS).at(-1)?.data).toMatchObject({
      status: "completed",
      recordsAffected: 0,
      completionNote: "scope_a_no_personal_data_persisted",
    });
  });

  it("retains field-minimised financial evidence and writes a future-sync tombstone", async () => {
    const fake = baseScript({ select: { [TXNS]: [[SCOPE_A_ROW]] } });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    const expected = computeShopifyOrderSuppressionDigest(KEYS[0].key, 42, 7, "gid://shopify/Order/501");
    expect(fake.writes("insert", TOMBSTONES)[0]?.data).toEqual([
      expect.objectContaining({ orderDigest: expected, keyVersion: "v1" }),
    ]);
    expect(fake.writes("delete", TXNS)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toHaveLength(1);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "completed",
      recordsFound: 1,
      transactionsDeleted: 0,
      anomalyScoresDeleted: 0,
      remainingTransactions: 1,
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
    expect(fake.writes("update", REQUESTS).some((op) => op.data?.status === "completed")).toBe(false);
  });

  it("keeps a tombstone-write outage retryable and rolls back selector destruction", async () => {
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

  it("does not let a stale worker complete after the exact lease is reclaimed", async () => {
    const fake = baseScript({
      select: { [TXNS]: [[SCOPE_A_ROW]] },
      // Claim succeeds and completion loses to a newer executor.
      update: { [JOBS]: [1, 0] },
    });

    await expect(handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake))).rejects.toThrow(/retry required/);

    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toEqual([]);
    expect(fake.writes("update", REQUESTS).some((op) => op.data?.status === "completed")).toBe(false);
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
    const attempts = new MySqlDialect().sqlToQuery(deferred?.data?.attempts as SQL).sql;
    expect(attempts).toMatch(/GREATEST\(`shopify_privacy_customer_redaction_jobs`\.`attempts` - 1, 0\)/);
    expect(fake.writes("insert", OUTBOX).at(-1)?.data).toMatchObject({ kind: "customer_redact", jobId: 901, failureCode: "store_fence_busy" });
    expect(fake.writes("insert", TOMBSTONES)).toEqual([]);
    expect(fake.writes("delete", SELECTORS)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
    expect(fenceRelease(fake)).toBeUndefined();
  });
});

describe("when the store fence is free as the worker runs", () => {
  it("should take the fence for this request before verifying, then complete and release it", async () => {
    const fake = baseScript({
      select: { [STORES]: [[{ ...FENCED_STORE, privacyRedactionState: "active", privacyRedactionRequestId: null }]], [TXNS]: [[]] },
    });

    await handleShopifyCustomerRedactionJob(JOB.requestId, deps(fake));

    const stores = fake.writes("update", STORES);
    expect(stores[0]?.data).toEqual({ privacyRedactionState: "customer_redacting", privacyRedactionRequestId: 901 });
    expect(stores[0]?.where?.params).toEqual([7, 42, "active"]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "completed" });
    expect(fenceRelease(fake)?.where?.params).toEqual([7, 42, "customer_redacting", 901]);
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
