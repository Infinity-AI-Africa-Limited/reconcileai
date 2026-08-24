/**
 * Shared router building blocks (gap-closure plan WS-4 pre-work — the first
 * step of the routers.ts split, see docs/ROUTERS_SPLIT_PLAN.md).
 *
 * Everything a domain router needs to leave the monolith: role-guarded
 * procedure builders, the audit logger, and request helpers. Extracted from
 * server/routers.ts verbatim — every future `server/routers/<domain>.ts`
 * imports from here instead of re-declaring.
 */
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { moduleAppliesTo, moduleUnavailableReason } from "@shared/moduleScope";
import { featureAppliesTo, featureUnavailableReason, type VerticalFeature } from "@shared/verticalFeatures";
import { protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb, createAuditLog, getChannelByIdForOrg } from "../db";
import { organizations, users } from "../../drizzle/schema";

// ─── Constants ───────────────────────────────────────────────────────

/** Max length for user-supplied names (jobs, reports, channels). */
export const MAX_NAME_LENGTH = 255;

// ─── Super Admin Procedure ───────────────────────────────────────────
// Only Infinity AI staff (super_admin role) can access these procedures.
// Cross-tenant visibility: can see ALL organisations, instances, and users.

export const superAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "super_admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Super Admin access required. This action is restricted to Infinity AI staff." });
  }
  return next({ ctx });
});

// ─── Admin Procedure ─────────────────────────────────────────────────
// Allows both super_admin (Infinity AI) and admin (org-level admin) roles.

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" && ctx.user.role !== "super_admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx });
});

// Tenancy guard for user-management mutations. Super admins (Infinity AI) may act
// on anyone. Org admins may only act on non-super-admin users within their OWN
// organisation — they can neither see nor touch Infinity AI staff or other orgs.
export async function assertCanManageUsers(
  ctx: { user: { role: string; organizationId: number | null } },
  userIds: number[]
): Promise<void> {
  if (ctx.user.role === "super_admin") return;
  if (userIds.length === 0) return;
  const drizzle = await getDb();
  if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  const targets = await drizzle
    .select({ id: users.id, role: users.role, organizationId: users.organizationId })
    .from(users)
    .where(inArray(users.id, userIds));
  for (const t of targets) {
    if (t.role === "super_admin" || t.organizationId !== ctx.user.organizationId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You can only manage users within your own organisation.",
      });
    }
  }
}

// ─── Vertical Feature Middleware ─────────────────────────────────────

/** The caller's organisation segment, or null when they have no organisation. */
async function segmentOf(ctx: { user: { organizationId?: number | null } }): Promise<string | null> {
  if (!ctx.user.organizationId) return null;
  const drizzle = await getDb();
  if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const [org] = await drizzle
    .select({ segment: organizations.segment })
    .from(organizations)
    .where(eq(organizations.id, ctx.user.organizationId))
    .limit(1);
  return org?.segment ?? null;
}

/**
 * A procedure only some verticals may call at all.
 *
 * Applied as a procedure BUILDER rather than a line inside each handler on
 * purpose: a router built from it cannot gain an unguarded procedure by someone
 * adding one and forgetting the check. That is precisely how the module-scope
 * gap happened — the guard was on the two module mutations, and the procedures
 * that actually ran the engine were added without it.
 *
 * The segment lookup costs one indexed read on a hot-ish path. Acceptable here
 * because these routers are low-traffic (regulatory reporting, a distributor
 * registry), and correctness at the boundary is worth more than the round trip.
 */
export function verticalFeatureProcedure(feature: VerticalFeature) {
  return protectedProcedure.use(async ({ ctx, next }) => {
    // "No organisation at all" is NOT the same as "segment not yet known", and
    // the two must not share a branch. An unknown segment keeps the feature by
    // design (see featureAppliesTo). An account with no organisation has no
    // institution whose feature this could be — and several CBN handlers fall
    // back to `ctx.user.organizationId ?? 0`, so allowing it through would pool
    // every such account into one shared pseudo-tenant able to read and
    // overwrite each other's report settings and regulatory runs. Refuse before
    // that fallback is reachable. 22 accounts currently have no organisation;
    // none of them is a super admin, so this locks out no operator.
    if (!ctx.user.organizationId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Your account is not linked to an organisation, so this feature is unavailable.",
      });
    }
    const segment = await segmentOf(ctx);
    if (!featureAppliesTo(feature, segment)) {
      throw new TRPCError({ code: "FORBIDDEN", message: featureUnavailableReason(feature, segment) });
    }
    return next({ ctx });
  });
}

/** CBN/BoU regulatory reporting, attestation, deadlines, Auditor dashboard. */
export const cbnProcedure = verticalFeatureProcedure("cbn_regulatory_reporting");

/** Distributor identity registry and the Pilot Readiness scorecard over it. */
export const distributorProcedure = verticalFeatureProcedure("distributor_registry");

// ─── Guest Protection Middleware ─────────────────────────────────────

export const guestProtectedProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.isGuest) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Guest users cannot perform write operations. Please sign up to save your work."
    });
  }
  return next({ ctx });
});

// ─── Operations-Only Middleware ───────────────────────────────────────
// Blocks CFO and Compliance/Audit roles from performing reconciliation
// and exception mutations. Admins and Operations users are allowed.
export const operationsProcedure = protectedProcedure.use(({ ctx, next }) => {
  const restrictedRoles = ["cfo", "compliance"];
  if (ctx.user.isGuest) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Guest users cannot perform write operations." });
  }
  if (restrictedRoles.includes(ctx.user.role as string)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Your role (${ctx.user.role}) does not have permission to perform reconciliation or exception write operations. This is a read-only action for your role.`,
    });
  }
  return next({ ctx });
});

// Public-but-gated Woodcore POC procedures: require a valid access token (the
// x-poc-access-token header) for the fixed "woodcore" POC key. Keeps the live
// Woodcore/Fineract data behind the per-POC invite link.
export const woodcoreProcedure = publicProcedure.use(async (opts) => {
  const { assertPocAccess, tokenFromCtx } = await import("../pocAccess");
  await assertPocAccess("woodcore", tokenFromCtx(opts.ctx));
  return opts.next();
});

// ─── Helpers ─────────────────────────────────────────────────────────

export async function logAudit(
  userId: number | null,
  action: string,
  entityType: string,
  entityId?: number,
  details?: any,
  ipAddress?: string,
  userAgent?: string
) {
  try {
    await createAuditLog({
      userId,
      action,
      entityType,
      entityId,
      details: details ? JSON.stringify(details) : null,
      ipAddress: ipAddress || null,
      userAgent: userAgent ? userAgent.substring(0, 500) : null,
    });
  } catch (err) {
    // Audit logging should never crash the main operation
    console.error("[Audit] Failed to log:", err);
  }
}

export function getClientInfo(ctx: any): { ip: string; ua: string } {
  const ip = ctx.req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim()
    || ctx.req?.socket?.remoteAddress
    || "unknown";
  const ua = ctx.req?.headers?.["user-agent"] || "unknown";
  return { ip, ua };
}

/**
 * Prove an organization may bind a data feed to this channel.
 *
 * Every ingestion source — SFTP, bucket drop, email forward, public upload API —
 * stores a caller-supplied `channelId` that decides what its transactions get
 * reconciled against. Left unchecked, an admin can bind a feed to a channel
 * their organization does not own. Ingested rows still carry the SOURCE's
 * organizationId, so this is not a cross-tenant read; the damage is that one
 * institution's settlements are matched against another's channel, and that a
 * foreign channel id becomes bindable and therefore enumerable.
 *
 * The same class as #25 / #31 / #32 / #34 — an id from the caller used without
 * proof of ownership. Note the tenancy ratchet in tenancyRatchet.test.ts cannot
 * catch this one: it guards id-keyed WRITES in db.ts, and this is a foreign key
 * accepted on the way in.
 *
 * Delegates to `getChannelByIdForOrg`, which applies `channelScope` — the org's
 * own channels plus the shared platform rails (organizationId NULL), never
 * widening to everything. NOT_FOUND rather than FORBIDDEN, so a probe cannot
 * distinguish "not yours" from "does not exist".
 */
export async function assertChannelBindable(
  organizationId: number,
  channelId: number,
): Promise<void> {
  const channel = await getChannelByIdForOrg(channelId, organizationId);
  if (!channel) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found" });
  }
}

/**
 * Refuse a module the caller's vertical cannot use.
 *
 * Hiding it on the module page is presentation; this is the rule. A retail
 * merchant has no general ledger wired to a core banking system, so
 * account_level is meaningless for them — and it was switched ON at
 * provisioning for every SHOPLINE tenant. See shared/moduleScope.
 *
 * Lives here rather than in one router because two domains need it and they
 * must not be able to disagree: `modules.toggle` / `modules.updateConfig` in
 * server/routers.ts decide whether the module can be ENABLED, and
 * ./reconciliation.ts decides whether a run may be CREATED. Guarding only the
 * first left the engine reachable — the toggle is not the gate, because the
 * job procedures take moduleType from the caller and never read
 * moduleConfigurations at all.
 */
export async function assertModuleAvailable(
  ctx: { user: { organizationId?: number | null } },
  moduleType: "settlement" | "account_level",
): Promise<void> {
  if (!ctx.user.organizationId) return;
  const drizzle = await getDb();
  if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const [org] = await drizzle
    .select({ segment: organizations.segment })
    .from(organizations)
    .where(eq(organizations.id, ctx.user.organizationId))
    .limit(1);
  if (!moduleAppliesTo(moduleType, org?.segment)) {
    throw new TRPCError({ code: "FORBIDDEN", message: moduleUnavailableReason(moduleType, org?.segment) });
  }
}

export function sanitizeInput(input: string, maxLength: number = 255): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .trim()
    .substring(0, maxLength);
}
