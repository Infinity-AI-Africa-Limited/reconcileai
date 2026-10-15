import type { GovernedControlPackIssue } from "@shared/governedControlEvidence";

export type EvidencePackState = "reconstructable" | "evidence_gap";

/** Presentation-only copy for the metadata-only governed evidence pack. */
export function evidencePackStateCopy(state: EvidencePackState) {
  return state === "reconstructable"
    ? {
        label: "Evidence linked",
        description: "The admitted sources, run lifecycle, governed-exception activity and audit references are linked for this run.",
        className: "border-emerald-200 bg-emerald-50 text-emerald-800",
      }
    : {
        label: "Evidence gap",
        description: "This run cannot be presented as a complete evidence pack until the listed metadata inconsistencies are investigated.",
        className: "border-amber-200 bg-amber-50 text-amber-900",
      };
}

/** Operator wording for every gap the server can report; a missing one does not compile. */
const ISSUE_COPY: Record<GovernedControlPackIssue, string> = {
    unreadable_admission_snapshot: "The run's admission record can no longer be read.",
    missing_source_evidence: "An admitted source manifest is no longer available to this tenant-scoped pack.",
    source_contract_channel_mismatch: "A source contract no longer names the channel recorded at admission.",
    source_contract_role_mismatch: "A source contract no longer carries its admitted control role.",
    source_contract_version_mismatch: "A manifest's recorded source-contract version no longer matches its contract record.",
    manifest_control_period_mismatch: "A manifest no longer names the control period recorded at admission.",
    manifest_batch_mismatch: "A manifest no longer names the upload batch recorded at admission.",
    manifest_not_accepted: "A source manifest is not in the accepted schema state.",
    manifest_has_invalid_rows: "A source manifest records invalid rows.",
    manifest_duplicate_delivery: "A source manifest records a duplicate-delivery state.",
    manifest_policy_version_mismatch: "A manifest policy version is outside the admitted policy-version set.",
    run_channel_mismatch: "The run reconciled channels other than the ones its admission recorded.",
    run_population_mismatch: "The run's recorded record counts differ from the admitted manifests' received counts.",
};

export function evidencePackIssueCopy(issue: string): string {
  return Object.prototype.hasOwnProperty.call(ISSUE_COPY, issue)
    ? ISSUE_COPY[issue as GovernedControlPackIssue]
    : "An unrecognised evidence inconsistency was reported.";
}

export function formatEvidenceTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not yet recorded";
}

/** State when the server's bounded timeline includes more records than shown. */
export function boundedEvidenceCount(count: number, truncated: boolean, noun: string): string {
  const label = `${count} ${noun}${count === 1 ? "" : "s"}`;
  return truncated ? `At least ${label}` : label;
}

/**
 * Whether to retry a failed pack read. A refusal (any 4xx — not a governed
 * run, not visible, a bad id) answers the same every time, so retrying it only
 * holds the panel on its loading state; a server or network failure may pass.
 */
export function shouldRetryEvidencePack(failureCount: number, error: unknown): boolean {
  const status = (error as { data?: { httpStatus?: unknown } } | null)?.data?.httpStatus;
  if (typeof status === "number" && status >= 400 && status < 500) return false;
  return failureCount < 2;
}

/** A client-side hint only; the server strictly parses and authorizes the pack. */
export function looksLikeGovernedControl(engineConfig: unknown): boolean {
  try {
    const parsed = typeof engineConfig === "string" ? JSON.parse(engineConfig) : engineConfig;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).governedDailyControl === "object" &&
      (parsed as Record<string, unknown>).governedDailyControl !== null;
  } catch {
    return false;
  }
}
