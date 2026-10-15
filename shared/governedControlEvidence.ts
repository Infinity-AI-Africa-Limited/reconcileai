/**
 * The evidence gaps a governed-run evidence pack can report.
 *
 * Shared so the server (server/controlEvidencePack.ts) and the page's copy
 * (client/src/lib/governedControlEvidence.ts) cannot disagree: the copy is a
 * `Record` over this list, so a gap added here without operator wording is a
 * compile error, not an "unrecognised inconsistency" on a CFO's screen.
 */
export const GOVERNED_CONTROL_PACK_ISSUES = [
  "unreadable_admission_snapshot",
  "missing_source_evidence",
  "source_contract_channel_mismatch",
  "source_contract_role_mismatch",
  "source_contract_version_mismatch",
  "manifest_control_period_mismatch",
  "manifest_batch_mismatch",
  "manifest_not_accepted",
  "manifest_has_invalid_rows",
  "manifest_duplicate_delivery",
  "manifest_policy_version_mismatch",
  "run_channel_mismatch",
  "run_population_mismatch",
] as const;

export type GovernedControlPackIssue = (typeof GOVERNED_CONTROL_PACK_ISSUES)[number];
