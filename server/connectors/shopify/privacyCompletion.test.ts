import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeAndPreparePrivacyDownload,
  canonicalShopifyOrderGid,
  cleanupExpiredShopifyPrivacyArtifacts,
  dispatchShopifyPrivacyOutbox,
  handleShopifyPrivacyJob,
  mayDownloadShopifyPrivacyArtifact,
  serializeShopifyPrivacyArtifact,
  type AuthorizedPrivacyArtifact,
  type PrivacyDownloadActor,
} from "./privacyCompletion";
import { scriptedDb } from "./scriptedDb.testkit";

const JOBS = "shopify_privacy_data_request_jobs";
const OUTBOX = "shopify_privacy_queue_outbox";
const REQUESTS = "shopify_privacy_requests";
const SELECTORS = "shopify_privacy_request_selectors";
const STORES = "shopify_connector_stores";
const ARTIFACTS = "shopify_privacy_artifacts";
const USERS = "users";
const TXNS = "transactions";
const MATCHES = "matches";
const EXCEPTIONS = "exceptions";
const ANOMALIES = "anomaly_scores";
const AUDIT = "audit_logs";
const NOW = new Date("2026-09-25T12:00:00.000Z");
const LATER = new Date("2026-09-25T13:00:00.000Z");

const JOB = {
  requestId: 901,
  organizationId: 42,
  storeId: 7,
  attempts: 1,
  manifestVersion: 1,
};
const STORE = { id: 7, organizationId: 42, claimedByUserId: 9 };
const ADMIN = { id: 9 };
const SELECTOR_ROWS = [
  { resourceType: "customer", position: 0, externalIdEnc: "enc-customer" },
  { resourceType: "order", position: 0, externalIdEnc: "enc-order-501" },
];
const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function uuidSequence() {
  let index = 0;
  return () => UUIDS[index++] ?? "44444444-4444-4444-8444-444444444444";
}

function artifactRow(recordsFound: number, status: "writing" | "ready" = "writing") {
  return {
    requestId: 901,
    organizationId: 42,
    storeId: 7,
    publicId: UUIDS[1],
    schemaVersion: 1,
    artifactKind: recordsFound ? "order_evidence" : "zero_record_attestation",
    objectKey: `org/42/privacy/shopify/901/${UUIDS[2]}.json`,
    sha256: status === "ready" ? "a".repeat(64) : null,
    sizeBytes: status === "ready" ? 123 : null,
    recordsFound,
    zeroReasonCode: recordsFound ? null : "no_customer_profile_fields_and_no_requested_orders_found",
    status,
    recipientUserId: 9,
    deliveryChannel: "authenticated_portal",
    deliveryStatus: "pending",
    deliveryAcceptedAt: null,
    generatedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    downloadedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function baseWorkerScript(overrides: Parameters<typeof scriptedDb>[0] = {}) {
  return scriptedDb({
    select: {
      [JOBS]: [[JOB]],
      [REQUESTS]: [[{ id: 901 }]],
      [STORES]: [[STORE]],
      [USERS]: [[ADMIN]],
      [SELECTORS]: [SELECTOR_ROWS],
      ...(overrides.select ?? {}),
    },
    update: overrides.update,
    insert: overrides.insert,
    delete: overrides.delete,
    standing: overrides.standing,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("Shopify privacy outbox recovery", () => {
  it("should recover committed admission using only kind and internal job id", async () => {
    const fake = scriptedDb({
      select: { [OUTBOX]: [[{ id: 77, kind: "customer_request", jobId: 901, attempts: 0 }]] },
    });
    const enqueue = vi.fn(async () => {});

    const result = await dispatchShopifyPrivacyOutbox({
      db: fake.db as never,
      now: () => NOW,
      uuid: uuidSequence(),
      enqueue,
    });

    expect(result).toEqual({ scanned: 1, dispatched: 1, failed: 0 });
    expect(enqueue).toHaveBeenCalledWith({ kind: "customer_request", jobId: 901 });
    expect(Object.keys(enqueue.mock.calls[0][0])).toEqual(["kind", "jobId"]);
    expect(JSON.stringify(enqueue.mock.calls[0][0])).not.toMatch(/organization|store|shop|domain|selector|hash|url/i);
    expect(fake.writes("update", OUTBOX).at(-1)?.data).toMatchObject({ status: "dispatched" });
  });

  it("should let only one competing claim publish and recover an expired dispatch lease", async () => {
    const candidate = { id: 77, kind: "customer_request", jobId: 901, attempts: 1 };
    const fake = scriptedDb({
      select: { [OUTBOX]: [[candidate, candidate]] },
      update: { [OUTBOX]: [1, 1, 0] },
    });
    const enqueue = vi.fn(async () => {});

    const result = await dispatchShopifyPrivacyOutbox({
      db: fake.db as never,
      now: () => LATER,
      uuid: uuidSequence(),
      enqueue,
    });

    expect(result.dispatched).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(fake.writes("update", OUTBOX)[0]?.where?.params).toContain("dispatching");
  });

  it("should persist a bounded retryable queue failure and never mark it dispatched", async () => {
    const fake = scriptedDb({
      select: { [OUTBOX]: [[{ id: 77, kind: "customer_request", jobId: 901, attempts: 0 }]] },
    });
    const result = await dispatchShopifyPrivacyOutbox({
      db: fake.db as never,
      now: () => NOW,
      uuid: uuidSequence(),
      enqueue: vi.fn(async () => { throw new Error("contains-sensitive-provider-value"); }),
    });

    expect(result.failed).toBe(1);
    const failure = fake.writes("update", OUTBOX).at(-1)?.data;
    expect(failure).toMatchObject({ status: "failed_retryable", failureCode: "durable_queue_unavailable" });
    expect(JSON.stringify(failure)).not.toContain("contains-sensitive-provider-value");
    expect(fake.committed().flatMap((op) => Object.values(op.data ?? {}))).not.toContain("contains-sensitive-provider-value");
  });

  it("should keep an acknowledged request dispatchable after repeated queue failures", async () => {
    const fake = scriptedDb({
      select: {
        [OUTBOX]: [
          [{ id: 77, kind: "customer_request", jobId: 901, attempts: 5 }],
          [{ id: 77, kind: "customer_request", jobId: 901, attempts: 6 }],
        ],
      },
    });
    const enqueue = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary durable queue outage"))
      .mockResolvedValueOnce();

    const failed = await dispatchShopifyPrivacyOutbox({
      db: fake.db as never,
      now: () => NOW,
      uuid: uuidSequence(),
      enqueue,
    });
    const recovered = await dispatchShopifyPrivacyOutbox({
      db: fake.db as never,
      now: () => LATER,
      uuid: uuidSequence(),
      enqueue,
    });

    expect(failed).toEqual({ scanned: 1, dispatched: 0, failed: 1 });
    expect(recovered).toEqual({ scanned: 1, dispatched: 1, failed: 0 });
    const writes = fake.writes("update", OUTBOX).map((operation) => operation.data);
    expect(writes).toContainEqual(expect.objectContaining({ status: "failed_retryable", failureCode: "durable_queue_unavailable" }));
    expect(writes).toContainEqual(expect.objectContaining({ status: "dispatched" }));
    expect(writes.map((write) => (write as Record<string, unknown> | null)?.status)).not.toContain("failed_terminal");
  });
});

describe("Shopify data-request execution", () => {
  it("should map only canonical decimal selectors to exact Order GIDs", () => {
    expect(canonicalShopifyOrderGid("501")).toBe("gid://shopify/Order/501");
    for (const invalid of ["0", "-1", "+1", "01", "1.0", " 1", "gid://shopify/Order/1"]) {
      expect(canonicalShopifyOrderGid(invalid)).toBeNull();
    }
  });

  it("should create a field-minimized positive export under a private org key", async () => {
    const fake = baseWorkerScript({
      select: {
        [JOBS]: [[JOB]], [REQUESTS]: [[{ id: 901 }]], [STORES]: [[STORE]], [USERS]: [[ADMIN]],
        [SELECTORS]: [SELECTOR_ROWS],
        [TXNS]: [[{
          id: 3001,
          providerOrderGid: "gid://shopify/Order/501",
          displayName: "#1001",
          amount: "125.50",
          currency: "USD",
          orderCurrency: "USD",
          createdAt: new Date("2026-09-20T10:00:00Z"),
          processedAt: new Date("2026-09-20T10:05:00Z"),
          updatedAt: new Date("2026-09-20T11:00:00Z"),
          cancelledAt: null,
          financialStatus: "PAID",
          reconciliationStatus: "unmatched",
          debitCredit: "credit",
          isReversal: false,
          matchId: null,
          rawData: null,
        }]],
        [MATCHES]: [[]], [EXCEPTIONS]: [[]], [ANOMALIES]: [[]], [AUDIT]: [[]],
        [ARTIFACTS]: [[], [artifactRow(1)]],
      },
    });
    const putObject = vi.fn(async (key: string, bytes: Buffer) => ({ key, url: "must-not-persist" }));

    await handleShopifyPrivacyJob(
      { kind: "customer_request", jobId: 901 },
      {
        db: fake.db as never,
        now: () => NOW,
        uuid: uuidSequence(),
        decrypt: vi.fn(async (_org, value) => value === "enc-customer" ? "41" : "501"),
        putObject,
      },
    );

    expect(putObject).toHaveBeenCalledTimes(1);
    const [key, bytes] = putObject.mock.calls[0];
    expect(key).toMatch(/^org\/42\/privacy\/shopify\/901\/[0-9a-f-]+\.json$/);
    const document = JSON.parse(bytes.toString("utf8"));
    expect(document).toEqual({
      schema: "reconcileai.shopify.customer_data_request",
      version: 1,
      generatedAt: NOW.toISOString(),
      result: "order_evidence",
      recordsFound: 1,
      orders: [{
        providerOrderGid: "gid://shopify/Order/501",
        displayName: "#1001",
        amount: "125.50",
        currency: "USD",
        orderCurrency: "USD",
        createdAt: "2026-09-20T10:00:00.000Z",
        processedAt: "2026-09-20T10:05:00.000Z",
        updatedAt: "2026-09-20T11:00:00.000Z",
        cancelledAt: null,
        financialStatus: "PAID",
        reconciliationStatus: "unmatched",
        debitCredit: "credit",
        isReversal: false,
      }],
    });
    for (const forbidden of ["organizationId", "storeId", "userId", "channelId", "batchId", "matchId", "rawData", "customerId", "selector", "token", "url"]) {
      expect(bytes.toString("utf8")).not.toContain(forbidden);
    }
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "awaiting_delivery", recordsFound: 1 });
    expect(fake.writes("update", REQUESTS).at(-1)?.data).toMatchObject({ status: "awaiting_delivery" });
    expect(fake.committed().flatMap((op) => Object.values(op.data ?? {}))).not.toContain("must-not-persist");
    expect(fake.ops.find((op) => op.kind === "select" && op.table === TXNS)?.where?.params).toEqual(
      expect.arrayContaining([42, 7, "gid://shopify/Order/501"]),
    );
  });

  it("should produce an explicit zero-record attestation rather than a silent completion", async () => {
    const fake = baseWorkerScript({
      select: {
        [JOBS]: [[JOB]], [REQUESTS]: [[{ id: 901 }]], [STORES]: [[STORE]], [USERS]: [[ADMIN]],
        [SELECTORS]: [SELECTOR_ROWS], [TXNS]: [[]], [ARTIFACTS]: [[], [artifactRow(0)]],
      },
    });
    const putObject = vi.fn(async (key: string, bytes: Buffer) => ({ key, url: "unused" }));

    await handleShopifyPrivacyJob(
      { kind: "customer_request", jobId: 901 },
      {
        db: fake.db as never,
        now: () => NOW,
        uuid: uuidSequence(),
        decrypt: vi.fn(async (_org, value) => value === "enc-customer" ? "41" : "501"),
        putObject,
      },
    );

    const document = JSON.parse(putObject.mock.calls[0][1].toString("utf8"));
    expect(document).toMatchObject({
      version: 1,
      result: "zero_record_attestation",
      recordsFound: 0,
      reasonCode: "no_customer_profile_fields_and_no_requested_orders_found",
      selectorDisposition: "deleted_after_authenticated_delivery",
    });
    expect(fake.writes("update", REQUESTS).at(-1)?.data).toMatchObject({ status: "awaiting_delivery" });
    expect(fake.writes("update", REQUESTS).some((op) => op.data?.status === "completed")).toBe(false);
  });

  it("should block selected orders with downstream evidence and create no artifact", async () => {
    const fake = baseWorkerScript({
      select: {
        [JOBS]: [[JOB]], [REQUESTS]: [[{ id: 901 }]], [STORES]: [[STORE]], [USERS]: [[ADMIN]],
        [SELECTORS]: [SELECTOR_ROWS],
        [TXNS]: [[{
          id: 3001, providerOrderGid: "gid://shopify/Order/501", displayName: "#1001", amount: "1.00",
          currency: "USD", orderCurrency: "USD", createdAt: NOW, processedAt: null, updatedAt: NOW,
          cancelledAt: null, financialStatus: "PAID", reconciliationStatus: "matched", debitCredit: "credit",
          isReversal: false, matchId: 88, rawData: null,
        }]],
      },
    });
    const putObject = vi.fn();

    await handleShopifyPrivacyJob(
      { kind: "customer_request", jobId: 901 },
      { db: fake.db as never, now: () => NOW, uuid: uuidSequence(), decrypt: vi.fn(async (_o, v) => v === "enc-customer" ? "41" : "501"), putObject },
    );

    expect(putObject).not.toHaveBeenCalled();
    expect(fake.writes("insert", ARTIFACTS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "blocked_dependency",
      failureCode: "downstream_evidence_present",
    });
  });

  it("should preserve tenant/store isolation in the only business-row lookup", async () => {
    const fake = baseWorkerScript({
      select: {
        [JOBS]: [[JOB]], [REQUESTS]: [[{ id: 901 }]], [STORES]: [[STORE]], [USERS]: [[ADMIN]],
        [SELECTORS]: [SELECTOR_ROWS], [TXNS]: [[]], [ARTIFACTS]: [[], [artifactRow(0)]],
      },
    });
    await handleShopifyPrivacyJob(
      { kind: "customer_request", jobId: 901 },
      { db: fake.db as never, now: () => NOW, uuid: uuidSequence(), decrypt: vi.fn(async (_o, v) => v === "enc-customer" ? "41" : "501"), putObject: vi.fn(async (key) => ({ key, url: "unused" })) },
    );
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === TXNS);
    expect(lookup?.where?.params).toEqual(expect.arrayContaining([42, 7, "gid://shopify/Order/501"]));
    expect(lookup?.where?.sql).not.toMatch(/email|name|description|counterparty|rawData|json/i);
  });

  it("should use manual review when no verified active claiming admin exists", async () => {
    const fake = baseWorkerScript({
      select: {
        [JOBS]: [[JOB]], [REQUESTS]: [[{ id: 901 }]], [STORES]: [[{ ...STORE, claimedByUserId: null }]],
      },
    });
    await handleShopifyPrivacyJob({ kind: "customer_request", jobId: 901 }, { db: fake.db as never, now: () => NOW, uuid: uuidSequence() });
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "manual_review",
      failureCode: "merchant_admin_unavailable",
    });
    expect(fake.writes("update", REQUESTS).some((op) => op.data?.status === "completed")).toBe(false);
  });

  it("should bound selector failures without leaking decrypted values or becoming completed", async () => {
    const fake = baseWorkerScript();
    await handleShopifyPrivacyJob(
      { kind: "customer_request", jobId: 901 },
      { db: fake.db as never, now: () => NOW, uuid: uuidSequence(), decrypt: vi.fn(async (_o, value) => value === "enc-customer" ? "41" : "sensitive-bad-value") },
    );
    const persistedValues = fake.committed().flatMap((op) => Object.values(op.data ?? {}));
    expect(persistedValues).not.toContain("sensitive-bad-value");
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "manual_review", failureCode: "selector_integrity_failed" });
    expect(persistedValues).not.toContain("completed");
  });

  it("should be idempotent when a completed or concurrently leased job cannot be claimed", async () => {
    const fake = scriptedDb({ update: { [JOBS]: [0] } });
    const putObject = vi.fn();
    await handleShopifyPrivacyJob({ kind: "customer_request", jobId: 901 }, { db: fake.db as never, putObject });
    expect(putObject).not.toHaveBeenCalled();
    expect(fake.writes("insert", ARTIFACTS)).toEqual([]);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
  });

  it("should never convert a retryable worker failure into completion", async () => {
    const fake = baseWorkerScript({ select: { [JOBS]: [[JOB]], [REQUESTS]: [[{ id: 901 }]], [STORES]: [[STORE]], [USERS]: [[ADMIN]], [SELECTORS]: [SELECTOR_ROWS], [TXNS]: [[]], [ARTIFACTS]: [[], [artifactRow(0)]] } });
    await expect(handleShopifyPrivacyJob(
      { kind: "customer_request", jobId: 901 },
      { db: fake.db as never, now: () => NOW, uuid: uuidSequence(), decrypt: vi.fn(async (_o, v) => v === "enc-customer" ? "41" : "501"), putObject: vi.fn(async () => { throw new Error("secret-provider-error"); }) },
    )).rejects.toThrow("retry required");
    const persistedValues = fake.committed().flatMap((op) => Object.values(op.data ?? {}));
    expect(persistedValues).not.toContain("secret-provider-error");
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "failed_retryable", failureCode: "worker_failed" });
    expect(persistedValues).not.toContain("completed");
  });
});

describe("privacy artifact authorization and lifecycle", () => {
  const artifact: AuthorizedPrivacyArtifact = {
    requestId: 901,
    organizationId: 42,
    storeId: 7,
    objectKey: `org/42/privacy/shopify/901/${UUIDS[2]}.json`,
    expiresAt: new Date("2026-09-26T12:00:00Z"),
    recipientUserId: 9,
    claimedByUserId: 9,
    status: "ready",
    deliveryStatus: "pending",
    schemaVersion: 1,
    sha256: "a".repeat(64),
    sizeBytes: 123,
  };
  const actor: PrivacyDownloadActor = { id: 9, organizationId: 42, role: "admin", isActive: true };

  it("should deny logged-out, cross-tenant, non-admin, inactive, non-claimant and expired access", () => {
    expect(mayDownloadShopifyPrivacyArtifact(null, artifact, NOW)).toBe(false);
    expect(mayDownloadShopifyPrivacyArtifact({ ...actor, organizationId: 43 }, artifact, NOW)).toBe(false);
    expect(mayDownloadShopifyPrivacyArtifact({ ...actor, role: "operations" }, artifact, NOW)).toBe(false);
    expect(mayDownloadShopifyPrivacyArtifact({ ...actor, isActive: false }, artifact, NOW)).toBe(false);
    expect(mayDownloadShopifyPrivacyArtifact({ ...actor, id: 10 }, artifact, NOW)).toBe(false);
    expect(mayDownloadShopifyPrivacyArtifact(actor, { ...artifact, expiresAt: NOW }, NOW)).toBe(false);
    expect(mayDownloadShopifyPrivacyArtifact(actor, { ...artifact, sha256: null }, NOW)).toBe(false);
  });

  it("should issue a five-minute link only after audited claimant-admin authorization and persist delivery evidence", async () => {
    const fake = scriptedDb();
    const getObject = vi.fn(async () => ({ key: artifact.objectKey, url: "https://short.example/signed" }));
    const audit = vi.fn(async () => 1);
    const url = await authorizeAndPreparePrivacyDownload({ db: fake.db as never, actor, artifact, now: NOW, getObject, audit: audit as never });
    expect(url).toBe("https://short.example/signed");
    expect(getObject).toHaveBeenCalledWith(artifact.objectKey, 300);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 42,
      userId: 9,
      action: "shopify_privacy_artifact_access",
      details: { decision: "allowed", channel: "authenticated_portal" },
    }));
    expect(fake.writes("delete", SELECTORS)[0]?.where?.params).toEqual(expect.arrayContaining([901, 42]));
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "completed", selectorDestroyedAt: NOW });
    expect(fake.writes("update", REQUESTS).at(-1)?.data).toMatchObject({ status: "completed", completedAt: NOW });
  });

  it("should clean expired objects idempotently and move undelivered work to manual review", async () => {
    const fake = scriptedDb({ select: { [ARTIFACTS]: [[{
      requestId: 901, organizationId: 42, storeId: 7, objectKey: artifact.objectKey, deliveryStatus: "pending",
    }], []] } });
    const deleteObject = vi.fn(async () => {});
    expect(await cleanupExpiredShopifyPrivacyArtifacts({ db: fake.db as never, now: () => NOW, deleteObject })).toBe(1);
    expect(await cleanupExpiredShopifyPrivacyArtifacts({ db: fake.db as never, now: () => NOW, deleteObject })).toBe(0);
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(fake.writes("update", ARTIFACTS)[0]?.data).toMatchObject({ status: "deleted", deletedAt: NOW });
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({ status: "manual_review", failureCode: "artifact_expired" });
    expect(fake.writes("update", REQUESTS).at(-1)?.data).toMatchObject({ status: "manual_review" });
  });

  it("should serialize deterministic exact bytes for digest evidence", () => {
    const bytes = serializeShopifyPrivacyArtifact({
      schema: "reconcileai.shopify.customer_data_request",
      version: 1,
      generatedAt: NOW.toISOString(),
      result: "zero_record_attestation",
      recordsFound: 0,
      reasonCode: "no_customer_profile_fields_and_no_requested_orders_found",
      statement: "none",
      selectorDisposition: "deleted_after_authenticated_delivery",
      dataClassesNotStored: ["email"],
    });
    expect(bytes.toString("utf8")).toBe(`${JSON.stringify(JSON.parse(bytes.toString("utf8")))}\n`);
  });
});
