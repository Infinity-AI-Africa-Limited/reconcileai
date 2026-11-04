/**
 * Duplicate retail exceptions: one case filed several times by a sync.
 *
 * SHOPLINE and Shopify reconcile inline (`runReconciliationOnPersistedData`).
 * They file what stays unmatched as exceptions with the synthetic `jobId` 0 and
 * the precise retail category in `subCategory`. Until #209, an unscoped sync
 * never looked for an exception it had already filed. So every sync that
 * re-read a window filed another copy for each row still unmatched, and a
 * merchant saw one case several times over, with counts, ageing and SLA
 * figures inflated by the copies.
 *
 * **What counts as a duplicate here.** Two or more inline-filed exceptions of
 * one tenant, for one transaction and one retail category, that are awaiting a
 * person at the same time. #209 refuses exactly that on every pass, whichever
 * rule is chosen for cases a person has decided. Of such copies, one is kept.
 * Every other copy no person has touched is dismissed, with a note naming the
 * copy kept. Nothing is deleted, and a dismissed copy can be reopened.
 *
 * **Never closed, only reported:**
 * - A copy someone has worked on: assigned, in review, escalated, annotated,
 *   diagnosed, drafted for, or enrolled in a governed workflow. A person
 *   decides between copies that each carry work.
 * - An open copy beside a DECIDED one. A settlement file may raise a case
 *   again after a person closed it, as new evidence, and nothing on the row
 *   says which path filed it.
 *
 * **Written directly, not through the exceptions router, on purpose.** Closing
 * a duplicate is not a resolution. The router's closure would teach the
 * exception intelligence flywheel that dismissing this category is the answer,
 * and would announce it to the tenant's webhooks. Reopening a copy closed here
 * retracts nothing, because no learning was recorded for it.
 *
 * Every read and write is scoped to one tenant, and each closure is recorded in
 * that tenant's audit chain in the same transaction as the change.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  agentActionDrafts,
  agentMemory,
  exceptions,
  exceptionWorkflows,
  organizations,
} from "../drizzle/schema";
import { createAuditLog, type DbExecutor, type DbTransaction, getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ExceptionStatus = (typeof exceptions.$inferSelect)["status"];

/** The synthetic job inline reconciliation files under (`raiseRetailExceptions`). */
export const INLINE_EXCEPTION_JOB_ID = 0;

/** Statuses that are still waiting for a person. */
const AWAITING_A_PERSON: readonly ExceptionStatus[] = ["open", "in_review", "escalated"];
const ID_CHUNK = 500;
/** Closures per transaction: bounds the locks held and the audit record's size. */
export const CLOSURES_PER_TRANSACTION = 200;
/**
 * A copy filed more recently than this means the source is still filing them:
 * closing them now would be undone by the next sync. Syncs re-read the last 24
 * hours, so once #209 is live the newest copy is at least that old.
 */
export const STILL_FILING_WINDOW_MS = 24 * 60 * 60_000;

export const DUPLICATE_AUDIT_ACTION = "close_duplicate_exceptions";

export interface DuplicateCandidate {
  id: number;
  organizationId: number;
  transactionId: number;
  subCategory: string;
  status: ExceptionStatus;
  createdAt: Date;
  /** Someone has worked on this copy (see `touched` in readDuplicateCandidates). */
  touched: boolean;
  /**
   * Dismissed by this maintenance: not a decision anyone made, and no longer a
   * copy to account for. Left out of every group, so a run after a commit
   * reports what is still outstanding, not its own work.
   */
  dismissedAsDuplicate: boolean;
}

export interface DuplicateGroupPlan {
  organizationId: number;
  transactionId: number;
  subCategory: string;
  /** The copy kept: null when no copy is awaiting a person. */
  keeperId: number | null;
  /** Untouched copies awaiting a person beside the keeper: dismissed. */
  close: number[];
  /** Copies awaiting a person beside the keeper that carry work: left for a person. */
  leftForPerson: number[];
  /** A decided copy sits beside one still awaiting a person. Reported only. */
  decidedBesideOpen: boolean;
}

const STATUS_RANK: Partial<Record<ExceptionStatus, number>> = { escalated: 2, in_review: 1, open: 0 };

/** The copy to keep: the most worked-on one, then the oldest. */
function keeperOrder(left: DuplicateCandidate, right: DuplicateCandidate): number {
  return (
    (STATUS_RANK[right.status] ?? 0) - (STATUS_RANK[left.status] ?? 0) ||
    Number(right.touched) - Number(left.touched) ||
    left.id - right.id
  );
}

/**
 * Which copies to close, per duplicate group. Pure.
 *
 * Rows are grouped by tenant, transaction and category; a group of one is not
 * a duplicate and is dropped.
 */
export function planDuplicateGroups(rows: readonly DuplicateCandidate[]): DuplicateGroupPlan[] {
  const groups = new Map<string, DuplicateCandidate[]>();
  for (const row of rows) {
    if (row.dismissedAsDuplicate) continue;
    const key = `${row.organizationId}\u0000${row.transactionId}\u0000${row.subCategory}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const plans: DuplicateGroupPlan[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [first] = group;
    const awaiting = group.filter((row) => AWAITING_A_PERSON.includes(row.status)).sort(keeperOrder);
    const decided = group.length - awaiting.length;
    const [keeper, ...others] = awaiting;
    const untouched = (row: DuplicateCandidate) => row.status === "open" && !row.touched;
    plans.push({
      organizationId: first.organizationId,
      transactionId: first.transactionId,
      subCategory: first.subCategory,
      keeperId: keeper?.id ?? null,
      close: others.filter(untouched).map((row) => row.id),
      leftForPerson: others.filter((row) => !untouched(row)).map((row) => row.id),
      decidedBesideOpen: decided > 0 && awaiting.length > 0,
    });
  }
  return plans.sort((left, right) => (left.keeperId ?? 0) - (right.keeperId ?? 0));
}

export interface TenantDuplicateSummary {
  organizationId: number;
  /** Groups of two or more copies of one case. */
  groups: number;
  /** Copies `--commit` would dismiss. */
  toClose: number;
  /** Groups where more than one copy awaiting a person carries work. */
  needPerson: number;
  /** Groups holding a decided copy beside one awaiting a person. Reported only. */
  decidedBesideOpen: number;
  /** When the newest copy that would be dismissed was filed. */
  newestToClose: Date | null;
}

export function summariseTenant(
  organizationId: number,
  candidates: readonly DuplicateCandidate[],
  plans: readonly DuplicateGroupPlan[],
): TenantDuplicateSummary {
  const closing = new Set(plans.flatMap((plan) => plan.close));
  const newest = candidates
    .filter((row) => closing.has(row.id))
    .reduce<Date | null>((latest, row) => (!latest || row.createdAt > latest ? row.createdAt : latest), null);
  return {
    organizationId,
    groups: plans.length,
    toClose: closing.size,
    needPerson: plans.filter((plan) => plan.leftForPerson.length > 0).length,
    decidedBesideOpen: plans.filter((plan) => plan.decidedBesideOpen).length,
    newestToClose: newest,
  };
}

/** Inline-filed retail exceptions of one tenant. */
function inlineRetail(organizationId: number) {
  return and(
    eq(exceptions.organizationId, organizationId),
    eq(exceptions.jobId, INLINE_EXCEPTION_JOB_ID),
    isNotNull(exceptions.subCategory),
  );
}

/** Every tenant holding at least one duplicate group, whatever its state. */
export async function tenantsWithDuplicateRetailExceptions(db: DbExecutor): Promise<number[]> {
  const keys = db
    .select({ organizationId: exceptions.organizationId })
    .from(exceptions)
    .where(and(eq(exceptions.jobId, INLINE_EXCEPTION_JOB_ID), isNotNull(exceptions.subCategory)))
    .groupBy(exceptions.organizationId, exceptions.transactionId, exceptions.subCategory)
    .having(sql`COUNT(*) > 1`)
    .as("duplicate_keys");
  const rows = await db.selectDistinct({ organizationId: keys.organizationId }).from(keys);
  return rows.map((row) => row.organizationId).sort((left, right) => left - right);
}

/**
 * Ids, among `ids`, that another table links work to.
 *
 * `lock`: when closing, every read is a locking read, taken after the copies'
 * own row locks. Two reasons:
 * - **Order.** It is the order a governed Start (exception, then workflow) and
 *   `superAgent.addMemory` (exception, then memory) take their locks. Either
 *   writer committed before this batch locked the copy, and is seen here, or it
 *   waits until the batch commits.
 * - **Freshness.** A locking read sees the latest committed rows. A plain read
 *   would not on TiDB: it answers from the snapshot taken when the transaction
 *   began, which can predate a writer that committed while this batch waited
 *   for its locks.
 */
async function linkedIds(db: DbExecutor, organizationId: number, ids: number[], lock: boolean): Promise<Set<number>> {
  const linked = new Set<number>();
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    const chunk = ids.slice(index, index + ID_CHUNK);
    const reads = [
      db
        .select({ id: exceptionWorkflows.exceptionId })
        .from(exceptionWorkflows)
        .where(and(eq(exceptionWorkflows.organizationId, organizationId), inArray(exceptionWorkflows.exceptionId, chunk))),
      db
        .select({ id: agentActionDrafts.exceptionId })
        .from(agentActionDrafts)
        .where(and(eq(agentActionDrafts.organizationId, organizationId), inArray(agentActionDrafts.exceptionId, chunk))),
      db
        .select({ id: agentMemory.exceptionId })
        .from(agentMemory)
        .where(and(eq(agentMemory.organizationId, organizationId), inArray(agentMemory.exceptionId, chunk))),
    ];
    // One after another, so the locks are taken in a fixed order.
    for (const read of reads) {
      for (const row of await (lock ? read.for("update") : read)) if (row.id !== null) linked.add(row.id);
    }
  }
  return linked;
}

const CANDIDATE_FIELDS = {
  id: exceptions.id,
  organizationId: exceptions.organizationId,
  transactionId: exceptions.transactionId,
  subCategory: exceptions.subCategory,
  status: exceptions.status,
  createdAt: exceptions.createdAt,
  assignedTo: exceptions.assignedTo,
  resolvedBy: exceptions.resolvedBy,
  resolutionNotes: exceptions.resolutionNotes,
  aiAnalysis: exceptions.aiAnalysis,
  cbsVerificationNote: exceptions.cbsVerificationNote,
} as const;

type CandidateRow = {
  id: number;
  organizationId: number;
  transactionId: number;
  subCategory: string | null;
  status: ExceptionStatus;
  createdAt: Date;
  assignedTo: number | null;
  resolvedBy: number | null;
  resolutionNotes: string | null;
  aiAnalysis: string | null;
  cbsVerificationNote: string | null;
};

/** Work on the row itself: an assignee, a person's decision or note, a diagnosis. */
function carriesWork(row: CandidateRow): boolean {
  return (
    row.assignedTo !== null ||
    row.resolvedBy !== null ||
    row.resolutionNotes !== null ||
    row.aiAnalysis !== null ||
    row.cbsVerificationNote !== null
  );
}

function toCandidates(rows: CandidateRow[], linked: Set<number>): DuplicateCandidate[] {
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    transactionId: row.transactionId,
    subCategory: row.subCategory ?? "",
    status: row.status,
    createdAt: row.createdAt,
    touched: carriesWork(row) || linked.has(row.id),
    // Only this maintenance dismisses with no person named: the exceptions
    // router always records who closed a case.
    dismissedAsDuplicate:
      row.status === "dismissed" &&
      row.resolvedBy === null &&
      (row.resolutionNotes ?? "").startsWith(DUPLICATE_NOTE_PREFIX),
  }));
}

/** Every copy in one tenant's duplicate groups, with whether it carries work. */
export async function readDuplicateCandidates(db: DbExecutor, organizationId: number): Promise<DuplicateCandidate[]> {
  const keys = db
    .select({ transactionId: exceptions.transactionId, subCategory: exceptions.subCategory })
    .from(exceptions)
    .where(inlineRetail(organizationId))
    .groupBy(exceptions.transactionId, exceptions.subCategory)
    .having(sql`COUNT(*) > 1`)
    .as("duplicate_keys");
  const rows = await db
    .select(CANDIDATE_FIELDS)
    .from(exceptions)
    .innerJoin(
      keys,
      and(eq(exceptions.transactionId, keys.transactionId), eq(exceptions.subCategory, keys.subCategory)),
    )
    .where(inlineRetail(organizationId));
  const linked = await linkedIds(db, organizationId, rows.map((row) => row.id), false);
  return toCandidates(rows, linked);
}

/**
 * One tenant's duplicates: reads only.
 *
 * Not in a READ ONLY transaction, deliberately. Drizzle sends that as
 * `START TRANSACTION READ ONLY`, which MySQL (CI) accepts and TiDB
 * (production) refuses: TiDB raises ErrFunctionsNoopImpl("READ ONLY") unless
 * `tidb_enable_noop_functions` is on, and it is OFF by default. It would pass
 * every test and fail on the one database it is for. readOnlyTransactionRatchet
 * keeps the construct out of the codebase.
 */
export async function measureTenantDuplicates(
  db: DbExecutor,
  organizationId: number,
): Promise<{ summary: TenantDuplicateSummary; plans: DuplicateGroupPlan[] }> {
  const candidates = await readDuplicateCandidates(db, organizationId);
  const plans = planDuplicateGroups(candidates);
  return { summary: summariseTenant(organizationId, candidates, plans), plans };
}

const DUPLICATE_NOTE_PREFIX = "Duplicate of exception #";

export function duplicateNote(keeperId: number, now: Date): string {
  return (
    `${DUPLICATE_NOTE_PREFIX}${keeperId}: the same transaction and category, filed again by a sync ` +
    `before the fix in #209. Dismissed by maintenance on ${now.toISOString().slice(0, 10)}; ` +
    "reopen it if this is wrong."
  );
}

export interface CloseDuplicatesResult {
  organizationId: number;
  closed: number;
  /** Planned closures that no longer qualified under lock: someone acted first. */
  skipped: number;
  /** Groups left for a person, and groups with a decided copy, as measured. */
  needPerson: number;
  decidedBesideOpen: number;
}

export class DuplicatesStillBeingFiledError extends Error {
  constructor(readonly organizationId: number, readonly newest: Date) {
    super(
      `Organisation ${organizationId}: a duplicate was filed at ${newest.toISOString()}, less than 24 hours ago. ` +
        "The source is still filing them, so closing them now would be undone by the next sync. " +
        "Deploy the fix (#209), wait 24 hours, then run again.",
    );
    this.name = "DuplicatesStillBeingFiledError";
  }
}

export interface CloseDuplicatesDeps {
  now?: () => Date;
  /** Test-only checkpoint between planning and the closing transaction. */
  afterPlan?: (plans: readonly DuplicateGroupPlan[]) => Promise<void> | void;
  /** Test-only checkpoint inside a batch, once its copies are locked. */
  afterLock?: () => Promise<void> | void;
}

/**
 * Close one tenant's untouched duplicate copies.
 *
 * Planned from a plain read, then applied in transactions of at most
 * CLOSURES_PER_TRANSACTION closures. Each one locks the copies and their
 * keepers, re-checks under the lock that each copy is still open, untouched
 * and the same case as its keeper, dismisses only those, and appends one audit
 * record listing them to the tenant's chain before it commits. A copy someone
 * acted on in between is skipped, never overwritten.
 */
export async function closeTenantDuplicates(
  db: Db,
  organizationId: number,
  deps: CloseDuplicatesDeps = {},
): Promise<CloseDuplicatesResult> {
  const now = (deps.now ?? (() => new Date()))();
  const candidates = await readDuplicateCandidates(db, organizationId);
  const plans = planDuplicateGroups(candidates);
  const summary = summariseTenant(organizationId, candidates, plans);
  if (summary.newestToClose && now.getTime() - summary.newestToClose.getTime() < STILL_FILING_WINDOW_MS) {
    throw new DuplicatesStillBeingFiledError(organizationId, summary.newestToClose);
  }
  await deps.afterPlan?.(plans);

  const closures = plans.flatMap((plan) =>
    plan.keeperId === null ? [] : plan.close.map((id) => ({ id, keeperId: plan.keeperId as number })),
  );
  let closed = 0;
  for (let index = 0; index < closures.length; index += CLOSURES_PER_TRANSACTION) {
    const batch = closures.slice(index, index + CLOSURES_PER_TRANSACTION);
    closed += await db.transaction((tx) => closeBatch(tx, organizationId, batch, now, deps.afterLock));
  }
  return {
    organizationId,
    closed,
    skipped: closures.length - closed,
    needPerson: summary.needPerson,
    decidedBesideOpen: summary.decidedBesideOpen,
  };
}

async function closeBatch(
  tx: DbTransaction,
  organizationId: number,
  batch: Array<{ id: number; keeperId: number }>,
  now: Date,
  afterLock?: () => Promise<void> | void,
): Promise<number> {
  const ids = [...new Set(batch.flatMap((closure) => [closure.id, closure.keeperId]))].sort((left, right) => left - right);
  const locked = await tx
    .select(CANDIDATE_FIELDS)
    .from(exceptions)
    .where(and(inlineRetail(organizationId), inArray(exceptions.id, ids)))
    .orderBy(exceptions.id)
    .for("update");
  await afterLock?.();
  const linked = await linkedIds(tx, organizationId, batch.map((closure) => closure.id), true);
  const byId = new Map(toCandidates(locked, linked).map((row) => [row.id, row]));

  const stillQualifies = ({ id, keeperId }: { id: number; keeperId: number }) => {
    const copy = byId.get(id);
    const keeper = byId.get(keeperId);
    return (
      copy !== undefined &&
      keeper !== undefined &&
      copy.status === "open" &&
      !copy.touched &&
      // The kept copy must still be awaiting a person. If someone closed it
      // after the plan, this copy now sits beside a decided one: a pair the
      // plan reports and never dismisses (Greptile, #222).
      AWAITING_A_PERSON.includes(keeper.status) &&
      copy.transactionId === keeper.transactionId &&
      copy.subCategory === keeper.subCategory
    );
  };
  const byKeeper = new Map<number, number[]>();
  for (const closure of batch.filter(stillQualifies)) {
    byKeeper.set(closure.keeperId, [...(byKeeper.get(closure.keeperId) ?? []), closure.id]);
  }

  let closed = 0;
  const closedPairs: Array<{ id: number; keeperId: number }> = [];
  for (const [keeperId, copyIds] of byKeeper) {
    // The WHERE repeats the checks just made under the lock, so this write can
    // only ever dismiss a copy that is open and carries no work on its row.
    const [result] = await tx
      .update(exceptions)
      .set({ status: "dismissed", resolvedAt: now, resolvedBy: null, resolutionNotes: duplicateNote(keeperId, now) })
      .where(
        and(
          inlineRetail(organizationId),
          inArray(exceptions.id, copyIds),
          eq(exceptions.status, "open"),
          isNull(exceptions.assignedTo),
          isNull(exceptions.resolvedBy),
          isNull(exceptions.resolutionNotes),
          isNull(exceptions.aiAnalysis),
          isNull(exceptions.cbsVerificationNote),
        ),
      );
    const affected = Number((result as { affectedRows?: number }).affectedRows ?? 0);
    if (affected !== copyIds.length) {
      // Every row was checked under its lock a moment ago; a mismatch means the
      // lock did not hold. Roll the whole batch back rather than guess.
      throw new Error(`Expected to dismiss ${copyIds.length} copies of #${keeperId}, dismissed ${affected}`);
    }
    closed += affected;
    closedPairs.push(...copyIds.map((id) => ({ id, keeperId })));
  }

  if (closed > 0) {
    await createAuditLog(
      {
        userId: null,
        organizationId,
        action: DUPLICATE_AUDIT_ACTION,
        entityType: "exception",
        details: JSON.stringify({
          reason: "Duplicate copies of one case, filed again by a sync before #209",
          dismissed: closedPairs,
        }),
        ipAddress: null,
        userAgent: "scripts/close-duplicate-retail-exceptions.ts",
      },
      tx,
    );
  }
  return closed;
}

/** A tenant's code, to tell demo and dev tenants apart in the report. */
export async function organizationCodes(db: DbExecutor, ids: number[]): Promise<Map<number, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: organizations.id, code: organizations.code })
    .from(organizations)
    .where(inArray(organizations.id, ids));
  return new Map(rows.map((row) => [row.id, row.code]));
}
