/**
 * End-to-end proof of the destructive `shop/redact` boundary against a real,
 * isolated MySQL database. The test is disabled unless DATABASE_URL is a local
 * target, so it can never use a developer's or Railway's production database.
 */
import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations, users } from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyPrivacyRequests,
  shopifyShopRedactionJobs,
  shopifyShopRedactionReceipts,
} from "../../../drizzle/shopify_schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { handleShopifyShopRedactionJob } from "./shopRedaction";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
const NOW = new Date("2026-10-16T07:30:00.000Z");

describe.runIf(localDatabase)(
  "when Shopify shop redaction erases a tenant in MySQL",
  () => {
    let pool: mysql.Pool;
    let db: MySql2Database;
    const nonce = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const runId = `00000000-0000-4000-8000-${nonce.slice(-12).padStart(12, "0")}`;
    const requestHash = `receipt_${nonce}`.slice(0, 64);
    let organizationId = 0;
    let storeId = 0;
    let requestId = 0;
    let jobId = 0;

    beforeAll(async () => {
      pool = mysql.createPool({ uri: url, timezone: "Z", connectionLimit: 1 });
      db = drizzle(pool);
    });

    afterAll(async () => {
      if (!db) return;
      // The passing case has already removed the tenant. These narrow best-effort
      // cleanup writes make a failed assertion safe to re-run in the same CI DB.
      if (jobId)
        await db
          .delete(shopifyShopRedactionJobs)
          .where(eq(shopifyShopRedactionJobs.id, jobId));
      if (requestId)
        await db
          .delete(shopifyPrivacyRequests)
          .where(eq(shopifyPrivacyRequests.id, requestId));
      if (storeId)
        await db
          .delete(shopifyConnectorStores)
          .where(eq(shopifyConnectorStores.id, storeId));
      if (organizationId)
        await db.delete(users).where(eq(users.organizationId, organizationId));
      if (organizationId)
        await db
          .delete(organizations)
          .where(eq(organizations.id, organizationId));
      await db
        .delete(shopifyShopRedactionReceipts)
        .where(eq(shopifyShopRedactionReceipts.runId, runId));
      await pool.end();
    });

    it("should remove the fenced workspace and leave only a de-identified receipt", async () => {
      const [organization] = await db.insert(organizations).values({
        name: `Erasure rehearsal ${nonce}`,
        code: `ERASURE_${nonce}`.slice(0, 50),
        segment: "retail_commerce",
        onboardingChannel: "shopify_public_app",
        deletionState: "redacting",
        isActive: false,
        redactingAt: NOW,
        redactionRunId: runId,
      });
      organizationId = Number((organization as { insertId: number }).insertId);

      const [user] = await db.insert(users).values({
        openId: `erasure_${nonce}`.slice(0, 64),
        name: "Masked rehearsal merchant",
        email: `masked-${nonce}@example.invalid`.slice(0, 320),
        role: "admin",
        organizationId,
        isActive: false,
      });

      const [store] = await db.insert(shopifyConnectorStores).values({
        organizationId,
        shopDomain: `erasure-${nonce}.myshopify.com`.slice(0, 253),
        shopId: `shop_${nonce}`.slice(0, 64),
        displayName: "Masked rehearsal store",
        grantedScopes: "read_orders",
        requestedScopes: "read_orders",
        status: "redacting",
        claimedByUserId: Number((user as { insertId: number }).insertId),
      });
      storeId = Number((store as { insertId: number }).insertId);

      const [request] = await db.insert(shopifyPrivacyRequests).values({
        organizationId,
        storeId,
        topic: "shop/redact",
        requestHash,
        status: "received",
      });
      requestId = Number((request as { insertId: number }).insertId);

      const [job] = await db.insert(shopifyShopRedactionJobs).values({
        runId,
        organizationId,
        storeId,
        privacyRequestId: requestId,
        requestHash,
        webhookId: `wh_${nonce}`.slice(0, 128),
        status: "admitted",
        manifestVersion: 1,
      });
      jobId = Number((job as { insertId: number }).insertId);

      await handleShopifyShopRedactionJob(jobId, {
        db: db as never,
        now: () => NOW,
        uuid: () => "11111111-1111-4111-8111-111111111111",
        deleteObject: async () => {},
      });

      const [
        remainingOrganization,
        remainingStore,
        remainingUser,
        remainingJob,
        receipt,
      ] = await Promise.all([
        db
          .select()
          .from(organizations)
          .where(eq(organizations.id, organizationId)),
        db
          .select()
          .from(shopifyConnectorStores)
          .where(eq(shopifyConnectorStores.id, storeId)),
        db.select().from(users).where(eq(users.organizationId, organizationId)),
        db
          .select()
          .from(shopifyShopRedactionJobs)
          .where(eq(shopifyShopRedactionJobs.id, jobId)),
        db
          .select()
          .from(shopifyShopRedactionReceipts)
          .where(
            and(
              eq(shopifyShopRedactionReceipts.runId, runId),
              eq(shopifyShopRedactionReceipts.requestHash, requestHash)
            )
          ),
      ]);
      expect(remainingOrganization).toEqual([]);
      expect(remainingStore).toEqual([]);
      expect(remainingUser).toEqual([]);
      expect(remainingJob).toEqual([]);
      expect(receipt).toHaveLength(1);
      expect(receipt[0]).toMatchObject({
        runId,
        requestHash,
        completedAt: NOW,
      });
      expect(JSON.stringify(receipt[0])).not.toMatch(
        /"(organizationId|storeId|shopDomain|webhookId|email|payload)"/i
      );
    });
  }
);
