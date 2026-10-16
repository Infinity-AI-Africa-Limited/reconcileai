/**
 * End-to-end proof of the destructive `shop/redact` boundary against a real,
 * isolated MySQL database. The test is disabled unless DATABASE_URL is a local
 * target, so it can never use a developer's or Railway's production database.
 *
 * Storage is an in-memory bucket with S3's listing semantics; everything else
 * — locks, the transaction, the kind-paired outbox delete — is the real thing.
 */
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations, users } from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyInstallLeases,
  shopifyPrivacyArtifacts,
  shopifyPrivacyDataRequestJobs,
  shopifyPrivacyQueueOutbox,
  shopifyPrivacyRequests,
  shopifyShopRedactionJobs,
  shopifyShopRedactionReceipts,
} from "../../../drizzle/shopify_schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { createAppPool } from "../../dbSession";
import { handleShopifyShopRedactionJob } from "./shopRedaction";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
const NOW = new Date("2026-10-16T07:30:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

const insertId = (result: unknown) => Number((result as [{ insertId: number }])[0].insertId);

describe.runIf(localDatabase)("when Shopify shop redaction erases a tenant in MySQL", () => {
  let pool: Pool;
  let db: MySql2Database;
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000)}`.slice(-12);
  // Explicit job ids far above any request id, so a number can be shared across
  // kinds on purpose without colliding with this run's own rows.
  let nextJobId = 800_000_000 + Math.floor(Math.random() * 100_000_000);
  const orgIds: number[] = [];
  const runIds: string[] = [];
  const outboxIds: number[] = [];
  const domains: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    pool = createAppPool(url!).promise();
    db = drizzle(pool);
  });

  afterAll(async () => {
    if (!db) return;
    // A passing case has already removed its tenant. These narrow writes make a
    // failed assertion safe to re-run against the same database.
    if (orgIds.length) {
      for (const table of [
        shopifyPrivacyArtifacts,
        shopifyPrivacyDataRequestJobs,
        shopifyShopRedactionJobs,
        shopifyPrivacyRequests,
        shopifyConnectorStores,
        users,
      ])
        await db.delete(table).where(inArray(table.organizationId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (outboxIds.length) await db.delete(shopifyPrivacyQueueOutbox).where(inArray(shopifyPrivacyQueueOutbox.id, outboxIds));
    if (domains.length) await db.delete(shopifyInstallLeases).where(inArray(shopifyInstallLeases.shopDomain, domains));
    if (runIds.length) await db.delete(shopifyShopRedactionReceipts).where(inArray(shopifyShopRedactionReceipts.runId, runIds));
    await pool.end();
  });

  const tag = () => `${nonce}_${++seq}`;
  const uuid = () => {
    const id = `00000000-0000-4000-8000-${String(++seq).padStart(4, "0")}${nonce.slice(-8)}`;
    return id;
  };

  async function seedOrganization(state: "active" | "redacting") {
    const t = tag();
    const id = insertId(
      await db.insert(organizations).values({
        name: `Erasure rehearsal ${t}`,
        code: `ERASURE_${t}`.slice(0, 50),
        segment: "retail_commerce",
        onboardingChannel: "shopify_public_app",
        deletionState: state,
        isActive: state === "active",
        redactingAt: state === "redacting" ? NOW : null,
      })
    );
    orgIds.push(id);
    const userId = insertId(
      await db.insert(users).values({
        openId: `erasure_${t}`.slice(0, 64),
        name: "Masked rehearsal merchant",
        email: `masked-${t}@example.invalid`,
        role: "admin",
        organizationId: id,
        isActive: state === "active",
      })
    );
    return { id, userId };
  }

  async function seedStore(organizationId: number, userId: number) {
    const t = tag();
    const shopDomain = `erasure-${t}.myshopify.com`;
    domains.push(shopDomain);
    const id = insertId(
      await db.insert(shopifyConnectorStores).values({
        organizationId,
        shopDomain,
        shopId: `shop_${t}`,
        displayName: "Masked rehearsal store",
        grantedScopes: "read_orders",
        requestedScopes: "read_orders",
        status: "redacting",
        claimedByUserId: userId,
      })
    );
    await db.insert(shopifyInstallLeases).values({ shopDomain, leaseId: `lease_${t}`, expiresAt: later(60_000) });
    return { id, shopDomain };
  }

  async function seedRequest(organizationId: number, storeId: number, topic: "shop/redact" | "customers/data_request") {
    const requestHash = `receipt_${tag()}`;
    const id = insertId(
      await db.insert(shopifyPrivacyRequests).values({ organizationId, storeId, topic, requestHash, status: "received" })
    );
    return { id, requestHash };
  }

  async function seedShopRedaction(organizationId: number, storeId: number) {
    const request = await seedRequest(organizationId, storeId, "shop/redact");
    const id = nextJobId++;
    const runId = uuid();
    runIds.push(runId);
    await db.insert(shopifyShopRedactionJobs).values({
      id,
      runId,
      organizationId,
      storeId,
      privacyRequestId: request.id,
      requestHash: request.requestHash,
      webhookId: `wh_${tag()}`,
      status: "admitted",
      manifestVersion: 1,
    });
    await addOutbox("shop_redact", id);
    return { id, runId, requestHash: request.requestHash };
  }

  async function addOutbox(kind: "customer_request" | "customer_redact" | "shop_redact", jobId: number) {
    const id = insertId(await db.insert(shopifyPrivacyQueueOutbox).values({ kind, jobId, status: "pending" }));
    outboxIds.push(id);
    return id;
  }

  /** A data-request export: its job, its artifact row, and its stored object. */
  async function seedExport(
    organizationId: number,
    storeId: number,
    userId: number,
    state: { jobStatus: "processing" | "blocked_dependency"; leaseExpiresAt: Date | null; artifact: "writing" | "ready" }
  ) {
    const request = await seedRequest(organizationId, storeId, "customers/data_request");
    await db.insert(shopifyPrivacyDataRequestJobs).values({
      requestId: request.id,
      organizationId,
      storeId,
      status: state.jobStatus,
      leaseId: state.leaseExpiresAt ? uuid() : null,
      leaseExpiresAt: state.leaseExpiresAt,
    });
    const objectKey = `org/${organizationId}/privacy/shopify/${request.id}/${tag()}.json`;
    await db.insert(shopifyPrivacyArtifacts).values({
      requestId: request.id,
      organizationId,
      storeId,
      publicId: uuid(),
      artifactKind: "order_evidence",
      objectKey,
      sha256: state.artifact === "ready" ? "a".repeat(64) : null,
      sizeBytes: state.artifact === "ready" ? 10 : null,
      status: state.artifact,
      recipientUserId: userId,
      generatedAt: NOW,
      expiresAt: later(7 * 86_400_000),
    });
    await addOutbox("customer_request", request.id);
    return { requestId: request.id, objectKey };
  }

  function bucket(keys: string[]) {
    const objects = new Set(keys);
    return {
      objects,
      listObjects: async (prefix: string) => [...objects].filter(key => key.startsWith(prefix)),
      deleteObject: async (key: string) => {
        objects.delete(key);
      },
    };
  }

  const exists = async (table: typeof organizations, id: number) =>
    (await db.select({ id: table.id }).from(table).where(eq(table.id, id))).length > 0;

  it("should erase every store, settle each shop/redact with a receipt, and leave another tenant's rows that share a number", async () => {
    const tenant = await seedOrganization("redacting");
    const first = await seedStore(tenant.id, tenant.userId);
    const second = await seedStore(tenant.id, tenant.userId);
    const job = await seedShopRedaction(tenant.id, first.id);
    const sibling = await seedShopRedaction(tenant.id, second.id);
    const exported = await seedExport(tenant.id, first.id, tenant.userId, {
      jobStatus: "blocked_dependency",
      leaseExpiresAt: null,
      artifact: "ready",
    });

    // Another tenant whose outbox rows carry this tenant's numbers under the
    // OTHER kind: a request id under `shop_redact`, a job id under `customer_request`.
    const other = await seedOrganization("active");
    const otherStore = await seedStore(other.id, other.userId);
    const sharesJobNumber = await addOutbox("customer_request", job.id);
    const sharesRequestNumber = await addOutbox("shop_redact", exported.requestId);

    const storage = bucket([
      exported.objectKey,
      `org/${tenant.id}/exports/${tenant.userId}/exceptions-export-1.xlsx`,
      `exports/${tenant.userId}/audit-trail-export-1.xlsx`,
      `org/${other.id}/exports/${other.userId}/theirs.xlsx`,
      `exports/${other.userId}/theirs.xlsx`,
    ]);

    await handleShopifyShopRedactionJob(job.id, { db: db as never, now: () => NOW, ...storage });

    expect(await exists(organizations, tenant.id)).toBe(false);
    expect(await db.select().from(users).where(eq(users.organizationId, tenant.id))).toEqual([]);
    expect(
      await db.select().from(shopifyConnectorStores).where(eq(shopifyConnectorStores.organizationId, tenant.id))
    ).toEqual([]);
    expect(
      await db.select().from(shopifyShopRedactionJobs).where(eq(shopifyShopRedactionJobs.organizationId, tenant.id))
    ).toEqual([]);
    expect(
      await db.select().from(shopifyPrivacyArtifacts).where(eq(shopifyPrivacyArtifacts.organizationId, tenant.id))
    ).toEqual([]);

    const receipts = await db
      .select()
      .from(shopifyShopRedactionReceipts)
      .where(inArray(shopifyShopRedactionReceipts.runId, [job.runId, sibling.runId]));
    expect(receipts.map(receipt => [receipt.runId, receipt.requestHash]).sort()).toEqual(
      [
        [job.runId, job.requestHash],
        [sibling.runId, sibling.requestHash],
      ].sort()
    );
    for (const receipt of receipts) {
      expect(receipt.completedAt).toEqual(NOW);
      expect(JSON.stringify(receipt)).not.toMatch(/"(organizationId|storeId|shopDomain|webhookId|email|payload)"/i);
    }

    const outbox = await db
      .select({ id: shopifyPrivacyQueueOutbox.id })
      .from(shopifyPrivacyQueueOutbox)
      .where(inArray(shopifyPrivacyQueueOutbox.id, outboxIds));
    expect(outbox.map(row => row.id).sort()).toEqual([sharesJobNumber, sharesRequestNumber].sort());

    const leases = await db
      .select({ shopDomain: shopifyInstallLeases.shopDomain })
      .from(shopifyInstallLeases)
      .where(inArray(shopifyInstallLeases.shopDomain, [first.shopDomain, second.shopDomain, otherStore.shopDomain]));
    expect(leases).toEqual([{ shopDomain: otherStore.shopDomain }]);

    expect([...storage.objects].sort()).toEqual(
      [`exports/${other.userId}/theirs.xlsx`, `org/${other.id}/exports/${other.userId}/theirs.xlsx`].sort()
    );
    expect(await exists(organizations, other.id)).toBe(true);
  });

  it("should redo the deletion when an export finishes uploading after the objects were deleted", async () => {
    const tenant = await seedOrganization("redacting");
    const store = await seedStore(tenant.id, tenant.userId);
    const job = await seedShopRedaction(tenant.id, store.id);
    // A worker that outlived its lease mid-upload: no live lease, artifact still writing.
    const exported = await seedExport(tenant.id, store.id, tenant.userId, {
      jobStatus: "processing",
      leaseExpiresAt: later(-60_000),
      artifact: "writing",
    });
    const storage = bucket([exported.objectKey]);

    await handleShopifyShopRedactionJob(job.id, {
      db: db as never,
      now: () => NOW,
      ...storage,
      afterObjectsDeleted: async () => {
        // Its upload lands after the delete, and it marks the export ready.
        storage.objects.add(exported.objectKey);
        await db
          .update(shopifyPrivacyArtifacts)
          .set({ status: "ready", sha256: "b".repeat(64), sizeBytes: 12 })
          .where(eq(shopifyPrivacyArtifacts.requestId, exported.requestId));
      },
    });

    const [retry] = await db
      .select()
      .from(shopifyShopRedactionJobs)
      .where(eq(shopifyShopRedactionJobs.id, job.id));
    expect(retry).toMatchObject({ status: "failed_retryable", failureCode: "storage_inventory_changed" });
    expect(await exists(organizations, tenant.id)).toBe(true);
    expect(storage.objects.has(exported.objectKey)).toBe(true);

    await handleShopifyShopRedactionJob(job.id, {
      db: db as never,
      now: () => new Date(retry.nextAttemptAt!.getTime() + 1_000),
      ...storage,
    });

    expect(await exists(organizations, tenant.id)).toBe(false);
    expect(storage.objects.size).toBe(0);
  });

  it("should delete nothing while an export still holds its lease, and retry after it ends", async () => {
    const tenant = await seedOrganization("redacting");
    const store = await seedStore(tenant.id, tenant.userId);
    const job = await seedShopRedaction(tenant.id, store.id);
    const leaseEnds = later(3 * 60_000);
    const exported = await seedExport(tenant.id, store.id, tenant.userId, {
      jobStatus: "processing",
      leaseExpiresAt: leaseEnds,
      artifact: "writing",
    });
    const storage = bucket([exported.objectKey]);

    await handleShopifyShopRedactionJob(job.id, { db: db as never, now: () => NOW, ...storage });

    const [deferred] = await db
      .select()
      .from(shopifyShopRedactionJobs)
      .where(eq(shopifyShopRedactionJobs.id, job.id));
    expect(deferred).toMatchObject({ status: "failed_retryable", failureCode: "export_in_flight" });
    expect(deferred.nextAttemptAt?.getTime()).toBe(leaseEnds.getTime() + 1_000);
    const [outbox] = await db
      .select()
      .from(shopifyPrivacyQueueOutbox)
      .where(and(eq(shopifyPrivacyQueueOutbox.kind, "shop_redact"), eq(shopifyPrivacyQueueOutbox.jobId, job.id)));
    expect(outbox.nextAttemptAt).toEqual(deferred.nextAttemptAt);
    expect(storage.objects.has(exported.objectKey)).toBe(true);
    expect(await exists(organizations, tenant.id)).toBe(true);
  });

  it("should refuse to erase an organisation that is not fenced", async () => {
    const tenant = await seedOrganization("active");
    const store = await seedStore(tenant.id, tenant.userId);
    const job = await seedShopRedaction(tenant.id, store.id);
    const storage = bucket([`org/${tenant.id}/exports/${tenant.userId}/keep.xlsx`]);

    await handleShopifyShopRedactionJob(job.id, { db: db as never, now: () => NOW, ...storage });

    const [held] = await db
      .select()
      .from(shopifyShopRedactionJobs)
      .where(eq(shopifyShopRedactionJobs.id, job.id));
    expect(held).toMatchObject({ status: "manual_review", failureCode: "tenant_not_fenced" });
    expect(storage.objects.size).toBe(1);
    expect(await exists(organizations, tenant.id)).toBe(true);
  });
});
