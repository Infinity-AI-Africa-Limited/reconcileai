import { and, eq } from "drizzle-orm";
import { agentMemory, exceptions, transactions } from "../drizzle/schema";
import { getDb } from "./db";
import { loggableError } from "./dbErrors";

export type ExceptionClosure = {
  /** The tenant whose exception closed. Learning is skipped without one. */
  organizationId: number | null;
  exceptionId: number;
  userId: number;
  outcome: "resolved" | "dismissed";
  resolutionNotes: string | null;
};

/**
 * What every exception closure does once it has COMMITTED, whichever path
 * closed it (the legacy `exceptions.resolve` or a governed workflow):
 *   - the per-institution learning record (`agentMemory`) and the anonymised
 *     cross-institution signature (`recordLocalSignature`);
 *   - the `exception.resolved` webhook.
 * One helper, so a governed closure cannot quietly drop them again.
 *
 * Fire-and-forget for callers: it never throws and never delays the response.
 * The returned promise settles when both effects have, which tests await.
 */
export function afterExceptionClosed(closure: ExceptionClosure): Promise<void> {
  return Promise.allSettled([
    captureResolutionLearning(closure).catch(error =>
      console.warn("[exception-closure] learning capture failed (best-effort)", loggableError(error))
    ),
    notifyResolved(closure).catch(error =>
      console.warn("[exception-closure] webhook dispatch failed (best-effort)", loggableError(error))
    ),
  ]).then(() => undefined);
}

/**
 * Learn from the closure. The exception is read WITHIN the closing tenant:
 * the legacy route read it by id alone, so a caller naming another tenant's
 * exception id (which its scoped update then left untouched) had that
 * tenant's category, amount band and transaction reference filed into their
 * own learning data.
 */
async function captureResolutionLearning(closure: ExceptionClosure): Promise<void> {
  const { organizationId, exceptionId, userId, outcome, resolutionNotes } = closure;
  if (!organizationId) return;
  const db = await getDb();
  if (!db) return;
  const [row] = await db
    .select({
      category: exceptions.category,
      description: exceptions.description,
      amount: transactions.amount,
      counterparty: transactions.counterparty,
      transactionRef: transactions.transactionRef,
    })
    .from(exceptions)
    .innerJoin(transactions, eq(exceptions.transactionId, transactions.id))
    .where(and(eq(exceptions.id, exceptionId), eq(exceptions.organizationId, organizationId)))
    .limit(1);
  if (!row) return;

  const amount = parseFloat(String(row.amount)) || 0;
  const amountRange: "0-100k" | "100k-1m" | "1m+" = amount < 100_000 ? "0-100k" : amount < 1_000_000 ? "100k-1m" : "1m+";
  const intelligence = await import("./exceptionIntelligence");
  const counterpartyType = intelligence.counterpartyTypeOf(row.counterparty);
  const resolution = resolutionNotes || "Exception resolved";
  const actionClass = intelligence.classifyResolutionAction(resolution);
  const learnedOutcome: "resolved" | "rejected" = outcome === "resolved" ? "resolved" : "rejected";
  await db.insert(agentMemory).values({
    organizationId,
    exceptionId,
    exceptionCategory: row.category,
    transactionRef: row.transactionRef ?? null,
    amountRange,
    counterpartyType,
    deductionType: null,
    resolution,
    outcome: learnedOutcome,
    reasoning: row.description || "Exception resolved by operations team",
    embeddingText: `category:${row.category} amount:${amountRange} counterparty:${counterpartyType} resolution:${actionClass} outcome:${learnedOutcome}`,
    resolvedBy: userId,
  });
  // Also feed the anonymised cross-institution pool.
  const signature = intelligence.deriveSignature({
    exceptionCategory: row.category,
    amount,
    counterparty: row.counterparty,
    resolution,
    outcome: learnedOutcome,
  });
  await intelligence.recordLocalSignature(organizationId, signature);
}

/** The same event, with the same payload, the legacy route always sent. */
async function notifyResolved(closure: ExceptionClosure): Promise<void> {
  const { dispatchWebhookEvent } = await import("./webhookDelivery");
  await dispatchWebhookEvent("exception.resolved", {
    exceptionId: closure.exceptionId,
    status: closure.outcome,
  });
}
