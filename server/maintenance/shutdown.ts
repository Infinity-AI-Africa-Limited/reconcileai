import type { Server } from "node:http";
import { applicationLifecycle, type ApplicationLifecycle } from "./lifecycle";

type SignalSource = {
  once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
};
export type ShutdownResult = {
  status: "stopped" | "incomplete";
  scope: "tracked_process_only";
};

/** Deadline bounds the wait. Neither a handler nor resource close is cancelled by it. */
async function withinDeadline(work: Promise<void>, remainingMs: number): Promise<boolean> {
  if (remainingMs <= 0) { void work.catch(() => {}); return false; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), remainingMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** No process.exit(), queue purge, database query, provider call or runtime resume switch. */
export function attachShutdownSignals(
  server: Pick<Server, "close" | "closeIdleConnections">,
  options: { timeoutMs: number; closeResources: (isStillDrained: () => boolean) => Promise<void> },
  lifecycle: ApplicationLifecycle = applicationLifecycle,
  signals: SignalSource = process,
): { shutdown: () => Promise<ShutdownResult>; detach: () => void } {
  let inFlight: Promise<ShutdownResult> | undefined;
  const isStillDrained = () => {
    const snapshot = lifecycle.snapshot();
    return snapshot.state === "drained" && snapshot.active === 0 && snapshot.stopFailures === 0;
  };
  const shutdown = (): Promise<ShutdownResult> => {
    if (inFlight) return inFlight;
    lifecycle.beginDrain(); // synchronous admission fence and producer stops
    const deadline = Date.now() + options.timeoutMs;
    inFlight = (async (): Promise<ShutdownResult> => {
      const drain = await lifecycle.drain(options.timeoutMs);
      if (drain.status !== "drained" || !isStillDrained()) return { status: "incomplete", scope: "tracked_process_only" };
      // Do not close pools or HTTP sockets while known tasks still use them.
      const closing = Promise.all([
        Promise.resolve().then(() => {
          if (!isStillDrained()) throw new Error("drain_proof_invalidated");
          return options.closeResources(isStillDrained);
        }),
        new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections();
        }),
      ]).then(() => {});
      const closed = await withinDeadline(closing, deadline - Date.now());
      return { status: closed && isStillDrained() ? "stopped" : "incomplete", scope: "tracked_process_only" };
    })().catch((): ShutdownResult => ({ status: "incomplete", scope: "tracked_process_only" }));
    return inFlight;
  };
  const onSignal = () => {
    void shutdown().then(result => {
      console.log(`[shutdown] ${result.status}; scope=tracked_process_only`);
      // Timeout/failure leaves the process fenced. A platform may still kill it;
      // that must NEVER be used as drain/export authorisation.
      process.exitCode = result.status === "stopped" ? 0 : 1;
    });
  };
  signals.once("SIGTERM", onSignal);
  signals.once("SIGINT", onSignal);
  return {
    shutdown,
    detach: () => { signals.off("SIGTERM", onSignal); signals.off("SIGINT", onSignal); },
  };
}
