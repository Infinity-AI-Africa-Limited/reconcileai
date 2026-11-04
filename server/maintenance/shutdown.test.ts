import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationLifecycle } from "./lifecycle";
import { attachShutdownSignals } from "./shutdown";

const fakeServer = (listening = true) => ({
  listening,
  close: vi.fn((callback: (error?: Error) => void) => { callback(); }),
  closeIdleConnections: vi.fn(),
});
const signals = () => new EventEmitter();
afterEach(() => { vi.useRealTimers(); });

describe("when an isolated process receives the maintenance shutdown sequence", () => {
  it("should fence synchronously, stop producers, await real work, then close resources once", async () => {
    const lifecycle = new ApplicationLifecycle();
    const order: string[] = [];
    let finish!: () => void;
    const task = lifecycle.run("background", () => new Promise<void>(resolve => { finish = resolve; }));
    lifecycle.registerStop(() => { order.push("producer_stopped"); });
    const server = fakeServer();
    const closeResources = vi.fn(async () => { order.push("resources_closed"); });
    const hook = attachShutdownSignals(server as never, { timeoutMs: 1000, closeResources }, lifecycle, signals());
    const first = hook.shutdown();
    expect(lifecycle.isAcceptingWork()).toBe(false);
    expect(order).toEqual(["producer_stopped"]);
    expect(hook.shutdown()).toBe(first);
    expect(closeResources).not.toHaveBeenCalled();
    finish();
    await task;
    expect(await first).toEqual({ status: "stopped", scope: "tracked_process_only" });
    expect(order).toEqual(["producer_stopped", "resources_closed"]);
    expect(server.close).toHaveBeenCalledOnce();
    hook.detach();
  });
  it("should leave live work and its resources alone when the drain deadline expires", async () => {
    vi.useFakeTimers();
    const lifecycle = new ApplicationLifecycle();
    let finish!: () => void;
    const task = lifecycle.run("background", () => new Promise<void>(resolve => { finish = resolve; }));
    const server = fakeServer();
    const closeResources = vi.fn(async () => {});
    const hook = attachShutdownSignals(server as never, { timeoutMs: 1000, closeResources }, lifecycle, signals());
    const outcome = hook.shutdown();
    await vi.advanceTimersByTimeAsync(1001);
    expect(await outcome).toEqual({ status: "incomplete", scope: "tracked_process_only" });
    expect(lifecycle.snapshot().active).toBe(1);
    expect(closeResources).not.toHaveBeenCalled();
    expect(server.close).not.toHaveBeenCalled();
    finish();
    await task;
    expect((await hook.shutdown()).status).toBe("incomplete");
    expect(lifecycle.isAcceptingWork()).toBe(false);
    hook.detach();
  });
  it("should not close resources if a producer cannot be stopped", async () => {
    const lifecycle = new ApplicationLifecycle();
    lifecycle.registerStop(() => { throw new Error("fixture_stop_failure"); });
    const closeResources = vi.fn(async () => {});
    const hook = attachShutdownSignals(fakeServer() as never, { timeoutMs: 1000, closeResources }, lifecycle, signals());
    expect((await hook.shutdown()).status).toBe("incomplete");
    expect(closeResources).not.toHaveBeenCalled();
    hook.detach();
  });
  it("should report resource failure instead of a successful process stop", async () => {
    const lifecycle = new ApplicationLifecycle();
    const hook = attachShutdownSignals(fakeServer() as never, {
      timeoutMs: 1000,
      closeResources: async () => { throw new Error("fixture_resource_failure"); },
    }, lifecycle, signals());
    expect((await hook.shutdown()).status).toBe("incomplete");
    expect(lifecycle.isAcceptingWork()).toBe(false);
    hook.detach();
  });
  it("should bound the entire close phase without cancelling a late resource completion", async () => {
    vi.useFakeTimers();
    const lifecycle = new ApplicationLifecycle();
    let finish!: () => void;
    let completed = false;
    const hook = attachShutdownSignals(fakeServer() as never, {
      timeoutMs: 1000,
      closeResources: async () => { await new Promise<void>(resolve => { finish = resolve; }); completed = true; },
    }, lifecycle, signals());
    const outcome = hook.shutdown();
    await vi.advanceTimersByTimeAsync(1001);
    expect((await outcome).status).toBe("incomplete");
    expect(completed).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(true);
    expect((await hook.shutdown()).status).toBe("incomplete");
    hook.detach();
  });
  it("should withhold pool closure when a late queue event invalidates the drain", async () => {
    const lifecycle = new ApplicationLifecycle();
    const closePool = vi.fn(async () => {});
    const hook = attachShutdownSignals(fakeServer() as never, {
      timeoutMs: 1000,
      closeResources: async isStillDrained => {
        lifecycle.registerStop(() => { throw new Error("fixture_late_acquisition"); });
        if (!isStillDrained()) throw new Error("drain_proof_invalidated");
        await closePool();
      },
    }, lifecycle, signals());
    expect((await hook.shutdown()).status).toBe("incomplete");
    expect(closePool).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().state).toBe("incomplete");
    hook.detach();
  });
  it("should revalidate final proof even if a resource closer resolves after a late failure", async () => {
    const lifecycle = new ApplicationLifecycle();
    const hook = attachShutdownSignals(fakeServer() as never, {
      timeoutMs: 1000,
      closeResources: async () => {
        lifecycle.registerStop(() => { throw new Error("fixture_late_failure"); });
      },
    }, lifecycle, signals());
    expect((await hook.shutdown()).status).toBe("incomplete");
    hook.detach();
  });
  it("should close the pools without touching a server that never listened", async () => {
    // Startup met the fence and skipped its listen: server.close() would fail
    // with ERR_SERVER_NOT_RUNNING and leave the process reporting incomplete.
    const lifecycle = new ApplicationLifecycle();
    const server = fakeServer(false);
    const closeResources = vi.fn(async () => {});
    const hook = attachShutdownSignals(server as never, { timeoutMs: 1000, closeResources }, lifecycle, signals());
    expect(await hook.shutdown()).toEqual({ status: "stopped", scope: "tracked_process_only" });
    expect(closeResources).toHaveBeenCalledOnce();
    expect(server.close).not.toHaveBeenCalled();
    hook.detach();
  });
  it("should detach only its own signal listeners", () => {
    const emitter = signals();
    const other = vi.fn();
    emitter.on("SIGTERM", other);
    const hook = attachShutdownSignals(fakeServer() as never, { timeoutMs: 1000, closeResources: async () => {} }, new ApplicationLifecycle(), emitter);
    expect(emitter.listenerCount("SIGTERM")).toBe(2);
    hook.detach();
    expect(emitter.listenerCount("SIGTERM")).toBe(1);
    expect(emitter.listeners("SIGTERM")).toEqual([other]);
  });
});
