import crypto from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { SHOPIFY_INSTALL_LEASE_MS, shopifyInstallLeases } from "../../../drizzle/shopify_schema";
import { getDb, type DbExecutor } from "../../db";
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

/** A lease one callback holds on one shop. */
export interface InstallLease {
  shopDomain: string;
  leaseId: string;
}

/**
 * Extend a lease this callback still holds. False means it expired and was
 * taken over. Run inside a transaction, the UPDATE also row-locks the lease, so
 * no takeover can commit before that transaction does (see
 * suspendForReauthorization, the one caller).
 *
 * Renewing right before the exchange is what bounds the exchange inside the
 * lease: the exchange times out at 30s, far inside the TTL, so the grant
 * happens while this callback still holds the shop. (mysql2 reports MATCHED
 * rows, so a same-second renewal that changes nothing still counts.)
 */
export async function renewInstallLease(db: DbExecutor, lease: InstallLease, now: Date = new Date()): Promise<boolean> {
  const renewed = affectedRows(
    await db
      .update(shopifyInstallLeases)
      .set({ expiresAt: new Date(now.getTime() + SHOPIFY_INSTALL_LEASE_MS) })
      .where(and(eq(shopifyInstallLeases.shopDomain, lease.shopDomain), eq(shopifyInstallLeases.leaseId, lease.leaseId))),
  );
  return renewed === 1;
}

/**
 * Inside a transaction: does this callback still hold the shop's lease?
 *
 * The locking read is the point: a takeover is an UPDATE of this row, so it
 * cannot commit until the caller's transaction does — the answer stays true
 * until the caller's writes are in. Only the lease id is compared, not the
 * expiry: an expired lease nobody has taken over still means nobody else has
 * exchanged a code for this shop.
 */
export async function holdsInstallLease(tx: DbExecutor, lease: InstallLease): Promise<boolean> {
  const [row] = await tx
    .select({ leaseId: shopifyInstallLeases.leaseId })
    .from(shopifyInstallLeases)
    .where(and(eq(shopifyInstallLeases.shopDomain, lease.shopDomain), eq(shopifyInstallLeases.leaseId, lease.leaseId)))
    .for("update")
    .limit(1);
  return Boolean(row);
}

/** Release a lease this callback holds. A lease since taken over by another is left alone. */
export async function releaseInstallLease(db: Db, shopDomain: string, leaseId: string): Promise<void> {
  await db
    .delete(shopifyInstallLeases)
    .where(and(eq(shopifyInstallLeases.shopDomain, shopDomain), eq(shopifyInstallLeases.leaseId, leaseId)));
}
