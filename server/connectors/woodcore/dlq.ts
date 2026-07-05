/**
 * Dead-letter queue for failed connector work — DB-backed (no Redis; BullMQ is
 * a deferred tech-debt item, and the DLQ must also work in air-gapped installs).
 *
 * Lifecycle: pending → retrying → resolved | exhausted | discarded
 *  - Exponential backoff with jitter between attempts (1m base, 6h cap).
 *  - `exhausted` items stay visible on the dashboard for manual replay.
 *  - Replay resets the attempt budget and retries immediately.
 */
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  wcConnectorDeadLetters,
  type WcConnectorDeadLetter,
} from "../../../drizzle/connector_schema";
import { getDb } from "../../db";

export type DlqSource = "webhook" | "batch_sync" | "mapping" | "api_call" | "write_back";

/** 60s · 2^attempts with ±20% jitter, capped at 6 hours. */
export function computeNextRetryMs(attempts: number, rand: () => number = Math.random): number {
  const base = Math.min(60_000 * 2 ** attempts, 6 * 60 * 60_000);
  const jitter = base * 0.2 * (rand() * 2 - 1);
  return Math.round(base + jitter);
}

export async function enqueueDeadLetter(input: {
  configId: number;
  organizationId: number;
  source: DlqSource;
  refType?: string;
  refId?: string;
  payload?: unknown;
  error: string;
  maxAttempts?: number;
}): Promise<number | null> {
  const db = await getDb();
  if (!db) {
    console.error("[wc-dlq] DB unavailable; dropping dead letter:", input.error);
    return null;
  }
  const result = await db.insert(wcConnectorDeadLetters).values({
    configId: input.configId,
    organizationId: input.organizationId,
    source: input.source,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    payload: input.payload ?? null,
    error: input.error.slice(0, 4000),
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 5,
    nextRetryAt: new Date(Date.now() + computeNextRetryMs(0)),
    status: "pending",
  });
  return Number((result as unknown as [{ insertId: number }])[0]?.insertId ?? 0) || null;
}

/** A handler retries one dead letter; throw to signal the attempt failed. */
export type DlqHandler = (letter: WcConnectorDeadLetter) => Promise<void>;

export interface DlqProcessResult {
  processed: number;
  resolved: number;
  failedAgain: number;
  exhausted: number;
}

/**
 * Retry all due dead letters. Called by the scheduled connector tick and by
 * manual "Retry now" on the dashboard.
 */
export async function processDueDeadLetters(
  handlers: Partial<Record<DlqSource, DlqHandler>>,
  opts: { limit?: number; configId?: number } = {},
): Promise<DlqProcessResult> {
  const db = await getDb();
  const out: DlqProcessResult = { processed: 0, resolved: 0, failedAgain: 0, exhausted: 0 };
  if (!db) return out;

  const due = await db
    .select()
    .from(wcConnectorDeadLetters)
    .where(
      and(
        inArray(wcConnectorDeadLetters.status, ["pending", "retrying"]),
        or(
          isNull(wcConnectorDeadLetters.nextRetryAt),
          lte(wcConnectorDeadLetters.nextRetryAt, new Date()),
        ),
        ...(opts.configId ? [eq(wcConnectorDeadLetters.configId, opts.configId)] : []),
      ),
    )
    .orderBy(wcConnectorDeadLetters.nextRetryAt)
    .limit(opts.limit ?? 50);

  for (const letter of due) {
    out.processed++;
    const handler = handlers[letter.source];
    const attempts = letter.attempts + 1;
    try {
      if (!handler) throw new Error(`no retry handler registered for source "${letter.source}"`);
      await handler(letter);
      await db
        .update(wcConnectorDeadLetters)
        .set({ status: "resolved", resolvedAt: new Date(), lastAttemptAt: new Date(), attempts })
        .where(eq(wcConnectorDeadLetters.id, letter.id));
      out.resolved++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isExhausted = attempts >= letter.maxAttempts;
      await db
        .update(wcConnectorDeadLetters)
        .set({
          status: isExhausted ? "exhausted" : "retrying",
          attempts,
          lastAttemptAt: new Date(),
          nextRetryAt: isExhausted ? null : new Date(Date.now() + computeNextRetryMs(attempts)),
          error: sql`CONCAT(LEFT(${wcConnectorDeadLetters.error}, 2000), ${"\n--- attempt " + attempts + ": " + msg.slice(0, 1500)})`,
        })
        .where(eq(wcConnectorDeadLetters.id, letter.id));
      if (isExhausted) out.exhausted++;
      else out.failedAgain++;
    }
  }
  return out;
}

/** Manual replay from the dashboard: reset budget, make due immediately. */
export async function replayDeadLetter(id: number, organizationId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .select()
    .from(wcConnectorDeadLetters)
    .where(and(eq(wcConnectorDeadLetters.id, id), eq(wcConnectorDeadLetters.organizationId, organizationId)))
    .limit(1);
  const letter = rows[0];
  if (!letter || letter.status === "resolved") return false;
  await db
    .update(wcConnectorDeadLetters)
    .set({ status: "pending", attempts: 0, nextRetryAt: new Date(), resolutionNote: "manual replay" })
    .where(eq(wcConnectorDeadLetters.id, id));
  return true;
}

/** Manual discard (e.g. known-bad payload) — keeps the row for audit. */
export async function discardDeadLetter(id: number, organizationId: number, note: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const res = await db
    .update(wcConnectorDeadLetters)
    .set({ status: "discarded", resolutionNote: note.slice(0, 1000), resolvedAt: new Date() })
    .where(and(eq(wcConnectorDeadLetters.id, id), eq(wcConnectorDeadLetters.organizationId, organizationId)));
  return Number((res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0) > 0;
}
