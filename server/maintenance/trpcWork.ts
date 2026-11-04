import { TRPCError } from "@trpc/server";
import { applicationLifecycle, MaintenanceAdmissionError } from "./lifecycle";

/**
 * Track one phase of a tRPC request (context creation, or a procedure) for its
 * real promise lifetime.
 *
 * The HTTP admission lease ends when the client disconnects; this does not. So
 * a drain cannot report idle, and the pools cannot close, while authentication
 * is still writing `lastSignedIn` for a caller that has already gone.
 *
 * A refused admission is a 503 the client can retry, not a server fault, so it
 * leaves as SERVICE_UNAVAILABLE and `logProcedureFailure` does not log it.
 */
export async function runTrpcWork<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await applicationLifecycle.run("request", operation);
  } catch (error) {
    if (!(error instanceof MaintenanceAdmissionError)) throw error;
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "maintenance_unavailable" });
  }
}
