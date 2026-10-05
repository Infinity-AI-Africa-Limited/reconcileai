/**
 * What the job queues are actually doing, in the states `/api/health` and the
 * corporate-B2B pilot gate both report. One function, so the two cannot drift:
 * until it existed each kept its own copy of the rule, and a test kept a third.
 *
 *   confirmed             every queue is on BullMQ AND answered a count read
 *   unreachable           every queue is on BullMQ, but Redis did not answer a
 *                         count read: durability is not currently proven
 *   configured_unverified REDIS_URL is set but no queue has been built, so a
 *                         wrong or unreachable URL looks the same. Not evidence
 *   fallback              in-process; queued work is lost on restart
 *
 * `durable` means CONFIRMED and nothing else. Being built on BullMQ is not
 * enough: a queue whose Redis stopped answering reports `durable: true` with an
 * error, and until 2026-10-05 that was read as confirmed, so the endpoint could
 * claim durability while reporting the queue error beside it.
 */
import type { QueueStats } from "./jobQueue";

export type QueueDurability = "confirmed" | "unreachable" | "configured_unverified" | "fallback";

export interface QueueDurabilityReport {
  durable: boolean;
  durability: QueueDurability;
  /** `error` for a broken dependency, `degraded` for an accepted non-durable state. */
  status: "ok" | "degraded" | "error";
}

export function classifyQueueDurability(
  queues: Record<string, Pick<QueueStats, "durable" | "error">>,
  redisUrl: string | undefined,
): QueueDurabilityReport {
  const names = Object.keys(queues);
  const broken = names.some((name) => Boolean(queues[name].error));
  if (names.length === 0) {
    return { durable: false, durability: redisUrl?.trim() ? "configured_unverified" : "fallback", status: "degraded" };
  }
  // One in-process queue means work in THAT queue is lost on restart, whatever the others do.
  if (!names.every((name) => queues[name].durable)) {
    return { durable: false, durability: "fallback", status: broken ? "error" : "degraded" };
  }
  if (broken) return { durable: false, durability: "unreachable", status: "error" };
  return { durable: true, durability: "confirmed", status: "ok" };
}
