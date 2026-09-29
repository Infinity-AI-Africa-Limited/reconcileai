/**
 * Committing a SHOPLINE settlement file: one transaction, one writer per store.
 *
 * The import used to run as separate statements: an order-level dedupe read,
 * an insert, then a reconciliation over a date window. Four defects followed
 * from that shape, and each is closed here:
 *
 * 1. **Distinct settlement events were dropped.** The dedupe keyed on
 *    `(channel, transactionRef)`, and `transactionRef` is the ORDER reference
 *    (the join key). A payment and its refund, or two partial settlements, for
 *    one order collapsed into one, and a refund imported in a later file than
 *    its payment was silently discarded as a "duplicate". File-imported rows
 *    are now compared by settlement EVENT (`settlementEventKey`), as a multiset.
 * 2. **Concurrent imports could double-insert.** Two overlapping uploads could
 *    both pass the dedupe read before either inserted. The store row is now
 *    locked first, and the existing rows are read under that lock with a
 *    LOCKING read (TiDB answers a plain read from the snapshot taken when the
 *    transaction began, which can predate the other import's commit).
 * 3. **Partial imports flagged unrelated orders.** Reconciliation ran over a
 *    ±3-day window for EVERY unmatched order, raising exceptions for orders
 *    whose evidence simply had not been uploaded yet, and again on every later
 *    import. It is now scoped to the orders this file speaks to, and skips an
 *    exception already open for the same transaction and category.
 * 4. **References compared in the wrong form.** Insert sanitises
 *    `transactionRef` (`#1001` is stored as `1001`), but the dedupe compared the
 *    file's raw text, so re-uploading such a file inserted every row again.
 *    Everything is now compared in its stored form.
 *
 * What is deliberately NOT changed: an order that already has settlement
 * evidence from the SHOPLINE API sync (a SHOPLINE Payments merchant) keeps the
 * old order-level protection. Those rows share the payments channel, key the
 * same order, and carry a different provenance, so an event comparison would
 * never recognise a file row as the same money — the API is the record for
 * that order and the file's rows for it are skipped, exactly as before.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { slConnectorStores } from "../../../drizzle/connector_schema";
import { transactions, uploadBatches, type InsertTransaction } from "../../../drizzle/schema";
import { getDb, insertTransactionsWithExecutor, sanitizeRef, type DbExecutor } from "../../db";
import { selectUnimportedSettlementEvents, settlementEventKey } from "./settlementFileImport";
import { runReconciliationOnPersistedData } from "./syncOrchestrator";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Each settled row may sit this far from its order and still be matched. */
const RECONCILIATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const REFERENCE_LOOKUP_CHUNK = 500;

export interface ShoplineSettlementCommitParams {
  organizationId: number;
  storeId: number;
  ordersChannelId: number;
  paymentsChannelId: number;
  batchId: number;
  /** Mapped rows, as `mapSettlementRows` produced them. */
  rows: InsertTransaction[];
  /** Rows the mapper already refused; recorded on the batch. */
  mappingFailures: Array<{ rowIndex: number; reason: string }>;
  currency: string;
}

export interface ShoplineSettlementCommitResult {
  imported: number;
  /** Already recorded: the same event from an earlier file, or an order the API sync has settled. */
  duplicates: number;
  /**
   * Of `duplicates`, the rows that matched an earlier file's event WITHOUT a
   * gateway transaction ID to prove it — see unverifiableDuplicatesNote().
   */
  unverifiableDuplicates: number;
  failures: Array<{ rowIndex: number; reason: string }>;
  matchedCount: number;
  exceptionCount: number;
}

export interface ShoplineSettlementCommitDeps {
  reconcile?: typeof runReconciliationOnPersistedData;
}

/**
 * Why a skipped row without a transaction ID is reported rather than decided.
 *
 * With no gateway transaction ID, a settlement is identified only by its order,
 * direction, amount, currency and date. Two exports that overlap — 1–15 Sept,
 * then 10–30 Sept — repeat those rows exactly, and that is the case the dedupe
 * exists for: importing them would double-count every overlap. But a genuinely
 * separate same-amount, same-day settlement for the same order, arriving in a
 * later file, looks identical and cannot be told apart. (Within ONE file both
 * are kept: an export does not repeat a line.) So such rows are skipped, as the
 * far more common case requires — and COUNTED, so the merchant is told, with
 * the remedy, instead of the difference vanishing.
 */
export function unverifiableDuplicatesNote(count: number): string | null {
  if (count === 0) return null;
  return (
    `${count} row${count === 1 ? "" : "s"} matched settlements already imported and carr${count === 1 ? "ies" : "y"} no ` +
    "transaction ID to tell them apart, so they were skipped. If they are separate settlements, " +
    "re-export the file with its transaction ID column and import it again."
  );
}

function gatewayRefOf(rawData: unknown): string {
  const value = (rawData as { gatewayRef?: unknown } | null)?.gatewayRef;
  return typeof value === "string" ? value.trim() : "";
}

/** A row imported from a settlement file carries its source label; an API-synced row never does. */
function isSettlementFileRow(rawData: unknown): boolean {
  let value = rawData;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  const importedFrom = (value as { importedFrom?: unknown } | null)?.importedFrom;
  return typeof importedFrom === "string" && importedFrom.length > 0;
}

/**
 * Serialise imports for one store and refuse one that stopped being active
 * since the request began. Must be the transaction's first statement.
 */
async function lockStoreForImport(tx: DbExecutor, organizationId: number, storeId: number): Promise<void> {
  const [locked] = await tx
    .select({ id: slConnectorStores.id })
    .from(slConnectorStores)
    .where(
      and(
        eq(slConnectorStores.id, storeId),
        eq(slConnectorStores.organizationId, organizationId),
        eq(slConnectorStores.status, "active"),
      ),
    )
    .limit(1)
    .for("update");
  if (!locked) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active SHOPLINE store for this organisation" });
  }
}

/** Existing payment-leg rows for these references, read under the store lock. */
async function lockExistingSettlementRows(
  tx: DbExecutor,
  organizationId: number,
  paymentsChannelId: number,
  refs: string[],
) {
  const rows: Array<Pick<InsertTransaction, "transactionRef" | "amount" | "debitCredit" | "currency" | "valueDate" | "rawData">> = [];
  for (let index = 0; index < refs.length; index += REFERENCE_LOOKUP_CHUNK) {
    const chunk = refs.slice(index, index + REFERENCE_LOOKUP_CHUNK);
    rows.push(
      ...(await tx
        .select({
          transactionRef: transactions.transactionRef,
          amount: transactions.amount,
          debitCredit: transactions.debitCredit,
          currency: transactions.currency,
          valueDate: transactions.valueDate,
          rawData: transactions.rawData,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, organizationId),
            eq(transactions.channelId, paymentsChannelId),
            inArray(transactions.transactionRef, chunk),
          ),
        )
        .for("update")),
    );
  }
  return rows;
}

export async function commitShoplineSettlementFile(
  db: Db,
  params: ShoplineSettlementCommitParams,
  deps: ShoplineSettlementCommitDeps = {},
): Promise<ShoplineSettlementCommitResult> {
  return db.transaction(async (tx) => {
    await lockStoreForImport(tx, params.organizationId, params.storeId);

    // Compare, scope and store references in the form insert will store them.
    const failures = [...params.mappingFailures];
    const stored: InsertTransaction[] = params.rows.map((row) => {
      const transactionRef = sanitizeRef(row.transactionRef);
      // mapSettlementRows refuses these, at their row; one reaching here is a bug.
      if (!transactionRef) throw new Error("Settlement row reached commit without a usable order reference");
      return { ...row, transactionRef, externalRef: sanitizeRef(row.externalRef) };
    });

    const refs = [...new Set(stored.map((row) => row.transactionRef as string))];
    const existing = await lockExistingSettlementRows(tx, params.organizationId, params.paymentsChannelId, refs);

    // An order the API sync has settled keeps the order-level protection; every
    // other existing row is a file event, compared by event.
    const settledBySync = new Set<string>();
    const fileEvents: string[] = [];
    for (const row of existing) {
      if (isSettlementFileRow(row.rawData)) fileEvents.push(settlementEventKey(row));
      else if (row.transactionRef) settledBySync.add(row.transactionRef);
    }
    const candidates = stored.filter((row) => !settledBySync.has(row.transactionRef as string));
    const fresh = selectUnimportedSettlementEvents(fileEvents, candidates, settlementEventKey);
    const kept = new Set(fresh);
    const unverifiableDuplicates = candidates.filter((row) => !kept.has(row) && !gatewayRefOf(row.rawData)).length;

    await insertTransactionsWithExecutor(tx, fresh);

    let matchedCount = 0;
    let exceptionCount = 0;
    if (fresh.length > 0) {
      const times = fresh.map((row) => new Date(row.transactionDate as Date).getTime());
      const result = await (deps.reconcile ?? runReconciliationOnPersistedData)(
        tx,
        params.organizationId,
        params.ordersChannelId,
        params.paymentsChannelId,
        new Date(Math.min(...times) - RECONCILIATION_WINDOW_MS),
        new Date(Math.max(...times) + RECONCILIATION_WINDOW_MS),
        params.currency,
        // Only the orders this file speaks to: an order whose evidence is in a
        // file not yet imported must not be flagged for its absence.
        { orderRefs: [...new Set(fresh.map((row) => row.transactionRef as string))] },
      );
      matchedCount = result.matchedCount;
      exceptionCount = result.exceptionCount;
    }

    await tx
      .update(uploadBatches)
      .set({
        status: "completed",
        validRows: fresh.length,
        invalidRows: failures.length,
        completedAt: new Date(),
        errorMessage:
          [
            failures.length > 0 ? failures.slice(0, 10).map((f) => `row ${f.rowIndex}: ${f.reason}`).join("; ") : null,
            unverifiableDuplicatesNote(unverifiableDuplicates),
          ]
            .filter(Boolean)
            .join(" ") || null,
      })
      .where(and(eq(uploadBatches.id, params.batchId), eq(uploadBatches.organizationId, params.organizationId)));

    return {
      imported: fresh.length,
      duplicates: stored.length - fresh.length,
      unverifiableDuplicates,
      failures,
      matchedCount,
      exceptionCount,
    };
  });
}
