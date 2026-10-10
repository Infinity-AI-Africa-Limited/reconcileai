import { isControlPeriod } from "@shared/controlPeriod";

/** The API's own rule for a period (shared/controlPeriod.ts), so the two cannot disagree. */
export { isControlPeriod };

/**
 * What the page body shows. The period controls are rendered in EVERY state:
 * if an error or a bad date removed the date picker, the only way to correct
 * the date would be to leave the page.
 */
export type DailyControlView = "invalid_period" | "loading" | "error" | "assessed";

export function dailyControlView(state: {
  periodIsValid: boolean;
  isLoading: boolean;
  hasError: boolean;
}): DailyControlView {
  // Checked first: the query is held back for such a period, so neither
  // "loading" nor "error" could describe it.
  if (!state.periodIsValid) return "invalid_period";
  if (state.hasError) return "error";
  if (state.isLoading) return "loading";
  return "assessed";
}

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

/**
 * Why Start is withheld when the evidence itself is ready. "evidence_not_ready"
 * is left out because the status banner already says so; every other reason is
 * a governed-admission rule the preflight alone does not express (one
 * settlement and one register source, one time zone, a bound upload batch, a
 * population that still matches its manifest).
 */
export function governedStartBlockers(governedAdmission: {
  admissible: boolean;
  reasons: readonly string[];
}): string[] {
  if (governedAdmission.admissible) return [];
  return governedAdmission.reasons.filter(reason => reason !== "evidence_not_ready");
}

/** Machine reasons are intentionally stored and returned without customer data. */
export function humanizeControlReason(reason: string): string {
  return reason
    .split("_")
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
