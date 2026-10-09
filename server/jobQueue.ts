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
import { loggableError } from "./dbErrors";
import { stackFrames, errorSummary } from "./errorText";

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
  /**
   * Coalesce enqueues that ask for the same work. While an entry with this key
   * is still waiting, a further enqueue is absorbed into it. While one is
   * RUNNING, exactly one follow-up run is kept (carrying the latest data),
   * because the running pass may have started before whatever prompted the new
   * request — "refresh now" must not be satisfied by a refresh already under
   * way. So at most one runs and one waits per key, and never two at once.
   *
   * Unlike `uniqueJobNames`, the key is released when the work finishes, so the
   * same work can be requested again afterwards; a unique job id is retained
   * with the finished entry and would absorb every later request.
   */
  coalesceKey?: string;
  /**
   * Run no sooner than this many milliseconds after the enqueue.
   *
   * With `coalesceKey` this makes a fixed window that opens at the FIRST
   * request: later requests are absorbed into the waiting entry and do not push
   * it back, so a steady stream of requests cannot starve the work. A follow-up
   * kept while the work runs waits the same delay after it finishes.
   */
  delayMs?: number;
}

/** The per-queue retry defaults an enqueue may override. */
type RetryDefaults = Required<Pick<EnqueueOptions, "attempts" | "backoffMs">>;

export interface QueueCreateOptions<T = unknown> extends Pick<EnqueueOptions, "attempts" | "backoffMs"> {
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
  /** Observe a job only after its final configured attempt has failed. */
  onFinalFailure?: (job: QueueJob<T>, error: unknown) => Promise<void>;
  /** Let a later enqueue replace an exhausted BullMQ entry with the same unique name. */
  replaceFailedOnEnqueue?: boolean;
  /**
   * Jobs one BullMQ worker runs at once (default 1). The in-process queue runs
   * every job as it arrives and ignores this.
   */
  concurrency?: number;
  /**
   * How long a BullMQ `enqueue` or `remove` may wait for Redis before it is
   * refused with QueueOperationTimeoutError (default QUEUE_OPERATION_TIMEOUT_MS).
   * Exists so tests can shorten it; production queues keep the default.
   */
  operationTimeoutMs?: number;
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
  /**
   * Add work. On BullMQ this answers within `operationTimeoutMs`, rejecting
   * with QueueOperationTimeoutError if Redis has not answered by then.
   *
   * A rejection means "not known to be queued", NOT "not queued": the deadline
   * ends the wait, not the Redis command, which may still land once Redis
   * answers. So job names must make a repeat harmless (`uniqueJobNames`,
   * `coalesceKey`) or handlers must claim their work conditionally, and a
   * caller must never treat a rejection as proof the work will not run.
   */
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

/**
 * A BullMQ enqueue or remove that Redis has not answered in time.
 *
 * Without a deadline these never settle against an unreachable Redis: BullMQ
 * waits for a connection its retry strategy never abandons, and the connection
 * keeps ioredis's offline queue. A webhook that awaited one never answered, and
 * a recovery sweep that awaited one stopped, with every step behind it, for the
 * length of the outage.
 */
export class QueueOperationTimeoutError extends Error {
  constructor(
    readonly queueName: string,
    readonly operation: "enqueue" | "remove",
    readonly timeoutMs: number,
  ) {
    super(`[queue:${queueName}] ${operation} did not complete within ${timeoutMs}ms; Redis may be unreachable`);
    this.name = "QueueOperationTimeoutError";
  }
}

/**
 * How long a BullMQ enqueue or remove may wait for Redis. A healthy Redis
 * answers in milliseconds; this is the point at which "slow" has become
 * "unreachable". It stays under Shopify's 5-second webhook budget, so a
 * delivery is refused with a 503 Shopify retries, rather than abandoned.
 */
export const QUEUE_OPERATION_TIMEOUT_MS = 3_000;

/**
 * Settle with `work`, or with `onTimeout()` once `ms` have passed, whichever
 * comes first. `onTimeout` returns a fallback value or throws.
 *
 * The deadline ends the WAIT, not the work: an unreachable Redis does not
 * cancel a command, so `work` may still complete later. Every caller of this
 * must be correct when that happens.
 */
async function raceDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
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
  /** coalesceKey → whether its entry has started, and the one follow-up kept while it runs. */
  private readonly coalesced = new Map<
    string,
    { started: boolean; followUp: { name: string; data: T; opts?: EnqueueOptions } | null }
  >();

  constructor(
    private readonly queueName: string,
    private readonly handler: JobHandler<T>,
    private readonly defaults: RetryDefaults,
    private readonly onFinalFailure?: (job: QueueJob<T>, error: unknown) => Promise<void>,
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
    const delayMs = opts?.delayMs ?? 0;
    const key = opts?.coalesceKey;
    if (!key) {
      this.after(delayMs, () => this.run({ name, data, attempt: 1 }, attempts, backoffMs));
      return;
    }

    // The same rule the durable backend applies (see EnqueueOptions.coalesceKey).
    const current = this.coalesced.get(key);
    if (current && !current.started) return;
    if (current) {
      current.followUp = { name, data, opts };
      return;
    }
    const entry: { started: boolean; followUp: { name: string; data: T; opts?: EnqueueOptions } | null } = {
      started: false,
      followUp: null,
    };
    this.coalesced.set(key, entry);
    // While the delay runs the entry is not started, so further requests are
    // absorbed into it: the window opens at the first request and never moves.
    this.after(delayMs, () =>
      this.run({ name, data, attempt: 1 }, attempts, backoffMs, {
        onStart: () => {
          entry.started = true;
        },
        onSettled: () => {
          this.coalesced.delete(key);
          const next = entry.followUp;
          if (next) void this.enqueue(next.name, next.data, next.opts);
        },
      }),
    );
  }

  /** Start work now, or after `delayMs` (EnqueueOptions.delayMs). */
  private after(delayMs: number, start: () => void): void {
    if (delayMs <= 0) {
      start();
      return;
    }
    const timer = setTimeout(start, delayMs);
    // A delayed start must not hold the process open, any more than a retry.
    timer.unref?.();
  }

  private run(
    job: QueueJob<T>,
    maxAttempts: number,
    backoffMs: number,
    hooks?: { onStart: () => void; onSettled: () => void },
  ) {
    this.pending += 1;
    // setImmediate keeps enqueue non-blocking; the handler owns its own errors.
    setImmediate(async () => {
      hooks?.onStart();
      try {
        await this.handler(job);
        hooks?.onSettled();
      } catch (err) {
        if (job.attempt < maxAttempts) {
          const delay = backoffDelayMs(job.attempt, backoffMs);
          const timer = setTimeout(
            () => this.run({ ...job, attempt: job.attempt + 1 }, maxAttempts, backoffMs, hooks),
            delay,
          );
          // Never keep the process alive just for retries.
          if (typeof timer.unref === "function") timer.unref();
        } else {
          try {
            await this.onFinalFailure?.(job, err);
          } catch (terminalError) {
            console.error(
              `[queue:${this.queueName}] terminal failure hook failed for "${job.name}":`,
              loggableError(terminalError),
            );
          }
          console.error(
            `[queue:${this.queueName}] job "${job.name}" exhausted ${maxAttempts} attempts:`,
            { ...loggableError(err), frames: stackFrames(err) },
          );
          // After the terminal hook, so a follow-up never starts before this
          // run's failure has been recorded.
          hooks?.onSettled();
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
  defaults: RetryDefaults,
  redisUrl: string,
  uniqueJobNames: boolean,
  onFinalFailure?: (job: QueueJob<T>, error: unknown) => Promise<void>,
  replaceFailedOnEnqueue = false,
  concurrency = 1,
  operationTimeoutMs = QUEUE_OPERATION_TIMEOUT_MS,
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
    { connection, concurrency },
  );
  worker.on("error", (err) => console.error(`[queue:${queueName}] worker error:`, loggableError(err)));
  worker.on("failed", async (bullJob, error) => {
    if (!bullJob || bullJob.attemptsMade < (bullJob.opts.attempts ?? defaults.attempts)) return;
    const job: QueueJob<T> = {
      name: bullJob.name,
      data: bullJob.data as T,
      attempt: bullJob.attemptsMade,
    };
    try {
      await onFinalFailure?.(job, error);
    } catch (terminalError) {
      // Keep the failed BullMQ row as the queue's dead-letter evidence too.
      console.error(
        `[queue:${queueName}] terminal failure hook failed for "${bullJob.name}":`,
        loggableError(terminalError),
      );
    }
  });

  let statsInFlight: Promise<QueueStats> | null = null;
  async function readStats(): Promise<QueueStats> {
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
      return { backend: "bullmq", durable: true, error: errorSummary(err) };
    }
  }

  /**
   * `work`, refused with QueueOperationTimeoutError once the deadline passes.
   * A command that completes after that is logged: its caller was told it
   * failed, so a job that then runs anyway must be explainable from the logs.
   */
  function bounded(operation: "enqueue" | "remove", name: string, work: Promise<void>): Promise<void> {
    let timedOut = false;
    void work.then(
      () => {
        if (timedOut) {
          console.warn(`[queue:${queueName}] ${operation} of "${name}" completed after its deadline; its caller was told it failed`);
        }
      },
      () => {},
    );
    return raceDeadline(work, operationTimeoutMs, () => {
      timedOut = true;
      throw new QueueOperationTimeoutError(queueName, operation, operationTimeoutMs);
    });
  }

  async function enqueueNow(name: string, data: T, opts?: EnqueueOptions): Promise<void> {
    if (uniqueJobNames && replaceFailedOnEnqueue) {
      const existing = await queue.getJob(name);
      if (existing && (await existing.isFailed())) {
        // A failed unique entry is dead work, not an idempotency success. Keep
        // it until redelivery arrives (for inspection), then re-arm it so the
        // same provider delivery receives a fresh bounded attempt cycle.
        //
        // Re-arm with retry(), never remove()+add(): retry moves the entry
        // out of the failed set in ONE Redis script, and only while it is
        // still there. With remove()+add(), two concurrent redeliveries could
        // each hold the failed entry; the slower one's remove() then either
        // deleted the fresh entry the faster one had just queued, or threw
        // because the entry was already gone — failing a delivery whose work
        // was in fact queued.
        try {
          await existing.updateData(data);
          await existing.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
          return;
        } catch (error) {
          // Losing that race is success: a concurrent redelivery re-armed the
          // same unit of work. Only an entry that is STILL failed is an error.
          const current = await queue.getJob(name);
          if (current && !(await current.isFailed())) return;
          if (current) throw error;
          // Gone entirely (retention trimmed it): queue it afresh below.
        }
      }
    }
    await queue.add(name, data, {
      attempts: opts?.attempts ?? defaults.attempts,
      backoff: { type: "exponential", delay: opts?.backoffMs ?? defaults.backoffMs },
      // A delayed job with a coalesceKey makes a window from the first request:
      // BullMQ deduplicates every later add into it, from any instance, and
      // a follow-up kept while it runs is re-created with this same delay.
      ...(opts?.delayMs && opts.delayMs > 0 ? { delay: opts.delayMs } : {}),
      // Deterministic id only where the caller guarantees names are unique
      // per unit of work — see QueueCreateOptions.uniqueJobNames.
      ...(uniqueJobNames ? { jobId: name } : {}),
      // BullMQ releases the key when the job completes or fails; while it is
      // active, keepLastIfActive holds exactly one follow-up (latest data).
      ...(opts?.coalesceKey ? { deduplication: { id: opts.coalesceKey, keepLastIfActive: true } } : {}),
    });
  }

  return {
    backend: "bullmq" as const,
    async close(): Promise<void> {
      // Worker first: it holds the blocking connection that keeps the event
      // loop alive, so closing the Queue alone would still hang a test run.
      await worker.close().catch(() => {});
      await queue.close().catch(() => {});
      LIVE_QUEUES.delete(queueName);
    },
    stats(): Promise<QueueStats> {
      // One count read in flight per queue, shared by every caller. Against an
      // unreachable Redis a read never settles (BullMQ waits on a connection
      // its retry strategy never abandons), and callers' deadlines stop their
      // waiting, not the read. Unshared, every health check and every OAuth
      // request left two more reads pending for the length of the outage.
      statsInFlight ??= readStats().finally(() => {
        statsInFlight = null;
      });
      return statsInFlight;
    },
    enqueue(name: string, data: T, opts?: EnqueueOptions): Promise<void> {
      // The WHOLE operation is bounded, not each round trip: the re-arm path
      // makes up to four, and the caller's budget is for the enqueue.
      return bounded("enqueue", name, enqueueNow(name, data, opts));
    },
    // Addressable only when the name IS the job id; without that there is
    // nothing to look up, so the capability is simply absent.
    ...(uniqueJobNames
      ? {
          remove(name: string): Promise<void> {
            // Throws if the entry is currently active. Callers treat removal as
            // best-effort, so surface it rather than swallowing it here.
            return bounded(
              "remove",
              name,
              queue.remove(name).then(() => {}),
            );
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

/**
 * How long one queue's count read may take before it is reported as failing.
 *
 * An unreachable Redis does not fail a read, it holds it: BullMQ waits for a
 * connection its retry strategy never stops attempting, and a queue registers
 * here at construction, before anything has connected. Unbounded, one such
 * queue hung every caller of this function, /api/health included, in exactly
 * the outage it exists to report.
 */
export const QUEUE_STATS_TIMEOUT_MS = 3_000;

/**
 * Snapshot of every live queue, keyed by name. Never throws, and answers within
 * `timeoutMs`: the reads run in parallel, and one that has not answered by
 * then is reported with an error, as a read that failed.
 */
export async function allQueueStats(timeoutMs = QUEUE_STATS_TIMEOUT_MS): Promise<Record<string, QueueStats>> {
  const entries = await Promise.all(
    [...LIVE_QUEUES].map(async ([name, q]) => [name, await boundedStats(q, timeoutMs)] as const),
  );
  return Object.fromEntries(entries);
}

async function boundedStats(q: JobQueue<unknown>, timeoutMs: number): Promise<QueueStats> {
  const failed = (error: string): QueueStats => ({ backend: q.backend, durable: q.backend === "bullmq", error });
  try {
    return await raceDeadline(q.stats(), timeoutMs, () => failed("count read timed out"));
  } catch (err) {
    return failed(errorSummary(err));
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a named queue bound to a handler. Backend is decided once at creation:
 * BullMQ when REDIS_URL is set and initialises cleanly, in-process otherwise.
 */
export async function createQueue<T>(
  queueName: string,
  handler: JobHandler<T>,
  opts?: QueueCreateOptions<T>,
): Promise<JobQueue<T>> {
  const defaults: RetryDefaults = {
    attempts: opts?.attempts ?? 6,
    backoffMs: opts?.backoffMs ?? 30_000,
  };

  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    try {
      const q = await createBullMqQueue<T>(
        queueName,
        handler,
        defaults,
        redisUrl,
        opts?.uniqueJobNames === true,
        opts?.onFinalFailure,
        opts?.replaceFailedOnEnqueue === true,
        opts?.concurrency ?? 1,
        opts?.operationTimeoutMs ?? QUEUE_OPERATION_TIMEOUT_MS,
      );
      console.log(`[queue:${queueName}] BullMQ backend active`);
      LIVE_QUEUES.set(queueName, q as JobQueue<unknown>);
      return q;
    } catch (err) {
      if (opts?.requireDurable) {
        throw new DurableQueueUnavailableError(
          queueName,
          errorSummary(err),
        );
      }
      console.error(
        `[queue:${queueName}] BullMQ init failed — falling back to in-process queue:`,
        loggableError(err),
      );
    }
  }
  if (opts?.requireDurable) {
    throw new DurableQueueUnavailableError(queueName, "REDIS_URL is not configured");
  }
  const fallback = new InProcessQueue<T>(
    queueName,
    handler,
    defaults,
    opts?.onFinalFailure,
  );
  LIVE_QUEUES.set(queueName, fallback as JobQueue<unknown>);
  return fallback;
}
