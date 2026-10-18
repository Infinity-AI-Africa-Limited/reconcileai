/**
 * Real-MySQL proof that Shopify's development-store answer classifies its
 * tenant, and un-classifies it when the store goes live: migration 0117's
 * columns, the locking reads, the tenant flag and the audit record, together.
 *
 * Only this test's own organisation and store are touched. The scheduled sweep
 * (`recheckShopifyStoreClassifications`) reaches every tenant's due stores, so
 * it is not run here: on a shared or developer database it would ask about —
 * and record attempts on — stores that are not this test's. Its selection is
 * pinned in storeClassification.test.ts.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditChainLocks, auditLogs, organizations } from "../../../drizzle/schema";
import { shopifyConnectorStores } from "../../../drizzle/shopify_schema";
import { getDb } from "../../db";
import { classifyDatabaseTarget } from "../../dbTarget";
import { applyShopifyStoreClassification, type ShopifyClassificationTrigger } from "./storeClassification";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe.runIf(localDatabase)("when a Shopify store's development-store answer is applied on a real database", () => {
  const tag = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const shopDomain = `classify-${tag}.myshopify.com`;
  let db: Db;
  let organizationId = 0;
  let storeId = 0;

  const insertedId = (result: unknown) => Number((result as Array<{ insertId?: number }>)[0]?.insertId);

  const applyAnswer = (observed: boolean | null, trigger: ShopifyClassificationTrigger = "recheck") =>
    db.transaction((tx) =>
      applyShopifyStoreClassification(tx, { store: { id: storeId, organizationId, shopDomain }, observed, now: new Date(), trigger }),
    );

  const tenantIsDemo = async () =>
    (await db.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, organizationId)))[0]?.isDemo;

  const storePlan = async () =>
    (
      await db
        .select({ planPartnerDevelopment: shopifyConnectorStores.planPartnerDevelopment, planCheckedAt: shopifyConnectorStores.planCheckedAt })
        .from(shopifyConnectorStores)
        .where(eq(shopifyConnectorStores.id, storeId))
    )[0];

  const classificationAudits = () =>
    db
      .select({ userId: auditLogs.userId, details: auditLogs.details })
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, "update_org_is_demo")))
      .orderBy(auditLogs.id);

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;
    organizationId = insertedId(
      await db.insert(organizations).values({
        name: `Classification rehearsal ${tag}`,
        code: `CLASSIFY_${tag}`.slice(0, 50),
        segment: "retail_commerce",
        onboardingChannel: "shopify_public_app",
      }),
    );
    storeId = insertedId(
      await db.insert(shopifyConnectorStores).values({
        organizationId,
        shopDomain,
        shopId: `shop_${tag}`,
        displayName: "Classification rehearsal store",
        grantedScopes: "read_orders",
        requestedScopes: "read_orders",
        status: "active",
      }),
    );
  });

  afterAll(async () => {
    if (!db || !organizationId) return;
    for (const step of [
      () => db.delete(shopifyConnectorStores).where(eq(shopifyConnectorStores.organizationId, organizationId)),
      () => db.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId)),
      () => db.delete(auditChainLocks).where(eq(auditChainLocks.chainKey, organizationId)),
      () => db.delete(organizations).where(eq(organizations.id, organizationId)),
    ]) {
      try {
        await step();
      } catch (error) {
        console.error("[storeClassification.db.test] cleanup step failed:", error);
      }
    }
  });

  it("should start as a client whose store Shopify has never answered for", async () => {
    expect(await tenantIsDemo()).toBe(false);
    expect(await storePlan()).toEqual({ planPartnerDevelopment: null, planCheckedAt: null });
  });

  it("should record an unanswered question without classifying anything", async () => {
    await expect(applyAnswer(null)).resolves.toEqual({ changedTo: null });
    const plan = await storePlan();
    expect(plan?.planPartnerDevelopment).toBeNull();
    expect(plan?.planCheckedAt).not.toBeNull();
    expect(await tenantIsDemo()).toBe(false);
  });

  it("should make the tenant a test tenant when Shopify says development store, recorded as Shopify's doing", async () => {
    await expect(applyAnswer(true, "install")).resolves.toEqual({ changedTo: "test_tenant" });
    expect(await tenantIsDemo()).toBe(true);
    expect((await storePlan())?.planPartnerDevelopment).toBe(true);
    const audits = await classificationAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBeNull();
    expect(JSON.stringify(audits[0].details)).toMatch(/shopify_partner_development/);
  });

  it("should change nothing, and record nothing, while it stays a development store", async () => {
    await expect(applyAnswer(true)).resolves.toEqual({ changedTo: null });
    expect(await tenantIsDemo()).toBe(true);
    expect(await classificationAudits()).toHaveLength(1);
  });

  it("should make the tenant a client again the moment Shopify reports the store live", async () => {
    await expect(applyAnswer(false)).resolves.toEqual({ changedTo: "client" });
    expect(await tenantIsDemo()).toBe(false);
    expect((await storePlan())?.planPartnerDevelopment).toBe(false);
    expect(await classificationAudits()).toHaveLength(2);
  });

  it("should ignore a development answer that lost a race with the live one", async () => {
    // The sweep fetched "development" before a reauthorization recorded "live";
    // its transaction arrives second, holding the older answer (Greptile, #206).
    await expect(applyAnswer(true)).resolves.toEqual({ changedTo: null });
    expect(await tenantIsDemo()).toBe(false);
    expect((await storePlan())?.planPartnerDevelopment).toBe(false);
    expect(await classificationAudits()).toHaveLength(2);
  });

  it("should leave an operator's later demo mark on the live store alone", async () => {
    await db.update(organizations).set({ isDemo: true }).where(eq(organizations.id, organizationId));
    await expect(applyAnswer(false)).resolves.toEqual({ changedTo: null });
    expect(await tenantIsDemo()).toBe(true);
    expect(await classificationAudits()).toHaveLength(2);
  });
});
