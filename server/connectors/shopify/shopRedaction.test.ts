import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handleShopifyShopRedactionJob } from "./shopRedaction";
import { rowOf, scriptedDb } from "./scriptedDb.testkit";

const JOBS = "shopify_shop_redaction_jobs";
const REQUESTS = "shopify_privacy_requests";
const OUTBOX = "shopify_privacy_queue_outbox";
const STORES = "shopify_connector_stores";
const RECEIPTS = "shopify_shop_redaction_receipts";
const ORGANIZATIONS = "organizations";
const USERS = "users";
const ARTIFACTS = "shopify_privacy_artifacts";
const EXPORTS = "s3_csv_exports";
const BATCHES = "upload_batches";
const REPORTS = "reconciliation_reports";
const NOW = new Date("2026-10-16T07:30:00.000Z");

const JOB = {
  id: 903,
  runId: "00000000-0000-4000-8000-000000000903",
  organizationId: 42,
  storeId: 7,
  privacyRequestId: 904,
  requestHash: "request-digest",
  attempts: 1,
  manifestVersion: 1,
};

function workerDb(
  options: { unmanagedFile?: boolean; claimRows?: number[] } = {}
) {
  const select = (rows: unknown[]) => rows;
  return scriptedDb({
    standing: {
      // The manifest reads every tenant-scoped table as a count. A standing count
      // lets this fixture prove erasure behavior without embedding merchant data.
      shopify_connector_tokens: [{ count: 0 }],
      shopify_privacy_request_selectors: [{ count: 0 }],
      shopify_privacy_data_request_jobs: [{ count: 0 }],
      shopify_privacy_customer_redaction_jobs: [{ count: 0 }],
      shopify_webhook_events: [{ count: 0 }],
      shopify_sync_cursors: [{ count: 0 }],
      shopify_order_redaction_tombstones: [{ count: 0 }],
      transactions: [{ count: 0 }],
      channels: [{ count: 0 }],
      matches: [{ count: 0 }],
      exceptions: [{ count: 0 }],
      anomaly_scores: [{ count: 0 }],
    },
    select: {
      [JOBS]: [
        select([JOB]),
        select([{ shopDomain: "erasure-test.myshopify.com" }]),
      ],
      [REQUESTS]: [select([{ id: 904 }]), select([{ count: 0 }])],
      [STORES]: [select([{ count: 1 }])],
      [ARTIFACTS]: [
        select([{ count: 1 }]),
        select([{ key: "org/42/privacy/redaction.zip" }]),
      ],
      [EXPORTS]: [select([{ key: "org/42/exports/evidence.xlsx" }])],
      [BATCHES]: [
        select([{ count: 0 }]),
        select([{ count: 0 }]),
        select([{ count: options.unmanagedFile ? 1 : 0 }]),
      ],
      [REPORTS]: [select([{ count: 0 }])],
    },
    update: { [JOBS]: options.claimRows ?? [1] },
  });
}

describe("when the destructive Shopify shop-redaction worker runs", () => {
  it("should erase owned storage and tenant records while retaining only a non-identifying receipt", async () => {
    const fake = workerDb();
    const deleteObject = vi.fn(async () => {});

    await handleShopifyShopRedactionJob(903, {
      db: fake.db as never,
      now: () => NOW,
      uuid: () => "11111111-1111-4111-8111-111111111111",
      deleteObject,
    });

    expect(deleteObject).toHaveBeenCalledWith("org/42/privacy/redaction.zip");
    expect(deleteObject).toHaveBeenCalledWith("org/42/exports/evidence.xlsx");
    expect(fake.writes("delete", STORES)).toHaveLength(1);
    expect(fake.writes("delete", USERS)).toHaveLength(1);
    expect(fake.writes("delete", ORGANIZATIONS)).toHaveLength(1);
    expect(fake.writes("delete", JOBS)).toHaveLength(1);
    const receipt = rowOf(fake.writes("insert", RECEIPTS)[0]);
    expect(receipt).toMatchObject({
      runId: JOB.runId,
      requestHash: JOB.requestHash,
      manifestVersion: 1,
      completedAt: NOW,
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /organizationId|storeId|domain|orderId|email|payload|objectKey|url/i
    );
    expect(fake.writes("update", REQUESTS)).toEqual([]);
  });

  it("should stop before destructive database writes and retain a retry when object deletion fails", async () => {
    const fake = workerDb();
    await handleShopifyShopRedactionJob(903, {
      db: fake.db as never,
      now: () => NOW,
      deleteObject: async () => {
        throw new Error("object_store_temporarily_unavailable");
      },
    });

    expect(fake.writes("delete", STORES)).toEqual([]);
    expect(fake.writes("delete", ORGANIZATIONS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "failed_retryable",
      failureCode: "worker_failed",
      completedAt: null,
    });
    expect(fake.writes("update", OUTBOX).at(-1)?.data).toMatchObject({
      status: "failed_retryable",
    });
  });

  it("should fail closed for an unmanaged legacy file reference rather than claim deletion", async () => {
    const fake = workerDb({ unmanagedFile: true });
    const deleteObject = vi.fn(async () => {});

    await handleShopifyShopRedactionJob(903, {
      db: fake.db as never,
      now: () => NOW,
      deleteObject,
    });

    expect(fake.writes("delete", STORES)).toEqual([]);
    expect(fake.writes("insert", RECEIPTS)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "manual_review",
      failureCode: "unmanaged_file_reference",
      completedAt: null,
    });
  });

  it("should preserve an early redelivery when another worker still holds the lease", async () => {
    const fake = scriptedDb({
      select: { [JOBS]: [[{ status: "processing" }]] },
      update: { [JOBS]: [0] },
    });
    await expect(
      handleShopifyShopRedactionJob(903, {
        db: fake.db as never,
        now: () => NOW,
      })
    ).rejects.toMatchObject({ name: "ShopifyPrivacyJobNotClaimableError" });
  });

  it("should leave destructive erasure retryable if the process fails after inventory", async () => {
    const fake = workerDb();
    await handleShopifyShopRedactionJob(903, {
      db: fake.db as never,
      now: () => NOW,
      afterManifest: async () => {
        throw new Error("simulated_crash_after_inventory");
      },
    });
    expect(fake.writes("delete", STORES)).toEqual([]);
    expect(fake.writes("update", JOBS).at(-1)?.data).toMatchObject({
      status: "failed_retryable",
    });
  });

  it("should contain storage-first deletion, a lease-fenced database transaction, and no report-only blocker", () => {
    const source = readFileSync(
      new URL("./shopRedaction.ts", import.meta.url),
      "utf8"
    );
    expect(source).toMatch(/deleteTenantObjects\(\s*db,\s*job\.organizationId/);
    expect(source).toMatch(/eraseTenantWorkspace\(db, job, manifest, now\)/);
    expect(source).toMatch(
      /eq\(shopifyShopRedactionJobs\.leaseId, job\.leaseId\)/
    );
    expect(source).toMatch(/shopifyShopRedactionReceipts/);
    expect(source).not.toMatch(
      /automatic_deletion_not_enabled|report_only_manifest_recorded/
    );
  });
});
