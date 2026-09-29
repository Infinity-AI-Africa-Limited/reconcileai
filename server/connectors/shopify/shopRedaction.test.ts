import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SHOPIFY_SHOP_REDACTION_BLOCKER,
  handleShopifyShopRedactionJob,
} from "./shopRedaction";
import { scriptedDb } from "./scriptedDb.testkit";

const JOBS = "shopify_shop_redaction_jobs";
const REQUESTS = "shopify_privacy_requests";
const OUTBOX = "shopify_privacy_queue_outbox";
const STORES = "shopify_connector_stores";
const TOKENS = "shopify_connector_tokens";
const SELECTORS = "shopify_privacy_request_selectors";
const DATA_JOBS = "shopify_privacy_data_request_jobs";
const REDACTION_JOBS = "shopify_privacy_customer_redaction_jobs";
const ARTIFACTS = "shopify_privacy_artifacts";
const EVENTS = "shopify_webhook_events";
const CURSORS = "shopify_sync_cursors";
const TOMBSTONES = "shopify_order_redaction_tombstones";
const TRANSACTIONS = "transactions";
const CHANNELS = "channels";
const BATCHES = "upload_batches";
const MATCHES = "matches";
const EXCEPTIONS = "exceptions";
const ANOMALIES = "anomaly_scores";
const NOW = new Date("2026-09-25T12:00:00.000Z");

const JOB = {
  id: 903,
  organizationId: 42,
  storeId: 7,
  privacyRequestId: 904,
  requestHash: "request-digest",
  attempts: 1,
  manifestVersion: 1,
};

const COUNTS: Record<string, number> = {
  [STORES]: 1,
  [TOKENS]: 0,
  [REQUESTS]: 4,
  [SELECTORS]: 3,
  [DATA_JOBS]: 1,
  [REDACTION_JOBS]: 1,
  [ARTIFACTS]: 1,
  [EVENTS]: 8,
  [CURSORS]: 1,
  [TOMBSTONES]: 2,
  [TRANSACTIONS]: 6,
  [CHANNELS]: 1,
  [BATCHES]: 2,
  [MATCHES]: 9,
  [EXCEPTIONS]: 4,
  [ANOMALIES]: 3,
};

/** Tables counted twice per run: the orders channel first, then settlement evidence. */
const SETTLEMENT_COUNTS: Record<string, number> = {
  [TRANSACTIONS]: 5,
  [CHANNELS]: 1,
  [BATCHES]: 7,
};

function workerDb(options: {
  claimRows?: number[];
  finalRows?: number;
  counts?: Partial<Record<string, number>>;
} = {}) {
  const countRows = { ...COUNTS, ...options.counts };
  return scriptedDb({
    select: {
      [JOBS]: [[JOB], [JOB]],
      [REQUESTS]: [[{ id: 904 }], [{ count: countRows[REQUESTS] }], [{ id: 904 }], [{ count: countRows[REQUESTS] }]],
      [STORES]: [[{ count: countRows[STORES] }], [{ count: countRows[STORES] }]],
      [TOKENS]: [[{ count: countRows[TOKENS] }], [{ count: countRows[TOKENS] }]],
      [SELECTORS]: [[{ count: countRows[SELECTORS] }], [{ count: countRows[SELECTORS] }]],
      [DATA_JOBS]: [[{ count: countRows[DATA_JOBS] }], [{ count: countRows[DATA_JOBS] }]],
      [REDACTION_JOBS]: [[{ count: countRows[REDACTION_JOBS] }], [{ count: countRows[REDACTION_JOBS] }]],
      [ARTIFACTS]: [[{ count: countRows[ARTIFACTS] }], [{ count: countRows[ARTIFACTS] }]],
      [EVENTS]: [[{ count: countRows[EVENTS] }], [{ count: countRows[EVENTS] }]],
      [CURSORS]: [[{ count: countRows[CURSORS] }], [{ count: countRows[CURSORS] }]],
      [TOMBSTONES]: [[{ count: countRows[TOMBSTONES] }], [{ count: countRows[TOMBSTONES] }]],
      [TRANSACTIONS]: twice([{ count: countRows[TRANSACTIONS] }], [{ count: SETTLEMENT_COUNTS[TRANSACTIONS] }]),
      [CHANNELS]: twice([{ count: countRows[CHANNELS] }], [{ count: SETTLEMENT_COUNTS[CHANNELS] }]),
      [BATCHES]: twice([{ count: countRows[BATCHES] }], [{ count: SETTLEMENT_COUNTS[BATCHES] }]),
      [MATCHES]: [[{ count: countRows[MATCHES] }], [{ count: countRows[MATCHES] }]],
      [EXCEPTIONS]: [[{ count: countRows[EXCEPTIONS] }], [{ count: countRows[EXCEPTIONS] }]],
      [ANOMALIES]: [[{ count: countRows[ANOMALIES] }], [{ count: countRows[ANOMALIES] }]],
    },
    update: {
      [JOBS]: [...(options.claimRows ?? [1]), options.finalRows ?? 1],
    },
  });
}

/** One run's orders-then-settlement answers, for each of up to two runs. */
function twice(orders: unknown[], settlement: unknown[]): unknown[][] {
  return [orders, settlement, orders, settlement];
}

function uuidSequence() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

describe("when the report-only shop-redaction worker runs", () => {
  it("should allow only one worker to claim a job", async () => {
    const fake = workerDb({ claimRows: [1, 0] });
    const firstCheckpoint = vi.fn(async () => {});
    const secondCheckpoint = vi.fn(async () => {});

    await Promise.all([
      handleShopifyShopRedactionJob(903, {
        db: fake.db as never,
        now: () => NOW,
        uuid: uuidSequence(),
        afterManifest: firstCheckpoint,
      }),
      handleShopifyShopRedactionJob(903, {
        db: fake.db as never,
        now: () => NOW,
        uuid: uuidSequence(),
        afterManifest: secondCheckpoint,
      }),
    ]);

    expect(firstCheckpoint).toHaveBeenCalledTimes(1);
    expect(secondCheckpoint).not.toHaveBeenCalled();
    expect(fake.writes("update", JOBS).filter((op) => op.data?.status === "processing")).toHaveLength(2);
    expect(fake.writes("update", JOBS).filter((op) => op.data?.status === "blocked_dependency")).toHaveLength(1);
  });

  it("should keep an early redelivery retryable while another worker holds the lease", async () => {
    const fake = scriptedDb({
      select: { [JOBS]: [[{ status: "processing" }]] },
      update: { [JOBS]: [0] },
    });

    await expect(handleShopifyShopRedactionJob(903, { db: fake.db as never, now: () => NOW }))
      .rejects.toMatchObject({ name: "ShopifyPrivacyJobNotClaimableError" });

    expect(fake.writes("update", JOBS)).toHaveLength(1);
    expect(fake.ops.some((op) => op.kind === "update" && op.table === REQUESTS)).toBe(false);
  });

  it("should record only scoped numeric counts and end blocked, never completed", async () => {
    const fake = workerDb();

    await handleShopifyShopRedactionJob(903, {
      db: fake.db as never,
      now: () => NOW,
      uuid: () => "11111111-1111-4111-8111-111111111111",
    });

    const finalJob = fake.writes("update", JOBS).at(-1);
    expect(finalJob?.data).toMatchObject({
      status: "blocked_dependency",
      failureCode: SHOPIFY_SHOP_REDACTION_BLOCKER,
      lastCheckpoint: "report_only_manifest_recorded",
      completedAt: null,
      manifestSummary: {
        connectorStores: 1,
        connectorTokens: 0,
        privacyRequests: 4,
        privacySelectors: 3,
        dataRequestJobs: 1,
        customerRedactionJobs: 1,
        privacyArtifacts: 1,
        webhookEvents: 8,
        syncCursors: 1,
        suppressionTombstones: 2,
        orderTransactions: 6,
        directShopifyChannels: 1,
        directShopifyBatches: 2,
        settlementEvidenceChannels: 1,
        settlementEvidenceTransactions: 5,
        settlementEvidenceBatches: 7,
        reconciliationMatches: 9,
        reconciliationExceptions: 4,
        anomalyScores: 3,
      },
    });
    expect(Object.values((finalJob?.data?.manifestSummary ?? {}) as Record<string, unknown>)
      .every((value) => Number.isSafeInteger(value) && Number(value) >= 0)).toBe(true);
    expect(JSON.stringify(finalJob?.data?.manifestSummary)).not.toMatch(
      /domain|orderId|email|payload|objectKey|hash|webhookId|organizationId|storeId/i,
    );
    expect(fake.writes("update", REQUESTS).at(-1)?.data).toMatchObject({
      status: "blocked_dependency",
      completionNote: SHOPIFY_SHOP_REDACTION_BLOCKER,
      completedAt: null,
    });
    expect(fake.committed().some((op) => op.data?.status === "completed")).toBe(false);
    expect(fake.writes("delete", STORES)).toEqual([]);
    expect(fake.writes("delete", TRANSACTIONS)).toEqual([]);
    expect(fake.committed().filter((op) => op.kind !== "select" && ![JOBS, REQUESTS].includes(op.table))).toEqual([]);
  });

  it("should fence every count by exact organization and store/channel snapshot", async () => {
    const fake = workerDb();

    await handleShopifyShopRedactionJob(903, { db: fake.db as never, now: () => NOW });

    for (const table of [STORES, TOKENS, REQUESTS, SELECTORS, DATA_JOBS, REDACTION_JOBS, ARTIFACTS,
      EVENTS, CURSORS, TOMBSTONES, TRANSACTIONS, CHANNELS, BATCHES, MATCHES, EXCEPTIONS, ANOMALIES]) {
      const countSelect = fake.ops.find((op) => op.kind === "select" && op.table === table && op.where);
      expect(countSelect, `missing scoped count for ${table}`).toBeDefined();
      expect(countSelect?.where?.params).toContain(42);
    }
    for (const table of [STORES, TOKENS, REQUESTS, DATA_JOBS, REDACTION_JOBS, ARTIFACTS,
      EVENTS, CURSORS, TOMBSTONES, TRANSACTIONS, SELECTORS, MATCHES, EXCEPTIONS, ANOMALIES]) {
      const countSelect = fake.ops.find((op) => op.kind === "select" && op.table === table && op.where);
      expect(countSelect?.where?.params).toContain(7);
    }
    for (const table of [CHANNELS, BATCHES]) {
      const countSelect = fake.ops.find((op) => op.kind === "select" && op.table === table && op.where);
      expect(countSelect?.where?.params).toContain("shopify_orders_7");
    }
    expect(fake.ops.some((op) => op.kind === "select" && op.table === EVENTS && op.where?.params.includes(null))).toBe(false);
    // The two membership subqueries are ORM-built and correlated to the row counted.
    const selectorCount = fake.ops.find((op) => op.kind === "select" && op.table === "shopify_privacy_request_selectors");
    expect(selectorCount?.where?.sql).toMatch(
      /exists \(select `id` from `shopify_privacy_requests` where \(`shopify_privacy_requests`\.`id` = `shopify_privacy_request_selectors`\.`requestId`/i,
    );
    const batchCount = fake.ops.find((op) => op.kind === "select" && op.table === "upload_batches");
    expect(batchCount?.where?.sql).toMatch(/exists \(select `id` from `channels` where \(`channels`\.`id` = `upload_batches`\.`channelId`/i);
  });

  it("should prevent a stale worker from finalizing or changing the parent request", async () => {
    const fake = workerDb({ finalRows: 0 });
    const leaseId = "11111111-1111-4111-8111-111111111111";

    await handleShopifyShopRedactionJob(903, { db: fake.db as never, now: () => NOW, uuid: () => leaseId });

    const finalJob = fake.writes("update", JOBS).at(-1);
    expect(finalJob?.where?.params).toContain("processing");
    expect(finalJob?.where?.params).toContain(leaseId);
    expect(fake.writes("update", REQUESTS)).toEqual([]);
  });

  it("should re-arm only the matching internal outbox row after a report-only worker crash", async () => {
    const fake = workerDb();

    await handleShopifyShopRedactionJob(903, {
      db: fake.db as never,
      now: () => NOW,
      afterManifest: async () => {
        throw new Error("simulated_worker_crash");
      },
    });

    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "failed_retryable",
      failureCode: "worker_failed",
      completedAt: null,
    });
    const rearmed = fake.writes("update", OUTBOX).at(-1);
    expect(rearmed?.data).toMatchObject({
      status: "failed_retryable",
      failureCode: "worker_failed",
    });
    expect(rearmed?.where?.params).toContain("shop_redact");
    expect(rearmed?.where?.params).toContain(903);
    expect(fake.writes("update", REQUESTS).at(-1)?.data).toMatchObject({
      status: "failed_retryable",
      completionNote: "worker_failed",
      completedAt: null,
    });
  });

  it("should contain no destructive database or storage operation in the executor module", () => {
    const source = readFileSync(new URL("./shopRedaction.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.delete\s*\(/);
    expect(source).not.toMatch(/storage(Delete|Put|Get)|createAuditLog|tenantEncryptionKeys|\busers\b|\borganizations\b/);
    expect(source).not.toMatch(/status:\s*["']completed["']/);
    expect(source.match(/completedAt:\s*null/g)).toHaveLength(4);
  });
});

describe("when the store's data reaches beyond the orders channel", () => {
  // Greptile #161 (review of 21ba605): settlement evidence imported through App
  // Home lives in its own channel, on rows without `shopifyStoreId`, so the
  // inventory missed its channel, rows and batches. The reconciliation output
  // derived from the store's rows was missing too.
  const counted = (fake: ReturnType<typeof workerDb>, table: string) =>
    fake.ops.filter((op) => op.kind === "select" && op.table === table && op.where);

  it("should count settlement evidence by its own channel, scoped to the tenant", async () => {
    const fake = workerDb();
    await handleShopifyShopRedactionJob(903, { db: fake.db as never, now: () => NOW });

    for (const table of [TRANSACTIONS, CHANNELS, BATCHES]) {
      const settlement = counted(fake, table).find((op) => op.where?.params.includes("shopify_settlement_evidence_7"));
      expect(settlement, `no settlement-evidence count for ${table}`).toBeDefined();
      expect(settlement?.where?.params).toContain(42);
    }
  });

  it("should count matches, exceptions and anomaly scores from both the orders and the settlement rows", async () => {
    const fake = workerDb();
    await handleShopifyShopRedactionJob(903, { db: fake.db as never, now: () => NOW });

    for (const table of [MATCHES, EXCEPTIONS, ANOMALIES]) {
      const [op] = counted(fake, table);
      // Scoped to the tenant, and to the store's rows by either route.
      expect(op?.where?.params).toEqual(expect.arrayContaining([42, 7, "shopify_settlement_evidence_7"]));
      expect(op?.where?.sql).toMatch(/`transactions`\.`shopifyStoreId` = \?/);
    }
    const [matchCount] = counted(fake, MATCHES);
    expect(matchCount?.where?.sql).toMatch(/`matches`\.`sourceTransactionId` in \(select/);
    expect(matchCount?.where?.sql).toMatch(/`matches`\.`targetTransactionId` in \(select/);
  });
});
