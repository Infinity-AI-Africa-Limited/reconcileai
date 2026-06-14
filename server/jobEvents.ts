/**
 * In-process event bus for live reconciliation job-progress streaming.
 *
 * trackProgress() (jobProgressService) emits here after persisting each progress
 * event; the GET /api/monitoring/stream SSE endpoint relays them to connected
 * dashboards in real time, replacing timer polling. Single Node process (the web
 * server and the in-process job runner share this emitter), so an EventEmitter is
 * sufficient — no Redis pub/sub needed at this stage.
 */
import { EventEmitter } from "node:events";

export type JobProgressEvent = {
  jobId: number;
  phase: string;
  progress: number;
  message: string;
  processedCount?: number;
  totalCount?: number;
};

export const jobEvents = new EventEmitter();
// One listener per open SSE connection — lift the default 10-listener cap.
jobEvents.setMaxListeners(0);

export function emitJobProgress(event: JobProgressEvent): void {
  jobEvents.emit("progress", event);
}
