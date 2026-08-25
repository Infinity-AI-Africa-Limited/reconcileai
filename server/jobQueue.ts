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
  /**
   * Opt in ONLY when this queue's job names identify a unit of work uniquely.
   * The name then becomes the durable backend's job id, which makes entries
   * addressable by `remove()` and makes a double enqueue de-duplicate instead
   * of running twice.
   *
   * OFF BY DEFAULT, and it must stay that way. `webhook-delivery` enqueues
   * under the EVENT name (`reconciliation.completed`, …), which every delivery
   * of that event shares — turning those into job ids would collapse all of
   * them into one and silently drop every webhook after the first.
   */
  uniqueJobNames?: boolean;
}

export type JobHandler<T> = (job: QueueJob<T>) => Promise<void>;

/**
 * Operational snapshot of a queue, for /api/health.
 *
 * The go-live plan's exit criterion for durable processing asks for
 * "Redis/BullMQ health evidence". Before this, production could not report
 * WHICH backend was live — a deployment running the in-process fallback and one
 * running BullMQ were indistinguishable from outside, which is precisely the
 * thing an institution needs to see.
 */
export interface QueueStats {
  backend: "bullmq" | "in-process";
  /** Survives process restart and is safe across multiple instances. */
  durable: boolean;
  /** Present only on BullMQ; the in-process queue has no inspectable store. */
  counts?: { waiting: number; active: number; completed: number; failed: number; delayed: number };
  /** Populated when the counts lookup itself fails, so a broken Redis is visible. */
  error?: string;
}

export interface JobQueue<T> {
  enqueue(name: string, data: T, opts?: EnqueueOptions): Promise<void>;
  /** Operational snapshot for health output. */
  stats(): Promise<QueueStats>;
  /**
   * Drop a not-yet-running entry by the name it was enqueued under. Present
   * only on durable backends: the in-process queue holds its work in closures
   * with nothing addressable to remove, and loses everything on restart anyway.
   *
   * Best-effort by contract — an entry that is already active cannot be
   * removed, so callers must not rely on this alone to stop work. It exists to
   * reclaim capacity, never as the sole guard against a job executing.
   */
  remove?(name: string): Promise<void>;
  /**
   * Release the backend's resources and deregister the queue.
   *
   * The server never calls this — its queues live as long as the process, which
   * is the point of them. TESTS must, because a BullMQ queue holds a Queue and a
   * Worker, each with its own Redis connection, and an unclosed pair keeps the
   * event loop alive: the run leaks connections and may simply never terminate.
   */
  close(): Promise<void>;
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

  async stats(): Promise<QueueStats> {
    // No inspectable store: work lives in closures and dies with the process.
    // Reporting `durable: false` is the point — it is the degraded signal.
    return { backend: this.backend, durable: false };
  }

  async close(): Promise<void> {
    // Nothing to release — pending work is timers and closures, and the retry
    // timers are already unref'd so they cannot hold the process open.
    LIVE_QUEUES.delete(this.queueName);
  }

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
  uniqueJobNames: boolean,
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

  const worker = new Worker(
    queueName,
    async (bullJob) => {
      await handler({
        name: bullJob.name,
        data: bullJob.data as T,
        attempt: bullJob.attemptsMade + 1,
      });
    },
    { connection },
  );
  worker.on("error", (err) => console.error(`[queue:${queueName}] worker error:`, err.message));

  return {
    backend: "bullmq" as const,
    async close(): Promise<void> {
      // Worker first: it holds the blocking connection that keeps the event
      // loop alive, so closing the Queue alone would still hang a test run.
      await worker.close().catch(() => {});
      await queue.close().catch(() => {});
      LIVE_QUEUES.delete(queueName);
    },
    async stats(): Promise<QueueStats> {
      try {
        const c = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
        return {
          backend: "bullmq",
          durable: true,
          counts: {
            waiting: c.waiting ?? 0,
            active: c.active ?? 0,
            completed: c.completed ?? 0,
            failed: c.failed ?? 0,
            delayed: c.delayed ?? 0,
          },
        };
      } catch (err) {
        // A queue that cannot be counted is a queue whose Redis is unwell —
        // report it rather than presenting a healthy-looking empty snapshot.
        return { backend: "bullmq", durable: true, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async enqueue(name: string, data: T, opts?: EnqueueOptions) {
      await queue.add(name, data, {
        attempts: opts?.attempts ?? defaults.attempts,
        backoff: { type: "exponential", delay: opts?.backoffMs ?? defaults.backoffMs },
        // Deterministic id only where the caller guarantees names are unique
        // per unit of work — see QueueCreateOptions.uniqueJobNames.
        ...(uniqueJobNames ? { jobId: name } : {}),
      });
    },
    // Addressable only when the name IS the job id; without that there is
    // nothing to look up, so the capability is simply absent.
    ...(uniqueJobNames
      ? {
          async remove(name: string) {
            // Throws if the entry is currently active. Callers treat removal as
            // best-effort, so surface it rather than swallowing it here.
            await queue.remove(name);
          },
        }
      : {}),
  };
}

// ─── Live-queue registry (health/ops) ─────────────────────────────────────────

/**
 * Every queue this process created, so /api/health can report on what is
 * actually running rather than on what the configuration implies.
 */
const LIVE_QUEUES = new Map<string, JobQueue<unknown>>();

/** Snapshot of every live queue, keyed by name. Never throws. */
export async function allQueueStats(): Promise<Record<string, QueueStats>> {
  const out: Record<string, QueueStats> = {};
  for (const [name, q] of LIVE_QUEUES) {
    try {
      out[name] = await q.stats();
    } catch (err) {
      out[name] = {
        backend: q.backend,
        durable: q.backend === "bullmq",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return out;
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
      const q = await createBullMqQueue<T>(queueName, handler, defaults, redisUrl, opts?.uniqueJobNames === true);
      console.log(`[queue:${queueName}] BullMQ backend active`);
      LIVE_QUEUES.set(queueName, q as JobQueue<unknown>);
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
  const fallback = new InProcessQueue<T>(queueName, handler, defaults);
  LIVE_QUEUES.set(queueName, fallback as JobQueue<unknown>);
  return fallback;
}
