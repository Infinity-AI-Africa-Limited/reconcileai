import { eq, and, gte, lte, like, or, desc, asc, sql, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
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
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
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
    else if (user.openId === ENV.ownerOpenId) { values.role = 'admin'; updateSet.role = 'admin'; }
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

export async function getAllUsers() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).orderBy(desc(users.createdAt));
}

export async function updateUserRole(userId: number, role: "user" | "admin") {
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

export async function createChannel(data: InsertChannel) {
  const db = await getDb();
  if (!db) return;
  await db.insert(channels).values(data);
}

// ─── Upload Batches ──────────────────────────────────────────────────

export async function createUploadBatch(data: InsertUploadBatch) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(uploadBatches).values(data);
  return result[0].insertId;
}

export async function updateUploadBatch(id: number, data: Partial<InsertUploadBatch>) {
  const db = await getDb();
  if (!db) return;
  await db.update(uploadBatches).set(data).where(eq(uploadBatches.id, id));
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
  // Insert in batches of 100
  for (let i = 0; i < txns.length; i += 100) {
    const batch = txns.slice(i, i + 100);
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
    conditions.push(
      or(
        like(transactions.transactionRef, `%${filters.search}%`),
        like(transactions.description, `%${filters.search}%`),
        like(transactions.counterparty, `%${filters.search}%`)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const data = await db.select().from(transactions)
    .where(whereClause)
    .orderBy(desc(transactions.transactionDate))
    .limit(limit)
    .offset(offset);

  const countResult = await db.select({ count: sql<number>`count(*)` }).from(transactions).where(whereClause);
  const total = Number(countResult[0]?.count || 0);

  return { data, total };
}

export async function getTransactionsByIds(ids: number[]) {
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  return db.select().from(transactions).where(inArray(transactions.id, ids));
}

export async function updateTransactionStatus(id: number, status: string, matchId?: number) {
  const db = await getDb();
  if (!db) return;
  const updateData: any = { status };
  if (matchId !== undefined) updateData.matchId = matchId;
  await db.update(transactions).set(updateData).where(eq(transactions.id, id));
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

// ─── Matches ─────────────────────────────────────────────────────────

export async function insertMatch(data: InsertMatch) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(matches).values(data);
  return result[0].insertId;
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

export async function getExceptions(filters: {
  jobId?: number;
  status?: string;
  category?: string;
  severity?: string;
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

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

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

// ─── Audit Logs ──────────────────────────────────────────────────────

export async function createAuditLog(data: InsertAuditLog) {
  const db = await getDb();
  if (!db) return;
  await db.insert(auditLogs).values(data);
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
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

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

// ─── Dashboard Stats ─────────────────────────────────────────────────

export async function getDashboardStats(userId: number, isAdmin: boolean) {
  const db = await getDb();
  if (!db) return null;

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

  const channelStats = await db.select({
    channelId: transactions.channelId,
    total: sql<number>`count(*)`,
    matched: sql<number>`sum(case when ${transactions.status} = 'matched' or ${transactions.status} = 'manually_matched' then 1 else 0 end)`,
    unmatched: sql<number>`sum(case when ${transactions.status} = 'unmatched' then 1 else 0 end)`,
  }).from(transactions).where(userCondition).groupBy(transactions.channelId);

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
    channelStats,
  };
}
