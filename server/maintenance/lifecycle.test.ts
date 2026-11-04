import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationLifecycle,
  MaintenanceAdmissionError,
  applicationLifecycle,
  runBackgroundWork,
  type WorkKind,
} from "./lifecycle";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

let lifecycle: ApplicationLifecycle;
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  lifecycle = new ApplicationLifecycle();
  vi.useFakeTimers();
  logs = ["error", "warn", "log", "info", "debug"].map(method =>
    vi.spyOn(console, method as "error").mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("when root work is admitted", () => {
  it("should export an initially running process singleton", () => {
    expect(applicationLifecycle).toBeInstanceOf(ApplicationLifecycle);
    expect(applicationLifecycle.isAcceptingWork()).toBe(true);
    expect(lifecycle.snapshot()).toEqual({ state: "running", active: 0, stopFailures: 0 });
  });

  it.each<WorkKind>(["request", "background", "queue-handler", "queue-operation", "startup"])(
    "should reserve %s synchronously before invoking its operation",
    async kind => {
      const gate = deferred<number>();
      const operation = vi.fn(() => {
        expect(lifecycle.snapshot().active).toBe(1);
        return gate.promise;
      });
      const work = lifecycle.run(kind, operation);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(lifecycle.snapshot().active).toBe(1);
      gate.resolve(42);
      await expect(work).resolves.toBe(42);
      expect(lifecycle.snapshot().active).toBe(0);
    },
  );

  it("should release on rejection while propagating the original value without logs", async () => {
    const rejection = { customerPayload: "sensitive-test-value" };
    const gate = deferred();
    const work = lifecycle.run("background", () => gate.promise);
    const assertion = expect(work).rejects.toBe(rejection);
    gate.reject(rejection);
    await assertion;
    expect(lifecycle.snapshot()).toEqual({ state: "running", active: 0, stopFailures: 0 });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("should reject an original synchronous throw and release its reservation", async () => {
    const error = new Error("sensitive-test-message");
    const operation = vi.fn(() => { throw error; });
    const work = lifecycle.run("startup", operation);
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(work).rejects.toBe(error);
    expect(lifecycle.snapshot().active).toBe(0);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("should return isolated payload-free snapshots", async () => {
    const gate = deferred<{ payload: string }>();
    const work = lifecycle.run("queue-handler", () => gate.promise);
    const snapshot = lifecycle.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual(["active", "state", "stopFailures"]);
    snapshot.active = 999;
    snapshot.state = "drained";
    expect(lifecycle.snapshot()).toEqual({ state: "running", active: 1, stopFailures: 0 });
    gate.resolve({ payload: "sensitive-test-value" });
    await work;
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("when the admission fence closes", () => {
  it.each<WorkKind>(["request", "background", "queue-handler", "queue-operation", "startup"])(
    "should reject new root %s work without invoking it",
    async kind => {
      lifecycle.beginDrain();
      const operation = vi.fn(async () => undefined);
      await expect(lifecycle.run(kind, operation)).rejects.toBeInstanceOf(MaintenanceAdmissionError);
      expect(operation).not.toHaveBeenCalled();
      expect(lifecycle.isAcceptingWork()).toBe(false);
      expect(lifecycle.snapshot()).toEqual({ state: "draining", active: 0, stopFailures: 0 });
    },
  );

  it("should expose only a constant generic admission error", async () => {
    lifecycle.beginDrain();
    const error = await lifecycle.run("request", async () => undefined).catch(value => value);
    expect(error).toBeInstanceOf(MaintenanceAdmissionError);
    expect(error.name).toBe("MaintenanceAdmissionError");
    expect(error.code).toBe("maintenance_unavailable");
    expect(error.message).toBe("Application is not accepting new work.");
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("should admit nested late descendants while their own parent token is live", async () => {
    const parentGate = deferred();
    const childGate = deferred();
    const grandchildGate = deferred();
    let child!: Promise<void>;
    let grandchild!: Promise<void>;
    const parent = lifecycle.run("request", async () => {
      await parentGate.promise;
      expect(lifecycle.isAcceptingWork()).toBe(false);
      child = lifecycle.run("queue-handler", async () => {
        await childGate.promise;
        // The request has settled; this child still owns a live token.
        grandchild = lifecycle.run("queue-operation", () => grandchildGate.promise);
      });
    });
    const drain = lifecycle.drain(1_000);
    let completed = false;
    void drain.then(() => { completed = true; });
    parentGate.resolve(undefined);
    await parent;
    expect(lifecycle.snapshot().active).toBe(1);
    childGate.resolve(undefined);
    await child;
    expect(lifecycle.snapshot().active).toBe(1);
    expect(completed).toBe(false);
    grandchildGate.resolve(undefined);
    await grandchild;
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should reject an expired ALS descendant while unrelated tracked work remains", async () => {
    const unrelatedGate = deferred();
    const unrelated = lifecycle.run("startup", () => unrelatedGate.promise);
    const descendantGate = deferred();
    const operation = vi.fn(async () => undefined);
    let late!: Promise<unknown>;
    await lifecycle.run("request", async () => {
      late = descendantGate.promise.then(() => lifecycle.run("background", operation)).catch(error => error);
    });
    const drain = lifecycle.drain(1_000);
    descendantGate.resolve(undefined);
    await expect(late).resolves.toBeInstanceOf(MaintenanceAdmissionError);
    expect(operation).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(1);
    unrelatedGate.resolve(undefined);
    await unrelated;
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should reject timer descendants created before their parent settles", async () => {
    const late = deferred<unknown>();
    const operation = vi.fn(async () => undefined);
    await lifecycle.run("request", async () => {
      setTimeout(() => {
        void lifecycle.run("background", operation).catch(error => late.resolve(error));
      }, 10);
    });
    await lifecycle.drain(100);
    await vi.advanceTimersByTimeAsync(10);
    await expect(late.promise).resolves.toBeInstanceOf(MaintenanceAdmissionError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("should not let another lifecycle borrow the caller's admission token", async () => {
    const other = new ApplicationLifecycle();
    other.beginDrain();
    await lifecycle.run("request", async () => {
      await expect(other.run("background", async () => undefined)).rejects.toBeInstanceOf(MaintenanceAdmissionError);
    });
  });
});

describe("when startup runs as root work", () => {
  it("should hold the drain open until startup settles", async () => {
    const gate = deferred();
    const startup = lifecycle.runRoot("startup", () => gate.promise);
    expect(lifecycle.snapshot()).toEqual({ state: "running", active: 1, stopFailures: 0 });
    let settled = false;
    const drain = lifecycle.drain(1_000).then(result => { settled = true; return result; });
    await flushMicrotasks();
    expect(settled).toBe(false);
    gate.resolve(undefined);
    await startup;
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should not lend its admission to work it launches after the fence", async () => {
    // A request may finish its own effects after the fence; a booting server
    // must not start new writers because it happened to be mid-startup.
    const gate = deferred();
    const lateWriter = vi.fn(async () => undefined);
    let launched!: Promise<unknown>;
    const startup = lifecycle.runRoot("startup", async () => {
      await gate.promise;
      launched = lifecycle.run("background", lateWriter).catch(error => error);
    });
    const drain = lifecycle.drain(1_000);
    gate.resolve(undefined);
    await startup;
    await expect(launched).resolves.toBeInstanceOf(MaintenanceAdmissionError);
    expect(lateWriter).not.toHaveBeenCalled();
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should still track work it launched before the fence", async () => {
    const writerGate = deferred();
    let writer!: Promise<void>;
    const startup = lifecycle.runRoot("startup", async () => {
      writer = lifecycle.run("background", () => writerGate.promise);
    });
    await startup;
    const drain = lifecycle.drain(1_000);
    await flushMicrotasks();
    expect(lifecycle.snapshot()).toMatchObject({ state: "draining", active: 1 });
    writerGate.resolve(undefined);
    await writer;
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should refuse to start once the fence is up, even from inside admitted work", async () => {
    const operation = vi.fn(async () => undefined);
    await lifecycle.run("request", async () => {
      lifecycle.beginDrain();
      await expect(lifecycle.runRoot("startup", operation)).rejects.toBeInstanceOf(MaintenanceAdmissionError);
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it("should release its reservation when startup fails", async () => {
    await expect(lifecycle.runRoot("startup", async () => { throw new Error("fixture_startup_failure"); }))
      .rejects.toThrow("fixture_startup_failure");
    expect(lifecycle.snapshot().active).toBe(0);
  });
});

describe("when HTTP request lifetimes are reserved", () => {
  it("should invoke middleware synchronously after reservation and release idempotently", async () => {
    const operation = vi.fn(() => { expect(lifecycle.snapshot().active).toBe(1); });
    const request = lifecycle.enterRequest(operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    request.release();
    request.release();
    request.release();
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should automatically release and propagate an original synchronous middleware error", () => {
    const error = { payload: "sensitive-test-value" };
    let thrown: unknown;
    try {
      lifecycle.enterRequest(() => { throw error; });
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
    expect(lifecycle.snapshot().active).toBe(0);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("should reject fenced HTTP reservations without invoking middleware", () => {
    lifecycle.beginDrain();
    const operation = vi.fn();
    expect(() => lifecycle.enterRequest(operation)).toThrow(MaintenanceAdmissionError);
    expect(operation).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(0);
  });

  it("should retain live request ALS scope until release and track detached children", async () => {
    const startChild = deferred();
    const childGate = deferred();
    let child!: Promise<void>;
    const request = lifecycle.enterRequest(() => {
      child = startChild.promise.then(() => lifecycle.run("background", () => childGate.promise));
    });
    const drain = lifecycle.drain(100);
    startChild.resolve(undefined);
    await flushMicrotasks();
    expect(lifecycle.snapshot().active).toBe(2);
    request.release();
    expect(lifecycle.snapshot().active).toBe(1);
    childGate.resolve(undefined);
    await child;
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should fence asynchronous descendants after an HTTP response is released", async () => {
    const gate = deferred();
    const operation = vi.fn(async () => undefined);
    let late!: Promise<unknown>;
    const request = lifecycle.enterRequest(() => {
      late = gate.promise.then(() => lifecycle.run("background", operation)).catch(error => error);
    });
    lifecycle.beginDrain();
    request.release();
    gate.resolve(undefined);
    await expect(late).resolves.toBeInstanceOf(MaintenanceAdmissionError);
    expect(operation).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(0);
  });
});

describe("when producers register stop callbacks", () => {
  it("should invoke every stop immediately behind the fence and only once", async () => {
    const stop = vi.fn(() => { expect(lifecycle.isAcceptingWork()).toBe(false); });
    lifecycle.registerStop(stop);
    lifecycle.beginDrain();
    expect(stop).toHaveBeenCalledTimes(1);
    lifecycle.beginDrain();
    await lifecycle.drain(100);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("should honor idempotent unregister before the fence closes", async () => {
    const stop = vi.fn();
    const unregister = lifecycle.registerStop(stop);
    unregister();
    unregister();
    await lifecycle.drain(100);
    expect(stop).not.toHaveBeenCalled();
  });

  it("should register the same function independently for each producer", async () => {
    const stop = vi.fn();
    const unregister = lifecycle.registerStop(stop);
    lifecycle.registerStop(stop);
    unregister();
    await lifecycle.drain(100);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("should await all stop promises without counting them as active work", async () => {
    const first = deferred();
    const second = deferred();
    lifecycle.registerStop(() => first.promise);
    lifecycle.registerStop(() => second.promise);
    const drain = lifecycle.drain(100);
    let settled = false;
    void drain.then(() => { settled = true; });
    expect(lifecycle.snapshot()).toEqual({ state: "draining", active: 0, stopFailures: 0 });
    first.resolve(undefined);
    await flushMicrotasks();
    expect(settled).toBe(false);
    second.resolve(undefined);
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should invoke late registrations immediately and keep their promises in the same drain", async () => {
    const gate = deferred();
    const work = lifecycle.run("startup", () => gate.promise);
    const drain = lifecycle.drain(100);
    const stopGate = deferred();
    const stop = vi.fn(() => stopGate.promise);
    const unregister = lifecycle.registerStop(stop);
    expect(stop).toHaveBeenCalledTimes(1);
    unregister();
    gate.resolve(undefined);
    await work;
    expect(lifecycle.snapshot().state).toBe("draining");
    stopGate.resolve(undefined);
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("should invoke late registrations even when beginDrain preceded the drain wait", async () => {
    lifecycle.beginDrain();
    const gate = deferred();
    const stop = vi.fn(() => gate.promise);
    lifecycle.registerStop(stop);
    expect(stop).toHaveBeenCalledTimes(1);
    const drain = lifecycle.drain(100);
    expect(lifecycle.snapshot().state).toBe("draining");
    gate.resolve(undefined);
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should count synchronous throws and asynchronous rejections without retaining or logging values", async () => {
    const error = { query: "sensitive-test-query", payload: "sensitive-test-value" };
    const gate = deferred();
    lifecycle.registerStop(() => { throw error; });
    lifecycle.registerStop(() => gate.promise);
    const last = vi.fn();
    lifecycle.registerStop(last);
    const drain = lifecycle.drain(100);
    expect(last).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot().stopFailures).toBe(1);
    gate.reject(error);
    await expect(drain).resolves.toEqual({ status: "incomplete", active: 0, stopFailures: 2 });
    expect(lifecycle.snapshot()).toEqual({ state: "incomplete", active: 0, stopFailures: 2 });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("should track a rejected late stop promise registered from another stop callback", async () => {
    const gate = deferred();
    const lateStop = vi.fn(() => gate.promise);
    lifecycle.registerStop(() => { lifecycle.registerStop(lateStop); });
    const drain = lifecycle.drain(100);
    expect(lateStop).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot().state).toBe("draining");
    gate.reject(new Error("sensitive-test-message"));
    await expect(drain).resolves.toEqual({ status: "incomplete", active: 0, stopFailures: 1 });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("should publish one drain before reentrant stop callbacks can request it", async () => {
    const gate = deferred();
    let reentrant!: ReturnType<ApplicationLifecycle["drain"]>;
    lifecycle.registerStop(() => { reentrant = lifecycle.drain(0); });
    lifecycle.registerStop(() => gate.promise);
    const drain = lifecycle.drain(100);
    expect(reentrant).toBe(drain);
    expect(lifecycle.snapshot().state).toBe("draining");
    await vi.advanceTimersByTimeAsync(1);
    expect(lifecycle.snapshot().state).toBe("draining");
    gate.resolve(undefined);
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should not finish a reentrant drain before the entire beginDrain callback batch runs", async () => {
    const gate = deferred();
    let drain!: ReturnType<ApplicationLifecycle["drain"]>;
    lifecycle.registerStop(() => { drain = lifecycle.drain(100); });
    lifecycle.registerStop(() => gate.promise);
    lifecycle.beginDrain();
    expect(lifecycle.snapshot().state).toBe("draining");
    gate.resolve(undefined);
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should not lend a live task's token to producer stop callbacks", async () => {
    let refused!: Promise<unknown>;
    const operation = vi.fn(async () => undefined);
    lifecycle.registerStop(() => {
      refused = lifecycle.run("background", operation).catch(error => error);
    });
    await lifecycle.run("request", async () => { lifecycle.beginDrain(); });
    await expect(refused).resolves.toBeInstanceOf(MaintenanceAdmissionError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("should invalidate an earlier successful proof when a late async stop is still pending", async () => {
    await lifecycle.drain(100);
    const gate = deferred();
    const stop = vi.fn(() => gate.promise);
    lifecycle.registerStop(stop);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot().state).toBe("incomplete");
    await expect(lifecycle.drain(100)).resolves.toEqual({ status: "incomplete", active: 0, stopFailures: 0 });
    gate.resolve(undefined);
    await flushMicrotasks();
    expect(lifecycle.snapshot().state).toBe("incomplete");
  });

  it("should record late stop failure after successful drain and never reopen admission", async () => {
    await lifecycle.drain(100);
    lifecycle.registerStop(() => { throw new Error("sensitive-test-message"); });
    expect(lifecycle.snapshot()).toEqual({ state: "incomplete", active: 0, stopFailures: 1 });
    await expect(lifecycle.drain(100)).resolves.toEqual({ status: "incomplete", active: 0, stopFailures: 1 });
    expect(lifecycle.isAcceptingWork()).toBe(false);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("when drain reaches its deadline", () => {
  it("should end only the wait and report known active work without cancelling it", async () => {
    const gate = deferred<number>();
    const work = lifecycle.run("queue-operation", () => gate.promise);
    const drain = lifecycle.drain(100);
    await vi.advanceTimersByTimeAsync(99);
    expect(lifecycle.snapshot().state).toBe("draining");
    await vi.advanceTimersByTimeAsync(1);
    await expect(drain).resolves.toEqual({ status: "incomplete", active: 1, stopFailures: 0 });
    gate.resolve(73);
    await expect(work).resolves.toBe(73);
    expect(lifecycle.snapshot()).toEqual({ state: "incomplete", active: 0, stopFailures: 0 });
    await expect(lifecycle.drain(100)).resolves.toEqual({ status: "incomplete", active: 0, stopFailures: 0 });
    await expect(lifecycle.run("startup", async () => undefined)).rejects.toBeInstanceOf(MaintenanceAdmissionError);
  });

  it("should time out an unresolved stop even when active work is zero", async () => {
    const gate = deferred();
    lifecycle.registerStop(() => gate.promise);
    const drain = lifecycle.drain(10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(drain).resolves.toEqual({ status: "incomplete", active: 0, stopFailures: 0 });
    gate.resolve(undefined);
    await flushMicrotasks();
    expect(lifecycle.snapshot()).toEqual({ state: "incomplete", active: 0, stopFailures: 0 });
    await expect(lifecycle.drain(100)).resolves.toEqual({ status: "incomplete", active: 0, stopFailures: 0 });
  });

  it("should count a stop rejection after timeout while retaining the original incomplete result", async () => {
    const gate = deferred();
    lifecycle.registerStop(() => gate.promise);
    const drain = lifecycle.drain(10);
    await vi.advanceTimersByTimeAsync(10);
    const result = await drain;
    gate.reject({ payload: "sensitive-test-value" });
    await flushMicrotasks();
    expect(result).toEqual({ status: "incomplete", active: 0, stopFailures: 0 });
    expect(lifecycle.snapshot()).toEqual({ state: "incomplete", active: 0, stopFailures: 1 });
    await expect(lifecycle.drain(100)).resolves.toEqual({ status: "incomplete", active: 0, stopFailures: 1 });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("should allow only live descendants to settle their tracked work after timeout", async () => {
    const gate = deferred();
    const parent = lifecycle.run("request", async () => {
      await gate.promise;
      await lifecycle.run("queue-operation", async () => "finished");
    });
    const drain = lifecycle.drain(10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(drain).resolves.toEqual({ status: "incomplete", active: 1, stopFailures: 0 });
    gate.resolve(undefined);
    await parent;
    expect(lifecycle.snapshot()).toEqual({ state: "incomplete", active: 0, stopFailures: 0 });
  });

  it("should invoke and track registrations made after a timeout", async () => {
    const workGate = deferred();
    const work = lifecycle.run("startup", () => workGate.promise);
    const drain = lifecycle.drain(10);
    await vi.advanceTimersByTimeAsync(10);
    await drain;
    const stopGate = deferred();
    const stop = vi.fn(() => stopGate.promise);
    lifecycle.registerStop(stop);
    expect(stop).toHaveBeenCalledTimes(1);
    stopGate.reject(new Error("sensitive-test-message"));
    workGate.resolve(undefined);
    await work;
    await flushMicrotasks();
    expect(lifecycle.snapshot()).toEqual({ state: "incomplete", active: 0, stopFailures: 1 });
  });

  it.each([0, -10, Number.NaN, Number.POSITIVE_INFINITY])(
    "should fail closed for a nonpositive or invalid budget of %s",
    async budget => {
      const gate = deferred();
      const work = lifecycle.run("startup", () => gate.promise);
      const drain = lifecycle.drain(budget);
      await vi.advanceTimersByTimeAsync(0);
      await expect(drain).resolves.toEqual({ status: "incomplete", active: 1, stopFailures: 0 });
      gate.resolve(undefined);
      await work;
    },
  );
});

describe("when drain succeeds", () => {
  it("should return one in-flight promise and keep the first caller's deadline", async () => {
    const gate = deferred();
    const work = lifecycle.run("startup", () => gate.promise);
    const first = lifecycle.drain(100);
    const second = lifecycle.drain(1);
    expect(second).toBe(first);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(lifecycle.snapshot().state).toBe("draining");
    gate.resolve(undefined);
    await work;
    await expect(first).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should succeed immediately with no work and remain successfully idempotent", async () => {
    const stop = vi.fn();
    lifecycle.registerStop(stop);
    await expect(lifecycle.drain(0)).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
    lifecycle.beginDrain();
    await expect(lifecycle.drain(100)).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(lifecycle.snapshot()).toEqual({ state: "drained", active: 0, stopFailures: 0 });
    expect(lifecycle.isAcceptingWork()).toBe(false);
  });

  it("should permit a harmless late synchronous stop without invalidating success", async () => {
    await lifecycle.drain(100);
    const stop = vi.fn();
    lifecycle.registerStop(stop);
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(lifecycle.drain(100)).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
  });

  it("should treat a task rejection as settlement, not a producer stop failure", async () => {
    const gate = deferred();
    const work = lifecycle.run("background", () => gate.promise);
    const assertion = expect(work).rejects.toEqual({ payload: "sensitive-test-value" });
    const drain = lifecycle.drain(100);
    gate.reject({ payload: "sensitive-test-value" });
    await assertion;
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("when fire-and-forget work uses the safe background wrapper", () => {
  beforeEach(() => {
    // Test helper behaviour without poisoning the process singleton for siblings.
    vi.spyOn(applicationLifecycle, "run").mockImplementation(lifecycle.run.bind(lifecycle));
  });

  it("should use background admission synchronously and track its lifetime", async () => {
    const gate = deferred();
    const operation = vi.fn(() => gate.promise);
    expect(runBackgroundWork(operation)).toBeUndefined();
    expect(applicationLifecycle.run).toHaveBeenCalledWith("background", operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    gate.resolve(undefined);
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("should silently ignore only maintenance admission errors", async () => {
    lifecycle.beginDrain();
    const operation = vi.fn(async () => undefined);
    runBackgroundWork(operation);
    await flushMicrotasks();
    expect(operation).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("should admit a background descendant of a live task after drain begins", async () => {
    const gate = deferred();
    const parent = lifecycle.run("request", async () => {
      lifecycle.beginDrain();
      runBackgroundWork(() => gate.promise);
    });
    await parent;
    expect(lifecycle.snapshot().active).toBe(1);
    const drain = lifecycle.drain(100);
    gate.resolve(undefined);
    await expect(drain).resolves.toEqual({ status: "drained", active: 0, stopFailures: 0 });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    new Error("sensitive-test-message"),
    { code: "MaintenanceAdmissionError", payload: "sensitive-test-value" },
    "sensitive-test-string",
    undefined,
  ])("should log only the fixed safe code for a non-admission rejection %#", async rejection => {
    const gate = deferred();
    runBackgroundWork(() => gate.promise);
    gate.reject(rejection);
    await flushMicrotasks();
    expect(logs[0]).toHaveBeenCalledTimes(1);
    expect(logs[0]).toHaveBeenCalledWith("maintenance_background_work_failed");
    for (const log of logs.slice(1)) expect(log).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().active).toBe(0);
  });

  it("should catch an original synchronous operation error using the same fixed code", async () => {
    runBackgroundWork(() => { throw new Error("sensitive-test-message"); });
    await flushMicrotasks();
    expect(logs[0]).toHaveBeenCalledTimes(1);
    expect(logs[0]).toHaveBeenCalledWith("maintenance_background_work_failed");
    expect(lifecycle.snapshot().active).toBe(0);
  });
});
