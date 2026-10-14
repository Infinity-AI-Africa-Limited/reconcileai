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

export function evidencePackIssueCopy(issue: string): string {
  const copy: Record<string, string> = {
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
  };
  return copy[issue] ?? "An unrecognised evidence inconsistency was reported.";
}

export function formatEvidenceTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not yet recorded";
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
