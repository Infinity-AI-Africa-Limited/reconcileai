import { AsyncLocalStorage } from "node:async_hooks";

export type WorkKind =
  | "request"
  | "background"
  | "queue-handler"
  | "queue-operation"
  | "startup";

type LifecycleState = "running" | "draining" | "drained" | "incomplete";
type DrainResult = {
  status: "drained" | "incomplete";
  active: number;
  stopFailures: number;
};
type Stop = () => void | Promise<void>;
type WorkToken = { live: boolean; kind: WorkKind };

/** Safe to expose at an admission boundary; never contains operation details. */
export class MaintenanceAdmissionError extends Error {
  readonly code = "maintenance_unavailable";

  constructor() {
    super("Application is not accepting new work.");
    this.name = "MaintenanceAdmissionError";
  }
}

/**
 * Process-local proof about explicitly tracked work, not a distributed lock.
 * Stop callbacks stop producers; resource closure belongs AFTER drain completes.
 * No task, payload or caught error is retained in diagnostics or logged here.
 */
export class ApplicationLifecycle {
  private readonly context = new AsyncLocalStorage<WorkToken>();
  private readonly stops = new Set<{ stop: Stop }>();
  private state: LifecycleState = "running";
  private active = 0;
  private stopFailures = 0;
  private pendingStops = 0;
  private dispatchDepth = 0;
  private drainPromise?: Promise<DrainResult>;
  private checkDrain?: () => void;

  /** Reports root admission, even when called inside an admitted task. */
  isAcceptingWork(): boolean {
    return this.state === "running";
  }

  async run<T>(kind: WorkKind, operation: () => Promise<T>): Promise<T> {
    const token = this.reserve(kind);
    try {
      // Deliberately synchronous invocation: admission precedes all task effects.
      return await this.context.run(token, operation);
    } finally {
      this.release(token);
    }
  }

  /** Reserve a response lifetime; the HTTP adapter releases on finish/close. */
  enterRequest(operation: () => void): { release: () => void } {
    const token = this.reserve("request");
    const release = () => this.release(token);
    try {
      this.context.run(token, operation);
      return { release };
    } catch (error) {
      release();
      throw error;
    }
  }

  beginDrain(): void {
    if (this.state !== "running") return;
    this.state = "draining";
    // Hold completion across the whole batch, including reentrant registration.
    this.dispatchDepth += 1;
    const stops = [...this.stops];
    this.stops.clear();
    try {
      for (const { stop } of stops) this.invokeStop(stop);
    } finally {
      this.dispatchDepth -= 1;
      this.checkDrain?.();
    }
  }

  registerStop(stop: Stop): () => void {
    const registration = { stop };
    if (this.state === "running") {
      this.stops.add(registration);
    } else {
      // Registration after the fence cannot leave a producer running unnoticed.
      this.invokeStop(stop);
    }
    // Unregister prevents a future invocation, never cancels an invoked callback.
    return () => { this.stops.delete(registration); };
  }

  drain(timeoutMs: number): Promise<DrainResult> {
    if (this.drainPromise) return this.drainPromise;
    // A late callback can invalidate an earlier successful proof, never reopen it.
    if (this.state === "drained" && !this.isIdle()) this.state = "incomplete";
    if (this.state === "drained" || this.state === "incomplete") {
      return Promise.resolve(this.result(this.state));
    }

    let resolve!: (result: DrainResult) => void;
    const promise = new Promise<DrainResult>(done => { resolve = done; });
    // Publish BEFORE beginDrain: a stop callback may reenter drain synchronously.
    this.drainPromise = promise;
    // Invalid budgets fail closed; clamp to Node's maximum timer duration.
    const budget = Number.isFinite(timeoutMs)
      ? Math.max(0, Math.min(timeoutMs, 2_147_483_647))
      : 0;
    const finish = (status: DrainResult["status"]) => {
      clearTimeout(timer);
      this.state = status;
      this.checkDrain = undefined;
      this.drainPromise = undefined;
      resolve(this.result(status));
    };
    // A deadline ends ONLY this wait. Work and stop promises remain tracked.
    const timer = setTimeout(() => finish("incomplete"), budget);
    this.checkDrain = () => {
      if (this.isIdle()) finish(this.stopFailures === 0 ? "drained" : "incomplete");
    };
    this.beginDrain();
    this.checkDrain?.();
    return promise;
  }

  snapshot(): { state: LifecycleState; active: number; stopFailures: number } {
    return { state: this.state, active: this.active, stopFailures: this.stopFailures };
  }

  private reserve(kind: WorkKind): WorkToken {
    if (this.state !== "running" && !this.context.getStore()?.live) {
      throw new MaintenanceAdmissionError();
    }
    const token = { live: true, kind };
    this.active += 1;
    return token;
  }

  private release(token: WorkToken): void {
    if (!token.live) return;
    token.live = false;
    this.active -= 1;
    this.checkDrain?.();
  }

  private invokeStop(stop: Stop): void {
    const wasDrained = this.state === "drained";
    this.pendingStops += 1;
    this.dispatchDepth += 1;
    try {
      // Stopping producers must not borrow the caller's live admission token.
      const result = this.context.exit(stop);
      if (result === undefined) {
        this.pendingStops -= 1;
      } else {
        void Promise.resolve(result).then(
          () => this.settleStop(false),
          () => this.settleStop(true),
        );
      }
    } catch {
      this.pendingStops -= 1;
      this.stopFailures += 1;
    } finally {
      this.dispatchDepth -= 1;
      if (wasDrained && (this.pendingStops > 0 || this.stopFailures > 0)) {
        this.state = "incomplete";
      }
      this.checkDrain?.();
    }
  }

  private settleStop(failed: boolean): void {
    this.pendingStops -= 1;
    if (failed) this.stopFailures += 1;
    this.checkDrain?.();
  }

  private isIdle(): boolean {
    return this.active === 0 && this.pendingStops === 0 && this.dispatchDepth === 0;
  }

  private result(status: DrainResult["status"]): DrainResult {
    return { status, active: this.active, stopFailures: this.stopFailures };
  }
}

export const applicationLifecycle = new ApplicationLifecycle();

const BACKGROUND_WORK_FAILED = "maintenance_background_work_failed";

/** Fire-and-forget only work the caller already chose to launch; no scheduling. */
export function runBackgroundWork(operation: () => Promise<unknown>): void {
  void applicationLifecycle.run("background", operation).catch(error => {
    if (error instanceof MaintenanceAdmissionError) return;
    // Never inspect or stringify rejection values: they can carry customer data.
    console.error(BACKGROUND_WORK_FAILED);
  });
}
