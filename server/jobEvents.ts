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
  /**
   * The tenant that owns the job this event describes. REQUIRED.
   *
   * The event carried no tenant at all, and `/api/monitoring/stream` relayed
   * every event to every authenticated client — so one bank's operator watched
   * another bank's reconciliation runs go past, including the phase messages,
   * which read "Completed: 84,229 matched, 11 exceptions, 92.3% match rate".
   * Job ids, volumes and match quality are exactly the figures a competitor
   * would want.
   *
   * Required rather than optional so that a new emit site cannot omit it: an
   * optional field would default to undefined, and undefined compared against a
   * viewer's null organizationId is a delivery decision made by accident.
   * `null` means a genuinely org-less job and is matched only by an org-less
   * viewer, exactly as `orgFilter` treats null everywhere else.
   */
  organizationId: number | null;
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

/**
 * May this viewer receive this event?
 *
 * Exported and pure so the rule is testable without opening an HTTP stream —
 * the leak it replaces was invisible to every existing ratchet precisely
 * because it lived in an Express handler rather than in db.ts or routers.ts.
 *
 * Strict equality, with no super-admin bypass. A super admin inspecting a
 * specific tenant enters that tenant's portal, which is the same line
 * `navFor` draws; a live firehose of every tenant's job activity is not
 * something any role needs by default.
 */
export function mayReceiveJobEvent(
  event: Pick<JobProgressEvent, "organizationId">,
  viewerOrganizationId: number | null,
): boolean {
  return event.organizationId === viewerOrganizationId;
}
