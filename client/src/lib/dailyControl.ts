export type DailyControlStatus =
  | "ready_to_reconcile"
  | "awaiting_sources"
  | "incomplete"
  | "blocked";

export type DailyControlSourceStatus =
  | "ready"
  | "awaiting_source"
  | "incomplete"
  | "blocked";

export function localControlPeriod(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dailyControlStatusCopy(status: DailyControlStatus): {
  label: string;
  summary: string;
  tone: "ready" | "waiting" | "attention" | "blocked";
} {
  switch (status) {
    case "ready_to_reconcile":
      return {
        label: "Evidence ready for reconciliation",
        summary:
          "Approved source evidence is complete for this preflight. A separate, governed action is still required to run reconciliation.",
        tone: "ready",
      };
    case "awaiting_sources":
      return {
        label: "Awaiting source evidence",
        summary:
          "A required source is not yet due or has not yet been delivered. No match-rate interpretation is available.",
        tone: "waiting",
      };
    case "incomplete":
      return {
        label: "Evidence population incomplete",
        summary:
          "Required evidence is missing, late, or does not agree with its expected population. Reconciliation is not ready.",
        tone: "attention",
      };
    case "blocked":
      return {
        label: "Evidence blocked",
        summary:
          "The source contract or evidence cannot be trusted as recorded. Resolve the listed evidence issue before interpreting a run.",
        tone: "blocked",
      };
  }
}

export function dailyControlSourceStatusCopy(
  status: DailyControlSourceStatus
): {
  label: string;
  tone: "ready" | "waiting" | "attention" | "blocked";
} {
  switch (status) {
    case "ready":
      return { label: "Ready", tone: "ready" };
    case "awaiting_source":
      return { label: "Awaiting source", tone: "waiting" };
    case "incomplete":
      return { label: "Incomplete", tone: "attention" };
    case "blocked":
      return { label: "Blocked", tone: "blocked" };
  }
}

/** Machine reasons are intentionally stored and returned without customer data. */
export function humanizeControlReason(reason: string): string {
  return reason
    .split("_")
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
