import crypto from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { SHOPIFY_INSTALL_LEASE_MS, shopifyInstallLeases } from "../../../drizzle/shopify_schema";
import { getDb } from "../../db";
import { isDuplicateKeyError } from "../../dbErrors";
import { affectedRows } from "./tokenStore";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Take the shop's install lease (see shopifyInstallLeases). Returns the lease id,
 * or null while another callback holds a live one.
 *
 * An expired lease is taken over by one conditional UPDATE — the new expiry is
 * in the future, so of two callbacks racing for the same expired lease exactly
 * one matches `expiresAt < now`.
 */
export async function acquireInstallLease(db: Db, shopDomain: string, now: Date = new Date()): Promise<string | null> {
  const leaseId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + SHOPIFY_INSTALL_LEASE_MS);
  try {
    await db.insert(shopifyInstallLeases).values({ shopDomain, leaseId, expiresAt });
    return leaseId;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
  const taken = affectedRows(
    await db
      .update(shopifyInstallLeases)
      .set({ leaseId, expiresAt })
      .where(and(eq(shopifyInstallLeases.shopDomain, shopDomain), lt(shopifyInstallLeases.expiresAt, now))),
  );
  return taken === 1 ? leaseId : null;
}

/** Release a lease this callback holds. A lease since taken over by another is left alone. */
export async function releaseInstallLease(db: Db, shopDomain: string, leaseId: string): Promise<void> {
  await db
    .delete(shopifyInstallLeases)
    .where(and(eq(shopifyInstallLeases.shopDomain, shopDomain), eq(shopifyInstallLeases.leaseId, leaseId)));
}
