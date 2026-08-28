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
import { and, desc, eq, gt, isNull } from "drizzle-orm";
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
 * Marks an identity as existing only to back a reviewer link.
 *
 * The liveness check below keys off this rather than off `isReadOnly`, because
 * the two are not the same thing: an operator may legitimately mark an ordinary
 * user read-only, and such a user has no link behind them. Keying liveness on
 * `isReadOnly` would lock those people out of reads entirely.
 */
export const REVIEWER_LOGIN_METHOD = "reviewer_link";

/**
 * The identity a link signs in as — ONE PER LINK, not one per organisation.
 *
 * Per-link is what makes revocation mean something. The session cookie is a
 * stateless JWT carrying only an openId, so the only way a later request can
 * discover that its link was revoked is for that openId to identify the link.
 * A shared per-tenant identity cannot: revoking one of two links would either
 * cut off both reviewers or neither, and there would be no way to tell which
 * link a live session came from.
 *
 * The openId is derived from the token by hash, so it can be computed before
 * the link row exists (the row needs the userId) — and the token itself never
 * lands in the users table, where it would be a standing credential sitting in
 * a second place.
 *
 * Re-asserts `isReadOnly` and the role on every call: a user row is editable
 * from the admin screens, and this identity must not be able to drift into a
 * writable one through an unrelated edit.
 */
function reviewerOpenId(token: string): string {
  // 4 + 40 = 44 chars, inside the 64-char column.
  return `rvw_${crypto.createHash("sha256").update(token).digest("hex").slice(0, 40)}`;
}

export async function ensureReviewerUser(organizationId: number, token: string): Promise<number> {
  const db = await requireDb();
  const openId = reviewerOpenId(token);

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
    email: `${openId}@reviewer.invalid`,
    role: REVIEWER_ROLE,
    organizationId,
    isReadOnly: true,
    isGuest: false,
    isActive: true,
    loginMethod: REVIEWER_LOGIN_METHOD,
  });

  const [created] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not create the reviewer identity" });
  return created.id;
}

/**
 * Is the link behind an already-signed-in reviewer still good?
 *
 * Checked on EVERY request from a reviewer identity, reads included, because
 * the session is a stateless JWT: without this, revoking a link stops new
 * sign-ins and does nothing to the sessions already minted from it, which would
 * keep working for the full session TTL. "Revoke" that leaves the reviewer
 * inside for hours is not revocation, and an operator hitting that button
 * during an incident would believe otherwise.
 *
 * One indexed lookup per reviewer request. Reviewers are few; correctness here
 * is worth more than the round-trip.
 */
export async function isReviewerSessionLive(userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false; // fail closed
  const [link] = await db
    .select({ id: reviewerAccessLinks.id })
    .from(reviewerAccessLinks)
    .where(and(
      eq(reviewerAccessLinks.userId, userId),
      isNull(reviewerAccessLinks.revokedAt),
      gt(reviewerAccessLinks.expiresAt, new Date()),
    ))
    .limit(1);
  return Boolean(link);
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

  // Token first: the identity is derived from it, so that it is one-per-link and
  // revocation can therefore reach an already-minted session.
  const token = newToken();
  const userId = await ensureReviewerUser(params.organizationId, token);
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
