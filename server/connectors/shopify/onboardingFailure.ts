/**
 * What an onboarding refusal means to the merchant, classified in ONE place.
 *
 * App Home renders it in the embedded workspace (appHome.ts). It previously
 * had no answer at all: every
 * `ShopifyOnboardingError` fell through to a generic "temporarily unavailable",
 * which told a merchant whose shop has no contact email, or whose contact email
 * belongs to another workspace, to retry — and each retry re-ran the token
 * exchange, retiring the offline token pair that the previous attempt had just
 * been issued, while never being able to succeed.
 *
 * Deliberately pure, so both mappings are testable without a request, and so a
 * code added to `ShopifyOnboardingErrorCode` is classified in one place.
 */
import type { ShopifyInstallErrorReason } from "@shared/shopifyInstall";
import { ShopifyOnboardingError } from "./onboarding";

/** True when the merchant (or support) must act before a retry can ever work. */
export function onboardingFailureIsTerminal(reason: ShopifyInstallErrorReason): boolean {
  return reason !== "install_failed" && reason !== "installation_in_progress";
}

export function onboardingFailureReason(error: unknown): ShopifyInstallErrorReason {
  if (!(error instanceof ShopifyOnboardingError)) return "install_failed";
  switch (error.code) {
    case "OWNERSHIP_UNVERIFIED":
      return "ownership_verification_required";
    case "EMAIL_CONFLICT":
      return "email_already_registered";
    case "REDACTION_IN_PROGRESS":
      return "redaction_in_progress";
    case "MISSING_CONTACT_EMAIL":
      return "missing_contact_email";
    case "SHOP_IDENTITY_CONFLICT":
    case "WORKSPACE_CONFLICT":
      return "store_identity_conflict";
    case "INSTALL_LEASE_LOST":
      return "installation_in_progress";
    default:
      // DB_UNAVAILABLE and TOKEN_STORE_FAILED: genuinely transient, so a retry
      // is the right advice for these and only these.
      return "install_failed";
  }
}
