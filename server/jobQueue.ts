/**
 * Job queue abstraction (gap-closure plan WS-4 pre-work).
 *
 * Two backends behind one interface:
 *   - REDIS_URL set   → BullMQ (durable, multi-instance safe, survives restarts)
 *   - REDIS_URL unset → in-process retry queue (single-instance Railway + on-prem;
 *                       exponential backoff, bounded attempts, lost on restart)
 *
 * First consumer: outbound webhook delivery (server/webhookDelivery.ts).
 * When reconciliation runs move off the in-process fire-and-forget model
 * (tech-debt item), they enqueue here too.
 *
 * The BullMQ path activates the moment REDIS_URL is provisioned — no code
 * change. If BullMQ/Redis initialisation fails, we fall back in-process and
 * log loudly rather than dropping jobs silently.
 */

export interface QueueJob<T> {
  name: string;
  data: T;
  attempt: number; // 1-based
}

export interface EnqueueOptions {
  /** Max delivery attempts including the first (default 6). */
  attempts?: number;
  /** Base backoff in ms; attempt n waits base * 2^(n-1), capped at 10 min (default 30s). */
  backoffMs?: number;
}

export interface QueueCreateOptions extends EnqueueOptions {
  /** Refuse the in-process fallback. Required for bank-facing reconciliation. */
  requireDurable?: boolean;
}

export type JobHandler<T> = (job: QueueJob<T>) => Promise<void>;

export interface JobQueue<T> {
  enqueue(name: string, data: T, opts?: EnqueueOptions): Promise<void>;
  /** Which backend is live — surfaced in health/ops output. */
  readonly backend: "bullmq" | "in-process";
}

export class DurableQueueUnavailableError extends Error {
  constructor(queueName: string, reason: string) {
    super(`[queue:${queueName}] durable BullMQ processing is required but unavailable: ${reason}`);
    this.name = "DurableQueueUnavailableError";
  }
}

const MAX_BACKOFF_MS = 10 * 60 * 1000;

export function backoffDelayMs(attempt: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

// ─── In-process backend ───────────────────────────────────────────────────────

class InProcessQueue<T> implements JobQueue<T> {
  readonly backend = "in-process" as const;
  private pending = 0;

  constructor(
    private readonly queueName: string,
    private readonly handler: JobHandler<T>,
    private readonly defaults: Required<EnqueueOptions>,
  ) {}

  async enqueue(name: string, data: T, opts?: EnqueueOptions): Promise<void> {
    const attempts = opts?.attempts ?? this.defaults.attempts;
    const backoffMs = opts?.backoffMs ?? this.defaults.backoffMs;
    this.run({ name, data, attempt: 1 }, attempts, backoffMs);
  }

  private run(job: QueueJob<T>, maxAttempts: number, backoffMs: number) {
    this.pending += 1;
    // setImmediate keeps enqueue non-blocking; the handler owns its own errors.
    setImmediate(async () => {
      try {
        await this.handler(job);
      } catch (err) {
        if (job.attempt < maxAttempts) {
          const delay = backoffDelayMs(job.attempt, backoffMs);
          const timer = setTimeout(
            () => this.run({ ...job, attempt: job.attempt + 1 }, maxAttempts, backoffMs),
            delay,
          );
          // Never keep the process alive just for retries.
          if (typeof timer.unref === "function") timer.unref();
        } else {
          console.error(
            `[queue:${this.queueName}] job "${job.name}" exhausted ${maxAttempts} attempts:`,
            err instanceof Error ? err.message : err,
          );
        }
      } finally {
        this.pending -= 1;
      }
    });
  }
}

// ─── BullMQ backend (lazy — only when REDIS_URL is set) ──────────────────────

async function createBullMqQueue<T>(
  queueName: string,
  handler: JobHandler<T>,
  defaults: Required<EnqueueOptions>,
  redisUrl: string,
): Promise<JobQueue<T>> {
  const { Queue, Worker } = await import("bullmq");
  const connection = { url: redisUrl } as any;

  const queue = new Queue(queueName, {
    connection,
    defaultJobOptions: {
      attempts: defaults.attempts,
      backoff: { type: "exponential", delay: defaults.backoffMs },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });

  new Worker(
    queueName,
    async (bullJob) => {
      await handler({
        name: bullJob.name,
        data: bullJob.data as T,
        attempt: bullJob.attemptsMade + 1,
      });
    },
    { connection },
  ).on("error", (err) => console.error(`[queue:${queueName}] worker error:`, err.message));

  return {
    backend: "bullmq" as const,
    async enqueue(name: string, data: T, opts?: EnqueueOptions) {
      await queue.add(name, data, {
        attempts: opts?.attempts ?? defaults.attempts,
        backoff: { type: "exponential", delay: opts?.backoffMs ?? defaults.backoffMs },
      });
    },
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a named queue bound to a handler. Backend is decided once at creation:
 * BullMQ when REDIS_URL is set and initialises cleanly, in-process otherwise.
 */
export async function createQueue<T>(
  queueName: string,
  handler: JobHandler<T>,
  opts?: QueueCreateOptions,
): Promise<JobQueue<T>> {
  const defaults: Required<EnqueueOptions> = {
    attempts: opts?.attempts ?? 6,
    backoffMs: opts?.backoffMs ?? 30_000,
  };

  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    try {
      const q = await createBullMqQueue<T>(queueName, handler, defaults, redisUrl);
      console.log(`[queue:${queueName}] BullMQ backend active`);
      return q;
    } catch (err) {
      if (opts?.requireDurable) {
        throw new DurableQueueUnavailableError(
          queueName,
          err instanceof Error ? err.message : String(err),
        );
      }
      console.error(
        `[queue:${queueName}] BullMQ init failed — falling back to in-process queue:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (opts?.requireDurable) {
    throw new DurableQueueUnavailableError(queueName, "REDIS_URL is not configured");
  }
  return new InProcessQueue<T>(queueName, handler, defaults);
}
