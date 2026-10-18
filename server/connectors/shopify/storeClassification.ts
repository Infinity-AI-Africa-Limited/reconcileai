/**
 * Whether a Shopify store's tenant is a test tenant, decided by Shopify.
 *
 * Every installation provisions a tenant, and until now every tenant arrived as
 * a client (`organizations.isDemo = 0`). Our own development store did, on
 * 2026-10-16: it then appeared in the owner's SLA breach alert and blocked every
 * platform-wide reviewer link until someone marked it a demo by hand.
 *
 * Shopify knows the answer. `shop.plan.partnerDevelopment` is true for a partner
 * development store, its test store, which cannot take real payments. So:
 *
 *   - Shopify says development store → the tenant is a test tenant.
 *   - Shopify says otherwise, or cannot be asked → nothing changes. Unknown is
 *     never "test": the safe failure is an alert about a test store, never
 *     silence about a client.
 *
 * The danger is the classification going stale. A development store can be
 * handed to a merchant and taken live, keeping its domain and this app. Left
 * marked as a test tenant, that paying client's SLA breaches would never be
 * reported and their data would be open to a platform reviewer link. So the
 * answer is asked again on every reauthorization and, for every store not yet
 * known to be live, on a schedule (`recheckShopifyStoreClassifications`, run by
 * the order backstop). A store seen going from development to live becomes a
 * client at once, and the owner is told.
 *
 * Answers only move FORWARD: unknown, then development store, then live. A
 * live store never becomes a development store again, so an answer behind the
 * recorded one is a stale read that lost a race, and is ignored — never
 * applied, never recorded (`shopifyAnswerAdvances`).
 *
 * Only that TRANSITION is acted on. A store Shopify reports as live and an
 * operator chose to mark a demo keeps that choice, which is theirs and audited;
 * the re-check exists to correct OUR classification when its basis changes, not
 * to argue with an operator.
 */
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { organizations } from "../../../drizzle/schema";
import { SHOPIFY_API_VERSION, shopifyConnectorStores } from "../../../drizzle/shopify_schema";
import { assertEgressAllowed } from "../../_core/egress";
import { notifyOwner } from "../../_core/notification";
import { createAuditLog, getDb, type DbTransaction } from "../../db";
import { loggableError } from "../../dbErrors";
import { normalizeShopDomain } from "./auth";
import { getValidShopifyAccessToken } from "./tokenStore";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** How long a development store's (or an unknown store's) answer is trusted before Shopify is asked again. */
export const SHOPIFY_PLAN_RECHECK_INTERVAL_MS = 6 * 60 * 60_000;

/** Stores re-checked per backstop tick, least recently asked first. */
export const SHOPIFY_PLAN_RECHECK_BATCH = 25;

/**
 * Short, because an installation waits on it with the merchant watching. A slow
 * answer is simply unknown, and the scheduled re-check asks again.
 */
const SHOPIFY_PLAN_LOOKUP_TIMEOUT_MS = 10_000;

/** Read-only; asks for the one field and nothing about orders, customers or money. */
const SHOP_PLAN_QUERY = `query ReconcileAIShopPlan {
  shop {
    plan {
      partnerDevelopment
    }
  }
}`;

/**
 * Shopify's answer: true for a partner development store, false for any other,
 * null when it could not be had. Never throws.
 *
 * Asked on its own rather than inside the shop-metadata query, because an
 * installation needs that query and does not need this one: were Shopify ever
 * to refuse this field, folding it in would fail every install.
 */
export async function fetchShopifyPartnerDevelopment(params: {
  shopDomain: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean | null> {
  try {
    const shop = normalizeShopDomain(params.shopDomain);
    if (!shop) return null;
    const endpoint = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    assertEgressAllowed(endpoint, "Shopify store plan lookup");
    const response = await (params.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": params.accessToken,
      },
      body: JSON.stringify({ query: SHOP_PLAN_QUERY }),
      signal: AbortSignal.timeout(SHOPIFY_PLAN_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: { shop?: { plan?: { partnerDevelopment?: unknown } | null } | null } | null;
      errors?: unknown[];
    };
    if (Array.isArray(body.errors) && body.errors.length > 0) return null;
    const answer = body.data?.shop?.plan?.partnerDevelopment;
    return typeof answer === "boolean" ? answer : null;
  } catch {
    // Network, timeout, egress refusal or a body that is not JSON: unknown.
    return null;
  }
}

export type ShopifyTenantClassification = "test_tenant" | "client";

/**
 * How far along its one-way life a store's recorded answer is. A store is
 * unknown, then may be a development store, then may go live — and a live
 * store never becomes a development store again.
 */
function lifecycleRank(answer: boolean | null): number {
  if (answer === null) return 0;
  return answer ? 1 : 2;
}

/**
 * Whether an answer moves the store FORWARD from what is recorded. Anything
 * else is stale and is ignored, recorded value included.
 *
 * This is what makes a late answer harmless. Every answer is fetched before
 * the transaction that applies it, so another writer can record a newer one
 * in between: the sweep reads "development store", a reauthorization records
 * "live", and the sweep's transaction then arrives holding the older answer.
 * Accepted, it would mark a live merchant a test tenant — silencing their SLA
 * alerts and opening their data to platform reviewer links — and overwrite
 * the newer answer for the next six hours. (Greptile, #206: the first version
 * accepted live → development as though it were news.)
 */
export function shopifyAnswerAdvances(previous: boolean | null, observed: boolean | null): boolean {
  return lifecycleRank(observed) > lifecycleRank(previous);
}

/**
 * What a fresh answer from Shopify changes, given the last one recorded.
 *
 *   - unknown, or not newer than the recorded answer → nothing;
 *   - development store, seen for the first time     → test tenant;
 *   - live, after having been a development store    → client.
 *
 * A live store never seen as a development store changes nothing: the tenant
 * was created a client, and if an operator has since marked it a demo, that is
 * their decision.
 */
export function shopifyClassificationChange(
  previous: boolean | null,
  observed: boolean | null,
): ShopifyTenantClassification | null {
  if (!shopifyAnswerAdvances(previous, observed)) return null;
  if (observed === true) return "test_tenant";
  if (observed === false && previous === true) return "client";
  return null;
}

export type ShopifyClassificationTrigger = "install" | "reauthorization" | "recheck";

export interface ShopifyClassificationResult {
  /** The tenant's classification was changed by this call. */
  changedTo: ShopifyTenantClassification | null;
}

/**
 * Record Shopify's answer for a store and apply what it changes, inside the
 * caller's transaction.
 *
 * Lock order is organisation, then store — the order every Shopify path that
 * holds both uses (redaction, privacy completion, retention, reauthorization),
 * so this cannot deadlock against any of them. Both rows are read under the
 * locks, so two callers racing on one store apply one change, once.
 *
 * A tenant being redacted, or a store under a redaction fence, is left exactly
 * as it is: nothing is written into a workspace being deleted.
 */
export async function applyShopifyStoreClassification(
  tx: DbTransaction,
  params: {
    store: { id: number; organizationId: number; shopDomain: string };
    observed: boolean | null;
    now: Date;
    trigger: ShopifyClassificationTrigger;
  },
): Promise<ShopifyClassificationResult> {
  const { store, observed, now, trigger } = params;
  const [organization] = await tx
    .select({ isDemo: organizations.isDemo, deletionState: organizations.deletionState })
    .from(organizations)
    .where(eq(organizations.id, store.organizationId))
    .limit(1)
    .for("update");
  const [current] = await tx
    .select({
      planPartnerDevelopment: shopifyConnectorStores.planPartnerDevelopment,
      status: shopifyConnectorStores.status,
      privacyRedactionState: shopifyConnectorStores.privacyRedactionState,
    })
    .from(shopifyConnectorStores)
    .where(and(eq(shopifyConnectorStores.id, store.id), eq(shopifyConnectorStores.organizationId, store.organizationId)))
    .limit(1)
    .for("update");
  if (!organization || !current) return { changedTo: null };
  if (organization.deletionState !== "active" || current.status === "redacting" || current.privacyRedactionState !== "active") {
    return { changedTo: null };
  }

  const previous = current.planPartnerDevelopment;
  // Only an answer newer than the recorded one is kept: a stale one must not
  // overwrite it (see shopifyAnswerAdvances).
  await tx
    .update(shopifyConnectorStores)
    .set({ planCheckedAt: now, ...(shopifyAnswerAdvances(previous, observed) ? { planPartnerDevelopment: observed } : {}) })
    .where(and(eq(shopifyConnectorStores.id, store.id), eq(shopifyConnectorStores.organizationId, store.organizationId)));

  const change = shopifyClassificationChange(previous, observed);
  const isDemo = change === "test_tenant";
  // Already where Shopify's answer puts it — an operator got there first — so
  // there is nothing to change and nothing to record.
  if (change === null || Boolean(organization.isDemo) === isDemo) return { changedTo: null };

  await tx.update(organizations).set({ isDemo }).where(eq(organizations.id, store.organizationId));
  // The same action an operator's "Mark as demo" records, so one search of the
  // trail finds every change to this flag; `source` says who made this one.
  await createAuditLog(
    {
      organizationId: store.organizationId,
      userId: null,
      action: "update_org_is_demo",
      entityType: "organization",
      entityId: store.organizationId,
      details: {
        isDemo,
        source: "shopify_partner_development",
        partnerDevelopment: observed,
        previousPartnerDevelopment: previous,
        shopDomain: store.shopDomain,
        trigger,
      },
    },
    tx,
  );
  return { changedTo: change };
}

/**
 * Tell the owner a development store went live. After the change has
 * committed, and best effort: the classification is already correct, and a
 * failed email must not undo it or stop the sweep.
 */
export async function announceShopifyStoreWentLive(store: { organizationId: number; shopDomain: string }): Promise<void> {
  console.warn("[shopify-classification] a development store went live; its tenant is now a client", {
    code: "shopify_store_went_live",
    organizationId: store.organizationId,
    shopDomain: store.shopDomain,
  });
  try {
    await notifyOwner({
      title: `Shopify store went live: ${store.shopDomain}`,
      content: [
        `Shopify now reports ${store.shopDomain} as a live store, no longer a development store.`,
        `Its ReconcileAI workspace (organisation ${store.organizationId}) has been reclassified from a test tenant to a client:`,
        `its exceptions are now covered by SLA alerts, and it counts towards the platform-wide reviewer-link check.`,
        `If this is a store a merchant now runs, treat it as a customer from here on.`,
      ].join("\n"),
    });
  } catch (error) {
    console.error("[shopify-classification] could not notify the owner", {
      code: "shopify_store_went_live_notify_failed",
      ...loggableError(error),
    });
  }
}

export interface ShopifyClassificationRecheckReport {
  scanned: number;
  changed: number;
  unknown: number;
  failed: number;
}

export interface ShopifyClassificationRecheckDeps {
  db?: Db;
  now?: () => Date;
  getAccessToken?: typeof getValidShopifyAccessToken;
  fetchPartnerDevelopment?: typeof fetchShopifyPartnerDevelopment;
  announce?: typeof announceShopifyStoreWentLive;
  batchSize?: number;
  intervalMs?: number;
}

/**
 * Ask Shopify again about every store whose answer could still change the
 * tenant's classification: those last seen as development stores, and those
 * never answered (installed before this existed, or Shopify was unreachable).
 * A store known to be live is not asked — a live store cannot become a
 * development store. Never throws.
 */
export async function recheckShopifyStoreClassifications(
  deps: ShopifyClassificationRecheckDeps = {},
): Promise<ShopifyClassificationRecheckReport> {
  const report: ShopifyClassificationRecheckReport = { scanned: 0, changed: 0, unknown: 0, failed: 0 };
  const clock = deps.now ?? (() => new Date());
  let db: Db;
  let stores: Array<{ id: number; organizationId: number; shopDomain: string }>;
  try {
    const found = deps.db ?? (await getDb());
    if (!found) throw new Error("Database unavailable");
    db = found;
    const dueBefore = new Date(clock().getTime() - (deps.intervalMs ?? SHOPIFY_PLAN_RECHECK_INTERVAL_MS));
    stores = await db
      .select({
        id: shopifyConnectorStores.id,
        organizationId: shopifyConnectorStores.organizationId,
        shopDomain: shopifyConnectorStores.shopDomain,
      })
      .from(shopifyConnectorStores)
      .innerJoin(organizations, eq(organizations.id, shopifyConnectorStores.organizationId))
      .where(
        and(
          eq(shopifyConnectorStores.status, "active"),
          eq(shopifyConnectorStores.privacyRedactionState, "active"),
          eq(organizations.deletionState, "active"),
          or(isNull(shopifyConnectorStores.planPartnerDevelopment), eq(shopifyConnectorStores.planPartnerDevelopment, true)),
          or(isNull(shopifyConnectorStores.planCheckedAt), lte(shopifyConnectorStores.planCheckedAt, dueBefore)),
        ),
      )
      // Never asked first (NULL sorts first ascending in MySQL), then least recently.
      .orderBy(asc(shopifyConnectorStores.planCheckedAt), asc(shopifyConnectorStores.id))
      .limit(deps.batchSize ?? SHOPIFY_PLAN_RECHECK_BATCH);
  } catch (error) {
    console.error("[shopify-classification] store plan re-check unavailable", {
      code: "shopify_classification_unavailable",
      ...loggableError(error),
    });
    return report;
  }

  for (const store of stores) {
    report.scanned += 1;
    try {
      let observed: boolean | null = null;
      try {
        const accessToken = await (deps.getAccessToken ?? getValidShopifyAccessToken)({
          storeId: store.id,
          organizationId: store.organizationId,
        });
        observed = await (deps.fetchPartnerDevelopment ?? fetchShopifyPartnerDevelopment)({
          shopDomain: store.shopDomain,
          accessToken,
        });
      } catch {
        // No usable credential: the answer is unknown, and unknown changes nothing.
        observed = null;
      }
      if (observed === null) report.unknown += 1;
      // The attempt is recorded even when unanswered, so an unreachable store is
      // asked again after the interval rather than on every tick.
      const { changedTo } = await db.transaction((tx) =>
        applyShopifyStoreClassification(tx, { store, observed, now: clock(), trigger: "recheck" }),
      );
      if (changedTo) report.changed += 1;
      if (changedTo === "client") await (deps.announce ?? announceShopifyStoreWentLive)(store);
    } catch (error) {
      report.failed += 1;
      console.error("[shopify-classification] store plan re-check failed", {
        code: "shopify_classification_store_failed",
        storeId: store.id,
        organizationId: store.organizationId,
        ...loggableError(error),
      });
    }
  }
  if (report.scanned > 0) {
    console.log("[shopify-classification] store plan re-check ran", { code: "shopify_classification_completed", ...report });
  }
  return report;
}
