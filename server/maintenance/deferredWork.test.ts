import { EventEmitter } from "node:events";
import type { Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asyncHandler } from "../_core/asyncHandler";
import { ApplicationLifecycle, applicationLifecycle, runBackgroundWork } from "./lifecycle";
import { deferBackgroundWork, trackResponseCompletion } from "./deferredWork";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

let lifecycle: ApplicationLifecycle;
beforeEach(() => {
  lifecycle = new ApplicationLifecycle();
  vi.spyOn(applicationLifecycle, "run").mockImplementation(lifecycle.run.bind(lifecycle));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const response = () => new EventEmitter() as unknown as Response;

describe("when a tracked route answers before its async handler completes", () => {
  it("should keep the full handler counted after response finish and close", async () => {
    const gate = deferred();
    const res = response();
    const wrapped = asyncHandler(async () => {
      res.emit("finish");
      res.emit("close");
      await gate.promise;
    });
    wrapped({ path: "/early", method: "POST", headers: {} } as never, res, () => {});
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    await flush();
    expect(lifecycle.snapshot().state).toBe("draining");
    gate.resolve();
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });
});

describe("when background work is deferred to setImmediate", () => {
  it("should reserve before the timer fires and retain the task after its parent returns", async () => {
    const gate = deferred();
    const operation = vi.fn(() => gate.promise);
    await lifecycle.run("request", async () => { deferBackgroundWork(operation); });
    expect(operation).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot().active).toBe(1);
    gate.resolve();
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should permit descendants under its reserved token after the request token expires", async () => {
    vi.useRealTimers();
    const child = deferred();
    const operation = vi.fn(async () => { runBackgroundWork(() => child.promise); });
    await lifecycle.run("request", async () => { deferBackgroundWork(operation); });
    const drain = lifecycle.drain(100);
    await new Promise(resolve => setImmediate(resolve));
    await flush();
    expect(operation).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot().active).toBe(1);
    child.resolve();
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
  });

  it("should admit deferred descendants of a still-live handler during drain", async () => {
    const gate = deferred();
    const parent = lifecycle.run("request", async () => {
      lifecycle.beginDrain();
      deferBackgroundWork(() => gate.promise);
    });
    await parent;
    const drain = lifecycle.drain(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.snapshot().active).toBe(1);
    gate.resolve();
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
  });

  it("should refuse fresh deferred roots after the fence without scheduling an effect", async () => {
    lifecycle.beginDrain();
    const operation = vi.fn(async () => {});
    deferBackgroundWork(operation);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(operation).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])("should safely release an operation that fails by %s without an unhandled rejection", async failure => {
    vi.useRealTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      deferBackgroundWork(() => {
        if (failure === "throw") throw new Error("synthetic-private-value");
        return Promise.reject(new Error("synthetic-private-value"));
      });
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect(lifecycle.snapshot().active).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith("maintenance_background_work_failed");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("when follow-up work depends on response completion", () => {
  it("should reserve before finish and await the entire follow-up despite a later close", async () => {
    const gate = deferred();
    const onFinish = vi.fn(() => gate.promise);
    const res = response();
    await lifecycle.run("request", async () => { trackResponseCompletion(res, onFinish); });
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    expect(onFinish).not.toHaveBeenCalled();
    res.emit("finish");
    res.emit("close");
    await flush();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot()).toMatchObject({ state: "draining", active: 1 });
    gate.resolve();
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(res.listenerCount("finish")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("should release an aborted close without confirming or retaining event listeners", async () => {
    const onFinish = vi.fn(async () => {});
    const res = response();
    trackResponseCompletion(res, onFinish);
    const drain = lifecycle.drain(100);
    res.emit("close");
    res.emit("finish");
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(onFinish).not.toHaveBeenCalled();
    expect(res.listenerCount("finish")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("should perform at most one follow-up even if finish is emitted repeatedly", async () => {
    const onFinish = vi.fn(async () => {});
    const res = response();
    trackResponseCompletion(res, onFinish);
    res.emit("finish");
    res.emit("finish");
    await flush();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot().active).toBe(0);
  });

  it("should invoke the finish continuation in its live background context", async () => {
    const child = deferred();
    const res = response();
    await lifecycle.run("request", async () => {
      trackResponseCompletion(res, async () => { runBackgroundWork(() => child.promise); });
    });
    const drain = lifecycle.drain(100);
    // Emitting outside any admitted request must not lose the reserved context.
    res.emit("finish");
    await flush();
    expect(lifecycle.snapshot().active).toBe(1);
    child.resolve();
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])("should safely release a finish follow-up that fails by %s", async failure => {
    vi.useRealTimers();
    const res = response();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      trackResponseCompletion(res, () => {
        if (failure === "throw") throw new Error("synthetic-private-value");
        return Promise.reject(new Error("synthetic-private-value"));
      });
      res.emit("finish");
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect(lifecycle.snapshot().active).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith("maintenance_background_work_failed");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("should release already-destroyed responses without confirmation", async () => {
    const onFinish = vi.fn(async () => {});
    const res = Object.assign(response(), { destroyed: true, writableFinished: false });
    trackResponseCompletion(res, onFinish);
    await flush();
    expect(onFinish).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(0);
  });

  it("should confirm an already-finished response once and await the write", async () => {
    const gate = deferred();
    const onFinish = vi.fn(() => gate.promise);
    const res = Object.assign(response(), { destroyed: true, writableFinished: true });
    trackResponseCompletion(res, onFinish);
    await flush();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot().active).toBe(1);
    gate.resolve();
    await flush();
    expect(lifecycle.snapshot().active).toBe(0);
  });
});
