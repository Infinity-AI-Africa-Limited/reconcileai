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
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { organizations, reviewerAccessLinks, users } from "../drizzle/schema";

/** The retail tenant a SHOPLINE reviewer is shown: the canonical dev store. */
export const SHOPLINE_REVIEW_ORG_CODE = "SL_RECONCILEAI_DEV";

/**
 * How much of the platform a link opens.
 *
 *   tenant   — one organisation, role `operations`. A SHOPLINE App Store
 *              reviewer assessing the merchant portal.
 *   platform — cross-tenant, role `super_admin`. An investor or accelerator
 *              reviewer (YC) who needs the operator view and all three verticals,
 *              and has no email address we could provision an account against.
 */
export type ReviewerScope = "tenant" | "platform";

/**
 * Roles by scope. Read-only is enforced separately and globally, so these decide
 * only what the session may SEE.
 */
export const REVIEWER_ROLES: Record<ReviewerScope, "operations" | "super_admin"> = {
  tenant: "operations",
  platform: "super_admin",
};

/** Long enough to outlast an App Store review without becoming permanent. */
export const DEFAULT_REVIEWER_LINK_TTL_DAYS = 90;
export const MAX_REVIEWER_LINK_TTL_DAYS = 180;

/**
 * Tenant-scope reviewers get `operations`, never `admin`.
 *
 * The global write ban makes any role safe to WRITE with; it does nothing about
 * what a role may READ. Admin-scoped queries reach team membership and
 * integration configuration, which is not a merchant reviewer's business and not
 * part of the journey under review.
 */
export const REVIEWER_ROLE = REVIEWER_ROLES.tenant;

/**
 * A platform-scope link is refused while ANY real tenant exists.
 *
 * `super_admin` is cross-tenant by definition, so this link's exposure is not
 * fixed at issue time — it is whatever the platform holds when the reviewer
 * happens to open it. Every organisation is a demo today (verified against
 * production), which is the only reason a platform link is acceptable at all.
 * Onboard one real bank and an outstanding link silently becomes a disclosure of
 * that bank's data to whoever still has the URL.
 *
 * So the condition is checked at every sign-in rather than assumed from the day
 * the link was issued, and it fails closed. This is CLAUDE.md §19's
 * first-customer gate made structural instead of a note somebody has to
 * remember: the link stops working by itself.
 *
 * `isDemo` is the signal because it is the one an operator already sets
 * deliberately, from the super-admin screens. The operator's own `super_admin`
 * org is excluded — it holds no tenant data and is never `isDemo`.
 */
export async function platformScopeIsSafe(): Promise<boolean> {
  return (await blockingRealTenants(1)).length === 0;
}

/**
 * WHICH organisations are holding the gate shut.
 *
 * Shipped after the gate refused in production and the operator had a greyed-out
 * option, a sentence saying a non-demo organisation existed, and no way to find
 * out which one — so the only route forward was to ask an engineer. A control
 * that cannot be acted on is only half a control; naming the row turns a
 * dead end into one click on the organisation list.
 *
 * The cause was benign and will recur: a SHOPLINE App Store reviewer installing
 * the app auto-provisions a tenant, and onboarding does not mark it a demo. Over
 * a review that runs weeks, that will happen again.
 */
const UNREADABLE = { id: -1, code: null, name: "unknown — the database could not be read" };

export async function blockingRealTenants(limit = 10): Promise<Array<{ id: number; code: string | null; name: string }>> {
  const db = await getDb();
  // Fail closed: unknown is not safe, and an empty list would read as "all clear".
  if (!db) return [UNREADABLE];
  try {
    // One more than asked for, so the caller can tell a full page from a
    // truncated one. Reporting a partial list as complete would understate what
    // is blocking, and the operator would mark one tenant a demo and wonder why
    // nothing changed.
    return await db
      .select({ id: organizations.id, code: organizations.code, name: organizations.name })
      .from(organizations)
      .where(and(
        eq(organizations.isDemo, false),
        ne(organizations.segment, "super_admin"),
      ))
      .limit(limit);
  } catch (err) {
    // A connection that opened and then failed mid-query is exactly as unknown
    // as one that never opened. Throwing here would surface as an errored query
    // whose absent data reads as "no blockers" downstream — an outage opening
    // the gate.
    console.error("[reviewerAccess] could not read blocking tenants:", err);
    return [UNREADABLE];
  }
}

/*
 * Deliberately NOT filtered on `isActive`.
 *
 * Deactivating an organisation stops its members signing in; it does not delete
 * its rows, and the super-admin surfaces a platform reviewer actually uses —
 * `allOrganizations`, `getOrgContext`, `dashboard.stats` — do not filter on it
 * either. An inactive real tenant is therefore still fully readable, so counting
 * it as absent would report the platform safe while its customer data sat one
 * click away. "Not signed in" is not "not present".
 */

/** The operator's own organisation — the home org for a platform-scope session. */
export async function platformHomeOrganizationId(): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.segment, "super_admin"))
    .orderBy(organizations.id)
    .limit(1);
  return org?.id ?? null;
}

export interface ReviewerLinkView {
  id: number;
  label: string;
  scope: ReviewerScope;
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

export async function ensureReviewerUser(
  organizationId: number,
  token: string,
  scope: ReviewerScope = "tenant",
): Promise<number> {
  const db = await requireDb();
  const openId = reviewerOpenId(token);
  const role = REVIEWER_ROLES[scope];

  const [existing] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  if (existing) {
    await db
      .update(users)
      .set({ isReadOnly: true, isActive: true, role, organizationId })
      .where(eq(users.id, existing.id));
    return existing.id;
  }

  await db.insert(users).values({
    openId,
    name: scope === "platform" ? "Platform Reviewer" : "App Store Reviewer",
    // Not a deliverable address, and deliberately so: this identity must never
    // be reachable by a password reset or magic link. The link is the only way in.
    email: `${openId}@reviewer.invalid`,
    role,
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
    .select({ id: reviewerAccessLinks.id, scope: reviewerAccessLinks.scope })
    .from(reviewerAccessLinks)
    .where(and(
      eq(reviewerAccessLinks.userId, userId),
      isNull(reviewerAccessLinks.revokedAt),
      gt(reviewerAccessLinks.expiresAt, new Date()),
    ))
    .limit(1);
  if (!link) return false;

  /*
   * The first-customer condition is part of LIVENESS, not just of sign-in.
   *
   * Checking it only when the link is exchanged leaves a reviewer who signed in
   * the day before onboarding reading the new tenant's data for the rest of the
   * session TTL — the same shape as the revocation bug this function was written
   * to fix, one condition further along. Onboarding a customer is exactly the
   * moment nobody is thinking about a link issued months earlier.
   *
   * Folded in here rather than added beside it in authenticateRequest so there
   * is ONE predicate for "may this session continue". Two would eventually
   * disagree, and the one that got missed would be the one that mattered.
   */
  if (link.scope === "platform" && !(await platformScopeIsSafe())) return false;

  return true;
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
  scope?: ReviewerScope;
  ttlDays?: number;
  createdBy?: number | null;
  appUrl: string;
}): Promise<ReviewerLinkView> {
  const db = await requireDb();
  const scope: ReviewerScope = params.scope ?? "tenant";
  const ttlDays = Math.min(Math.max(params.ttlDays ?? DEFAULT_REVIEWER_LINK_TTL_DAYS, 1), MAX_REVIEWER_LINK_TTL_DAYS);

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, params.organizationId))
    .limit(1);
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "That organisation does not exist." });

  // Refused at issue AND re-checked at sign-in. Issue-time alone would be
  // meaningless: the link outlives the moment it was created, and the condition
  // it depends on is exactly the one that changes when the business succeeds.
  if (scope === "platform" && !(await platformScopeIsSafe())) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "A platform-wide reviewer link cannot be issued while a non-demo organisation exists — it would expose that tenant's data. Mark it as a demo, or issue a tenant-scoped link instead.",
    });
  }

  // Token first: the identity is derived from it, so that it is one-per-link and
  // revocation can therefore reach an already-minted session.
  const token = newToken();
  const userId = await ensureReviewerUser(params.organizationId, token, scope);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  await db.insert(reviewerAccessLinks).values({
    token,
    label: params.label.slice(0, 120),
    scope,
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
    scope: (row.scope === "platform" ? "platform" : "tenant") as ReviewerScope,
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
export type ReviewerLinkRejection =
  | "unknown_token"
  | "revoked"
  | "expired"
  | "user_unavailable"
  /** A platform link met a real tenant. Withdrawn rather than exposing it. */
  | "platform_scope_withdrawn";

export type ReviewerLinkResolution =
  | { ok: true; userId: number; openId: string; name: string; organizationId: number; linkId: number; scope: ReviewerScope }
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

  const scope: ReviewerScope = link.scope === "platform" ? "platform" : "tenant";

  // Re-checked HERE, not trusted from issue time. A platform link is
  // cross-tenant, so what it exposes is decided by what the platform holds the
  // moment it is opened — not by what it held when it was created. The first
  // real customer is precisely the event that changes the answer, and it is not
  // an event anyone will remember to connect to an old link.
  if (scope === "platform" && !(await platformScopeIsSafe())) {
    return { ok: false, reason: "platform_scope_withdrawn" };
  }

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
    scope,
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
