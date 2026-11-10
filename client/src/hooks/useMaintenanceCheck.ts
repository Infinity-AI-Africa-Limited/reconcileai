import { useEffect, useRef, useState } from "react";
import { onlineManager } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import {
  CheckController,
  describeSession,
  evidenceOf,
  MAINTENANCE_MUTATION_OPTIONS,
  type CheckSession,
  type Evidence,
} from "@/lib/maintenanceCheckSession";

export type WorkloadReport = inferRouterOutputs<AppRouter>["maintenanceCheck"]["runWorkloadCheck"];

/** Re-render on a timer so old readings turn into history. Local only: it never asks the server. */
const CLOCK_TICK_MS = 15_000;

/** The tRPC error code of a failure, never its message. */
function errorCode(error: unknown): string | undefined {
  if (!(error instanceof TRPCClientError)) return undefined;
  const data: unknown = error.data;
  if (!data || typeof data !== "object" || !("code" in data)) return undefined;
  return typeof data.code === "string" ? data.code : undefined;
}

/**
 * The maintenance check for this page visit: glue between React and the
 * CheckController in lib/maintenanceCheckSession, where the rules and the
 * lifecycle live and are tested. A press runs one reading now or not at all.
 * Nothing runs on load, on focus, on reconnect or on a timer. Readings live
 * only in this page's memory and are dropped when the page closes, the account
 * changes or the readings are cleared.
 */
export function useMaintenanceCheck(): {
  session: CheckSession<WorkloadReport>;
  evidence: Evidence<WorkloadReport>;
  summary: string;
  running: boolean;
  run: () => void;
  clear: () => void;
} {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  // The query library keeps these two functions stable for the hook's lifetime.
  const { mutateAsync, reset } = trpc.maintenanceCheck.runWorkloadCheck.useMutation(MAINTENANCE_MUTATION_OPTIONS);
  const [now, setNow] = useState(() => Date.now());
  const [session, setSession] = useState<CheckSession<WorkloadReport> | null>(null);
  const [controller] = useState(
    () =>
      new CheckController<WorkloadReport>({
        send: () => mutateAsync(),
        online: () => onlineManager.isOnline() && (typeof navigator === "undefined" || navigator.onLine !== false),
        now: () => Date.now(),
        codeOf: errorCode,
        forget: () => reset(),
        changed: next => {
          setSession(next);
          setNow(Date.now());
        },
      }),
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    controller.attach();
    return () => controller.detach();
  }, [controller]);

  const seenUser = useRef(userId);
  useEffect(() => {
    if (seenUser.current === userId) return;
    seenUser.current = userId;
    controller.changeAccount();
  }, [userId, controller]);

  const shown = session ?? controller.session;
  return {
    session: shown,
    evidence: evidenceOf(shown, now),
    summary: describeSession(shown, now),
    running: shown.attempt.kind === "running",
    run: () => controller.run(),
    clear: () => controller.clear(),
  };
}
