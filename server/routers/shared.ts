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
import { inArray } from "drizzle-orm";
import { protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb, createAuditLog } from "../db";
import { users } from "../../drizzle/schema";

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

export function sanitizeInput(input: string, maxLength: number = 255): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .trim()
    .substring(0, maxLength);
}
