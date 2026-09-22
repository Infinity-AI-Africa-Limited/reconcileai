/**
 * Every reason the Shopify OAuth routes may send the merchant to
 * `/shopify/error?reason=…` with. Shared so the two ends cannot drift: the
 * server may only send these, and the error page must have a message for each
 * (its message map is typed on this list, so a missing one is a compile error).
 */
export const SHOPIFY_INSTALL_ERROR_REASONS = [
  "invalid_shop",
  "not_configured",
  "invalid_callback",
  "security_check_failed",
  "expired_or_replayed",
  "temporarily_unavailable",
  "installation_in_progress",
  "required_permissions_not_granted",
  "ownership_verification_required",
  "email_already_registered",
  "missing_contact_email",
  "store_identity_conflict",
  "install_failed",
] as const;

export type ShopifyInstallErrorReason = (typeof SHOPIFY_INSTALL_ERROR_REASONS)[number];
