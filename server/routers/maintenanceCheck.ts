import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { runWorkloadCheck, type WorkloadCheckDependencies, type WorkloadCheckReport } from "../maintenance/workloadCheck";
import { appWorkloadDependencies } from "../maintenance/workloadReaders";
import { superAdminProcedure } from "./shared";

/**
 * The maintenance workload check, for platform staff only.
 *
 * - `superAdminProcedure`: the server refuses everyone else, whatever the page
 *   shows, and the call runs outside any tenant portal.
 * - A MUTATION, although it only reads, for two reasons. The global read-only
 *   ban (server/_core/trpc.ts) refuses every non-query operation, so a
 *   read-only reviewer session cannot start a check, even a cross-tenant
 *   platform one. And a mutation runs only when someone presses the button: a
 *   query would re-run itself on focus, mount and reconnect.
 * - One check at a time per server process, and not more often than every ten
 *   seconds, so a stuck button cannot queue load against the database.
 *
 * It writes nothing: no audit row and no storage probe. The log line carries
 * who ran it and the verdict, never a count.
 */
const MIN_INTERVAL_MS = 10_000;

let running = false;
let lastStartedAt = Number.NEGATIVE_INFINITY;
let dependencies: () => WorkloadCheckDependencies = appWorkloadDependencies;

/** Tests only: swap the real connections for fakes, and reset the gates. */
export function setWorkloadCheckDependenciesForTests(factory: (() => WorkloadCheckDependencies) | null): void {
  dependencies = factory ?? appWorkloadDependencies;
  running = false;
  lastStartedAt = Number.NEGATIVE_INFINITY;
}

export const maintenanceCheckRouter = router({
  runWorkloadCheck: superAdminProcedure.mutation(async ({ ctx }): Promise<WorkloadCheckReport> => {
    if (running) {
      throw new TRPCError({ code: "CONFLICT", message: "A workload check is already running. Wait for it to finish." });
    }
    const now = Date.now();
    if (now - lastStartedAt < MIN_INTERVAL_MS) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Wait ten seconds between workload checks." });
    }
    running = true;
    lastStartedAt = now;
    try {
      const report = await runWorkloadCheck(dependencies());
      console.info(`[maintenance-check] user ${ctx.user.id}: ${report.verdict} in ${report.elapsedMs}ms`);
      return report;
    } finally {
      running = false;
    }
  }),
});
