/**
 * Which institutions have a banking model, and how it reads.
 *
 * `organizations.bankingModel` records whether an institution operates on
 * conventional or non-interest (NIFI) principles. It is orthogonal to `segment`
 * — a non-interest bank is still `financial_services` and still runs NIP, POS
 * and cheque clearing — but it only MEANS anything for a financial-services
 * institution. A retail merchant or an FMCG supplier has no banking licence, so
 * offering them the choice would invite them to assert one.
 *
 * Extracted from SuperAdminDashboard rather than computed there, per the
 * "pages render; hooks decide" rule in CLAUDE.md §16: a page that computes its
 * own eligibility couples the rule to one rendering site, and the next consumer
 * — the New Organisation dialog, a tenant-facing badge, a CBN report header —
 * re-derives it slightly differently. That is exactly how the distributor
 * registry ended up scoped one way on the client and another on the server.
 *
 * NOT AUTHORISATION. `superAdmin.setOrganizationBankingModel` is
 * superAdminProcedure and refuses independently; this decides what is OFFERED.
 */
import { isFinancialServices, type Segment } from "./segments";

/** The two models an institution can be recorded as operating on. */
export type BankingModel = "conventional" | "non_interest";

export const BANKING_MODELS: readonly BankingModel[] = ["conventional", "non_interest"];

/**
 * Does the banking model apply to this vertical at all?
 *
 * Named for what it COMPARES, not for what it shows (CLAUDE.md §16). The caller
 * names the intent:
 *
 *     const showBankingModel = bankingModelAppliesTo(segment);
 *
 * A positive match, so a segment that has not resolved yet reads as "no" and the
 * control stays hidden for that frame rather than flickering in — the same
 * reasoning as the segment checks it delegates to.
 */
export function bankingModelAppliesTo(segment: Segment | null): boolean {
  return isFinancialServices(segment);
}

/**
 * Narrow an unknown string to a BankingModel, defaulting to conventional.
 *
 * Unknown means CONVENTIONAL, deliberately, and this must stay aligned with
 * `isNonInterestInstitution` on the server. Non-interest is a positive claim
 * about an institution's licence basis: showing "Non-interest (NIFI)" for an
 * unrecognised value would misstate that claim in the operator's own console,
 * and the Super Agent would still be treating the tenant as conventional.
 */
export function toBankingModel(value: string | null | undefined): BankingModel {
  return value === "non_interest" ? "non_interest" : "conventional";
}

/** How the model is written for a human. */
export function bankingModelLabel(model: BankingModel): string {
  return model === "non_interest" ? "Non-interest (NIFI)" : "Conventional";
}
