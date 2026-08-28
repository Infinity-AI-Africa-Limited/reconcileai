/**
 * Standing, revocable sign-in links for external reviewers.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A SHOPLINE App Store reviewer cannot get into the retail portal today, and
 * neither can a real merchant. Four walls, none of them the one people assume:
 *
 *   1. The OAuth callback provisions the tenant and establishes NO session — it
 *      redirects to /shopline/welcome and stops.
 *   2. The admin user it creates is `<handle>@shopline.merchant` when SHOPLINE
 *      returns no contact address. That domain does not exist, so no magic link
 *      can ever be delivered to it.
 *   3. The welcome screen's "enter portal" hand-off is restricted to an
 *      Infinity AI super-admin support session.
 *   4. Magic links are single-use and expire in 72 hours — against a review that
 *      runs for weeks, across several people and devices.
 *
 * ShoplineConnect.tsx names the underlying gap itself: "Production merchant
 * identity hand-off remains a separate P0 release gate." This module is the
 * narrow, revocable form of that hand-off — enough to let a reviewer in, small
 * enough to reason about.
 *
 * ── What contains it ─────────────────────────────────────────────────────────
 * The link mints a REAL session in the production application, so containment
 * is structural rather than cosmetic:
 *
 *   · `isReadOnly` on the user, refused globally in _core/trpc.ts — queries
 *     pass, every other operation type is refused, for every procedure that
 *     exists or is ever added.
 *   · Role `operations`, not `admin`: read-only stops writes, but it does not
 *     stop READS, and an admin session can query team membership and
 *     integration settings. Operations sees the whole retail journey —
 *     Settlement Monitor, Sync Status, Orders & Payments, Exceptions,
 *     Dashboard — and no administrative surface.
 *   · Pinned to one organizationId, with no portal switcher (that is
 *     super_admin only).
 *   · A hard expiry, plus revocation that takes effect on the next request.
 *   · `lastUsedAt`/`useCount`, because "did the reviewer ever open it?" is
 *     otherwise unanswerable while a submission is pending.
 */
import crypto from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { organizations, reviewerAccessLinks, users } from "../drizzle/schema";

/** The retail tenant a SHOPLINE reviewer is shown: the canonical dev store. */
export const SHOPLINE_REVIEW_ORG_CODE = "SL_RECONCILEAI_DEV";

/** Long enough to outlast an App Store review without becoming permanent. */
export const DEFAULT_REVIEWER_LINK_TTL_DAYS = 90;
export const MAX_REVIEWER_LINK_TTL_DAYS = 180;

/**
 * Read-only reviewers get `operations`, never `admin`.
 *
 * The global write ban makes any role safe to WRITE with; it does nothing about
 * what a role may READ. Admin-scoped queries reach team membership and
 * integration configuration, which is not a reviewer's business and not part of
 * the journey under review.
 */
export const REVIEWER_ROLE = "operations" as const;

export interface ReviewerLinkView {
  id: number;
  label: string;
  organizationId: number;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  useCount: number;
  createdAt: Date;
  /** Present only in the issue response — never re-shown on a list. */
  url?: string;
}

function newToken(): string {
  return crypto.randomBytes(24).toString("base64url"); // ~32 chars
}

/** The URL a reviewer is given. Path is served by the Express route below. */
export function reviewerLinkUrl(token: string, appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/reviewer-access?key=${encodeURIComponent(token)}`;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/**
 * The one read-only user a tenant's reviewer links sign in as.
 *
 * Stable per organisation (`reviewer_org_<id>`), so revoking a link never
 * orphans a user and issuing a second link never creates a second identity —
 * the audit trail stays about one reviewer rather than a growing pile of them.
 *
 * Re-asserts `isReadOnly` and the role on every call. A user row can be edited
 * from the admin screens, and this identity must not be able to drift into a
 * writable one by an unrelated edit.
 */
export async function ensureReviewerUser(organizationId: number): Promise<number> {
  const db = await requireDb();
  const openId = `reviewer_org_${organizationId}`;

  const [existing] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  if (existing) {
    await db
      .update(users)
      .set({ isReadOnly: true, isActive: true, role: REVIEWER_ROLE, organizationId })
      .where(eq(users.id, existing.id));
    return existing.id;
  }

  await db.insert(users).values({
    openId,
    name: "App Store Reviewer",
    // Not a deliverable address, and deliberately so: this identity must never
    // be reachable by a password reset or magic link. The link is the only way in.
    email: `reviewer+org${organizationId}@reviewer.invalid`,
    role: REVIEWER_ROLE,
    organizationId,
    isReadOnly: true,
    isGuest: false,
    isActive: true,
    loginMethod: "reviewer_link",
  });

  const [created] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not create the reviewer identity" });
  return created.id;
}

/** Resolve an organisation by code, for the SHOPLINE dev-store default. */
export async function organizationIdByCode(code: string): Promise<number | null> {
  const db = await requireDb();
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.code, code)).limit(1);
  return org?.id ?? null;
}

export async function issueReviewerLink(params: {
  label: string;
  organizationId: number;
  ttlDays?: number;
  createdBy?: number | null;
  appUrl: string;
}): Promise<ReviewerLinkView> {
  const db = await requireDb();
  const ttlDays = Math.min(Math.max(params.ttlDays ?? DEFAULT_REVIEWER_LINK_TTL_DAYS, 1), MAX_REVIEWER_LINK_TTL_DAYS);

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, params.organizationId))
    .limit(1);
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "That organisation does not exist." });

  const userId = await ensureReviewerUser(params.organizationId);
  const token = newToken();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  await db.insert(reviewerAccessLinks).values({
    token,
    label: params.label.slice(0, 120),
    organizationId: params.organizationId,
    userId,
    expiresAt,
    createdBy: params.createdBy ?? null,
  });

  const [row] = await db.select().from(reviewerAccessLinks).where(eq(reviewerAccessLinks.token, token)).limit(1);
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not issue the link" });

  return { ...toView(row), url: reviewerLinkUrl(token, params.appUrl) };
}

function toView(row: typeof reviewerAccessLinks.$inferSelect): ReviewerLinkView {
  return {
    id: row.id,
    label: row.label,
    organizationId: row.organizationId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    useCount: row.useCount,
    createdAt: row.createdAt,
  };
}

/**
 * Why a link was refused.
 *
 * Named states rather than a boolean, because the operator asking "why can't
 * the reviewer get in?" needs the reason, and the three causes call for three
 * different actions: reissue, un-revoke by reissuing, or check the URL.
 */
export type ReviewerLinkRejection = "unknown_token" | "revoked" | "expired" | "user_unavailable";

export type ReviewerLinkResolution =
  | { ok: true; userId: number; openId: string; name: string; organizationId: number; linkId: number }
  | { ok: false; reason: ReviewerLinkRejection };

/**
 * Validate a presented link and, if good, record the visit.
 *
 * Every rejection returns the same shape and the caller renders one message, so
 * the endpoint cannot be used to distinguish "no such token" from "revoked" —
 * that difference is for the operator's list, not for whoever holds the URL.
 */
export async function resolveReviewerLink(token: string | null | undefined): Promise<ReviewerLinkResolution> {
  if (!token) return { ok: false, reason: "unknown_token" };
  const db = await requireDb();

  const [link] = await db.select().from(reviewerAccessLinks).where(eq(reviewerAccessLinks.token, token)).limit(1);
  if (!link) return { ok: false, reason: "unknown_token" };
  if (link.revokedAt) return { ok: false, reason: "revoked" };
  if (link.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  const [user] = await db.select().from(users).where(eq(users.id, link.userId)).limit(1);
  // isReadOnly is re-checked here, not assumed from issue time. If this identity
  // has somehow been made writable since, the link stops working rather than
  // handing out a write-capable session.
  if (!user || !user.isActive || !user.isReadOnly) return { ok: false, reason: "user_unavailable" };

  await db
    .update(reviewerAccessLinks)
    .set({ lastUsedAt: new Date(), useCount: link.useCount + 1 })
    .where(eq(reviewerAccessLinks.id, link.id));

  return {
    ok: true,
    userId: user.id,
    openId: user.openId,
    name: user.name || "App Store Reviewer",
    organizationId: link.organizationId,
    linkId: link.id,
  };
}

export async function listReviewerLinks(): Promise<ReviewerLinkView[]> {
  const db = await requireDb();
  const rows = await db.select().from(reviewerAccessLinks).orderBy(desc(reviewerAccessLinks.createdAt)).limit(50);
  return rows.map(toView);
}

/** Revocation is a timestamp, not a delete — the audit trail outlives the link. */
export async function revokeReviewerLink(id: number): Promise<void> {
  const db = await requireDb();
  await db
    .update(reviewerAccessLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(reviewerAccessLinks.id, id), isNull(reviewerAccessLinks.revokedAt)));
}
