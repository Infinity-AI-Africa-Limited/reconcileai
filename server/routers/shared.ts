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
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { moduleAppliesTo, moduleUnavailableReason } from "@shared/moduleScope";
import { featureAppliesTo, featureUnavailableReason, type VerticalFeature } from "@shared/verticalFeatures";
import { isTenantId } from "@shared/tenantId";
import { currentAuditOrganizationId, currentPortalOrganizationId, runInRequestScope } from "../_core/requestScope";
import { protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb, createAuditLog, getChannelByIdForOrg, getReconciliationJob, type DbTransaction } from "../db";
import { organizations, users } from "../../drizzle/schema";

// ─── Constants ───────────────────────────────────────────────────────

/** Max length for user-supplied names (jobs, reports, channels). */
export const MAX_NAME_LENGTH = 255;

// ─── Portal scoping ──────────────────────────────────────────────────

/**
 * The organisation a READ should answer for, honouring the super-admin portal
 * switcher.
 *
 * `PortalContext` ("Enter Portal") is client state — sessionStorage and nothing
 * more. It changes the sidebar and the branding, and the server never hears
 * about it unless a procedure accepts `viewAsOrgId` and passes it here. Two
 * procedures did (`dashboard.stats`, `admin.users`); the rest did not, so a
 * super admin inside Globus Bank's portal still read Infinity AI's own
 * organisation — which holds no transactions, jobs, reports or exceptions at
 * all. Every one of Reconciliation, Reports, Exception Intelligence, Payment
 * Exceptions, Review Queue and Transactions rendered empty, for a tenant
 * holding tens of thousands of rows.
 *
 * `dashboard.stats` already carried a comment describing exactly this failure
 * being fixed there. It was fixed in one place and left everywhere else, which
 * is why this now lives in ONE function instead of being restated per call
 * site: the role check is the whole security boundary, and a boundary copied
 * seven times is a boundary that will be wrong in one of them.
 *
 * ── The security property ─────────────────────────────────────────────
 *
 * The override applies ONLY to `super_admin`. For anyone else the parameter is
 * ignored outright — not rejected, ignored — so a tenant user who discovers the
 * field and sends another organisation's id reads their own data exactly as
 * before. Ignoring rather than throwing is deliberate: a 403 would confirm the
 * id exists, and there is nothing to tell them.
 *
 * ── Writes ─────────────────────────────────────────────────────────────
 *
 * This first said "reads only, never a write". That stopped being the rule when
 * review showed what reads-only produced: the Exception Intelligence switches
 * and the Age Tracker's Escalate button, inside a tenant's portal, reported
 * success while changing Infinity AI's own organisation. A control that says
 * "saved" about a different tenant is worse than one that refuses.
 *
 * So a WRITE may take its tenant from here only when all three hold:
 *
 *   1. it is an action on the tenant ON SCREEN — the thing the portal exists
 *      for (settings, escalations, registry entries), not a platform action;
 *   2. the override is staff-only, which this function already enforces — for
 *      anyone else the field is ignored and they write to their own org;
 *   3. its audit record names that tenant (logAudit's `organizationId`), so the
 *      change appears in the trail of the organisation it changed.
 *
 * Where the write targets a ROW the client named by id, prefer deriving the
 * tenant from the row (canActOnTenant) — the row cannot be wrong about itself.
 */
export function portalScopedOrgId(
  user: { role: string; organizationId: number | null },
  viewAsOrgId?: number | null,
): number | null {
  if (viewAsOrgId && user.role === "super_admin") return viewAsOrgId;
  return user.organizationId ?? null;
}

/** The optional `viewAsOrgId` field, so every procedure declares it the same way. */
export const viewAsOrgInput = { viewAsOrgId: z.number().int().positive().optional() };

/**
 * The organisation that owns a new reconciliation run or schedule: the caller's.
 *
 * Every creator of runs and schedules used to omit it, and runReconciliation
 * refuses a job with no owner — so every run started from the UI or a schedule
 * failed. A caller with NO organisation is refused here rather than pooled into
 * a pseudo-tenant (CLAUDE.md §9C). A super admin owns runs under their own
 * organisation; creating one inside a tenant's portal is the known
 * portal-write gap.
 */
export function runOwner(user: { organizationId?: number | null }): number {
  // Not `== null`: organisation 0 is the legacy non-tenant (CLAUDE.md §19.2
  // traces unreachable rows to it), and a record filed there belongs to nobody.
  // Only a positive id names a tenant.
  if (!isTenantId(user.organizationId)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Your account is not linked to an organisation, so a reconciliation run would have no owner.",
    });
  }
  return user.organizationId;
}

/**
 * Refuse a job id the caller may not see, before anything about the job is read.
 *
 * Jobs are fetched by id alone (`getReconciliationJob`), so every procedure
 * that takes a job id from the caller must check the job's tenant itself.
 * `export.csv` / `export.xlsx` did not: any signed-in user could export any
 * tenant's full reconciliation — matches, exceptions and every transaction —
 * by walking sequential ids. NOT_FOUND either way, so another tenant's id is
 * indistinguishable from one that does not exist.
 */
export async function assertJobVisible(
  user: { role: string; organizationId: number | null },
  jobId: number,
): Promise<NonNullable<Awaited<ReturnType<typeof getReconciliationJob>>>> {
  const job = await getReconciliationJob(jobId);
  if (!job || !canActOnTenant(user, job.organizationId ?? null)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
  }
  return job;
}

/**
 * Resolve the channels a caller named for a run or schedule, each UNDER the
 * owning tenant (its own channel or a shared rail), in order; the first that is
 * not visible throws NOT_FOUND with its own message.
 *
 * The call sites looked channels up by id alone, so any tenant's channel could
 * be named — and the missing owner was all that stopped such a run. Owner and
 * channel scope are one rule, so every creator goes through `runOwner` and this.
 * NOT_FOUND rather than FORBIDDEN: another tenant's channel is indistinguishable
 * from one that does not exist.
 */
export async function requireOwnedChannels(
  tenant: number,
  named: readonly { id: number; notFound: string }[],
): Promise<NonNullable<Awaited<ReturnType<typeof getChannelByIdForOrg>>>[]> {
  const found: NonNullable<Awaited<ReturnType<typeof getChannelByIdForOrg>>>[] = [];
  for (const { id, notFound } of named) {
    const channel = await getChannelByIdForOrg(id, tenant);
    if (!channel) throw new TRPCError({ code: "NOT_FOUND", message: notFound });
    found.push(channel);
  }
  return found;
}

/**
 * Whose transactions a tenant list shows: the whole organisation's, except to a
 * guest, who sees only their own. Returns the user id to narrow by, or undefined
 * for "no narrowing — the organisation is the boundary".
 *
 * `transactions.list` used to narrow EVERY role except `admin` to rows the
 * caller had personally uploaded — the one tenant read that did, since
 * exceptions, jobs and reports have always been organisation-wide. So an
 * operations user saw exceptions on transactions their own list would not show;
 * rows a connector ingests (a SHOPLINE order carries user 0) were invisible to
 * everyone but an admin, the App Store reviewer included; and a super admin in
 * the Globus Bank portal saw 0 of its 1,191 transactions for the day, because a
 * seed account had loaded them. The tenancy predicate is unchanged and still
 * unconditional in `getTransactions`; only the per-uploader filter goes.
 *
 * Guests keep it. Demo guests share one tenant, and one guest's uploads are not
 * another's to read.
 */
export function transactionOwnerFilter(user: { id: number; isGuest?: boolean | null }): number | undefined {
  return user.isGuest ? user.id : undefined;
}

/**
 * May this caller act on a row that belongs to `tenantId`?
 *
 * For procedures that take a ROW id from the client — a job id, a report id —
 * the row already names its tenant, and that is the tenant the work belongs to.
 * The caller's own organisation only decides whether they may touch it. Using
 * the caller's organisation for the work itself is the bug this replaces:
 * `reports.generate` and `reconciliation.get` both loaded a job by id alone and
 * then read its exceptions under the CALLER's organisation, so inside a tenant
 * portal they paired that tenant's job and matches with Infinity AI's exceptions
 * (none), and for an ordinary user they returned another tenant's job to anyone
 * who guessed its id.
 *
 * Mirrors the rule `allocations.ts` already applies, plus the staff pass the
 * portal needs:
 *
 *   - staff outside a portal may act on any tenant;
 *   - staff INSIDE a tenant's portal may act on that tenant only. The role is
 *     unchanged in a portal, so a role check alone let a super admin viewing
 *     tenant A open tenant B's job, export or schedule by id — a stale link
 *     showing B's figures under A's banner, and any change filed in A's trail.
 *     The portal is read from the request scope (server/_core/requestScope.ts)
 *     rather than passed in, so no caller can forget it;
 *   - a caller with NO organisation may act on none. No organisation is not
 *     "unknown tenant, match anything": a null-to-null match would pool every
 *     org-less account into one shared pseudo-tenant;
 *   - everyone else, only their own.
 *
 * Callers answer a refusal with NOT_FOUND, never FORBIDDEN, so another tenant's
 * id is indistinguishable from one that does not exist.
 */
export function canActOnTenant(
  user: { role: string; organizationId: number | null },
  tenantId: number | null,
): boolean {
  if (user.role === "super_admin") {
    const portal = currentPortalOrganizationId();
    return portal === null || tenantId === portal;
  }
  if (user.organizationId == null) return false;
  return tenantId === user.organizationId;
}

/**
 * Which channels `channels.list` should return.
 *
 * `"all"` only for staff outside a portal — the platform overview genuinely
 * spans tenants. Inside a portal, staff see the tenant they are viewing: the
 * cross-tenant list was reaching the Reconciliation job form, so a super admin
 * in Globus Bank's portal could build a run whose source and target channels
 * belonged to two different tenants. Everyone else gets their own organisation,
 * and a `viewAsOrgId` from them is ignored exactly as in `portalScopedOrgId`.
 */
export function channelListScope(
  user: { role: string; organizationId: number | null },
  viewAsOrgId?: number | null,
  /** The portal tenant from the request context (ctx.viewingAs). */
  viewingAs?: number | null,
): "all" | number | null {
  // Keyed on role, so the organisation override in the request context does not
  // reach this branch on its own: a super admin in a portal would still get the
  // whole estate. The portal tenant must be passed in.
  if (user.role === "super_admin") {
    const portal = viewAsOrgId || viewingAs;
    return portal ? portal : "all";
  }
  return user.organizationId ?? null;
}

// ─── Super Admin Procedure ───────────────────────────────────────────
// Only Infinity AI staff (super_admin role) can access these procedures.
// Cross-tenant visibility: can see ALL organisations, instances, and users.
//
// A platform procedure acts for the PLATFORM, not for the tenant on screen, so
// it runs outside the portal's request scope. Without this, the portal header
// the browser sends on every call — including from the Super Admin dashboard
// while a portal is still open — filed "created organisation B" or "promoted X
// to super admin" in tenant A's audit trail, which A's own users can read and
// export. Failing this way round is the safe direction: a platform procedure
// that DOES act on the tenant on screen (demo.activate) and forgets to name it
// files its record in the global chain, as before — never in the wrong tenant.
// `ctx.user` is untouched; only the audit default and by-id reach change.

export const superAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "super_admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Super Admin access required. This action is restricted to Infinity AI staff." });
  }
  return runInRequestScope({ portalOrganizationId: null, auditOrganizationId: null }, () => next({ ctx }));
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
// on anyone — outside a portal. Org admins may only act on non-super-admin users
// within their OWN organisation — they can neither see nor touch Infinity AI
// staff or other orgs.
//
// Inside a tenant's portal a super admin is held to that same rule for the
// tenant on screen, as canActOnTenant is: the Team page there lists only that
// tenant's users, and a user id from anywhere else is a stale link or a crafted
// call, whose audit record would otherwise land in the wrong tenant's trail.
//
// A caller with no organisation manages no one. The comparison used to be a
// bare `!==`, so an org-less admin passed for every org-less user — the
// null-to-null pooling canActOnTenant already refuses.
//
// Returns each target's own tenant (null for none), which is where the audit
// record of acting on that user belongs. It is what the audit default already
// gives a tenant admin, or staff inside a portal — the guard holds their
// targets to that tenant — but NOT staff outside a portal: the Super Admin
// dashboard manages every tenant's users, and without this a bank's trail
// never showed Infinity AI staff deactivating one of its users.
export async function assertCanManageUsers(
  ctx: { user: { role: string; organizationId: number | null } },
  userIds: number[]
): Promise<ReadonlyMap<number, number | null>> {
  const tenantOf = new Map<number, number | null>();
  if (userIds.length === 0) return tenantOf;
  const portal = ctx.user.role === "super_admin" ? currentPortalOrganizationId() : null;
  const unrestricted = ctx.user.role === "super_admin" && portal === null;
  const own = portal ?? ctx.user.organizationId;
  const drizzle = await getDb();
  if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  const targets = await drizzle
    .select({ id: users.id, role: users.role, organizationId: users.organizationId })
    .from(users)
    .where(inArray(users.id, userIds));
  for (const t of targets) {
    if (!unrestricted && (own == null || t.role === "super_admin" || t.organizationId !== own)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You can only manage users within your own organisation.",
      });
    }
    tenantOf.set(t.id, isTenantId(t.organizationId) ? t.organizationId : null);
  }
  return tenantOf;
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
  userAgent?: string,
  /**
   * The tenant the event belongs to. A tenant's Audit Trail selects
   * `organizationId = tenant` exactly, so an event in the GLOBAL chain (null)
   * appears in NO tenant's trail, export or chain verification.
   *
   * Omitted → the tenant the request acts for (server/_core/requestScope.ts):
   * a tenant user's own organisation, or the tenant on screen for staff in a
   * portal; the global chain for staff outside a portal, platform procedures,
   * and work outside a tRPC call. Pass it explicitly when that is wrong:
   * `null` for an event about the ACCOUNT or the platform rather than a tenant
   * (sign-out, personal preferences, super-admin grants, moving a user between
   * organisations), or the row's own tenant when staff act on a tenant's row
   * from outside a portal, or when the work runs outside a request.
   */
  organizationId?: number | null,
) {
  try {
    await createAuditLog({
      userId,
      // Only an OMITTED argument is filled in, so no caller that chose the
      // global chain, or named a tenant, is moved.
      //
      // The default used to be the PORTAL tenant alone, so every ordinary
      // user's action — a bank's own staff resolving exceptions, approving
      // matches, uploading files — joined the global chain, and the bank's
      // trail never showed its own staff's work.
      organizationId: organizationId === undefined ? currentAuditOrganizationId() : organizationId,
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

/**
 * The audit chain a row's own tenant maps to: that tenant, or null (the global
 * chain) when the row names none — organisation 0 included, which is no tenant
 * (shared/tenantId.ts). For call sites that name the tenant from a ROW rather
 * than take logAudit's default: staff reaching a tenant's job from outside a
 * portal, or work that runs outside a request.
 */
export function auditTenant(organizationId: number | null | undefined): number | null {
  return isTenantId(organizationId) ? organizationId : null;
}

/**
 * Use for control-plane writes where reporting success without its audit record
 * would violate the feature's evidence promise. Unlike logAudit, failures are
 * deliberately propagated to the calling procedure.
 *
 * ── organizationId is REQUIRED, and named ─────────────────────────────────
 *
 * Takes an object rather than positional arguments so the tenant scope cannot
 * be forgotten. It was omittable, and it was duly omitted: `createAuditLog`
 * scopes the tamper-evident hash chain on `organizationId ?? null`, so an event
 * without one joins the GLOBAL chain. The tenant it actually concerns then has
 * no record of it in their audit listing, their export, or their chain
 * verification — the write looks audited and is not, which is worse than an
 * obvious gap on a surface a bank examiner reads.
 *
 * Passing `null` is a legitimate answer for a genuine platform-level event, but
 * it now has to be an answer rather than an omission — the same reason writes
 * use featureStrictlyAppliesTo (§9C): "no organisation" and "I forgot" must not
 * look identical at the call site.
 */
export async function logAuditStrict(entry: {
  userId: number | null;
  /** The tenant this event belongs to. `null` ONLY for true platform events. */
  organizationId: number | null;
  action: string;
  entityType: string;
  entityId?: number;
  details?: unknown;
  ipAddress?: string;
  userAgent?: string;
  /**
   * The caller's transaction, so the change and its audit record commit or roll
   * back together. Propagating the failure is not enough on its own: without
   * this the row is already committed when the audit insert fails, so the caller
   * reports failure over a change that did happen and left no trace.
   *
   * A transaction only: the audit chain's lock is held until commit, and a
   * pooled handle would release it statement by statement (createAuditLog).
   */
  executor?: DbTransaction;
}) {
  await createAuditLog(
    {
      userId: entry.userId,
      organizationId: entry.organizationId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      details: entry.details ? JSON.stringify(entry.details) : null,
      ipAddress: entry.ipAddress || null,
      userAgent: entry.userAgent ? entry.userAgent.substring(0, 500) : null,
    },
    entry.executor,
  );
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
