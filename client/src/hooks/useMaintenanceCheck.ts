import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { assessReadings, describeReadings, type Reading, type ReadingsStatus } from "@/lib/maintenanceCheck";

export type WorkloadReport = inferRouterOutputs<AppRouter>["maintenanceCheck"]["runWorkloadCheck"];

/** Readings kept on the page: enough to judge the latest three, and a short history. */
const KEPT = 10;

/**
 * The maintenance check's readings for this page visit. Each press runs one
 * reading on the server; nothing runs on load, on focus or on a timer. Readings
 * live only in this page's memory: nothing is stored.
 */
export function useMaintenanceCheck(): {
  latest: WorkloadReport | null;
  reports: WorkloadReport[];
  status: ReadingsStatus;
  summary: string;
  run: () => void;
  running: boolean;
  error: string | null;
} {
  const [reports, setReports] = useState<WorkloadReport[]>([]);
  const mutation = trpc.maintenanceCheck.runWorkloadCheck.useMutation({
    onSuccess: report => setReports(previous => [...previous, report].slice(-KEPT)),
  });
  const readings: Reading[] = reports.map(report => ({ checkedAt: report.checkedAt, verdict: report.verdict }));
  const status = assessReadings(readings, Date.now());
  return {
    latest: reports.at(-1) ?? null,
    reports,
    status,
    summary: describeReadings(status),
    run: () => mutation.mutate(),
    running: mutation.isPending,
    error: mutation.error ? mutation.error.message : null,
  };
}
