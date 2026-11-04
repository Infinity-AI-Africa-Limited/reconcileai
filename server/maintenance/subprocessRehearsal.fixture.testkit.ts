import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fixtureConfig, parseCommand, type FixtureEvent } from "./subprocessRehearsal.testkit";
import { asyncHandler } from "../_core/asyncHandler";

/**
 * TEST ONLY: injected synthetic HTTP/queue handlers, not reconciliation runners.
 * The pure route wrapper is statically visible to the existing route ratchet.
 * Guards precede dependency-touching imports. No bootstrap, routers, DB or providers.
 */
async function main() {
  const { queueName, timeoutMs } = fixtureConfig(process.env);
  if (!process.send) throw new Error("rehearsal_requires_ipc");
  const emit = (value: FixtureEvent) => { process.send?.(value); };
  const [
    { default: express }, { maintenanceAdmission },
    { applicationLifecycle, MaintenanceAdmissionError }, { attachShutdownSignals }, { createQueue },
  ] = await Promise.all([
    import("express"), import("./httpAdmission"),
    import("./lifecycle"), import("./shutdown"), import("../jobQueue"),
  ]);

  const httpGate = deferred();
  const jobGate = deferred();
  let resourcesClosed = false;
  let effects = 0;
  const app = express();
  app.disable("x-powered-by");
  app.use(maintenanceAdmission());
  app.get("/api/healthz", (_req, res) => { res.json({ code: "synthetic_alive" }); });
  app.get("/api/readyz", (_req, res) => {
    res.status(applicationLifecycle.isAcceptingWork() ? 200 : 503).json({ code: "synthetic_readiness" });
  });
  app.post("/synthetic/work", asyncHandler(async (_req, res) => {
    res.status(202).json({ code: "synthetic_accepted" });
    emit({ event: "http_started" });
    // Response finish must NOT release asyncHandler's real promise reservation.
    await httpGate.promise;
    await applicationLifecycle.run("background", async () => { effects += 1; });
    emit({ event: "http_settled" });
  }));
  app.use((_req, res) => { res.status(404).json({ code: "synthetic_not_found" }); });
  const server = createServer(app);
  const queue = await createQueue<{ synthetic: true }>(queueName, async job => {
    if (job.data?.synthetic !== true || Object.keys(job.data).join(",") !== "synthetic" ||
        !["synthetic-active", "synthetic-waiting", "synthetic-retry", "synthetic-peer"].includes(job.name)) {
      throw new Error("rehearsal_requires_synthetic_job");
    }
    const logicalName = job.name.slice("synthetic-".length);
    emit({ event: "job_started", job: logicalName, attempt: job.attempt });
    if (logicalName === "active") await jobGate.promise;
    if (logicalName === "retry" && job.attempt === 1) throw new Error("synthetic_retry_once");
    effects += 1;
    emit({ event: "job_settled", job: logicalName, attempt: job.attempt });
  }, { requireDurable: true, uniqueJobNames: true, concurrency: 1, attempts: 2, backoffMs: 10 });
  if (queue.backend !== "bullmq") throw new Error("rehearsal_requires_bullmq");

  const hook = attachShutdownSignals(server, {
    timeoutMs,
    closeResources: async isStillDrained => {
      if (!isStillDrained()) throw new Error("rehearsal_drain_proof_invalidated");
      await queue.close();
      resourcesClosed = true;
      emit({ event: "resources_closed" });
    },
  });
  const snapshot = () => ({ ...applicationLifecycle.snapshot(), resourcesClosed, listening: server.listening, effects });
  let signalObserved = false;
  const observedSignal = () => {
    if (signalObserved) return;
    signalObserved = true;
    // The shipped signal listener precedes this observer and fences synchronously.
    emit({ event: "fenced", ...snapshot() });
    void hook.shutdown().then(result => {
      const event = { event: "shutdown_result", ...result, ...snapshot() };
      if (result.status === "stopped") {
        hook.detach();
        // Drain the IPC send, then disconnect; natural process exit is asserted by the parent.
        process.send?.(event, () => { process.disconnect?.(); });
      } else {
        emit(event); // Keep IPC/server/queue alive and fenced; no exit or resume switch.
      }
    });
  };
  process.once("SIGTERM", observedSignal);
  process.once("SIGINT", observedSignal);
  process.on("message", value => {
    void (async () => {
      const { id, command } = parseCommand(value);
      if (command === "snapshot") {
        emit({ event: "command_result", id, ...snapshot() });
      } else if (command === "release_http") {
        httpGate.resolve();
        emit({ event: "command_result", id, status: "released" });
      } else if (command === "release_job") {
        jobGate.resolve();
        emit({ event: "command_result", id, status: "released" });
      } else {
        const name = command.slice("enqueue_".length);
        try {
          // uniqueJobNames also supplies BullMQ's Redis job id. Bare "active"
          // would alias its internal :active list, not a job hash.
          await queue.enqueue(`synthetic-${name}`, { synthetic: true });
          emit({ event: "command_result", id, status: "enqueued" });
        } catch (error) {
          if (!(error instanceof MaintenanceAdmissionError)) throw error;
          emit({ event: "command_result", id, status: "maintenance_unavailable" });
        }
      }
    })().catch(fail);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  emit({ event: "ready", port: (server.address() as AddressInfo).port, backend: queue.backend });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fail() {
  // Fixed diagnostics only; a failed fixture is killed/awaited by its owner.
  process.exitCode = 1;
  process.send?.({ event: "fixture_failed" });
}
void main().catch(fail);
