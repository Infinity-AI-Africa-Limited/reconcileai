import { eq, and, gte, lte, like, or, desc, asc, sql, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import * as schema from "../drizzle/schema";
import {
  InsertUser, users,
  channels, InsertChannel,
  uploadBatches, InsertUploadBatch,
  transactions, InsertTransaction,
  reconciliationJobs, InsertReconciliationJob,
  matches, InsertMatch,
  exceptions, InsertException,
  auditLogs, InsertAuditLog,
  reconciliationReports, InsertReconciliationReport,
  organizations, InsertOrganization,
  webhooks, InsertWebhook,
  apiKeys, InsertApiKey,
  scheduledTasks, InsertScheduledTask,
  scheduleRunHistory, InsertScheduleRunHistory,
  emailPreferences, InsertEmailPreference,
  jobProgressEvents, InsertJobProgressEvent,
  sftpCredentials, InsertSftpCredential,
  sftpIngestionLogs, InsertSftpIngestionLog,
  apiIngestionLogs, InsertApiIngestionLog,
  userRolePreferences, InsertUserRolePreference,
  anomalyScores, InsertAnomalyScore,
  detectionRules, InsertDetectionRule,
  resolutionTemplates, InsertResolutionTemplate,
  moduleConfigurations, InsertModuleConfiguration,
  distributors,
  corporateB2BPilotConfigs,
  dashboardStatsCache,
  cfoReportSchedules, InsertCfoReportSchedule, CfoReportSchedule,
  channelAlertSettings, InsertChannelAlertSetting, ChannelAlertSetting,
  platformAuditLogs, InsertPlatformAuditLog, PlatformAuditLog,
  exceptionAgingSettings,
} from "../drizzle/schema";
import { ENV } from './_core/env';
import { computeRecordHash } from "./auditChain";

// ─── Constants ──────────────────────────────────────────────────────

const MAX_QUERY_LIMIT = 500;
const DEFAULT_QUERY_LIMIT = 50;
// Rows per multi-row INSERT/UPDATE. 1000 keeps placeholder counts well under MySQL's
// 65,535 limit (widest table here is ~13 cols → ~13k placeholders) while cutting the
// round-trip count 10x versus the old value of 100 — important for 500k-row jobs.
const BATCH_INSERT_SIZE = 1000;

// ─── Database Connection ────────────────────────────────────────────

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL, { schema, mode: "default" });
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/** Force-drop the cached Drizzle instance so the next getDb() call re-creates it.
 *  Call this whenever a query throws ECONNRESET / ETIMEDOUT so the next tick
 *  gets a fresh connection instead of retrying on a dead socket. */
export function resetDb(): void {
  _db = null;
}

// Export schema tables for use in routers
export { resolutionTemplates, moduleConfigurations };

// ─── Utility: Sanitize LIKE patterns ────────────────────────────────

function sanitizeLikePattern(input: string): string {
  // Escape SQL LIKE wildcards to prevent injection
  return input.replace(/[%_\\]/g, (char) => `\\${char}`);
}

function clampLimit(limit: number | undefined): number {
  const val = limit || DEFAULT_QUERY_LIMIT;
  return Math.min(Math.max(1, val), MAX_QUERY_LIMIT);
}

function clampOffset(offset: number | undefined): number {
  return Math.max(0, offset || 0);
}

// ─── Utility: Sanitize text input ───────────────────────────────────

function sanitizeText(input: string | null | undefined): string | null {
  if (!input) return null;
  // Strip HTML tags and control characters to prevent XSS
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .trim()
    .substring(0, 10000); // Max text length
}

function sanitizeRef(input: string | null | undefined): string | null {
  if (!input) return null;
  // Allow only alphanumeric, hyphens, slashes, dots, underscores for references
  return input.replace(/[^\w\-\/\.\s]/g, "").trim().substring(0, 255);
}

// ─── Organizations ──────────────────────────────────────────────────

export async function createOrganization(data: InsertOrganization) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(organizations).values(data);
  return result[0].insertId;
}

export async function getOrganizations() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(organizations).orderBy(asc(organizations.name));
}

export async function getOrganizationById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return result[0];
}

/** Fail closed when an organisation is absent or unavailable: no model call is safer than ambiguous tenancy. */
export async function isOrganizationAiAssistanceEnabled(id: number): Promise<boolean> {
  const org = await getOrganizationById(id);
  return org?.aiAssistanceEnabled === true;
}

/**
 * The Corporate B2B pilot's recorded external-model boundary (gate B5), or null
 * when the tenant has never recorded one.
 *
 * Read by server/aiGate.ts. Null is NOT permission: a controlled pilot starts
 * with AI off and stays off until the customer records a private approved route
 * and the reference that authorised it.
 */
/**
 * The Corporate B2B pilot's recorded launch country, or null when no pilot
 * register exists yet.
 *
 * Read by the Super Agent so its regulatory framing follows the pilot rather
 * than defaulting to Nigeria. Null means "unknown", and the diagnosis prompt
 * says so generically rather than naming a revenue authority on a guess.
 */
export async function getCorporateB2BPilotCountry(id: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({ country: corporateB2BPilotConfigs.country })
    .from(corporateB2BPilotConfigs)
    .where(eq(corporateB2BPilotConfigs.organizationId, id))
    .limit(1);
  return row?.country ?? null;
}

export async function getCorporateB2BAiBoundary(
  id: number,
): Promise<{ aiAssistanceMode: string; aiBoundaryReference: string | null } | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({
      aiAssistanceMode: corporateB2BPilotConfigs.aiAssistanceMode,
      aiBoundaryReference: corporateB2BPilotConfigs.aiBoundaryReference,
    })
    .from(corporateB2BPilotConfigs)
    .where(eq(corporateB2BPilotConfigs.organizationId, id))
    .limit(1);
  return row ?? null;
}

// ─── Users ───────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) {
      // Only set admin role on INSERT (first creation). On UPDATE (subsequent logins),
      // do NOT overwrite the role — this allows the owner to be promoted to super_admin
      // or any other role without it being reset on every login.
      values.role = 'admin'; // used only if this is a new row (INSERT)
      // Intentionally NOT added to updateSet, so existing role is preserved on conflict
    }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) { console.error("[Database] Failed to upsert user:", error); throw error; }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getAllUsers() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).orderBy(desc(users.createdAt)).limit(MAX_QUERY_LIMIT);
}

// Tenant-scoped user list. Used so org admins (and super-admin portal-view) only
// see users in a single organisation, optionally excluding Infinity AI super admins.
export async function getUsersByOrg(
  orgId: number,
  opts: { excludeSuperAdmins?: boolean } = {}
) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(users.organizationId, orgId)];
  if (opts.excludeSuperAdmins) conditions.push(ne(users.role, "super_admin"));
  return db
    .select()
    .from(users)
    .where(and(...conditions))
    .orderBy(desc(users.createdAt))
    .limit(MAX_QUERY_LIMIT);
}

export async function updateUserRole(userId: number, role: "super_admin" | "admin" | "cfo" | "operations" | "compliance" | "user") {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ role }).where(eq(users.id, userId));
}

// ─── Channels ────────────────────────────────────────────────────────

/**
 * Channel visibility rule for a tenant: its OWN channels, plus the shared
 * platform rails (`organizationId IS NULL` — nibss/pos/atm/bank_statement/…,
 * seeded once for every institution). Never another tenant's.
 *
 * `organizationId` is REQUIRED, and `null` explicitly means platform-wide.
 * It is deliberately not optional: this function previously took no argument
 * and returned every channel on the platform to any authenticated caller, so a
 * default would let the same cross-tenant enumeration reappear the moment
 * someone forgot an argument. Making the unsafe case spell itself `null` keeps
 * it greppable and reviewable.
 */
/**
 * The tenancy predicate for any table carrying a nullable `organizationId`.
 *
 * `null` means the legacy/unattributed rows — NEVER "any organization". Kept as
 * one helper so the two spellings can't drift: writing `eq(col, orgId)` without
 * the null branch silently returns nothing for legacy tenants, and omitting the
 * predicate entirely returns everyone's.
 */
export function orgFilter(
  column: MySqlColumn,
  organizationId: number | null,
) {
  return organizationId === null ? isNull(column) : eq(column, organizationId);
}

export function channelScope(organizationId: number | null) {
  // A caller with no organization gets the shared rails ONLY. `null` must never
  // widen to "everything" — an org-less user would then silently receive every
  // tenant's channels, which is the exact bug this replaces.
  return organizationId === null
    ? isNull(channels.organizationId)
    : or(eq(channels.organizationId, organizationId), isNull(channels.organizationId));
}

export async function getChannels(organizationId: number | null) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(channels).where(channelScope(organizationId)).orderBy(asc(channels.name));
}

/**
 * Every channel on the platform, across all tenants.
 *
 * Deliberately a separate, awkwardly-named function rather than a flag on
 * `getChannels`: cross-tenant reads should be greppable and should require the
 * author to type something that reads like what it does. Only legitimate uses
 * are super-admin platform views and internal jobs that genuinely span tenants.
 */
export async function getAllChannelsAcrossTenants() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(channels).orderBy(asc(channels.name));
}

/**
 * Look a channel up by code, honouring the same tenancy rule. Returns undefined
 * when the code belongs to another tenant — so an attacker-supplied
 * `channelCode` cannot be used to read or write into someone else's channel.
 */
export async function getChannelByCode(code: string, organizationId: number | null) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(channels)
    .where(and(eq(channels.code, code), channelScope(organizationId)))
    .limit(1);
  return result[0];
}

/**
 * Platform-wide existence check for a channel code.
 *
 * `channels.code` carries a GLOBAL unique constraint, so uniqueness on create
 * must be validated across all tenants — an org-scoped check would pass and
 * then hit a duplicate-key error at insert. This is the one place a
 * cross-tenant read is correct, and it deliberately returns only a boolean so
 * it cannot leak another tenant's channel details.
 */
export async function channelCodeExists(code: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [row] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.code, code))
    .limit(1);
  return Boolean(row);
}

export async function getChannelById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
  return result[0];
}

/**
 * Look a channel up by id, honouring the tenancy rule — the by-id counterpart
 * of `getChannelByCode`.
 *
 * Required wherever a channel id arrives from OUTSIDE, most importantly the
 * public upload API: an API key is issued to one organization, so a
 * caller-supplied `channelId` must be proven to belong to that organization (or
 * be a shared rail) before anything is written to it. Returns undefined when it
 * does not, so the caller fails closed.
 */
export async function getChannelByIdForOrg(id: number, organizationId: number | null) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), channelScope(organizationId)))
    .limit(1);
  return result[0];
}

export async function createChannel(data: InsertChannel) {
  const db = await getDb();
  if (!db) return;
  await db.insert(channels).values(data);
}

/** Update a channel the caller's org owns. Returns rows affected (0 = not yours). */
export async function updateChannel(
  id: number,
  organizationId: number,
  data: Partial<InsertChannel>,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .update(channels)
    .set(data)
    .where(and(eq(channels.id, id), eq(channels.organizationId, organizationId)));
  return (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
}

// ─── Upload Batches ──────────────────────────────────────────────────

export async function createUploadBatch(data: InsertUploadBatch) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(uploadBatches).values(data);
  return result[0].insertId;
}

export async function getUploadBatchByHash(fileHash: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(uploadBatches)
    .where(and(eq(uploadBatches.fileHash, fileHash), eq(uploadBatches.status, "completed")))
    .limit(1);
  return result[0];
}

export async function updateUploadBatch(id: number, data: Partial<InsertUploadBatch>) {
  const db = await getDb();
  if (!db) return;
  await db.update(uploadBatches).set(data).where(eq(uploadBatches.id, id));
}

export async function getUploadBatchById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(uploadBatches).where(eq(uploadBatches.id, id)).limit(1);
  return result[0];
}

// Atomically add to a batch's running valid/invalid counts. Used by chunked uploads so
// each chunk accumulates onto the batch row without a read-modify-write race.
export async function incrementUploadBatchCounts(id: number, addValid: number, addInvalid: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(uploadBatches)
    .set({
      validRows: sql`${uploadBatches.validRows} + ${addValid}`,
      invalidRows: sql`${uploadBatches.invalidRows} + ${addInvalid}`,
    })
    .where(eq(uploadBatches.id, id));
}

/**
 * Upload batches for ONE organization.
 *
 * Was `(userId, isAdmin)`, where `isAdmin` took the branch with no WHERE at all —
 * so every bank administrator saw every other tenant's uploads on /upload. Same
 * defect and same fix as getTransactions, getReconciliationJobs and getReports.
 */
export async function getUploadBatches(organizationId: number | null) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(uploadBatches)
    .where(orgFilter(uploadBatches.organizationId, organizationId))
    .orderBy(desc(uploadBatches.createdAt))
    .limit(100);
}

// ─── Transactions ────────────────────────────────────────────────────

export async function insertTransactions(txns: InsertTransaction[]) {
  const db = await getDb();
  if (!db) return;
  if (txns.length === 0) return;
  // Sanitize all text fields before insertion
  const sanitized = txns.map((txn) => ({
    ...txn,
    transactionRef: sanitizeRef(txn.transactionRef),
    externalRef: sanitizeRef(txn.externalRef),
    description: sanitizeText(txn.description),
    counterparty: sanitizeText(txn.counterparty),
  }));
  // Insert in batches to prevent memory issues
  for (let i = 0; i < sanitized.length; i += BATCH_INSERT_SIZE) {
    const batch = sanitized.slice(i, i + BATCH_INSERT_SIZE);
    await db.insert(transactions).values(batch);
  }
}

/**
 * Transactions for ONE organization.
 *
 * `organizationId` is required and has no default. It was previously absent
 * entirely: the predicate was built from `userId` (and only when `!isAdmin`)
 * plus optional filters, so an admin calling with no filters produced an empty
 * conditions array, a `whereClause` of `undefined`, and therefore
 * `.where(undefined)` — every row of every tenant on the core financial table.
 * `channelScope` in this same file carries a comment warning about exactly that
 * "null must never widen to everything" mistake; this function was the place it
 * had already happened.
 *
 * Required rather than optional-with-a-default so the compiler forces every
 * call site to state its tenant, instead of inheriting a silent one. `null`
 * means the legacy rows that carry no organization (see CLAUDE.md §19) — it is
 * NOT "any organization".
 *
 * Cross-tenant reads must not go through here. Follow the precedent of
 * `getAllChannelsAcrossTenants` and add a separate, awkwardly-named function so
 * the intent is visible at the call site.
 */
export async function getTransactions(filters: {
  organizationId: number | null;
  userId?: number;
  isAdmin?: boolean;
  channelId?: number;
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
  amountMin?: number;
  amountMax?: number;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return { data: [], total: 0 };

  // Tenancy predicate first, and unconditionally — it is never optional, so it
  // also guarantees `conditions` is non-empty and the WHERE can never vanish.
  // Typed to allow undefined entries because drizzle's `or()` may return one;
  // `and()` ignores them, and the definite predicate below keeps the result SQL.
  const conditions: (SQL<unknown> | undefined)[] = [
    filters.organizationId === null
      ? isNull(transactions.organizationId)
      : eq(transactions.organizationId, filters.organizationId),
  ];
  if (!filters.isAdmin && filters.userId) {
    conditions.push(eq(transactions.userId, filters.userId));
  }
  if (filters.channelId) conditions.push(eq(transactions.channelId, filters.channelId));
  if (filters.status) conditions.push(eq(transactions.status, filters.status as any));
  if (filters.dateFrom) conditions.push(gte(transactions.transactionDate, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(transactions.transactionDate, filters.dateTo));
  if (filters.amountMin) conditions.push(gte(transactions.amount, String(filters.amountMin)));
  if (filters.amountMax) conditions.push(lte(transactions.amount, String(filters.amountMax)));
  if (filters.search) {
    // Sanitize search input to prevent SQL LIKE injection
    const safeSearch = sanitizeLikePattern(filters.search.substring(0, 100));
    conditions.push(
      or(
        like(transactions.transactionRef, `%${safeSearch}%`),
        like(transactions.description, `%${safeSearch}%`),
        like(transactions.counterparty, `%${safeSearch}%`)
      )
    );
  }

  // No `: undefined` fallback. The tenancy predicate is unconditional, so an
  // empty conditions array is impossible — and any path yielding `undefined`
  // here would restore the unscoped, all-tenant query.
  const whereClause = and(...conditions);
  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);

  const data = await db.select().from(transactions)
    .where(whereClause)
    .orderBy(desc(transactions.transactionDate))
    .limit(limit)
    .offset(offset);

  const countResult = await db.select({ count: sql<number>`count(*)` }).from(transactions).where(whereClause);
  const total = Number(countResult[0]?.count || 0);

  return { data, total };
}

/**
 * Exact per-channel transaction aggregates for a period, computed in SQL so they
 * are NOT subject to the row-limit clamp that caps getTransactions() at 500. Used
 * by CFO / board reporting where accurate totals matter.
 */
export async function getChannelTxnAggregate(channelId: number, dateFrom: Date, dateTo: Date) {
  const db = await getDb();
  if (!db) return { total: 0, matched: 0, exceptions: 0, exceptionAmount: 0 };
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      matched: sql<number>`sum(case when ${transactions.status} = 'matched' then 1 else 0 end)`,
      exceptions: sql<number>`sum(case when ${transactions.status} = 'exception' then 1 else 0 end)`,
      exceptionAmount: sql<number>`coalesce(sum(case when ${transactions.status} = 'exception' then abs(${transactions.amount}) else 0 end), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.channelId, channelId),
        gte(transactions.transactionDate, dateFrom),
        lte(transactions.transactionDate, dateTo),
      ),
    );
  return {
    total: Number(row?.total || 0),
    matched: Number(row?.matched || 0),
    exceptions: Number(row?.exceptions || 0),
    exceptionAmount: Number(row?.exceptionAmount || 0),
  };
}

/**
 * Transactions by id, for ONE organization.
 *
 * Use this wherever the ids came from the caller. Previously there was only an
 * unscoped version, so a tRPC input of arbitrary transaction ids read rows from
 * any tenant — the same class already fixed in `getTransactions` and
 * `getAuditLogs`.
 *
 * The org predicate is AND-ed into each batch's WHERE rather than applied to
 * the assembled results: filtering after the fact would still have fetched
 * every foreign row, and one forgotten `.filter()` would restore the leak.
 */
export async function getTransactionsByIds(ids: number[], organizationId: number | null) {
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  const orgPredicate = organizationId === null
    ? isNull(transactions.organizationId)
    : eq(transactions.organizationId, organizationId);
  // Batch large ID arrays to prevent query size limits
  const results = [];
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const batchResult = await db
      .select()
      .from(transactions)
      .where(and(inArray(transactions.id, batch), orgPredicate));
    results.push(...batchResult);
  }
  return results;
}

/**
 * Transactions by id with NO tenancy filter. Internal engine use only.
 *
 * Deliberately named so the absence of scoping is visible at every call site,
 * following the precedent of `getAllChannelsAcrossTenants`.
 *
 * ONLY legitimate when the ids were derived server-side, in the same cycle,
 * from a parent row the process already owns — never from request input. Two
 * such call sites exist, both inside the reconciliation runner:
 *   - `runDeferredAiAnalysis`, whose ids come from that job's own exceptions
 *   - `runReconciliation`, whose ids come from the matching engine's result
 *     over transactions loaded from the job's own channels
 *
 * Why these are NOT simply scoped to the job's organizationId: a transaction's
 * `organizationId` is not guaranteed to equal its job's. The legacy rows carry
 * NULL (CLAUDE.md §19.2), so an org predicate here could silently return fewer
 * rows than were just matched — and at the `runReconciliation` call site that
 * means exceptions never get persisted for the dropped rows. Losing exceptions
 * is a financial-correctness failure, and a worse outcome than the theoretical
 * exposure of an id the engine itself produced. Revisit once §19.2 is settled
 * and transaction/job organizationId are known to agree.
 */
export async function getTransactionsByIdsUnscoped(ids: number[]) {
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  const results = [];
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const batchResult = await db.select().from(transactions).where(inArray(transactions.id, batch));
    results.push(...batchResult);
  }
  return results;
}

export async function updateTransactionStatus(id: number, status: string, matchId?: number) {
  const db = await getDb();
  if (!db) return;
  const updateData: any = { status };
  if (matchId !== undefined) updateData.matchId = matchId;
  await db.update(transactions).set(updateData).where(eq(transactions.id, id));
}

// Bulk-set the status of many transactions in chunked IN(...) updates. Replaces per-row
// status writes in the reconciliation hot path (which were O(n) round-trips at scale).
export async function updateTransactionStatusBulk(ids: number[], status: string) {
  const db = await getDb();
  if (!db || ids.length === 0) return;
  for (let i = 0; i < ids.length; i += BATCH_INSERT_SIZE) {
    const batch = ids.slice(i, i + BATCH_INSERT_SIZE);
    await db.update(transactions).set({ status: status as any }).where(inArray(transactions.id, batch));
  }
}

export async function getTransactionsForReconciliation(channelId: number, dateFrom: Date, dateTo: Date) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(transactions)
    .where(and(
      eq(transactions.channelId, channelId),
      gte(transactions.transactionDate, dateFrom),
      lte(transactions.transactionDate, dateTo),
      eq(transactions.status, "unmatched")
    ))
    .orderBy(asc(transactions.transactionDate));
}

/**
 * Counterparty candidates for a single-transaction Super Agent diagnosis.
 *
 * `superAgent.diagnose` used to run its deep diagnosis with an EMPTY candidate
 * list, commented "no target txns needed for standalone diagnosis". They are
 * needed, and the omission was not cosmetic: with an empty candidate set
 * `findNearestTarget` always returns null, so every diagnosis reported
 * `shortfall: null` and narrated the amount as "approximately NGN unknown",
 * while the `bank_fee_deduction` and `fx_variance` categories — both reached
 * only through a comparison against a candidate — became unreachable. The
 * shortfall is the number a financial controller acts on.
 *
 * Scoped explicitly by organizationId rather than inferred from the channel:
 * "the channel implies the tenant" is exactly the reasoning that produced the
 * cross-tenant reads in CLAUDE.md §19.3. Candidates come from OTHER channels —
 * a row on the same feed is not the counterparty leg — and the result is capped
 * so a wide window cannot turn one diagnosis into an unbounded scan.
 */
export async function getDiagnosisCandidates(params: {
  organizationId: number;
  excludeChannelId: number;
  around: Date;
  windowDays: number;
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const windowMs = Math.max(0, params.windowDays) * 24 * 60 * 60 * 1000;
  const from = new Date(params.around.getTime() - windowMs);
  const to = new Date(params.around.getTime() + windowMs);
  return db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, params.organizationId),
        ne(transactions.channelId, params.excludeChannelId),
        gte(transactions.transactionDate, from),
        lte(transactions.transactionDate, to),
        inArray(transactions.status, ["unmatched", "exception"]),
      ),
    )
    .orderBy(asc(transactions.transactionDate))
    .limit(clampLimit(params.limit ?? 500));
}

// Check for duplicate transactions within a channel
export async function findDuplicateTransactions(
  channelId: number,
  transactionRef: string,
  amount: string,
  transactionDate: Date
) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(transactions)
    .where(and(
      eq(transactions.channelId, channelId),
      eq(transactions.transactionRef, transactionRef),
      eq(transactions.amount, amount),
      eq(transactions.transactionDate, transactionDate)
    ))
    .limit(5);
}

// ─── Reconciliation Jobs ─────────────────────────────────────────────

export async function createReconciliationJob(data: InsertReconciliationJob) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(reconciliationJobs).values(data);
  return result[0].insertId;
}

export async function updateReconciliationJob(id: number, data: Partial<InsertReconciliationJob>) {
  const db = await getDb();
  if (!db) return;
  await db.update(reconciliationJobs).set(data).where(eq(reconciliationJobs.id, id));
}

/**
 * Refresh a running job's liveness signal.
 *
 * Deliberately NOT keyed on `startedAt`, which records when the run began and
 * must stay accurate for duration reporting. Guarded on `abandonedAt IS NULL`
 * so a heartbeat can never revive a job the recovery sweep already declared
 * dead — the marker stays terminal.
 *
 * Best-effort by design: a failed heartbeat must not fail the reconciliation.
 * The worst case is that the sweep eventually treats the run as stale, which is
 * exactly the behaviour that existed before heartbeats.
 */
export async function touchReconciliationJobHeartbeat(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(reconciliationJobs)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(reconciliationJobs.id, id), isNull(reconciliationJobs.abandonedAt)));
}

/**
 * Write a run's terminal result, clearing any abandonment the sweep applied
 * while the run was still executing. Reports whether that happened.
 *
 * COMPLETION IS PROOF OF LIVENESS, and it beats the sweep's guess.
 *
 * The sweep declares a job dead from silence — it has no cancellation channel
 * and no way to interrupt a worker. Its verdict is an inference, and a worker
 * arriving here has definitively falsified it: this run finished. Only a worker
 * that claimed the job BEFORE the abandonment can reach this point, because
 * claimJob refuses to start an abandoned one, so completion cannot come from a
 * resurrected duplicate.
 *
 * An earlier revision refused the write and discarded the run's artifacts. That
 * was the wrong trade: it destroyed a completed reconciliation's matches and
 * exceptions — real computed financial output — to protect a status field. The
 * sweep cannot see inside a synchronous matching pass (runMatchingEngine blocks
 * the event loop, so even the heartbeat timer cannot fire during one), which
 * makes a wrong verdict entirely reachable on a large run. Losing the results
 * of such a run is far worse than briefly having shown "failed".
 *
 * Clearing `abandonedAt` here does NOT weaken the terminal guarantee the queue
 * handler relies on: that guarantee is "an abandoned job never STARTS", and
 * this job is finishing, not starting. It lands on `completed`, which the
 * handler already skips.
 */
export async function completeReconciliationJobClearingAbandonment(
  id: number,
  data: Partial<InsertReconciliationJob>,
): Promise<{ wasAbandoned: boolean }> {
  const db = await getDb();
  if (!db) return { wasAbandoned: false };

  const [before] = await db
    .select({ abandonedAt: reconciliationJobs.abandonedAt })
    .from(reconciliationJobs)
    .where(eq(reconciliationJobs.id, id))
    .limit(1);

  await db
    .update(reconciliationJobs)
    .set({ ...data, abandonedAt: null })
    .where(eq(reconciliationJobs.id, id));

  return { wasAbandoned: before?.abandonedAt != null };
}

/**
 * Abandon a job ONLY while it is still unstarted, and report whether that won.
 *
 * Half of the enqueue-ambiguity resolution; the other half is claimJob in
 * server/reconciliationQueue.ts. When `queue.add` rejects we cannot tell whether
 * the entry was persisted, so caller and worker race: the caller wants to
 * declare the job dead, a worker may already be starting it. Letting both
 * proceed on their own reading of the row is what allowed a job the caller
 * reported as failed to run anyway.
 *
 * The database arbitrates instead, and exactly one side wins:
 *   - caller first  → status is still "pending", this update applies, the
 *                     worker's claim then finds `abandonedAt` set and refuses.
 *   - worker first  → the claim moved the row to "running", this update matches
 *                     nothing, and the caller reports the job as started rather
 *                     than failed — which is the truth.
 *
 * Returns true when the abandonment took effect.
 */
export async function abandonUnstartedReconciliationJob(id: number, at: Date): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await db
    .update(reconciliationJobs)
    .set({ status: "failed", completedAt: at, abandonedAt: at })
    .where(and(
      eq(reconciliationJobs.id, id),
      eq(reconciliationJobs.status, "pending"),
      isNull(reconciliationJobs.abandonedAt),
    ));
  return Number((result as any)?.[0]?.affectedRows ?? 0) > 0;
}

/** Reconciliation runs for ONE organization. See getUploadBatches for the history. */
export async function getReconciliationJobs(organizationId: number | null) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(reconciliationJobs)
    .where(orgFilter(reconciliationJobs.organizationId, organizationId))
    .orderBy(desc(reconciliationJobs.createdAt))
    .limit(100);
}

export async function getReconciliationJob(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(reconciliationJobs).where(eq(reconciliationJobs.id, id)).limit(1);
  return result[0];
}

/** All child jobs belonging to a single multi-channel run (ascending creation). */
export async function getReconciliationJobsByMultiRun(multiRunId: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(reconciliationJobs)
    .where(eq(reconciliationJobs.multiRunId, multiRunId))
    .orderBy(asc(reconciliationJobs.createdAt));
}

// ─── Matches ─────────────────────────────────────────────────────────

export async function insertMatch(data: InsertMatch) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(matches).values(data);
  return result[0].insertId;
}

export async function insertMatchesBatch(dataArray: InsertMatch[]) {
  const db = await getDb();
  if (!db || dataArray.length === 0) return [];
  const ids: number[] = [];
  for (let i = 0; i < dataArray.length; i += BATCH_INSERT_SIZE) {
    const batch = dataArray.slice(i, i + BATCH_INSERT_SIZE);
    const result = await db.insert(matches).values(batch);
    ids.push(result[0].insertId);
  }
  return ids;
}

export async function getMatchesByJob(jobId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(matches).where(eq(matches.jobId, jobId)).orderBy(desc(matches.confidenceScore));
}

/**
 * Confirm or reject a match, within ONE organization.
 *
 * Previously keyed on a bare id, and allow-listed in tenancyRatchet.test.ts
 * only because `matches` had no organizationId to filter on. It has one now, so
 * the exemption is gone: an id belonging to another tenant matches no row and
 * the update is a no-op rather than a cross-tenant write.
 */
export async function updateMatchStatus(
  id: number,
  organizationId: number | null,
  status: string,
  reviewedBy?: number,
) {
  const db = await getDb();
  if (!db) return;
  const updateData: any = { status };
  if (reviewedBy) { updateData.reviewedBy = reviewedBy; updateData.reviewedAt = new Date(); }
  await db.update(matches).set(updateData).where(and(eq(matches.id, id), orgFilter(matches.organizationId, organizationId)));
}

/**
 * Matches awaiting human review, for ONE organization.
 *
 * The `userId`/`isAdmin` arguments were accepted and never used — the query
 * filtered on status alone, so every caller received every tenant's review
 * queue regardless of who asked.
 */
export async function getPendingReviewMatches(organizationId: number | null) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(matches)
    .where(and(eq(matches.status, "pending_review"), orgFilter(matches.organizationId, organizationId)))
    .orderBy(desc(matches.createdAt))
    .limit(100);
}

// ─── Exceptions ──────────────────────────────────────────────────────

function assertExceptionTenantOwnership(data: Pick<InsertException, "organizationId">) {
  if (!Number.isInteger(data.organizationId) || (data.organizationId as number) <= 0) {
    throw new Error("Exception writes require a valid owning organizationId");
  }
}

export async function insertException(data: InsertException) {
  assertExceptionTenantOwnership(data);
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(exceptions).values(data);
  return result[0].insertId;
}

export async function insertExceptionsBatch(dataArray: InsertException[]) {
  for (const data of dataArray) assertExceptionTenantOwnership(data);
  const db = await getDb();
  if (!db || dataArray.length === 0) return [];
  const ids: number[] = [];
  for (let i = 0; i < dataArray.length; i += BATCH_INSERT_SIZE) {
    const batch = dataArray.slice(i, i + BATCH_INSERT_SIZE);
    const result = await db.insert(exceptions).values(batch);
    ids.push(result[0].insertId);
  }
  return ids;
}

/**
 * Exceptions for ONE organization.
 *
 * This was the last read still allow-listed in readScopeRatchet.test.ts, and
 * the only reason was that `exceptions` had no organizationId column: with all
 * filters optional the predicate could vanish and return every tenant's
 * exceptions. The column now exists (migration 0078), so the exemption is gone
 * and the tenancy predicate is unconditional like every other scoped reader.
 */
export async function getExceptions(filters: {
  organizationId: number | null;
  jobId?: number;
  status?: string;
  category?: string;
  severity?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return { data: [], total: 0 };

  const conditions: (SQL<unknown> | undefined)[] = [
    orgFilter(exceptions.organizationId, filters.organizationId),
  ];
  if (filters.jobId) conditions.push(eq(exceptions.jobId, filters.jobId));
  if (filters.status) conditions.push(eq(exceptions.status, filters.status as any));
  if (filters.category) conditions.push(eq(exceptions.category, filters.category as any));
  if (filters.severity) conditions.push(eq(exceptions.severity, filters.severity as any));
  if (filters.dateFrom) conditions.push(gte(exceptions.createdAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(exceptions.createdAt, filters.dateTo));

  // Unconditional tenancy predicate above, so no `: undefined` fallback.
  const whereClause = and(...conditions);
  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);

  const data = await db.select().from(exceptions)
    .where(whereClause)
    .orderBy(desc(exceptions.createdAt))
    .limit(limit)
    .offset(offset);

  const countResult = await db.select({ count: sql<number>`count(*)` }).from(exceptions).where(whereClause);
  const total = Number(countResult[0]?.count || 0);

  return { data, total };
}

/**
 * Update one exception, within ONE organization.
 *
 * Allow-listed in tenancyRatchet.test.ts only because `exceptions` had no
 * organizationId to filter on. It has one now, so the exemption is removed and
 * an id from another tenant updates nothing.
 */
export async function updateException(
  id: number,
  organizationId: number | null,
  data: Partial<InsertException>,
) {
  const db = await getDb();
  if (!db) return;
  await db.update(exceptions).set(data).where(and(eq(exceptions.id, id), orgFilter(exceptions.organizationId, organizationId)));
}

// ─── Exception Age / Escalation Tracker ──────────────────────────────

/**
 * Open (unresolved) exceptions joined to their transaction (for amount) and job,
 * oldest first — the input to the age/escalation tracker. Resolved/dismissed
 * items are excluded since they no longer age.
 */
export async function getOpenExceptionsForAging(organizationId: number | null, limit = 2000) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: exceptions.id,
      jobId: exceptions.jobId,
      category: exceptions.category,
      severity: exceptions.severity,
      status: exceptions.status,
      description: exceptions.description,
      assignedTo: exceptions.assignedTo,
      createdAt: exceptions.createdAt,
      amount: transactions.amount,
      currency: transactions.currency, // WS-6: amounts shown in the right currency
      transactionRef: transactions.transactionRef,
      transactionDate: transactions.transactionDate,
      jobName: reconciliationJobs.name,
      assigneeName: users.name,
    })
    .from(exceptions)
    .innerJoin(transactions, eq(exceptions.transactionId, transactions.id))
    .leftJoin(reconciliationJobs, eq(exceptions.jobId, reconciliationJobs.id))
    .leftJoin(users, eq(exceptions.assignedTo, users.id))
    .where(and(
      orgFilter(exceptions.organizationId, organizationId),
      inArray(exceptions.status, ["open", "in_review", "escalated"]),
    ))
    .orderBy(asc(exceptions.createdAt))
    .limit(limit);
}

export async function getAgingSettings(organizationId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(exceptionAgingSettings)
    .where(eq(exceptionAgingSettings.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

export async function upsertAgingSettings(organizationId: number, slaDays: number) {
  const db = await getDb();
  if (!db) return;
  const existing = await getAgingSettings(organizationId);
  if (existing) {
    await db.update(exceptionAgingSettings).set({ slaDays }).where(eq(exceptionAgingSettings.organizationId, organizationId));
  } else {
    await db.insert(exceptionAgingSettings).values({ organizationId, slaDays });
  }
}

// High/critical exceptions for one tenant-owned job that still need an AI
// narrative (aiAnalysis null). The organization predicate is mandatory even
// though the job id is server-generated: it is the final data-boundary check
// before exception context can reach an AI provider.
export async function getJobExceptionsNeedingAi(jobId: number, organizationId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(exceptions)
    .where(
      and(
        eq(exceptions.jobId, jobId),
        eq(exceptions.organizationId, organizationId),
        isNull(exceptions.aiAnalysis),
        inArray(exceptions.severity, ["high", "critical"] as any)
      )
    );
}

// ─── Audit Logs ──────────────────────────────────────────────────────

/**
 * A drizzle handle: the pooled connection, or a transaction that must be joined.
 *
 * Derived as a union rather than from `getDb()` alone — a transaction is not
 * assignable to the pooled database type (it has no `$client`), so the wider
 * type silently excluded the very thing this parameter exists to accept.
 */
type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type DbExecutor = DbHandle | Parameters<Parameters<DbHandle["transaction"]>[0]>[0];

/**
 * `executor` lets a caller enrol the audit write in ITS OWN transaction.
 *
 * Without it the audit is a separate round trip, so a failed audit insert
 * leaves the change it was meant to record already committed — the caller
 * reports failure, the row is different anyway, and the chain has no evidence
 * either way. Passing the transaction makes the write and its record succeed or
 * fail together, which is the only version worth calling an evidence trail.
 *
 * Optional because most callers use logAudit, which is best-effort by design.
 */
export async function createAuditLog(data: InsertAuditLog, executor?: DbExecutor) {
  const db = executor ?? (await getDb());
  if (!db) return;

  // Tamper-evident hash chain (per organization). Fetch the latest entry in the
  // same org scope to link against, then compute this record's hash.
  // Note: best-effort under concurrency — see auditChain.ts. For the audit
  // volume here this is acceptable; a SELECT…FOR UPDATE tx would harden it.
  const orgScope = data.organizationId ?? null;
  const [prev] = await db
    .select({ seq: auditLogs.sequenceNumber, hash: auditLogs.recordHash })
    .from(auditLogs)
    .where(orgScope === null ? isNull(auditLogs.organizationId) : eq(auditLogs.organizationId, orgScope))
    .orderBy(desc(auditLogs.sequenceNumber))
    .limit(1);

  const sequenceNumber = (prev?.seq ?? 0) + 1;
  const prevRecordHash = prev?.hash ?? null;
  const createdAt = new Date();
  const recordHash = computeRecordHash(
    {
      sequenceNumber,
      userId: data.userId ?? null,
      organizationId: orgScope,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId ?? null,
      details: data.details ?? null,
      ipAddress: data.ipAddress ?? null,
      userAgent: data.userAgent ?? null,
      createdAt,
    },
    prevRecordHash,
  );

  await db.insert(auditLogs).values({
    ...data,
    sequenceNumber,
    prevRecordHash,
    recordHash,
    createdAt,
  });
}

/**
 * Fetch the full audit chain for an organization (ascending sequence) so it can
 * be verified. organizationId === null targets the global/unscoped chain.
 */
export async function getAuditChain(organizationId: number | null) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(auditLogs)
    .where(organizationId === null ? isNull(auditLogs.organizationId) : eq(auditLogs.organizationId, organizationId))
    .orderBy(asc(auditLogs.sequenceNumber), asc(auditLogs.id));
}

/**
 * Audit log entries for ONE organization.
 *
 * Same defect and same fix as `getTransactions` above: `organizationId` was
 * absent, so `getAuditLogs({ limit: 1000 })` — a real call site — built no
 * predicate at all and returned every tenant's audit trail. On a compliance
 * product that trail is among the most sensitive tables there is: who did what,
 * to which entity, from which address.
 *
 * Required, not optional. `null` means the global/unscoped chain, matching
 * `getAuditChain` directly below.
 */
export async function getAuditLogs(filters: {
  organizationId: number | null;
  entityType?: string;
  entityId?: number;
  userId?: number;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return { data: [], total: 0 };

  const conditions = [
    filters.organizationId === null
      ? isNull(auditLogs.organizationId)
      : eq(auditLogs.organizationId, filters.organizationId),
  ];
  if (filters.entityType) conditions.push(eq(auditLogs.entityType, filters.entityType));
  if (filters.entityId) conditions.push(eq(auditLogs.entityId, filters.entityId));
  if (filters.userId) conditions.push(eq(auditLogs.userId, filters.userId));

  const whereClause = and(...conditions);
  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);

  const data = await db.select().from(auditLogs)
    .where(whereClause)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  const countResult = await db.select({ count: sql<number>`count(*)` }).from(auditLogs).where(whereClause);
  const total = Number(countResult[0]?.count || 0);

  return { data, total };
}

// ─── Reports ─────────────────────────────────────────────────────────

export async function createReport(data: InsertReconciliationReport) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(reconciliationReports).values(data);
  return result[0].insertId;
}

/** Saved reports for ONE organization. See getUploadBatches for the history. */
export async function getReports(organizationId: number | null) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(reconciliationReports)
    .where(orgFilter(reconciliationReports.organizationId, organizationId))
    .orderBy(desc(reconciliationReports.createdAt))
    .limit(100);
}

// ─── Webhooks ────────────────────────────────────────────────────────

export async function createWebhook(data: InsertWebhook) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(webhooks).values(data);
  return result[0].insertId;
}

export async function getWebhooks(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(webhooks).where(eq(webhooks.userId, userId)).orderBy(desc(webhooks.createdAt));
}

export async function getActiveWebhooksByEvent(event: string) {
  const db = await getDb();
  if (!db) return [];
  // Get all active webhooks and filter by event in application code
  const allActive = await db.select().from(webhooks).where(eq(webhooks.isActive, true));
  return allActive.filter((w) => {
    const events = w.events as string[];
    return events && events.includes(event);
  });
}

export async function updateWebhook(id: number, data: Partial<InsertWebhook>) {
  const db = await getDb();
  if (!db) return;
  await db.update(webhooks).set(data).where(eq(webhooks.id, id));
}

/** Soft-delete a webhook the caller's org owns. Returns rows affected. */
export async function deleteWebhook(id: number, organizationId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .update(webhooks)
    .set({ isActive: false })
    .where(and(eq(webhooks.id, id), eq(webhooks.organizationId, organizationId)));
  return (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
}

// ─── API Keys ────────────────────────────────────────────────────────

export async function createApiKey(data: InsertApiKey) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(apiKeys).values(data);
  return result[0].insertId;
}

export async function getApiKeyByHash(keyHash: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .limit(1);
  return result[0];
}

export async function getApiKeys(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select({
    id: apiKeys.id,
    name: apiKeys.name,
    keyPrefix: apiKeys.keyPrefix,
    permissions: apiKeys.permissions,
    isActive: apiKeys.isActive,
    lastUsedAt: apiKeys.lastUsedAt,
    expiresAt: apiKeys.expiresAt,
    createdAt: apiKeys.createdAt,
  }).from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt));
}

export async function updateApiKeyLastUsed(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}

/** Revoke an API key belonging to the caller's org. Returns rows affected. */
export async function revokeApiKey(id: number, organizationId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .update(apiKeys)
    .set({ isActive: false })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.organizationId, organizationId)));
  return (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
}

// ─── Dashboard Stats ─────────────────────────────────────────────────

export type ChannelStat = { channelId: number | null; total: number; matched: number; unmatched: number; exceptions: number };

/**
 * How long a cached row may be served before it is recomputed.
 *
 * The cache previously had exactly ONE invalidation call site (the reconciliation
 * runner) and no expiry, which is not a cache so much as a write-once snapshot.
 * Anything that changes transaction counts by another route — ingestion, the
 * SHOPLINE connector, an archival script — left it silently wrong forever. In
 * production it was serving a row written 2026-08-02 claiming 5,852,363
 * transactions while the platform held 85,499, because the org-less archival ran
 * on 2026-08-11 and never touched it.
 *
 * A TTL bounds that failure to five minutes without giving up the full-scan
 * protection the cache exists for.
 */
const DASHBOARD_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Dashboard totals for ONE tenant.
 *
 * Takes an organizationId, not a `(userId, isAdmin)` pair. The previous signature
 * was the whole defect: `isAdmin` suppressed the only predicate there was, so any
 * user with role `admin` — every bank administrator — counted every tenant's
 * transactions and jobs, and the exceptions query carried no predicate at all for
 * anybody. `dashboard_stats_cache` has had an `organizationId` column and an index
 * on it since it was created; nothing ever wrote or read it, so a single global row
 * was served to whoever asked. Tenancy here now works exactly as it does in
 * `getTransactions` / `getExceptions`: an unconditional `orgFilter` per table.
 */
export async function getDashboardStats(organizationId: number | null) {
  const db = await getDb();
  if (!db) return null;

  const cacheScope = orgFilter(dashboardStatsCache.organizationId, organizationId);
  const txnScope = orgFilter(transactions.organizationId, organizationId);
  const jobScope = orgFilter(reconciliationJobs.organizationId, organizationId);
  const excScope = orgFilter(exceptions.organizationId, organizationId);

  // Jobs and exceptions are small and are never cached — only the transaction
  // counts justify a cache, and only they were ever actually read from one.
  const [jobStats] = await db.select({
    total: sql<number>`count(*)`,
    completed: sql<number>`sum(case when ${reconciliationJobs.status} = 'completed' then 1 else 0 end)`,
    running: sql<number>`sum(case when ${reconciliationJobs.status} = 'running' then 1 else 0 end)`,
    avgMatchRate: sql<number>`avg(${reconciliationJobs.matchRate})`,
  }).from(reconciliationJobs).where(jobScope);

  const [exceptionStats] = await db.select({
    total: sql<number>`count(*)`,
    open: sql<number>`sum(case when ${exceptions.status} = 'open' then 1 else 0 end)`,
    inReview: sql<number>`sum(case when ${exceptions.status} = 'in_review' then 1 else 0 end)`,
    resolved: sql<number>`sum(case when ${exceptions.status} = 'resolved' then 1 else 0 end)`,
  }).from(exceptions).where(excScope);

  // Per-channel breakdown. This returned a hardcoded `[]` before, which is why
  // the Multi-Channel View reported "No transactions uploaded" against every
  // channel and the Dashboard's Channel Performance card never rendered at all.
  const channelRows = await db.select({
    channelId: transactions.channelId,
    total: sql<number>`count(*)`,
    matched: sql<number>`sum(case when ${transactions.status} in ('matched','manually_matched') then 1 else 0 end)`,
    unmatched: sql<number>`sum(case when ${transactions.status} = 'unmatched' then 1 else 0 end)`,
    exceptions: sql<number>`sum(case when ${transactions.status} = 'exception' then 1 else 0 end)`,
  }).from(transactions).where(txnScope).groupBy(transactions.channelId);

  const channelStats: ChannelStat[] = channelRows.map((r) => ({
    channelId: r.channelId ?? null,
    total: Number(r.total || 0),
    matched: Number(r.matched || 0),
    unmatched: Number(r.unmatched || 0),
    exceptions: Number(r.exceptions || 0),
  }));

  const jobs = {
    total: Number(jobStats?.total || 0),
    completed: Number(jobStats?.completed || 0),
    running: Number(jobStats?.running || 0),
    avgMatchRate: Number(jobStats?.avgMatchRate || 0),
  };
  const exceptionTotals = {
    total: Number(exceptionStats?.total || 0),
    open: Number(exceptionStats?.open || 0),
    inReview: Number(exceptionStats?.inReview || 0),
    resolved: Number(exceptionStats?.resolved || 0),
  };

  // ── Cache-first for the transaction totals only (the one full-scan query) ──
  const [cached] = await db.select().from(dashboardStatsCache).where(cacheScope).limit(1);
  const fresh =
    cached && Date.now() - new Date(cached.lastUpdatedAt).getTime() < DASHBOARD_CACHE_TTL_MS;

  if (cached && fresh) {
    return {
      transactions: {
        total: Number(cached.totalTransactions || 0),
        matched: Number(cached.matchedTransactions || 0),
        unmatched: Number(cached.unmatchedTransactions || 0),
        exceptions: Number(cached.exceptionTransactions || 0),
      },
      jobs,
      exceptions: exceptionTotals,
      channelStats,
    };
  }

  // The per-channel aggregate above already visited every in-scope row, so the
  // totals are summed from it rather than re-scanning the table.
  const txnTotals = channelStats.reduce(
    (acc, c) => ({
      total: acc.total + c.total,
      matched: acc.matched + c.matched,
      unmatched: acc.unmatched + c.unmatched,
      exceptions: acc.exceptions + c.exceptions,
    }),
    { total: 0, matched: 0, unmatched: 0, exceptions: 0 },
  );

  try {
    await db.delete(dashboardStatsCache).where(cacheScope);
    await db.insert(dashboardStatsCache).values({
      organizationId,
      totalTransactions: txnTotals.total,
      matchedTransactions: txnTotals.matched,
      unmatchedTransactions: txnTotals.unmatched,
      exceptionTransactions: txnTotals.exceptions,
      totalJobs: jobs.total,
      completedJobs: jobs.completed,
      runningJobs: jobs.running,
      avgMatchRate: String(jobs.avgMatchRate.toFixed(2)),
      totalExceptions: exceptionTotals.total,
      openExceptions: exceptionTotals.open,
      inReviewExceptions: exceptionTotals.inReview,
      resolvedExceptions: exceptionTotals.resolved,
    });
  } catch (_e) {
    // Non-fatal: cache seeding failure should not break the dashboard
  }

  return { transactions: txnTotals, jobs, exceptions: exceptionTotals, channelStats };
}

/**
 * Drop one tenant's cached dashboard totals after their reconciliation job runs.
 *
 * Scoped, because the unscoped `delete(dashboardStatsCache)` it replaces threw
 * away every other tenant's row on any job completion — harmless while a single
 * global row existed, and a cache-stampede across all tenants once the rows are
 * per-organization.
 */
export async function invalidateDashboardStatsCache(organizationId: number | null) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.delete(dashboardStatsCache).where(orgFilter(dashboardStatsCache.organizationId, organizationId));
  } catch (_e) {
    // Non-fatal
  }
}

// ─── Export Helpers ──────────────────────────────────────────────────

export async function getTransactionsForExport(jobId: number) {
  const db = await getDb();
  if (!db) return [];
  const job = await getReconciliationJob(jobId);
  if (!job) return [];
  // Get all transactions for both channels in the job's date range
  const allTxns = await db.select().from(transactions)
    .where(and(
      or(
        eq(transactions.channelId, job.sourceChannelId),
        eq(transactions.channelId, job.targetChannelId)
      ),
      gte(transactions.transactionDate, job.dateFrom),
      lte(transactions.transactionDate, job.dateTo)
    ))
    .orderBy(asc(transactions.transactionDate));
  return allTxns;
}

export async function getFullReconciliationReport(jobId: number) {
  const job = await getReconciliationJob(jobId);
  if (!job) return null;
  const jobMatches = await getMatchesByJob(jobId);
  const { data: jobExceptions } = await getExceptions({
    organizationId: job.organizationId ?? null,
    jobId,
    limit: MAX_QUERY_LIMIT,
  });
  const allTxns = await getTransactionsForExport(jobId);
  return { job, matches: jobMatches, exceptions: jobExceptions, transactions: allTxns };
}

// ─── Scheduled Tasks ────────────────────────────────────────────────

export async function createScheduledTask(data: InsertScheduledTask) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(scheduledTasks).values(data);
  return result[0].insertId;
}

/**
 * Update a scheduled task the caller's org owns. Returns rows affected so the
 * router can fail closed — a bare-id update let any authenticated user retarget
 * another institution's schedule.
 *
 * Pass `null` only for platform-internal callers (the scheduling engine updates
 * tasks it selected itself).
 */
export async function updateScheduledTask(
  id: number,
  organizationId: number | null,
  data: Partial<InsertScheduledTask>,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .update(scheduledTasks)
    .set(data)
    .where(
      organizationId === null
        ? eq(scheduledTasks.id, id)
        : and(eq(scheduledTasks.id, id), eq(scheduledTasks.organizationId, organizationId)),
    );
  return (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
}

/** Scheduled tasks for ONE organization. See getUploadBatches for the history. */
export async function getScheduledTasks(organizationId: number | null) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(scheduledTasks)
    .where(orgFilter(scheduledTasks.organizationId, organizationId))
    .orderBy(desc(scheduledTasks.createdAt))
    .limit(100);
}

/**
 * One scheduled task, but only if it belongs to this organization.
 *
 * The ownership check `schedules.runNow` needs. `getScheduledTaskById` below is
 * unscoped by design — the scheduler resolves tasks it selected itself — so a
 * request-supplied id must come through here instead.
 */
export async function getScheduledTask(id: number, organizationId: number | null) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, id), orgFilter(scheduledTasks.organizationId, organizationId)))
    .limit(1);
  return result[0];
}

/**
 * One scheduled task by id, with NO tenancy filter.
 *
 * Valid only for the scheduling engine, which iterates tasks it selected itself.
 * Never call this with an id that came from a request — use `getScheduledTask`.
 */
export async function getScheduledTaskById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1);
  return result[0];
}

export async function getActiveScheduledTasks() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(scheduledTasks)
    .where(eq(scheduledTasks.isActive, true))
    .orderBy(asc(scheduledTasks.nextRunAt));
}

export async function getDueScheduledTasks(now: Date) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(scheduledTasks)
    .where(and(
      eq(scheduledTasks.isActive, true),
      lte(scheduledTasks.nextRunAt, now)
    ))
    .orderBy(asc(scheduledTasks.nextRunAt));
}

/** Soft-delete a scheduled task the caller's org owns. Returns rows affected. */
export async function deleteScheduledTask(id: number, organizationId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .update(scheduledTasks)
    .set({ isActive: false })
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.organizationId, organizationId)));
  return (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
}

// ─── Schedule Run History ───────────────────────────────────────────

export async function createScheduleRunHistory(data: InsertScheduleRunHistory) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(scheduleRunHistory).values(data);
  return result[0].insertId;
}

export async function updateScheduleRunHistory(id: number, data: Partial<InsertScheduleRunHistory>) {
  const db = await getDb();
  if (!db) return;
  await db.update(scheduleRunHistory).set(data).where(eq(scheduleRunHistory.id, id));
}

export async function getScheduleRunHistoryByTask(taskId: number, limit: number = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(scheduleRunHistory)
    .where(eq(scheduleRunHistory.scheduledTaskId, taskId))
    .orderBy(desc(scheduleRunHistory.startedAt))
    .limit(clampLimit(limit));
}

export async function getRecentScheduleRuns(limit: number = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(scheduleRunHistory)
    .orderBy(desc(scheduleRunHistory.startedAt))
    .limit(clampLimit(limit));
}

// ─── Email Preferences ──────────────────────────────────────────────

export async function getEmailPreferences(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(emailPreferences)
    .where(eq(emailPreferences.userId, userId))
    .limit(1);
  return result[0];
}

export async function upsertEmailPreferences(userId: number, data: Partial<InsertEmailPreference>) {
  const db = await getDb();
  if (!db) return null;
  const existing = await getEmailPreferences(userId);
  if (existing) {
    await db.update(emailPreferences).set(data).where(eq(emailPreferences.id, existing.id));
    return existing.id;
  } else {
    const result = await db.insert(emailPreferences).values({ userId, ...data } as InsertEmailPreference);
    return result[0].insertId;
  }
}

// ─── Job Progress Events ────────────────────────────────────────────

export async function insertJobProgressEvent(data: InsertJobProgressEvent) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(jobProgressEvents).values(data);
  return result[0].insertId;
}

export async function getJobProgressEvents(jobId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(jobProgressEvents)
    .where(eq(jobProgressEvents.jobId, jobId))
    .orderBy(asc(jobProgressEvents.createdAt));
}

export async function getLatestJobProgress(jobId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(jobProgressEvents)
    .where(eq(jobProgressEvents.jobId, jobId))
    .orderBy(desc(jobProgressEvents.createdAt))
    .limit(1);
  return result[0];
}

export async function getActiveJobsProgress() {
  const db = await getDb();
  if (!db) return [];
  // Get all running jobs
  const runningJobs = await db.select().from(reconciliationJobs)
    .where(or(
      eq(reconciliationJobs.status, "running"),
      eq(reconciliationJobs.status, "pending")
    ))
    .orderBy(desc(reconciliationJobs.createdAt))
    .limit(20);

  const jobsWithProgress = [];
  for (const job of runningJobs) {
    const latestProgress = await getLatestJobProgress(job.id);
    jobsWithProgress.push({
      ...job,
      latestProgress: latestProgress || null,
    });
  }
  return jobsWithProgress;
}

// ─── Dashboard Stats (Extended) ─────────────────────────────────────

/** Monitor-page stats for ONE organization. See getUploadBatches for the history. */
export async function getMonitoringStats(organizationId: number | null) {
  const db = await getDb();
  if (!db) return null;

  const jobCondition = orgFilter(reconciliationJobs.organizationId, organizationId);

  // Active jobs count
  const [activeJobs] = await db.select({
    running: sql<number>`sum(case when ${reconciliationJobs.status} = 'running' then 1 else 0 end)`,
    pending: sql<number>`sum(case when ${reconciliationJobs.status} = 'pending' then 1 else 0 end)`,
  }).from(reconciliationJobs).where(jobCondition);

  // Recent jobs (last 24h)
  const oneDayAgo = new Date(Date.now() - 86400000);
  const recentJobs = await db.select().from(reconciliationJobs)
    .where(and(
      jobCondition,
      gte(reconciliationJobs.createdAt, oneDayAgo)
    ))
    .orderBy(desc(reconciliationJobs.createdAt))
    .limit(20);

  // Performance stats (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
  const [perfStats] = await db.select({
    avgProcessingTime: sql<number>`avg(${reconciliationJobs.processingTimeMs})`,
    avgMatchRate: sql<number>`avg(${reconciliationJobs.matchRate})`,
    totalCompleted: sql<number>`sum(case when ${reconciliationJobs.status} = 'completed' then 1 else 0 end)`,
    totalFailed: sql<number>`sum(case when ${reconciliationJobs.status} = 'failed' then 1 else 0 end)`,
    totalTransactions: sql<number>`sum(${reconciliationJobs.totalSourceTxns} + ${reconciliationJobs.totalTargetTxns})`,
  }).from(reconciliationJobs)
    .where(and(
      jobCondition,
      gte(reconciliationJobs.createdAt, sevenDaysAgo)
    ));

  // Active schedules
  const [scheduleStats] = await db.select({
    total: sql<number>`count(*)`,
    active: sql<number>`sum(case when ${scheduledTasks.isActive} = true then 1 else 0 end)`,
  }).from(scheduledTasks)
    .where(orgFilter(scheduledTasks.organizationId, organizationId));

  return {
    activeJobs: {
      running: Number(activeJobs?.running || 0),
      pending: Number(activeJobs?.pending || 0),
    },
    recentJobs,
    performance: {
      avgProcessingTimeMs: Number(perfStats?.avgProcessingTime || 0),
      avgMatchRate: Number(perfStats?.avgMatchRate || 0),
      totalCompleted: Number(perfStats?.totalCompleted || 0),
      totalFailed: Number(perfStats?.totalFailed || 0),
      totalTransactions: Number(perfStats?.totalTransactions || 0),
      successRate: (() => {
        const completed = Number(perfStats?.totalCompleted || 0);
        const failed = Number(perfStats?.totalFailed || 0);
        const total = completed + failed;
        return total > 0 ? Math.round((completed / total) * 10000) / 100 : 100;
      })(),
    },
    schedules: {
      total: Number(scheduleStats?.total || 0),
      active: Number(scheduleStats?.active || 0),
    },
  };
}


// ─── SFTP Credentials ───────────────────────────────────────────────

export async function createSftpCredential(data: InsertSftpCredential) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const [result] = await db.insert(sftpCredentials).values(data);
  return result.insertId;
}

/**
 * List SFTP credentials for an organization.
 *
 * Scoped by ORG, not by the creating user: an SFTP feed is institutional
 * configuration, so a colleague must be able to see and manage it. The previous
 * `userId`-only filter both hid teammates' feeds and — because `organizationId`
 * was optional and callers omitted it — left the org boundary unenforced.
 */
export async function getSftpCredentials(organizationId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = [eq(sftpCredentials.organizationId, organizationId)];

  return db
    .select()
    .from(sftpCredentials)
    .where(and(...conditions))
    .orderBy(desc(sftpCredentials.createdAt));
}

/**
 * Fetch an SFTP credential, scoped to its owning organization.
 *
 * `organizationId` is REQUIRED. These rows hold BANK CONNECTION SECRETS (host,
 * username, encrypted password/key, remote path), and every accessor here was
 * previously keyed on `id` alone — so any caller who could guess an id could
 * read, repoint or delete another tenant's bank feed. Pass `null` only for
 * genuine platform-internal use (the poller iterates all sources by design).
 */
export async function getSftpCredentialById(id: number, organizationId: number | null) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [cred] = await db
    .select()
    .from(sftpCredentials)
    .where(
      organizationId === null
        ? eq(sftpCredentials.id, id)
        : and(eq(sftpCredentials.id, id), eq(sftpCredentials.organizationId, organizationId)),
    )
    .limit(1);
  
  return cred;
}

/**
 * Update an SFTP credential within its owning organization.
 * Returns the number of rows affected so callers can fail closed (0 = the row
 * exists but belongs to someone else, or does not exist — deliberately
 * indistinguishable, so this is not an enumeration oracle).
 */
export async function updateSftpCredential(
  id: number,
  organizationId: number,
  data: Partial<InsertSftpCredential>,
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .update(sftpCredentials)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(sftpCredentials.id, id), eq(sftpCredentials.organizationId, organizationId)));
  return (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
}

/** Delete an SFTP credential within its owning organization. Returns rows affected. */
export async function deleteSftpCredential(id: number, organizationId: number): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .delete(sftpCredentials)
    .where(and(eq(sftpCredentials.id, id), eq(sftpCredentials.organizationId, organizationId)));
  return (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
}

// ─── SFTP Ingestion Logs ────────────────────────────────────────────

export async function getSftpIngestionLogs(params: {
  credentialId?: number;
  organizationId?: number;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const limit = Math.min(params.limit || DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const offset = params.offset || 0;
  
  // Conditions are AND-ed into a single .where(). Chaining .where() twice does
  // NOT combine them in drizzle — the second call REPLACES the first, so the
  // previous form silently dropped whichever filter was applied earlier.
  const conditions = [];
  if (params.credentialId) conditions.push(eq(sftpIngestionLogs.sftpCredentialId, params.credentialId));
  if (params.organizationId) conditions.push(eq(sftpIngestionLogs.organizationId, params.organizationId));

  const query = conditions.length > 0
    ? db.select().from(sftpIngestionLogs).where(and(...conditions))
    : db.select().from(sftpIngestionLogs);

  return query
    .orderBy(desc(sftpIngestionLogs.createdAt))
    .limit(limit)
    .offset(offset);
}

// ─── API Ingestion Logs ─────────────────────────────────────────────

export async function getApiIngestionLogs(params: {
  organizationId?: number;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const limit = Math.min(params.limit || DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const offset = params.offset || 0;
  
  let query = db.select().from(apiIngestionLogs);
  
  if (params.organizationId) {
    query = query.where(eq(apiIngestionLogs.organizationId, params.organizationId)) as any;
  }
  
  return query
    .orderBy(desc(apiIngestionLogs.createdAt))
    .limit(limit)
    .offset(offset);
}

// ─── User Role Preferences ──────────────────────────────────────────

export async function getUserRolePreference(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const [pref] = await db
    .select()
    .from(userRolePreferences)
    .where(eq(userRolePreferences.userId, userId))
    .limit(1);
  
  return pref;
}

export async function upsertUserRolePreference(data: InsertUserRolePreference) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const existing = await getUserRolePreference(data.userId);
  
  if (existing) {
    await db
      .update(userRolePreferences)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(userRolePreferences.userId, data.userId));
  } else {
    await db.insert(userRolePreferences).values(data);
  }
}

// ─── Anomaly Detection Helpers ──────────────────────────────────────

export async function storeAnomalyScores(scores: InsertAnomalyScore[]) {
  const db = await getDb();
  if (!db || scores.length === 0) return [];
  
  // Batch insert
  const results = [];
  for (let i = 0; i < scores.length; i += BATCH_INSERT_SIZE) {
    const batch = scores.slice(i, i + BATCH_INSERT_SIZE);
    const inserted = await db.insert(anomalyScores).values(batch);
    results.push(inserted);
  }
  return results;
}

/**
 * Anomaly scores for ONE organization.
 *
 * `organizationId` is required and unconditional. It was optional, and the
 * predicate was assembled from optional filters — so a call with no filters
 * produced `db.select().from(anomalyScores)` with no WHERE and returned every
 * tenant's scores. The comment below records an EARLIER bug in this same
 * function (chained `.where()` replacing rather than combining); this is the
 * same hazard one layer out, and it is why the parameter is no longer optional.
 */
export async function getAnomalyScores(filters: {
  organizationId: number | null;
  transactionId?: number;
  reviewStatus?: string;
  minScore?: number;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  
  // AND the conditions into ONE .where(). Chaining .where() does not combine
  // in drizzle — each call REPLACES the previous predicate, so the old form
  // applied only the last matching filter. With minScore last, an
  // organizationId-filtered call silently returned EVERY tenant's anomaly
  // scores; transactionId and reviewStatus were dropped too.
  // Tenancy first and unconditionally, so there is no filter combination that
  // produces a query without it.
  const conditions: (SQL<unknown> | undefined)[] = [
    orgFilter(anomalyScores.organizationId, filters.organizationId),
  ];
  if (filters.transactionId) conditions.push(eq(anomalyScores.transactionId, filters.transactionId));
  if (filters.reviewStatus) conditions.push(eq(anomalyScores.reviewStatus, filters.reviewStatus as any));
  if (filters.minScore) conditions.push(gte(anomalyScores.anomalyScore, String(filters.minScore)));

  const limit = Math.min(filters.limit || DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const offset = filters.offset || 0;

  return db.select().from(anomalyScores)
    .where(and(...conditions))
    .limit(limit).offset(offset).orderBy(desc(anomalyScores.anomalyScore));
}

/** Review an anomaly belonging to the caller's org. Returns rows affected. */
export async function updateAnomalyReview(
  id: number,
  organizationId: number,
  reviewData: {
    reviewStatus: string;
    reviewedBy: number;
    reviewNotes?: string;
  }
) {
  const db = await getDb();
  if (!db) return null;
  
  const result = await db
    .update(anomalyScores)
    .set({ ...reviewData, reviewedAt: new Date() } as any)
    .where(and(eq(anomalyScores.id, id), eq(anomalyScores.organizationId, organizationId)));
  return (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
}

/**
 * Detection rules for ONE organization.
 *
 * Required, not optional-with-a-skip: `if (organizationId)` meant a call that
 * omitted it — or passed 0 — read every tenant's rules. Detection rules encode
 * how a bank flags anomalies, so leaking them leaks its control posture.
 */
export async function getDetectionRules(organizationId: number | null) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(detectionRules)
    .where(orgFilter(detectionRules.organizationId, organizationId))
    .orderBy(desc(detectionRules.createdAt));
}

export async function createDetectionRule(rule: InsertDetectionRule) {
  const db = await getDb();
  if (!db) return null;
  
  return db.insert(detectionRules).values(rule);
}

/** Update a detection rule the caller's org owns. Returns rows affected. */
export async function updateDetectionRule(
  id: number,
  organizationId: number,
  updates: Partial<InsertDetectionRule>,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .update(detectionRules)
    .set(updates as any)
    .where(and(eq(detectionRules.id, id), eq(detectionRules.organizationId, organizationId)));
  return (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
}

/** Delete a detection rule the caller's org owns. Returns rows affected. */
export async function deleteDetectionRule(id: number, organizationId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .delete(detectionRules)
    .where(and(eq(detectionRules.id, id), eq(detectionRules.organizationId, organizationId)));
  return (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
}

export async function getFlaggedTransactions(filters: {
  organizationId?: number;
  minScore?: number;
  reviewStatus?: string;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  
  const limit = Math.min(filters.limit || DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const offset = filters.offset || 0;
  
  // Join anomaly_scores with transactions to get full transaction details
  // Build where conditions
  const conditions: any[] = [eq(anomalyScores.isFlagged, true)];
  
  if (filters.organizationId) {
    conditions.push(eq(anomalyScores.organizationId, filters.organizationId));
  }
  if (filters.minScore) {
    conditions.push(gte(anomalyScores.anomalyScore, String(filters.minScore)));
  }
  if (filters.reviewStatus) {
    conditions.push(eq(anomalyScores.reviewStatus, filters.reviewStatus as any));
  }
  
  return db.select({
    anomaly: anomalyScores,
    transaction: transactions,
  })
  .from(anomalyScores)
  .innerJoin(transactions, eq(anomalyScores.transactionId, transactions.id))
  .where(and(...conditions))
  .limit(limit)
  .offset(offset)
  .orderBy(desc(anomalyScores.anomalyScore));
}

// ─── Distributor Identity Registry ──────────────────────────────────

export async function getDistributors(filters: {
  organizationId: number;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.min(filters.limit || 50, 200);
  const offset = filters.offset || 0;
  const conditions: any[] = [eq(distributors.organizationId, filters.organizationId)];
  if (filters.status) conditions.push(eq(distributors.status, filters.status as any));
  if (filters.search) {
    conditions.push(
      or(
        like(distributors.canonicalName, `%${filters.search}%`),
        like(distributors.canonicalId, `%${filters.search}%`),
        like(distributors.zone, `%${filters.search}%`)
      )
    );
  }
  return db.select().from(distributors)
    .where(and(...conditions))
    .orderBy(desc(distributors.updatedAt))
    .limit(limit).offset(offset);
}

export async function getDistributorById(id: number, organizationId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(distributors)
    .where(and(eq(distributors.id, id), eq(distributors.organizationId, organizationId)))
    .limit(1);
  return rows[0] || null;
}

export async function createDistributor(data: {
  organizationId: number;
  canonicalName: string;
  registeredBusinessName?: string;
  taxId?: string;
  primaryBankAccount?: string;
  primaryBankName?: string;
  contactEmail?: string;
  contactPhone?: string;
  zone?: string;
  nameVariants?: string[];
  notes?: string;
  createdBy: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Generate canonical ID
  const count = await db.select().from(distributors)
    .where(eq(distributors.organizationId, data.organizationId));
  const canonicalId = `DIST-${String(count.length + 1).padStart(4, "0")}`;
  const result = await db.insert(distributors).values({
    ...data,
    canonicalId,
    nameVariants: data.nameVariants || [],
    status: "active",
  });
  return result;
}

export async function updateDistributor(
  id: number,
  organizationId: number,
  data: Partial<{
    canonicalName: string;
    registeredBusinessName: string;
    taxId: string;
    primaryBankAccount: string;
    primaryBankName: string;
    contactEmail: string;
    contactPhone: string;
    zone: string;
    status: "active" | "inactive" | "pending_confirmation" | "flagged";
    nameVariants: string[];
    notes: string;
    confirmedBy: number;
    confirmedAt: Date;
  }>
) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.update(distributors)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(distributors.id, id), eq(distributors.organizationId, organizationId)));
}

export async function addDistributorNameVariant(id: number, organizationId: number, variant: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const dist = await getDistributorById(id, organizationId);
  if (!dist) throw new Error("Distributor not found");
  const existing = (dist.nameVariants as string[]) || [];
  if (!existing.includes(variant)) {
    await updateDistributor(id, organizationId, { nameVariants: [...existing, variant] });
  }
}

export async function getDistributorStats(organizationId: number) {
  const db = await getDb();
  if (!db) return { total: 0, active: 0, pendingConfirmation: 0, flagged: 0 };
  const all = await db.select().from(distributors)
    .where(eq(distributors.organizationId, organizationId));
  return {
    total: all.length,
    active: all.filter((d) => d.status === "active").length,
    pendingConfirmation: all.filter((d) => d.status === "pending_confirmation").length,
    flagged: all.filter((d) => d.status === "flagged").length,
  };
}

// ─── CFO Report Schedules ────────────────────────────────────────────

export async function getCfoReportSchedule(userId: number): Promise<CfoReportSchedule | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(cfoReportSchedules).where(eq(cfoReportSchedules.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function getCfoReportScheduleByTaskUid(taskUid: string): Promise<CfoReportSchedule | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(cfoReportSchedules).where(eq(cfoReportSchedules.scheduleCronTaskUid, taskUid)).limit(1);
  return rows[0] ?? null;
}

export async function upsertCfoReportSchedule(userId: number, data: Partial<InsertCfoReportSchedule>): Promise<CfoReportSchedule | null> {
  const db = await getDb();
  if (!db) return null;
  const existing = await getCfoReportSchedule(userId);
  if (existing) {
    await db.update(cfoReportSchedules).set({ ...data, updatedAt: new Date() }).where(eq(cfoReportSchedules.userId, userId));
    return getCfoReportSchedule(userId);
  } else {
    await db.insert(cfoReportSchedules).values({ userId, recipients: [], ...data } as InsertCfoReportSchedule);
    return getCfoReportSchedule(userId);
  }
}

export async function updateCfoReportScheduleLastSent(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(cfoReportSchedules).set({ lastSentAt: new Date() }).where(eq(cfoReportSchedules.userId, userId));
}

// ─── Channel Alert Settings ──────────────────────────────────────────

export async function getChannelAlertSettings(userId: number): Promise<ChannelAlertSetting[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(channelAlertSettings).where(eq(channelAlertSettings.userId, userId));
}

export async function getChannelAlertSetting(userId: number, channelCode: string): Promise<ChannelAlertSetting | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(channelAlertSettings)
    .where(and(eq(channelAlertSettings.userId, userId), eq(channelAlertSettings.channelCode, channelCode)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertChannelAlertSetting(userId: number, channelCode: string, data: { threshold?: number; alertEnabled?: boolean }): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await getChannelAlertSetting(userId, channelCode);
  if (existing) {
    await db.update(channelAlertSettings).set({
      ...(data.threshold !== undefined && { threshold: String(data.threshold) }),
      ...(data.alertEnabled !== undefined && { alertEnabled: data.alertEnabled }),
      updatedAt: new Date(),
    }).where(and(eq(channelAlertSettings.userId, userId), eq(channelAlertSettings.channelCode, channelCode)));
  } else {
    await db.insert(channelAlertSettings).values({
      userId,
      channelCode,
      threshold: String(data.threshold ?? 95),
      alertEnabled: data.alertEnabled ?? true,
    } as InsertChannelAlertSetting);
  }
}

export async function updateChannelAlertLastSent(userId: number, channelCode: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(channelAlertSettings).set({ lastAlertSentAt: new Date() })
    .where(and(eq(channelAlertSettings.userId, userId), eq(channelAlertSettings.channelCode, channelCode)));
}

// ─── Platform Audit Log helpers ──────────────────────────────────────────────
export async function logPlatformEvent(event: InsertPlatformAuditLog): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(platformAuditLogs).values(event);
}

export async function getPlatformAuditLogs(opts?: {
  eventType?: PlatformAuditLog["eventType"];
  limit?: number;
  offset?: number;
}): Promise<{ logs: PlatformAuditLog[]; total: number }> {
  const db = await getDb();
  if (!db) return { logs: [], total: 0 };
  const limit = Math.min(opts?.limit ?? 50, 200);
  const offset = opts?.offset ?? 0;
  const conditions = opts?.eventType ? [eq(platformAuditLogs.eventType, opts.eventType)] : [];
  const [logs, countResult] = await Promise.all([
    db.select().from(platformAuditLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(platformAuditLogs.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(platformAuditLogs)
      .where(conditions.length ? and(...conditions) : undefined),
  ]);
  return { logs, total: Number(countResult[0]?.count ?? 0) };
}
