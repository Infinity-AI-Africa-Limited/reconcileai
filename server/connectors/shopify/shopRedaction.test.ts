import { getTableColumns, getTableName } from "drizzle-orm";
import { MySqlDialect, MySqlTable } from "drizzle-orm/mysql-core";
import { describe, expect, it, vi } from "vitest";
import * as mainSchema from "../../../drizzle/schema";
import * as woodcoreSchema from "../../../drizzle/woodcore_schema";
import * as pocSchema from "../../../drizzle/poc_schema";
import * as mmSchema from "../../../drizzle/mobile_money_schema";
import * as connectorSchema from "../../../drizzle/connector_schema";
import * as tenantSchema from "../../../drizzle/tenant_schema";
import * as shopifySchema from "../../../drizzle/shopify_schema";
import {
  handleShopifyShopRedactionJob,
  SHOPIFY_SHOP_REDACTION_UPLOAD_SETTLE_MS,
  storageChangedSince,
  tenantOutboxRows,
  tenantStoragePrefixes,
  type ShopRedactionStorageInventory,
} from "./shopRedaction";
import { TENANT_UPLOAD_DEADLINE_MS } from "../../tenantStorage";
import { rowOf, scriptedDb, type RecordedOp } from "./scriptedDb.testkit";

const JOBS = "shopify_shop_redaction_jobs";
const REQUESTS = "shopify_privacy_requests";
const OUTBOX = "shopify_privacy_queue_outbox";
const STORES = "shopify_connector_stores";
const LEASES = "shopify_install_leases";
const RECEIPTS = "shopify_shop_redaction_receipts";
const ORGANIZATIONS = "organizations";
const USERS = "users";
const ARTIFACTS = "shopify_privacy_artifacts";
const DATA_JOBS = "shopify_privacy_data_request_jobs";
const EXPORTS = "s3_csv_exports";
const BATCHES = "upload_batches";
const REPORTS = "reconciliation_reports";
const BUCKET_SOURCES = "bucket_ingestion_sources";
const NOW = new Date("2026-10-16T07:30:00.000Z");
const MEMBER = 5;

const JOB = {
  id: 903,
  runId: "00000000-0000-4000-8000-000000000903",
  organizationId: 42,
  storeId: 7,
  privacyRequestId: 904,
  requestHash: "request-digest",
  attempts: 1,
  manifestVersion: 1,
  // First claimed long enough ago that no upload can still be landing.
  startedAt: new Date(NOW.getTime() - 10 * 60_000),
};
const SIBLING = {
  id: 950,
  runId: "00000000-0000-4000-8000-000000000950",
  storeId: 8,
  requestHash: "sibling-digest",
};
const ARTIFACT = {
  key: "org/42/privacy/shopify/904/export.json",
  status: "ready",
  sha256: "a".repeat(64),
};
const TRACKED_EXPORT = "csv-exports/cfo/5/1-report.csv";

type Rows = unknown[];
interface Fixture {
  bucketSourceOnPlatform?: boolean;
  job?: Record<string, unknown>;
  organization?: Rows;
  organizationInTx?: Rows;
  unmanagedFile?: boolean;
  liveLeaseBefore?: Rows;
  liveLeaseInTx?: Rows;
  artifactsInTx?: Rows;
  exportsInTx?: Rows;
  siblings?: Rows;
  claimRows?: number[];
}

function workerDb(fixture: Fixture = {}) {
  const redacting = [{ deletionState: "redacting" }];
  return scriptedDb({
    standing: {
      // The manifest reads every tenant-scoped table as a count. A standing count
      // lets this fixture prove erasure behavior without embedding merchant data.
      shopify_connector_tokens: [{ count: 0 }],
      shopify_privacy_request_selectors: [{ count: 0 }],
      shopify_privacy_customer_redaction_jobs: [{ count: 0 }],
      shopify_webhook_events: [{ count: 0 }],
      shopify_sync_cursors: [{ count: 0 }],
      shopify_order_redaction_tombstones: [{ count: 0 }],
      transactions: [{ count: 0 }],
      channels: [{ count: 0 }],
      matches: [{ count: 0 }],
      exceptions: [{ count: 0 }],
      anomaly_scores: [{ count: 0 }],
      upload_batches: [{ count: 0 }],
      bucket_ingestion_sources: [{ count: 0 }],
    },
    select: {
      [JOBS]: [
        [{ ...JOB, ...fixture.job }],
        [{ shopDomain: "erasure-test.myshopify.com" }],
        fixture.siblings ?? [],
      ],
      [REQUESTS]: [[{ id: 904 }], [{ count: 1 }]],
      [ORGANIZATIONS]: [
        fixture.organization ?? redacting,
        fixture.organizationInTx ?? redacting,
      ],
      [STORES]: [
        [{ count: 1 }],
        [
          { shopDomain: "erasure-test.myshopify.com" },
          ...(fixture.siblings?.length
            ? [{ shopDomain: "erasure-sibling.myshopify.com" }]
            : []),
        ],
      ],
      [DATA_JOBS]: [
        [{ count: 0 }],
        fixture.liveLeaseBefore ?? [],
        fixture.liveLeaseInTx ?? [],
      ],
      [ARTIFACTS]: [[{ count: 1 }], [ARTIFACT], fixture.artifactsInTx ?? [ARTIFACT]],
      [EXPORTS]: [[{ key: TRACKED_EXPORT }], fixture.exportsInTx ?? [{ key: TRACKED_EXPORT }]],
      [USERS]: [[{ id: MEMBER }]],
      [BATCHES]: [
        [{ count: 0 }],
        [{ count: 0 }],
        [{ count: fixture.unmanagedFile ? 1 : 0 }],
      ],
      [REPORTS]: [[{ count: 0 }]],
      [BUCKET_SOURCES]: [[{ count: fixture.bucketSourceOnPlatform ? 1 : 0 }]],
    },
    update: { [JOBS]: fixture.claimRows ?? [1] },
  });
}

/** In-memory object storage with the listing semantics of S3. */
function fakeStorage(keys: string[]) {
  const objects = new Set(keys);
  return {
    objects,
    listObjects: vi.fn(async (prefix: string) => [...objects].filter(key => key.startsWith(prefix))),
    deleteObject: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
}

const run = (fake: ReturnType<typeof scriptedDb>, deps: Parameters<typeof handleShopifyShopRedactionJob>[1] = {}) =>
  handleShopifyShopRedactionJob(903, {
    db: fake.db as never,
    now: () => NOW,
    uuid: () => "11111111-1111-4111-8111-111111111111",
    listObjects: async () => [],
    deleteObject: async () => {},
    platformBucket: "reconcileai-storage",
    ...deps,
  });

const lastJobWrite = (fake: ReturnType<typeof scriptedDb>) => rowOf(fake.writes("update", JOBS).at(-1));
const dialect = new MySqlDialect();

describe("when the destructive Shopify shop-redaction worker runs", () => {
  it("should erase owned storage and tenant records while retaining only a non-identifying receipt", async () => {
    const fake = workerDb();
    const storage = fakeStorage([ARTIFACT.key, TRACKED_EXPORT]);

    await run(fake, storage);

    expect(storage.objects.size).toBe(0);
    expect(fake.writes("delete", STORES)).toHaveLength(1);
    expect(fake.writes("delete", USERS)).toHaveLength(1);
    expect(fake.writes("delete", ORGANIZATIONS)).toHaveLength(1);
    expect(fake.writes("delete", JOBS)).toHaveLength(1);
    const receipts = fake.writes("insert", RECEIPTS)[0]?.data as Record<string, unknown>[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      runId: JOB.runId,
      requestHash: JOB.requestHash,
      manifestVersion: 1,
      completedAt: NOW,
    });
    expect(JSON.stringify(receipts)).not.toMatch(
      /organizationId|storeId|domain|orderId|email|payload|objectKey|url/i
    );
    expect(fake.writes("update", REQUESTS)).toEqual([]);
  });

  describe("when the tenant has files no row records", () => {
    it("should delete everything in the tenant's folder and in its users' old export folders, and nothing else", async () => {
      const fake = workerDb();
      const storage = fakeStorage([
        ARTIFACT.key,
        TRACKED_EXPORT,
        "org/42/exports/5/exceptions-export-1.xlsx",
        "org/42/reports/cfo/cfo-channel-report-7d-1.xlsx",
        `exports/${MEMBER}/audit-trail-export-1.xlsx`,
        `csv-exports/reconciliation/${MEMBER}/2-run.csv`,
        // Another tenant, a prefix-sharing tenant id, and another user: untouched.
        "org/43/exports/9/theirs.xlsx",
        "org/420/exports/9/theirs.xlsx",
        "exports/55/theirs.xlsx",
      ]);

      await run(fake, storage);

      expect([...storage.objects].sort()).toEqual([
        "exports/55/theirs.xlsx",
        "org/420/exports/9/theirs.xlsx",
        "org/43/exports/9/theirs.xlsx",
      ]);
      expect(storage.listObjects.mock.calls.map(([prefix]) => prefix)).toEqual([
        ...tenantStoragePrefixes(42, [MEMBER]),
        // The sweep after the erasure commits.
        "org/42/",
      ]);
    });

    it("should name every folder the tenant's files were ever written to", () => {
      expect(tenantStoragePrefixes(42, [5, 6])).toEqual([
        "org/42/",
        "exports/5/",
        "csv-exports/cbn/5/",
        "csv-exports/cfo/5/",
        "csv-exports/reconciliation/5/",
        "exports/6/",
        "csv-exports/cbn/6/",
        "csv-exports/cfo/6/",
        "csv-exports/reconciliation/6/",
      ]);
    });

    it("should stop before any database erasure when the folder cannot be listed", async () => {
      const fake = workerDb();
      const deleteObject = vi.fn(async () => {});

      await run(fake, {
        listObjects: async () => {
          throw new Error("storage_list_incomplete");
        },
        deleteObject,
      });

      expect(deleteObject).not.toHaveBeenCalled();
      expect(fake.writes("delete", STORES)).toEqual([]);
      expect(lastJobWrite(fake)).toMatchObject({
        status: "failed_retryable",
        failureCode: "object_deletion_failed",
      });
    });
  });

  it("should stop before destructive database writes and retain a retry when object deletion fails", async () => {
    const fake = workerDb();
    await run(fake, {
      listObjects: async () => ["org/42/exports/5/a.xlsx"],
      deleteObject: async () => {
        throw new Error("object_store_temporarily_unavailable");
      },
    });

    expect(fake.writes("delete", STORES)).toEqual([]);
    expect(fake.writes("delete", ORGANIZATIONS)).toEqual([]);
    expect(lastJobWrite(fake)).toMatchObject({
      status: "failed_retryable",
      failureCode: "object_deletion_failed",
      completedAt: null,
    });
    expect(rowOf(fake.writes("update", OUTBOX).at(-1))).toMatchObject({
      status: "failed_retryable",
      failureCode: "object_deletion_failed",
    });
  });

  describe("when the tenant has several stores", () => {
    it("should settle every other store's shop/redact with its own receipt and remove all of them", async () => {
      const fake = workerDb({ siblings: [SIBLING] });

      await run(fake);

      const receipts = fake.writes("insert", RECEIPTS)[0]?.data as Record<string, unknown>[];
      expect(receipts.map(receipt => [receipt.runId, receipt.requestHash])).toEqual([
        [JOB.runId, JOB.requestHash],
        [SIBLING.runId, SIBLING.requestHash],
      ]);
      expect(receipts[1]).toMatchObject({ manifestVersion: 1, completedAt: NOW });
      // Every job of the tenant, not only the one this worker claimed.
      const jobDelete = fake.writes("delete", JOBS)[0]?.where;
      expect(jobDelete?.sql).toBe("`shopify_shop_redaction_jobs`.`organizationId` = ?");
      expect(jobDelete?.params).toEqual([42]);
      // Every store's install lease.
      expect(fake.writes("delete", LEASES)[0]?.where?.params).toEqual([
        "erasure-test.myshopify.com",
        "erasure-sibling.myshopify.com",
      ]);
    });

    it("should lock the organisation before the job, then every sibling job, inside the erasure", async () => {
      const fake = workerDb({ siblings: [SIBLING] });

      await run(fake);

      const txId = fake.writes("delete", ORGANIZATIONS)[0]?.txId;
      const locked = fake.ops.filter(op => op.txId === txId && op.locked).map(op => op.table);
      expect(locked.slice(0, 4)).toEqual([ORGANIZATIONS, JOBS, JOBS, STORES]);
    });
  });

  describe("when a privacy-queue outbox row could share a number with another kind's", () => {
    it("should match each kind only against its own ids", () => {
      const { sql, params } = dialect.sqlToQuery(tenantOutboxRows(42)!);
      expect(sql).toBe(
        "((`shopify_privacy_queue_outbox`.`kind` in (?, ?) and `shopify_privacy_queue_outbox`.`jobId` in " +
          "(select `id` from `shopify_privacy_requests` where `shopify_privacy_requests`.`organizationId` = ?)) or " +
          "(`shopify_privacy_queue_outbox`.`kind` = ? and `shopify_privacy_queue_outbox`.`jobId` in " +
          "(select `id` from `shopify_shop_redaction_jobs` where `shopify_shop_redaction_jobs`.`organizationId` = ?)))"
      );
      expect(params).toEqual(["customer_request", "customer_redact", 42, "shop_redact", 42]);
    });

    it("should delete the tenant's outbox rows by that pairing", async () => {
      const fake = workerDb();
      await run(fake);
      const { sql, params } = dialect.sqlToQuery(tenantOutboxRows(42)!);
      expect(fake.writes("delete", OUTBOX)[0]?.where).toEqual({ sql, params });
    });
  });

  describe("when a data-request export may still be uploading", () => {
    const leaseEnds = new Date(NOW.getTime() + 4 * 60_000);

    it("should delete nothing and retry after the export's lease ends", async () => {
      const fake = workerDb({ liveLeaseBefore: [{ leaseExpiresAt: leaseEnds }] });
      const storage = fakeStorage([ARTIFACT.key]);

      await run(fake, storage);

      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(fake.writes("delete", STORES)).toEqual([]);
      const write = lastJobWrite(fake);
      expect(write).toMatchObject({ status: "failed_retryable", failureCode: "export_in_flight" });
      expect((write?.nextAttemptAt as Date).getTime()).toBe(leaseEnds.getTime() + 1_000);
      expect(rowOf(fake.writes("update", OUTBOX).at(-1))?.nextAttemptAt).toEqual(write?.nextAttemptAt);
    });

    it("should roll the erasure back when a live lease is found under its locks", async () => {
      const fake = workerDb({ liveLeaseInTx: [{ leaseExpiresAt: leaseEnds }] });

      await run(fake);

      expect(fake.writes("delete", STORES)).toEqual([]);
      expect(fake.writes("insert", RECEIPTS)).toEqual([]);
      expect(lastJobWrite(fake)).toMatchObject({ status: "failed_retryable", failureCode: "export_in_flight" });
    });

    it("should read the clock for that check after taking the locks", async () => {
      const times = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(minutes => new Date(NOW.getTime() + minutes * 60_000));
      const fake = workerDb();
      let call = 0;

      await run(fake, { now: () => times[Math.min(call++, times.length - 1)] });

      const txId = fake.writes("delete", ORGANIZATIONS)[0]?.txId;
      const leaseCheck = fake.ops.find(op => op.txId === txId && op.table === DATA_JOBS);
      const receipt = (fake.writes("insert", RECEIPTS)[0]?.data as Record<string, unknown>[])[0];
      // drizzle sends a timestamp as UTC text without the zone.
      const asSent = (receipt.completedAt as Date).toISOString().replace("T", " ").replace("Z", "");
      expect(leaseCheck?.where?.params).toContain(asSent);
      expect((receipt.completedAt as Date).getTime()).toBeGreaterThan(NOW.getTime());
    });
  });

  describe("when storage changed after its objects were deleted", () => {
    it("should roll back and retry when an export finished uploading in between", async () => {
      const fake = workerDb({
        artifactsInTx: [{ ...ARTIFACT, status: "ready", sha256: "b".repeat(64) }],
      });

      await run(fake);

      expect(fake.writes("delete", STORES)).toEqual([]);
      expect(fake.writes("delete", ARTIFACTS)).toEqual([]);
      expect(lastJobWrite(fake)).toMatchObject({
        status: "failed_retryable",
        failureCode: "storage_inventory_changed",
      });
    });

    it("should roll back and retry when a file it never saw is now recorded", async () => {
      const fake = workerDb({
        exportsInTx: [{ key: TRACKED_EXPORT }, { key: "org/42/csv-exports/cfo/5/9-new.csv" }],
      });

      await run(fake);

      expect(fake.writes("delete", ORGANIZATIONS)).toEqual([]);
      expect(lastJobWrite(fake)?.failureCode).toBe("storage_inventory_changed");
    });

    const inventory: ShopRedactionStorageInventory = {
      deletedKeys: new Set(["a", "b", "x"]),
      artifactStates: new Map([
        ["a", "writing:"],
        ["b", "ready:abc"],
      ]),
    };
    it.each([
      ["an export that finished uploading", true, [{ key: "a", status: "ready", sha256: "abc" }], []],
      ["a late upload handed back for deletion", true, [{ key: "b", status: "writing", sha256: "abc" }], []],
      ["an export with a key it never deleted", true, [{ key: "c", status: "writing", sha256: null }], []],
      ["a tracked file it never deleted", true, [], ["y"]],
      ["an export discarded since", false, [{ key: "a", status: "deleted", sha256: null }], []],
      ["nothing new", false, [{ key: "b", status: "ready", sha256: "abc" }], ["x", null]],
    ] as const)("should treat %s as a change: %s", (_label, changed, artifacts, exportKeys) => {
      expect(storageChangedSince(inventory, artifacts, exportKeys)).toBe(changed);
    });
  });

  describe("when tenant uploads that saw the tenant active may still be landing", () => {
    it("should leave storage untouched and retry once none can be", async () => {
      // First claimed just now: admission committed moments ago.
      const fake = workerDb({ job: { startedAt: NOW } });
      const storage = fakeStorage([ARTIFACT.key, "org/42/exports/5/late.xlsx"]);

      await run(fake, storage);

      expect(storage.listObjects).not.toHaveBeenCalled();
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(fake.writes("delete", STORES)).toEqual([]);
      const write = lastJobWrite(fake);
      expect(write).toMatchObject({ status: "failed_retryable", failureCode: "uploads_settling" });
      expect((write?.nextAttemptAt as Date).getTime()).toBe(
        NOW.getTime() + SHOPIFY_SHOP_REDACTION_UPLOAD_SETTLE_MS + 1_000
      );
    });

    it("should wait longer than any upload may run", () => {
      expect(SHOPIFY_SHOP_REDACTION_UPLOAD_SETTLE_MS).toBeGreaterThanOrEqual(TENANT_UPLOAD_DEADLINE_MS + 60_000);
    });

    it("should proceed once the window has passed since the job was first claimed", async () => {
      const fake = workerDb({ job: { startedAt: new Date(NOW.getTime() - SHOPIFY_SHOP_REDACTION_UPLOAD_SETTLE_MS) } });

      await run(fake);

      expect(fake.writes("delete", ORGANIZATIONS)).toHaveLength(1);
    });
  });

  describe("when the organisation is not fenced for redaction", () => {
    it("should delete nothing and hand the job to a person", async () => {
      const fake = workerDb({ organization: [{ deletionState: "active" }] });
      const storage = fakeStorage([ARTIFACT.key]);

      await run(fake, storage);

      expect(storage.listObjects).not.toHaveBeenCalled();
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(lastJobWrite(fake)).toMatchObject({ status: "manual_review", failureCode: "tenant_not_fenced" });
    });

    it("should roll back if the fence is gone by the time the erasure locks it", async () => {
      const fake = workerDb({ organizationInTx: [{ deletionState: "active" }] });

      await run(fake);

      expect(fake.writes("delete", USERS)).toEqual([]);
      expect(lastJobWrite(fake)).toMatchObject({ status: "manual_review", failureCode: "tenant_not_fenced" });
    });
  });

  describe("when the erasure has committed", () => {
    it("should sweep the tenant's folder once more, and a failed sweep should not undo the erasure", async () => {
      const fake = workerDb();
      let lists = 0;

      await run(fake, {
        listObjects: async prefix => {
          lists += 1;
          if (prefix === "org/42/" && lists > 5) throw new Error("storage_unavailable");
          return [];
        },
      });

      expect(lists).toBe(tenantStoragePrefixes(42, [MEMBER]).length + 1);
      expect(fake.writes("delete", ORGANIZATIONS)).toHaveLength(1);
    });
  });

  describe("when a bucket-ingestion source reads from the platform's own bucket", () => {
    it("should delete nothing and hand the job to a person", async () => {
      const fake = workerDb({ bucketSourceOnPlatform: true });
      const storage = fakeStorage([ARTIFACT.key]);

      await run(fake, { ...storage, platformBucket: "reconcileai-storage" });

      expect(storage.listObjects).not.toHaveBeenCalled();
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(lastJobWrite(fake)).toMatchObject({ status: "manual_review", failureCode: "unmanaged_file_reference" });
      // This tenant's sources on THIS bucket — not any tenant's, not any bucket.
      const check = fake.ops.find(op => op.kind === "select" && op.table === BUCKET_SOURCES);
      expect(check?.where?.params).toEqual([42, "reconcileai-storage"]);
    });

    it("should not ask at all when no platform bucket is configured", async () => {
      const fake = workerDb({ bucketSourceOnPlatform: true });

      await run(fake, { platformBucket: "" });

      expect(fake.ops.some(op => op.kind === "select" && op.table === BUCKET_SOURCES)).toBe(false);
      expect(fake.writes("delete", ORGANIZATIONS)).toHaveLength(1);
    });
  });

  it("should fail closed for an unmanaged legacy file reference rather than claim deletion", async () => {
    const fake = workerDb({ unmanagedFile: true });
    const deleteObject = vi.fn(async () => {});

    await run(fake, { deleteObject });

    expect(deleteObject).not.toHaveBeenCalled();
    expect(fake.writes("delete", STORES)).toEqual([]);
    expect(fake.writes("insert", RECEIPTS)).toEqual([]);
    expect(lastJobWrite(fake)).toMatchObject({
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
    await run(fake, {
      afterManifest: async () => {
        throw new Error("simulated_crash_after_inventory");
      },
    });
    expect(fake.writes("delete", STORES)).toEqual([]);
    expect(lastJobWrite(fake)).toMatchObject({ status: "failed_retryable", failureCode: "worker_failed" });
  });
});

/** Every table across the migrated schema files. */
function allTables(): MySqlTable[] {
  return [mainSchema, woodcoreSchema, pocSchema, mmSchema, connectorSchema, tenantSchema, shopifySchema].flatMap(module =>
    Object.values(module as Record<string, unknown>).filter((value): value is MySqlTable => value instanceof MySqlTable)
  );
}

/**
 * Tables that name a tenant or one of its users but which this erasure leaves,
 * each with the reason. Empty today — and a new table that names either one
 * fails the test below until it is erased or listed here with a reason.
 */
const RETAINED_ON_ERASURE: Record<string, string> = {};

describe("when a table holds a tenant's rows or its users'", () => {
  it("should be erased by the shop redaction, or retained for a stated reason", async () => {
    const fake = workerDb();
    await run(fake);
    const erased = new Set(
      fake.committed().filter((op: RecordedOp) => op.kind === "delete").map(op => op.table)
    );

    const tenantTables = allTables()
      .filter(table =>
        Object.values(getTableColumns(table)).some(column =>
          ["organizationId", "guestOrganizationId", "userId"].includes(column.name)
        )
      )
      .map(table => getTableName(table));

    expect(tenantTables.length).toBeGreaterThan(60);
    const missing = tenantTables.filter(table => !erased.has(table) && !(table in RETAINED_ON_ERASURE));
    expect(missing).toEqual([]);
  });
});
