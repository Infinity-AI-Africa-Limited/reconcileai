import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobQueue } from "./jobQueue";

type BullJob = { name: string; data: unknown; attemptsMade: number; opts: { attempts?: number } };
type Listener = (...args: any[]) => unknown;

const bull = vi.hoisted(() => ({
  workers: [] as Array<{
    processor: (job: BullJob) => Promise<void>;
    options: Record<string, unknown>;
    listeners: Map<string, Listener>;
    pause: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  queues: [] as Array<{
    options: Record<string, any>;
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    drain: ReturnType<typeof vi.fn>;
    obliterate: ReturnType<typeof vi.fn>;
  }>,
  construct: undefined as undefined | (() => void),
  addWork: undefined as undefined | (() => Promise<void>),
  removeWork: undefined as undefined | (() => Promise<void>),
  pauseWork: undefined as undefined | ((doNotWaitActive: boolean) => Promise<void>),
}));

vi.mock("bullmq", () => ({
  Queue: class {
    options: Record<string, any>;
    add = vi.fn(() => bull.addWork?.() ?? Promise.resolve());
    remove = vi.fn(() => bull.removeWork?.() ?? Promise.resolve());
    close = vi.fn(async () => {});
    pause = vi.fn(async () => {});
    drain = vi.fn(async () => {});
    obliterate = vi.fn(async () => {});
    constructor(_name: string, options: Record<string, any>) {
      this.options = options;
      bull.queues.push(this);
      bull.construct?.();
    }
    async getJobCounts() { return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }; }
  },
  Worker: class {
    listeners = new Map<string, Listener>();
    pause = vi.fn((doNotWaitActive: boolean) => bull.pauseWork?.(doNotWaitActive) ?? Promise.resolve());
    close = vi.fn(async () => {});
    constructor(public name: string, public processor: (job: BullJob) => Promise<void>, public options: Record<string, unknown>) {
      bull.workers.push(this);
    }
    on(event: string, listener: Listener) { this.listeners.set(event, listener); }
    // run deliberately absent: normal autorun must work with the existing mock
    // contract; late creation uses autorun:false and never starts a run loop.
  },
}));

function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let api: typeof import("./jobQueue");
let lifecycle: typeof import("./maintenance/lifecycle");
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));
const job = (attemptsMade = 0): BullJob => ({ name: "synthetic-job", data: { id: 7 }, attemptsMade, opts: { attempts: 2 } });

beforeEach(async () => {
  vi.resetModules();
  bull.workers.length = 0;
  bull.queues.length = 0;
  bull.construct = undefined;
  bull.addWork = undefined;
  bull.removeWork = undefined;
  bull.pauseWork = undefined;
  vi.stubEnv("REDIS_URL", "redis://synthetic.invalid:6379");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  lifecycle = await import("./maintenance/lifecycle");
  api = await import("./jobQueue");
});

afterEach(async () => {
  // Stop timers only; a fenced in-process queue deliberately refuses closure.
  lifecycle.applicationLifecycle.beginDrain();
  await api.closeAllQueues().catch(() => {});
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function durable(options: Parameters<typeof api.createQueue>[2] = {}) {
  return api.createQueue("synthetic-queue", async () => {}, { requireDurable: true, ...options });
}

async function local(handler: (job: { name: string; data: unknown; attempt: number }) => Promise<void>, options: Parameters<typeof api.createQueue>[2] = {}) {
  vi.stubEnv("REDIS_URL", "");
  return api.createQueue("synthetic-local", handler, options);
}

describe("when maintenance stops a durable worker", () => {
  it("should locally pause acquisition without closing resources or changing retained work policies", async () => {
    await durable();
    lifecycle.applicationLifecycle.beginDrain();
    await flush();

    expect(bull.workers[0].pause).toHaveBeenCalledOnce();
    expect(bull.workers[0].pause).toHaveBeenCalledWith(false);
    expect(bull.workers[0].close).not.toHaveBeenCalled();
    expect(bull.queues[0].close).not.toHaveBeenCalled();
    expect(bull.queues[0].remove).not.toHaveBeenCalled();
    expect(bull.queues[0].pause).not.toHaveBeenCalled();
    expect(bull.queues[0].drain).not.toHaveBeenCalled();
    expect(bull.queues[0].obliterate).not.toHaveBeenCalled();
    expect(bull.queues[0].options.defaultJobOptions).toMatchObject({ removeOnComplete: 1000, removeOnFail: 5000 });
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "drained" });
    await api.closeAllQueues();
    expect(bull.workers[0].close).toHaveBeenCalledOnce();
    expect(bull.queues[0].close).toHaveBeenCalledOnce();
  });

  it("should await a blocking fetch even when no handler lease is active", async () => {
    const fetch = gate();
    // Match BullMQ: pause(true) fences future acquisition but resolves before
    // the main loop's in-flight blocking fetch; pause(false) awaits that loop.
    bull.pauseWork = (doNotWaitActive) => doNotWaitActive ? Promise.resolve() : fetch.promise;
    await durable();
    let drained = false;
    const drain = lifecycle.applicationLifecycle.drain(1000).then((result) => { drained = true; return result; });
    await flush();

    expect(lifecycle.applicationLifecycle.snapshot().active).toBe(0);
    expect(drained).toBe(false);
    expect(bull.workers[0].pause).toHaveBeenCalledWith(false);
    expect(bull.workers[0].close).not.toHaveBeenCalled();
    fetch.resolve();
    expect(await drain).toMatchObject({ status: "drained", active: 0 });
  });

  it("should bound acquisition quiescence by the lifecycle drain and remain incomplete after a late fetch settles", async () => {
    const fetch = gate();
    bull.pauseWork = (doNotWaitActive) => doNotWaitActive ? Promise.resolve() : fetch.promise;
    await durable();
    vi.useFakeTimers();
    const drain = lifecycle.applicationLifecycle.drain(25);
    await vi.advanceTimersByTimeAsync(25);

    expect(await drain).toMatchObject({ status: "incomplete", active: 0 });
    expect(bull.workers[0].close).not.toHaveBeenCalled();
    expect(bull.queues[0].close).not.toHaveBeenCalled();
    expect(await api.allQueueStats()).toHaveProperty("synthetic-queue");
    fetch.resolve();
    await flush();
    expect(await lifecycle.applicationLifecycle.drain(25)).toMatchObject({ status: "incomplete" });
  });

  it("should invalidate drain when the awaited blocking fetch acquires a job after the fence", async () => {
    const fetch = gate();
    bull.pauseWork = (doNotWaitActive) => doNotWaitActive ? Promise.resolve() : fetch.promise;
    const handler = vi.fn(async () => {});
    await api.createQueue("synthetic-fetched", handler, { requireDurable: true });
    const drain = lifecycle.applicationLifecycle.drain(1000);
    await expect(bull.workers[0].processor(job())).rejects.toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    fetch.resolve();

    expect(handler).not.toHaveBeenCalled();
    expect(await drain).toMatchObject({ status: "incomplete", stopFailures: 1 });
    expect(bull.workers[0].close).not.toHaveBeenCalled();
    expect(bull.queues[0].close).not.toHaveBeenCalled();
  });

  it("should await a late factory and its local pause, with constructor autorun disabled", async () => {
    const pause = gate();
    bull.pauseWork = () => pause.promise;
    // The queue constructor is inside the admitted lazy factory, before Worker
    // construction. A drain here simulates the import finishing after the fence.
    const constructed = gate();
    bull.construct = () => {
      lifecycle.applicationLifecycle.beginDrain();
      constructed.resolve();
    };
    let returned = false;
    const construction = durable().then((queue) => { returned = true; return queue; });
    await constructed.promise;
    await flush();
    let drained = false;
    const drain = lifecycle.applicationLifecycle.drain(1000).then((result) => { drained = true; return result; });
    await flush();

    expect(bull.workers[0].options.autorun).toBe(false);
    expect(bull.workers[0].pause).toHaveBeenCalledOnce();
    expect(bull.workers[0].pause).toHaveBeenCalledWith(false);
    expect(returned).toBe(false);
    expect(drained).toBe(false);
    pause.resolve();
    const queue = await construction;
    expect(await drain).toMatchObject({ status: "drained", active: 0 });
    expect(await api.allQueueStats()).toHaveProperty("synthetic-queue");
    await queue.close();
  });

  it("should refuse a newly requested factory before constructing any Redis objects", async () => {
    lifecycle.applicationLifecycle.beginDrain();
    await expect(durable()).rejects.toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    expect(bull.workers).toHaveLength(0);
    expect(bull.queues).toHaveLength(0);
  });

  it("should fail drain closed when local pause fails", async () => {
    const failure = new Error("synthetic pause failure");
    bull.pauseWork = () => Promise.reject(failure);
    await durable();
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "incomplete", stopFailures: 1 });
    expect(bull.workers[0].close).not.toHaveBeenCalled();
  });
});

describe("when BullMQ processing is already admitted", () => {
  it("should track the handler through its completion acknowledgement", async () => {
    const handler = gate();
    await api.createQueue("synthetic-active", () => handler.promise, { requireDurable: true });
    const current = job();
    const processing = bull.workers[0].processor(current);
    let drained = false;
    const drain = lifecycle.applicationLifecycle.drain(1000).then((result) => { drained = true; return result; });
    await flush();
    expect(drained).toBe(false);
    handler.resolve();
    await processing;
    await flush();
    expect(drained).toBe(false); // Redis has not acknowledged completion yet.
    await bull.workers[0].listeners.get("completed")!(current);
    expect(await drain).toMatchObject({ status: "drained", active: 0 });
  });

  it("should let an active handler enqueue completion effects during drain and reject external enqueue/remove first", async () => {
    const proceed = gate();
    let queue!: JobQueue<unknown>;
    queue = await api.createQueue("synthetic-descendant", async () => {
      await proceed.promise;
      await queue.enqueue("synthetic-child", {});
      await queue.remove!("synthetic-old");
    }, { requireDurable: true, uniqueJobNames: true });
    const current = job();
    const processing = bull.workers[0].processor(current);
    const drain = lifecycle.applicationLifecycle.drain(1000);

    await expect(queue.enqueue("external", {})).rejects.toMatchObject({ message: "Application is not accepting new work." });
    await expect(queue.remove!("external")).rejects.toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    expect(bull.queues[0].add).not.toHaveBeenCalled();
    expect(bull.queues[0].remove).not.toHaveBeenCalled();
    proceed.resolve();
    await processing;
    expect(bull.queues[0].add).toHaveBeenCalledOnce();
    expect(bull.queues[0].remove).toHaveBeenCalledOnce();
    expect(bull.queues[0].remove).toHaveBeenCalledWith("synthetic-old");
    await bull.workers[0].listeners.get("completed")!(current);
    expect(await drain).toMatchObject({ status: "drained" });
  });

  it("should track the final failure hook and its descendant enqueue in the original handler context", async () => {
    const fail = gate();
    const hook = gate();
    const error = new Error("synthetic handler failure");
    let queue!: JobQueue<unknown>;
    queue = await api.createQueue("synthetic-final", () => fail.promise, {
      requireDurable: true,
      attempts: 2,
      onFinalFailure: async () => {
        await hook.promise;
        await queue.enqueue("final-effect", {});
      },
    });
    const current = job(1);
    const processing = bull.workers[0].processor(current).catch((caught: unknown) => caught);
    let drained = false;
    const drain = lifecycle.applicationLifecycle.drain(1000).then((result) => { drained = true; return result; });
    fail.reject(error);
    expect(await processing).toBe(error);
    current.attemptsMade = 2;
    const final = bull.workers[0].listeners.get("failed")!(current, error);
    await flush();
    expect(drained).toBe(false);
    hook.resolve();
    await final;
    expect(bull.queues[0].add).toHaveBeenCalledOnce();
    expect(await drain).toMatchObject({ status: "drained", active: 0 });
  });

  it("should not invoke a handler for an acquisition racing the maintenance fence", async () => {
    const handler = vi.fn(async () => {});
    await api.createQueue("synthetic-fenced", handler, { requireDurable: true });
    lifecycle.applicationLifecycle.beginDrain();
    await expect(bull.workers[0].processor(job())).rejects.toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    expect(handler).not.toHaveBeenCalled();
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "incomplete", stopFailures: 1 });
  });

  it("should refuse a preservation claim for a deferred terminal event without live handler ancestry", async () => {
    const final = vi.fn(async () => {});
    await durable({ onFinalFailure: final });
    lifecycle.applicationLifecycle.beginDrain();
    await bull.workers[0].listeners.get("failed")!(job(2), new Error("synthetic deferred failure"));
    expect(final).not.toHaveBeenCalled();
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "incomplete", stopFailures: 1 });
  });
});

describe("when a caller deadline does not cancel a Redis command", () => {
  it.each(["enqueue", "remove"] as const)("should keep an underlying %s tracked after the caller times out", async (operation) => {
    const command = gate();
    if (operation === "enqueue") bull.addWork = () => command.promise;
    else bull.removeWork = () => command.promise;
    const queue = await durable({ uniqueJobNames: true, operationTimeoutMs: 20 });
    vi.useFakeTimers();
    const result = (operation === "enqueue" ? queue.enqueue("late", {}) : queue.remove!("late")).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBeInstanceOf(api.QueueOperationTimeoutError);
    let drained = false;
    const drain = lifecycle.applicationLifecycle.drain(1000).then((outcome) => { drained = true; return outcome; });
    await flush();
    expect(drained).toBe(false);
    command.resolve();
    expect(await drain).toMatchObject({ status: "drained", active: 0 });
  });
});

describe("when queue resource closure fails", () => {
  it("should propagate the worker error and not prematurely close its Queue", async () => {
    const queue = await durable();
    const failure = new Error("synthetic worker close failure");
    bull.workers[0].close.mockRejectedValueOnce(failure);
    await expect(queue.close()).rejects.toBe(failure);
    expect(bull.queues[0].close).not.toHaveBeenCalled();
    expect(await api.allQueueStats()).toHaveProperty("synthetic-queue");
  });

  it("should fail closed when Worker close emits cleanup errors and then resolves, including later retries", async () => {
    const queue = await durable();
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "drained" });
    const cleanup = gate();
    const failures = [new Error("synthetic blocking cleanup failure"), new Error("synthetic connection cleanup failure")];
    bull.workers[0].close.mockImplementationOnce(async () => {
      // BullMQ catches each cleanup failure, emits error, continues the next
      // cleanup, and resolves its cached close promise instead of rejecting.
      await cleanup.promise;
      for (const error of failures) bull.workers[0].listeners.get("error")!(error);
    });
    let settled = false;
    const closure = queue.close().catch((error: unknown) => error).finally(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    cleanup.resolve();
    const error = await closure;

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(failures);
    expect(bull.queues[0].close).not.toHaveBeenCalled();
    expect(await api.allQueueStats()).toHaveProperty("synthetic-queue");
    await expect(queue.close()).rejects.toBe(error);
    const retry = await api.closeAllQueues().catch((caught: unknown) => caught);
    expect(retry).toBeInstanceOf(AggregateError);
    expect((retry as AggregateError).errors).toContain(error);
    expect(bull.workers[0].close).toHaveBeenCalledOnce();
    expect(bull.queues[0].close).not.toHaveBeenCalled();
    expect(await api.allQueueStats()).toHaveProperty("synthetic-queue");
  });

  it("should not mistake an error emitted before the close interval for a cleanup failure", async () => {
    const queue = await durable();
    bull.workers[0].listeners.get("error")!(new Error("synthetic earlier worker error"));
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "drained" });

    await expect(queue.close()).resolves.toBeUndefined();
    expect(bull.queues[0].close).toHaveBeenCalledOnce();
    expect(await api.allQueueStats()).not.toHaveProperty("synthetic-queue");
  });

  it("should reject closure when an acquisition invalidates drain while Worker close is pending", async () => {
    const handler = vi.fn(async () => {});
    const queue = await api.createQueue("synthetic-closing", handler, { requireDurable: true });
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "drained" });
    const cleanup = gate();
    bull.workers[0].close.mockImplementationOnce(() => cleanup.promise);
    const closure = queue.close().catch((error: unknown) => error);
    await flush();
    await expect(bull.workers[0].processor(job())).rejects.toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    cleanup.resolve();

    expect(await closure).toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    expect(handler).not.toHaveBeenCalled();
    expect(bull.queues[0].close).not.toHaveBeenCalled();
    expect(await api.allQueueStats()).toHaveProperty("synthetic-closing");
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "incomplete", stopFailures: 1 });
    await expect(queue.close()).rejects.toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    expect(bull.queues[0].close).not.toHaveBeenCalled();
  });

  it("should retain the registry when an acquisition invalidates drain during Queue close", async () => {
    const queue = await durable();
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "drained" });
    const cleanup = gate();
    bull.queues[0].close.mockImplementationOnce(() => cleanup.promise);
    const closure = queue.close().catch((error: unknown) => error);
    await flush();
    expect(bull.queues[0].close).toHaveBeenCalledOnce();
    await expect(bull.workers[0].processor(job())).rejects.toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    cleanup.resolve();

    expect(await closure).toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    expect(await api.allQueueStats()).toHaveProperty("synthetic-queue");
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "incomplete", stopFailures: 1 });
  });

  it("should reject closure when an unadmitted deferred terminal event arrives during Worker close", async () => {
    const final = vi.fn(async () => {});
    const queue = await durable({ onFinalFailure: final });
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "drained" });
    const cleanup = gate();
    bull.workers[0].close.mockImplementationOnce(() => cleanup.promise);
    const closure = queue.close().catch((error: unknown) => error);
    await flush();
    await bull.workers[0].listeners.get("failed")!(job(2), new Error("synthetic late terminal failure"));
    cleanup.resolve();

    expect(await closure).toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    expect(final).not.toHaveBeenCalled();
    expect(bull.queues[0].close).not.toHaveBeenCalled();
    expect(await api.allQueueStats()).toHaveProperty("synthetic-queue");
  });

  it("should propagate a Queue close error without deregistering the queue", async () => {
    const queue = await durable();
    const failure = new Error("synthetic Queue close failure");
    bull.queues[0].close.mockRejectedValueOnce(failure);
    await expect(queue.close()).rejects.toBe(failure);
    expect(await api.allQueueStats()).toHaveProperty("synthetic-queue");
  });

  it("should close all same-name instances and aggregate errors rather than omit resources", async () => {
    await durable();
    await durable();
    const failure = new Error("synthetic close-all failure");
    bull.workers[0].close.mockRejectedValueOnce(failure);
    const result = await api.closeAllQueues().catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toContain(failure);
    expect(bull.workers[1].close).toHaveBeenCalledOnce();
    expect(bull.queues[1].close).toHaveBeenCalledOnce();
  });
});

describe("when in-process work cannot be durably preserved", () => {
  it.each([0, 1000])("should retain a fenced waiting entry with delay %s and refuse safe closure", async (delayMs) => {
    const handler = vi.fn(async () => {});
    const queue = await local(handler);
    vi.useFakeTimers();
    await queue.enqueue("waiting", {}, { delayMs, coalesceKey: "synthetic-key" });
    lifecycle.applicationLifecycle.beginDrain();
    await vi.advanceTimersByTimeAsync(2000);
    expect(handler).not.toHaveBeenCalled();
    expect(await lifecycle.applicationLifecycle.drain(100)).toMatchObject({ status: "drained", active: 0 });
    await expect(queue.close()).rejects.toMatchObject({
      name: "InProcessQueueNotEmptyError",
      message: "In-process queue has unfinished work; maintenance cannot safely close it.",
    });
    expect(await api.allQueueStats()).toHaveProperty("synthetic-local");
  });

  it("should refuse external enqueue after the fence without scheduling a new timer", async () => {
    const handler = vi.fn(async () => {});
    const queue = await local(handler);
    vi.useFakeTimers();
    lifecycle.applicationLifecycle.beginDrain();
    await expect(queue.enqueue("external", {}, { delayMs: 1000 })).rejects.toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
    expect(vi.getTimerCount()).toBe(0);
    await expect(queue.close()).resolves.toBeUndefined();
  });

  it("should track an active handler and retain its retry without acquiring it after stop", async () => {
    const active = gate();
    const handler = vi.fn(() => active.promise);
    const queue = await local(handler, { attempts: 3, backoffMs: 10 });
    await queue.enqueue("retry", {});
    await immediate();
    expect(handler).toHaveBeenCalledOnce();
    let drained = false;
    const drain = lifecycle.applicationLifecycle.drain(1000).then((result) => { drained = true; return result; });
    await flush();
    expect(drained).toBe(false);
    active.reject(new Error("synthetic retry"));
    expect(await drain).toMatchObject({ status: "drained", active: 0 });
    await expect(queue.close()).rejects.toBeInstanceOf(api.InProcessQueueNotEmptyError);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should retain one coalesced follow-up after the active handler finishes during drain", async () => {
    const active = gate();
    const handler = vi.fn(() => active.promise);
    const queue = await local(handler, { attempts: 1 });
    await queue.enqueue("coalesced", { id: 1 }, { coalesceKey: "same" });
    await immediate();
    await queue.enqueue("coalesced", { id: 2 }, { coalesceKey: "same" });
    await queue.enqueue("coalesced", { id: 3 }, { coalesceKey: "same" });
    const drain = lifecycle.applicationLifecycle.drain(1000);
    active.resolve();
    expect(await drain).toMatchObject({ status: "drained", active: 0 });
    await immediate();
    expect(handler).toHaveBeenCalledOnce();
    await expect(queue.close()).rejects.toBeInstanceOf(api.InProcessQueueNotEmptyError);
  });

  it("should track the terminal failure hook and allow close when no unfinished entries remain", async () => {
    const active = gate();
    const terminal = gate();
    const queue = await local(() => active.promise, { attempts: 1, onFinalFailure: () => terminal.promise });
    await queue.enqueue("terminal", {});
    await immediate();
    let drained = false;
    const drain = lifecycle.applicationLifecycle.drain(1000).then((result) => { drained = true; return result; });
    active.reject(new Error("synthetic terminal failure"));
    await flush();
    expect(drained).toBe(false);
    terminal.resolve();
    expect(await drain).toMatchObject({ status: "drained", active: 0 });
    await expect(queue.close()).resolves.toBeUndefined();
    await expect(queue.enqueue("closed", {})).rejects.toBeInstanceOf(lifecycle.MaintenanceAdmissionError);
  });

  it("should preserve ordinary attempt numbers and exponential backoff before maintenance", async () => {
    const attempts: Array<{ attempt: number; at: number }> = [];
    const final = vi.fn(async () => {});
    const queue = await local(async (current) => {
      attempts.push({ attempt: current.attempt, at: Date.now() });
      throw new Error("synthetic exhausted");
    }, { attempts: 3, backoffMs: 100, onFinalFailure: final });
    vi.useFakeTimers();
    await queue.enqueue("ordinary", {});
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts.map((entry) => entry.attempt)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts.map((entry) => entry.attempt)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(201);
    expect(attempts.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
    expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(100);
    expect(attempts[2].at - attempts[1].at).toBeGreaterThanOrEqual(200);
    expect(final).toHaveBeenCalledOnce();
    await expect(queue.close()).resolves.toBeUndefined();
  });
});
