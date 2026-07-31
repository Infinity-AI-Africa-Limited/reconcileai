import { eq, and, gte, lte, like, or, desc, asc, sql, inArray, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
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

export async function getChannels() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(channels).orderBy(asc(channels.name));
}

export async function getChannelByCode(code: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(channels).where(eq(channels.code, code)).limit(1);
  return result[0];
}

export async function getChannelById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
  return result[0];
}

export async function createChannel(data: InsertChannel) {
  const db = await getDb();
  if (!db) return;
  await db.insert(channels).values(data);
}

export async function updateChannel(id: number, data: Partial<InsertChannel>) {
  const db = await getDb();
  if (!db) return;
  await db.update(channels).set(data).where(eq(channels.id, id));
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

export async function getUploadBatches(userId: number, isAdmin: boolean) {
  const db = await getDb();
  if (!db) return [];
  if (isAdmin) {
    return db.select().from(uploadBatches).orderBy(desc(uploadBatches.createdAt)).limit(100);
  }
  return db.select().from(uploadBatches).where(eq(uploadBatches.userId, userId)).orderBy(desc(uploadBatches.createdAt)).limit(100);
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

export async function getTransactions(filters: {
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

  const conditions = [];
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

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
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

export async function getTransactionsByIds(ids: number[]) {
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  // Batch large ID arrays to prevent query size limits
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

export async function getReconciliationJobs(userId: number, isAdmin: boolean) {
  const db = await getDb();
  if (!db) return [];
  if (isAdmin) {
    return db.select().from(reconciliationJobs).orderBy(desc(reconciliationJobs.createdAt)).limit(100);
  }
  return db.select().from(reconciliationJobs).where(eq(reconciliationJobs.userId, userId)).orderBy(desc(reconciliationJobs.createdAt)).limit(100);
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

export async function updateMatchStatus(id: number, status: string, reviewedBy?: number) {
  const db = await getDb();
  if (!db) return;
  const updateData: any = { status };
  if (reviewedBy) { updateData.reviewedBy = reviewedBy; updateData.reviewedAt = new Date(); }
  await db.update(matches).set(updateData).where(eq(matches.id, id));
}

export async function getPendingReviewMatches(userId: number, isAdmin: boolean) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(matches).where(eq(matches.status, "pending_review")).orderBy(desc(matches.createdAt)).limit(100);
}

// ─── Exceptions ──────────────────────────────────────────────────────

export async function insertException(data: InsertException) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(exceptions).values(data);
  return result[0].insertId;
}

export async function insertExceptionsBatch(dataArray: InsertException[]) {
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

export async function getExceptions(filters: {
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

  const conditions = [];
  if (filters.jobId) conditions.push(eq(exceptions.jobId, filters.jobId));
  if (filters.status) conditions.push(eq(exceptions.status, filters.status as any));
  if (filters.category) conditions.push(eq(exceptions.category, filters.category as any));
  if (filters.severity) conditions.push(eq(exceptions.severity, filters.severity as any));
  if (filters.dateFrom) conditions.push(gte(exceptions.createdAt, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(exceptions.createdAt, filters.dateTo));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
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

export async function updateException(id: number, data: Partial<InsertException>) {
  const db = await getDb();
  if (!db) return;
  await db.update(exceptions).set(data).where(eq(exceptions.id, id));
}

// ─── Exception Age / Escalation Tracker ──────────────────────────────

/**
 * Open (unresolved) exceptions joined to their transaction (for amount) and job,
 * oldest first — the input to the age/escalation tracker. Resolved/dismissed
 * items are excluded since they no longer age.
 */
export async function getOpenExceptionsForAging(limit = 2000) {
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
    .where(inArray(exceptions.status, ["open", "in_review", "escalated"]))
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

// High/critical exceptions for a job that still need an AI narrative (aiAnalysis
// null). Backs the deferred, out-of-hot-path AI pass; restartable because it
// re-queries the DB rather than relying on in-memory state.
export async function getJobExceptionsNeedingAi(jobId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(exceptions)
    .where(
      and(
        eq(exceptions.jobId, jobId),
        isNull(exceptions.aiAnalysis),
        inArray(exceptions.severity, ["high", "critical"] as any)
      )
    );
}

// ─── Audit Logs ──────────────────────────────────────────────────────

export async function createAuditLog(data: InsertAuditLog) {
  const db = await getDb();
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

export async function getAuditLogs(filters: {
  entityType?: string;
  entityId?: number;
  userId?: number;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return { data: [], total: 0 };

  const conditions = [];
  if (filters.entityType) conditions.push(eq(auditLogs.entityType, filters.entityType));
  if (filters.entityId) conditions.push(eq(auditLogs.entityId, filters.entityId));
  if (filters.userId) conditions.push(eq(auditLogs.userId, filters.userId));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
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

export async function getReports(userId: number, isAdmin: boolean) {
  const db = await getDb();
  if (!db) return [];
  if (isAdmin) {
    return db.select().from(reconciliationReports).orderBy(desc(reconciliationReports.createdAt)).limit(100);
  }
  return db.select().from(reconciliationReports).where(eq(reconciliationReports.userId, userId)).orderBy(desc(reconciliationReports.createdAt)).limit(100);
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

export async function deleteWebhook(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(webhooks).set({ isActive: false }).where(eq(webhooks.id, id));
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

export async function revokeApiKey(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, id));
}

// ─── Dashboard Stats ─────────────────────────────────────────────────

export async function getDashboardStats(userId: number, isAdmin: boolean) {
  const db = await getDb();
  if (!db) return null;

  // ── Cache-first: read pre-computed stats (avoids full scan of 26M+ rows) ──
  const cacheRows = await db.select().from(dashboardStatsCache).limit(1);
  const cached = cacheRows[0];

  if (cached) {
    // Cache hit — return instantly
    const jobCondition = !isAdmin ? eq(reconciliationJobs.userId, userId) : undefined;
    const [jobStats] = await db.select({
      total: sql<number>`count(*)`,
      completed: sql<number>`sum(case when ${reconciliationJobs.status} = 'completed' then 1 else 0 end)`,
      running: sql<number>`sum(case when ${reconciliationJobs.status} = 'running' then 1 else 0 end)`,
      avgMatchRate: sql<number>`avg(${reconciliationJobs.matchRate})`,
    }).from(reconciliationJobs).where(jobCondition);

    const [exceptionStats] = await db.select({
      total: sql<number>`count(*)`,
      open: sql<number>`sum(case when ${exceptions.status} = 'open' then 1 else 0 end)`,
      inReview: sql<number>`sum(case when ${exceptions.status} = 'in_review' then 1 else 0 end)`,
      resolved: sql<number>`sum(case when ${exceptions.status} = 'resolved' then 1 else 0 end)`,
    }).from(exceptions);

    return {
      transactions: {
        total: Number(cached.totalTransactions || 0),
        matched: Number(cached.matchedTransactions || 0),
        unmatched: Number(cached.unmatchedTransactions || 0),
        exceptions: Number(cached.exceptionTransactions || 0),
      },
      jobs: {
        total: Number(jobStats?.total || 0),
        completed: Number(jobStats?.completed || 0),
        running: Number(jobStats?.running || 0),
        avgMatchRate: Number(jobStats?.avgMatchRate || 0),
      },
      exceptions: {
        total: Number(exceptionStats?.total || 0),
        open: Number(exceptionStats?.open || 0),
        inReview: Number(exceptionStats?.inReview || 0),
        resolved: Number(exceptionStats?.resolved || 0),
      },
      channelStats: [] as Array<{ channelId: number | null; total: number; matched: number; unmatched: number }>,
    };
  }

  // ── Cache miss: run full query and seed the cache ──
  const userCondition = !isAdmin ? eq(transactions.userId, userId) : undefined;
  const jobCondition = !isAdmin ? eq(reconciliationJobs.userId, userId) : undefined;

  const [txnStats] = await db.select({
    total: sql<number>`count(*)`,
    matched: sql<number>`sum(case when ${transactions.status} = 'matched' or ${transactions.status} = 'manually_matched' then 1 else 0 end)`,
    unmatched: sql<number>`sum(case when ${transactions.status} = 'unmatched' then 1 else 0 end)`,
    exceptions: sql<number>`sum(case when ${transactions.status} = 'exception' then 1 else 0 end)`,
  }).from(transactions).where(userCondition);

  const [jobStats] = await db.select({
    total: sql<number>`count(*)`,
    completed: sql<number>`sum(case when ${reconciliationJobs.status} = 'completed' then 1 else 0 end)`,
    running: sql<number>`sum(case when ${reconciliationJobs.status} = 'running' then 1 else 0 end)`,
    avgMatchRate: sql<number>`avg(${reconciliationJobs.matchRate})`,
  }).from(reconciliationJobs).where(jobCondition);

  const [exceptionStats] = await db.select({
    total: sql<number>`count(*)`,
    open: sql<number>`sum(case when ${exceptions.status} = 'open' then 1 else 0 end)`,
    inReview: sql<number>`sum(case when ${exceptions.status} = 'in_review' then 1 else 0 end)`,
    resolved: sql<number>`sum(case when ${exceptions.status} = 'resolved' then 1 else 0 end)`,
  }).from(exceptions);

  // Seed the cache so future requests are instant
  try {
    await db.insert(dashboardStatsCache).values({
      totalTransactions: Number(txnStats?.total || 0),
      matchedTransactions: Number(txnStats?.matched || 0),
      unmatchedTransactions: Number(txnStats?.unmatched || 0),
      exceptionTransactions: Number(txnStats?.exceptions || 0),
      totalJobs: Number(jobStats?.total || 0),
      completedJobs: Number(jobStats?.completed || 0),
      runningJobs: Number(jobStats?.running || 0),
      avgMatchRate: String(Number(jobStats?.avgMatchRate || 0).toFixed(2)),
      totalExceptions: Number(exceptionStats?.total || 0),
      openExceptions: Number(exceptionStats?.open || 0),
      inReviewExceptions: Number(exceptionStats?.inReview || 0),
      resolvedExceptions: Number(exceptionStats?.resolved || 0),
    });
  } catch (_e) {
    // Non-fatal: cache seeding failure should not break the dashboard
  }

  return {
    transactions: {
      total: Number(txnStats?.total || 0),
      matched: Number(txnStats?.matched || 0),
      unmatched: Number(txnStats?.unmatched || 0),
      exceptions: Number(txnStats?.exceptions || 0),
    },
    jobs: {
      total: Number(jobStats?.total || 0),
      completed: Number(jobStats?.completed || 0),
      running: Number(jobStats?.running || 0),
      avgMatchRate: Number(jobStats?.avgMatchRate || 0),
    },
    exceptions: {
      total: Number(exceptionStats?.total || 0),
      open: Number(exceptionStats?.open || 0),
      inReview: Number(exceptionStats?.inReview || 0),
      resolved: Number(exceptionStats?.resolved || 0),
    },
    channelStats: [] as Array<{ channelId: number | null; total: number; matched: number; unmatched: number }>,
  };
}

/**
 * Invalidate the dashboard stats cache after a reconciliation job completes.
 * Call this from the reconciliation runner after each job finishes.
 */
export async function invalidateDashboardStatsCache() {
  const db = await getDb();
  if (!db) return;
  try {
    await db.delete(dashboardStatsCache);
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
  const { data: jobExceptions } = await getExceptions({ jobId, limit: MAX_QUERY_LIMIT });
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

export async function updateScheduledTask(id: number, data: Partial<InsertScheduledTask>) {
  const db = await getDb();
  if (!db) return;
  await db.update(scheduledTasks).set(data).where(eq(scheduledTasks.id, id));
}

export async function getScheduledTasks(userId: number, isAdmin: boolean) {
  const db = await getDb();
  if (!db) return [];
  if (isAdmin) {
    return db.select().from(scheduledTasks).orderBy(desc(scheduledTasks.createdAt)).limit(100);
  }
  return db.select().from(scheduledTasks)
    .where(eq(scheduledTasks.userId, userId))
    .orderBy(desc(scheduledTasks.createdAt))
    .limit(100);
}

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

export async function deleteScheduledTask(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(scheduledTasks).set({ isActive: false }).where(eq(scheduledTasks.id, id));
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

export async function getMonitoringStats(userId: number, isAdmin: boolean) {
  const db = await getDb();
  if (!db) return null;

  const jobCondition = !isAdmin ? eq(reconciliationJobs.userId, userId) : undefined;

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
    .where(!isAdmin ? eq(scheduledTasks.userId, userId) : undefined);

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

export async function getSftpCredentials(userId: number, organizationId?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  let conditions = [eq(sftpCredentials.userId, userId)];
  
  if (organizationId) {
    conditions.push(eq(sftpCredentials.organizationId, organizationId));
  }
  
  return db
    .select()
    .from(sftpCredentials)
    .where(and(...conditions))
    .orderBy(desc(sftpCredentials.createdAt));
}

export async function getSftpCredentialById(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const [cred] = await db
    .select()
    .from(sftpCredentials)
    .where(eq(sftpCredentials.id, id))
    .limit(1);
  
  return cred;
}

export async function updateSftpCredential(id: number, data: Partial<InsertSftpCredential>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db
    .update(sftpCredentials)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(sftpCredentials.id, id));
}

export async function deleteSftpCredential(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.delete(sftpCredentials).where(eq(sftpCredentials.id, id));
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
  
  let query = db.select().from(sftpIngestionLogs);
  
  if (params.credentialId) {
    query = query.where(eq(sftpIngestionLogs.sftpCredentialId, params.credentialId)) as any;
  }
  
  if (params.organizationId) {
    query = query.where(eq(sftpIngestionLogs.organizationId, params.organizationId)) as any;
  }
  
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

export async function getAnomalyScores(filters: {
  transactionId?: number;
  organizationId?: number;
  reviewStatus?: string;
  minScore?: number;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  
  let query = db.select().from(anomalyScores);
  
  if (filters.transactionId) {
    query = query.where(eq(anomalyScores.transactionId, filters.transactionId)) as any;
  }
  if (filters.organizationId) {
    query = query.where(eq(anomalyScores.organizationId, filters.organizationId)) as any;
  }
  if (filters.reviewStatus) {
    query = query.where(eq(anomalyScores.reviewStatus, filters.reviewStatus as any)) as any;
  }
  if (filters.minScore) {
    query = query.where(gte(anomalyScores.anomalyScore, String(filters.minScore))) as any;
  }
  
  const limit = Math.min(filters.limit || DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const offset = filters.offset || 0;
  
  return query.limit(limit).offset(offset).orderBy(desc(anomalyScores.anomalyScore));
}

export async function updateAnomalyReview(
  id: number,
  reviewData: {
    reviewStatus: string;
    reviewedBy: number;
    reviewNotes?: string;
  }
) {
  const db = await getDb();
  if (!db) return null;
  
  return db.update(anomalyScores)
    .set({
      ...reviewData,
      reviewedAt: new Date(),
    } as any)
    .where(eq(anomalyScores.id, id));
}

export async function getDetectionRules(organizationId?: number) {
  const db = await getDb();
  if (!db) return [];
  
  let query = db.select().from(detectionRules);
  
  if (organizationId) {
    query = query.where(eq(detectionRules.organizationId, organizationId)) as any;
  }
  
  return query.orderBy(desc(detectionRules.createdAt));
}

export async function createDetectionRule(rule: InsertDetectionRule) {
  const db = await getDb();
  if (!db) return null;
  
  return db.insert(detectionRules).values(rule);
}

export async function updateDetectionRule(id: number, updates: Partial<InsertDetectionRule>) {
  const db = await getDb();
  if (!db) return null;
  
  return db.update(detectionRules)
    .set(updates as any)
    .where(eq(detectionRules.id, id));
}

export async function deleteDetectionRule(id: number) {
  const db = await getDb();
  if (!db) return null;
  
  return db.delete(detectionRules).where(eq(detectionRules.id, id));
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
