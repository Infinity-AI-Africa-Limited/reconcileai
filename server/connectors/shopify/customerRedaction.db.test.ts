/**
 * The Shopify customer-redaction worker against a real, isolated MySQL
 * database. The suite is disabled unless DATABASE_URL is a local target, so it
 * can never touch a developer's or Railway's production database.
 *
 * customerRedaction.test.ts pins each write against a scripted database. This
 * proves the outcome on real rows, locks and transactions:
 *   - what a supported request records, and that it claims no erasure;
 *   - that the encrypted selectors and the reconciliation evidence are kept;
 *   - that only the request's own store fence is released;
 *   - that a request already parked or resolved is never overwritten;
 *   - that two dispatches of one request at the same moment do the work once.
 */
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations, transactions, users } from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyOrderRedactionTombstones,
  shopifyPrivacyCustomerRedactionJobs,
  shopifyPrivacyQueueOutbox,
  shopifyPrivacyRequests,
  shopifyPrivacyRequestSelectors,
} from "../../../drizzle/shopify_schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { createAppPool } from "../../dbSession";
import { handleShopifyCustomerRedactionJob } from "./customerRedaction";
import { shopifyOrderDescription } from "./ingest";
import { ShopifyPrivacyJobNotClaimableError } from "./privacyJobState";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
const NOW = new Date("2026-11-17T09:00:00.000Z");
const KEYS = [{ version: "v1", key: Buffer.alloc(32, 11) }];

const insertId = (result: unknown) => Number((result as [{ insertId: number }])[0].insertId);

/** Selector ciphertext in this suite is `enc:<plaintext>`; the worker gets it back through `decrypt`. */
const decrypt = async (_organizationId: number, ciphertext: string) => ciphertext.split(":")[1] ?? "";

interface Tenant {
  organizationId: number;
  userId: number;
  storeId: number;
}

describe.runIf(localDatabase)("when a Shopify customer redaction runs against MySQL", () => {
  let pool: Pool;
  let db: MySql2Database;
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000)}`.slice(-12);
  const orgIds: number[] = [];
  const requestIds: number[] = [];
  let seq = 0;
  const tag = () => `${nonce}_${++seq}`;
  const lease = () => `00000000-0000-4000-8000-${String(++seq).padStart(4, "0")}${nonce.slice(-8)}`;

  beforeAll(async () => {
    pool = createAppPool(url!).promise();
    db = drizzle(pool);
  });

  afterAll(async () => {
    if (!db) return;
    if (orgIds.length) {
      for (const table of [
        shopifyOrderRedactionTombstones,
        shopifyPrivacyCustomerRedactionJobs,
        shopifyPrivacyRequestSelectors,
        shopifyPrivacyRequests,
        transactions,
        shopifyConnectorStores,
        users,
      ] as const) {
        await db.delete(table).where(inArray(table.organizationId, orgIds));
      }
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (requestIds.length) {
      await db
        .delete(shopifyPrivacyQueueOutbox)
        .where(and(eq(shopifyPrivacyQueueOutbox.kind, "customer_redact"), inArray(shopifyPrivacyQueueOutbox.jobId, requestIds)));
    }
    await pool?.end();
  });

  function deps(leaseId = lease()) {
    return { db: db as never, now: () => NOW, uuid: () => leaseId, decrypt, suppressionKeys: KEYS };
  }

  async function seedTenant(): Promise<Tenant> {
    const t = tag();
    const organizationId = insertId(
      await db.insert(organizations).values({
        name: `Customer redaction rehearsal ${t}`,
        code: `CUSTREDACT_${t}`.slice(0, 50),
        segment: "retail_commerce",
        onboardingChannel: "shopify_public_app",
        deletionState: "active",
      }),
    );
    orgIds.push(organizationId);
    const userId = insertId(
      await db.insert(users).values({
        openId: `custredact_${t}`.slice(0, 64),
        name: "Masked rehearsal merchant",
        email: `masked-${t}@example.invalid`,
        role: "admin",
        organizationId,
      }),
    );
    const storeId = insertId(
      await db.insert(shopifyConnectorStores).values({
        organizationId,
        shopDomain: `custredact-${t}.myshopify.com`.replace(/_/g, "-"),
        shopId: `shop_${t}`,
        displayName: "Masked rehearsal store",
        grantedScopes: "read_orders",
        requestedScopes: "read_orders",
        status: "active",
      }),
    );
    return { organizationId, userId, storeId };
  }

  /** A customers/redact request with its encrypted selectors and a claimable job, as admission leaves it. */
  async function seedRequest(
    t: Tenant,
    options: { orders: string[]; fence: "this_request" | "free" | number; parentStatus?: "received" | "manual_review" | "completed" },
  ): Promise<number> {
    const requestId = insertId(
      await db.insert(shopifyPrivacyRequests).values({
        organizationId: t.organizationId,
        storeId: t.storeId,
        topic: "customers/redact",
        requestHash: `${nonce}${String(++seq).padStart(52, "0")}`.slice(0, 64),
        status: options.parentStatus ?? "received",
        receivedAt: NOW,
      }),
    );
    requestIds.push(requestId);
    const selectors = [
      { resourceType: "customer" as const, position: 0, value: "41" },
      ...options.orders.map((value, position) => ({ resourceType: "order" as const, position, value })),
    ];
    await db.insert(shopifyPrivacyRequestSelectors).values(
      selectors.map((s) => ({
        requestId,
        organizationId: t.organizationId,
        resourceType: s.resourceType,
        position: s.position,
        externalIdEnc: `enc:${s.value}`,
        externalIdHmac: `${s.resourceType}-${s.value}-${tag()}`.slice(0, 80),
      })),
    );
    await db.insert(shopifyPrivacyCustomerRedactionJobs).values({
      requestId,
      organizationId: t.organizationId,
      storeId: t.storeId,
      status: "received",
      lastCheckpoint: "admitted",
      manifestVersion: 1,
    });
    if (options.fence !== "free") {
      await db
        .update(shopifyConnectorStores)
        .set({
          privacyRedactionState: "customer_redacting",
          privacyRedactionRequestId: options.fence === "this_request" ? requestId : options.fence,
        })
        .where(eq(shopifyConnectorStores.id, t.storeId));
    }
    return requestId;
  }

  /** The order's own row exactly as ingest.ts projects it: the minimised form the worker accepts. */
  async function seedOrderRow(t: Tenant, orderId: string, name: string): Promise<number> {
    return insertId(
      await db.insert(transactions).values({
        organizationId: t.organizationId,
        userId: t.userId,
        batchId: 0,
        channelId: 0,
        shopifyStoreId: t.storeId,
        transactionRef: `gid://shopify/Order/${orderId}`,
        shopifyRefundId: "",
        externalRef: name,
        description: shopifyOrderDescription(name),
        counterparty: "Shopify",
        originalTransactionRef: null,
        isReversal: false,
        amount: "110.00",
        currency: "USD",
        shopifyOrderCurrency: "USD",
        transactionDate: NOW,
        shopifyUpdatedAt: NOW,
        shopifyFinancialStatus: "PAID",
        debitCredit: "credit",
        rawData: null,
      }),
    );
  }

  const jobOf = async (requestId: number) =>
    (await db.select().from(shopifyPrivacyCustomerRedactionJobs).where(eq(shopifyPrivacyCustomerRedactionJobs.requestId, requestId)))[0];
  const parentOf = async (requestId: number) =>
    (await db.select().from(shopifyPrivacyRequests).where(eq(shopifyPrivacyRequests.id, requestId)))[0];
  const storeOf = async (t: Tenant) =>
    (await db.select().from(shopifyConnectorStores).where(eq(shopifyConnectorStores.id, t.storeId)))[0];
  const selectorsOf = async (requestId: number) =>
    db.select({ id: shopifyPrivacyRequestSelectors.id }).from(shopifyPrivacyRequestSelectors).where(eq(shopifyPrivacyRequestSelectors.requestId, requestId));
  const tombstonesOf = async (t: Tenant) =>
    db.select().from(shopifyOrderRedactionTombstones).where(eq(shopifyOrderRedactionTombstones.organizationId, t.organizationId));

  describe("when the request names orders in the minimised form", () => {
    it("should record suppression for review without claiming erasure, keep the selectors and the evidence, and release its own fence", async () => {
      const t = await seedTenant();
      const requestId = await seedRequest(t, { orders: ["501"], fence: "this_request" });
      const orderRow = await seedOrderRow(t, "501", "#1001");

      await handleShopifyCustomerRedactionJob(requestId, deps());

      expect(await jobOf(requestId)).toMatchObject({
        status: "manual_review",
        failureCode: "privacy_scope_review_required",
        lastCheckpoint: "suppression_recorded_review_required",
        attempts: 1,
        leaseId: null,
        completedAt: null,
        selectorDestroyedAt: null,
        recordsFound: 1,
        tombstonesWritten: 1,
        transactionsDeleted: 0,
      });
      expect(await parentOf(requestId)).toMatchObject({
        status: "manual_review",
        completionNote: "privacy_scope_review_required",
        completedAt: null,
      });
      expect(await selectorsOf(requestId)).toHaveLength(2);
      const tombstones = await tombstonesOf(t);
      expect(tombstones).toHaveLength(1);
      expect(tombstones[0]).toMatchObject({ storeId: t.storeId, sourceRequestId: requestId, keyVersion: "v1" });
      expect(await storeOf(t)).toMatchObject({ privacyRedactionState: "active", privacyRedactionRequestId: null });
      expect(await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, orderRow))).toHaveLength(1);
    });

    it("should still go to review, not claim there is nothing held, when it names no orders", async () => {
      const t = await seedTenant();
      const requestId = await seedRequest(t, { orders: [], fence: "free" });

      await handleShopifyCustomerRedactionJob(requestId, deps());

      expect(await jobOf(requestId)).toMatchObject({ status: "manual_review", failureCode: "privacy_scope_review_required", recordsFound: 0 });
      expect(await parentOf(requestId)).toMatchObject({ status: "manual_review", completedAt: null });
      expect(await tombstonesOf(t)).toEqual([]);
      // It took the free fence to work under, and gave it back.
      expect(await storeOf(t)).toMatchObject({ privacyRedactionState: "active", privacyRedactionRequestId: null });
    });
  });

  describe("when the request was already parked or resolved before the run", () => {
    it.each(["manual_review", "completed"] as const)(
      "should park only its job when the request is %s, and write nothing else",
      async (parentStatus) => {
        const t = await seedTenant();
        const requestId = await seedRequest(t, { orders: ["601"], fence: "this_request", parentStatus });
        await db
          .update(shopifyPrivacyRequests)
          .set({ completionNote: "reviewer_decision" })
          .where(eq(shopifyPrivacyRequests.id, requestId));
        await seedOrderRow(t, "601", "#2001");

        await expect(handleShopifyCustomerRedactionJob(requestId, deps())).rejects.toThrow(/retry required/);

        expect(await jobOf(requestId)).toMatchObject({ status: "manual_review", failureCode: "parent_state_conflict", leaseId: null });
        // The parent is a person's (or a newer run's) decision: untouched.
        expect(await parentOf(requestId)).toMatchObject({ status: parentStatus, completionNote: "reviewer_decision" });
        expect(await tombstonesOf(t)).toEqual([]);
        expect(await selectorsOf(requestId)).toHaveLength(2);
        // Its own fence is handed back: no work remains to hold it.
        expect(await storeOf(t)).toMatchObject({ privacyRedactionState: "active", privacyRedactionRequestId: null });
      },
    );

    it("should never release a fence another request holds", async () => {
      const t = await seedTenant();
      const requestId = await seedRequest(t, { orders: ["602"], fence: "free", parentStatus: "completed" });
      const other = await seedRequest(t, { orders: ["603"], fence: "this_request" });

      await expect(handleShopifyCustomerRedactionJob(requestId, deps())).rejects.toThrow(/retry required/);

      expect(await jobOf(requestId)).toMatchObject({ status: "manual_review", failureCode: "parent_state_conflict" });
      expect(await storeOf(t)).toMatchObject({ privacyRedactionState: "customer_redacting", privacyRedactionRequestId: other });
    });
  });

  describe("when one request is dispatched twice at the same moment", () => {
    it("should do the work once", async () => {
      const t = await seedTenant();
      const requestId = await seedRequest(t, { orders: ["701", "702"], fence: "this_request" });
      await seedOrderRow(t, "701", "#3001");
      await seedOrderRow(t, "702", "#3002");

      const runs = await Promise.allSettled([
        handleShopifyCustomerRedactionJob(requestId, deps()),
        handleShopifyCustomerRedactionJob(requestId, deps()),
      ]);

      // One run claims the job. The other finds it parked (and returns), or still
      // leased (and asks the queue to keep the entry): never a second run.
      const refused = runs.filter((run): run is PromiseRejectedResult => run.status === "rejected");
      expect(refused.length).toBeLessThanOrEqual(1);
      for (const run of refused) expect(run.reason).toBeInstanceOf(ShopifyPrivacyJobNotClaimableError);
      expect(await jobOf(requestId)).toMatchObject({ status: "manual_review", failureCode: "privacy_scope_review_required", attempts: 1, tombstonesWritten: 2 });
      const tombstones = await tombstonesOf(t);
      expect(tombstones).toHaveLength(2);
      for (const tombstone of tombstones) expect(tombstone.sourceRequestId).toBe(requestId);
      expect(await parentOf(requestId)).toMatchObject({ status: "manual_review" });
      expect(await storeOf(t)).toMatchObject({ privacyRedactionState: "active", privacyRedactionRequestId: null });
    });
  });
});
