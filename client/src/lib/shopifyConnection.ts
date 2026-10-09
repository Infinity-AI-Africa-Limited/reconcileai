import { SHOPIFY_INSTALL_ERROR_REASONS, type ShopifyInstallErrorReason } from "@shared/shopifyInstall";

/**
 * The error page's copy, one entry per reason the server can send. Typed on the
 * shared list, so a reason added on the server without a message here is a
 * compile error rather than a generic "something went wrong".
 */
const SHOPIFY_INSTALL_ERROR_MESSAGES: Record<ShopifyInstallErrorReason, string> = {
  invalid_shop: "The Shopify store address is not valid. Restart installation from Shopify.",
  not_configured: "The ReconcileAI Dev Store Shopify connector is not yet configured for this environment.",
  invalid_callback: "The response from Shopify was incomplete. Restart installation from Shopify.",
  security_check_failed: "The Shopify security check could not be completed. Restart installation from Shopify.",
  expired_or_replayed: "This installation session expired or was already used. Restart installation from Shopify.",
  temporarily_unavailable: "ReconcileAI Dev Store is temporarily unavailable. Please restart installation from Shopify in a few minutes.",
  installation_in_progress:
    "Another installation for this store is already in progress. Wait a minute, then restart installation from Shopify.",
  required_permissions_not_granted: "ReconcileAI Dev Store needs read-only order access to continue. No Shopify data was changed.",
  ownership_verification_required:
    "This store is already connected to a ReconcileAI Dev Store workspace, and its current contact email does not match that workspace's administrator. For your protection the connection was not transferred. Contact ReconcileAI Dev Store support to verify ownership.",
  email_already_registered:
    "This store's contact email already belongs to another ReconcileAI Dev Store workspace, so a new workspace could not be created for it. Contact ReconcileAI Dev Store support to connect this store.",
  redaction_in_progress:
    "This store has an active data-deletion request, so ReconcileAI Dev Store cannot reconnect it. Contact ReconcileAI Dev Store support if you believe this is unexpected.",
  missing_contact_email:
    "Shopify did not provide a contact email for this store. Add a store contact email in Shopify settings, then restart installation.",
  store_identity_conflict:
    "This store's details conflict with an existing connection, so it was not connected. Contact ReconcileAI Dev Store support.",
  install_failed: "We could not finish the secure Shopify connection. No changes were made to your store.",
  managed_install_only:
    "ReconcileAI Dev Store is now installed and reconnected from inside Shopify. In your Shopify admin, open Apps and choose ReconcileAI Dev Store. No changes were made to your store.",
};

function isInstallErrorReason(value: string): value is ShopifyInstallErrorReason {
  return (SHOPIFY_INSTALL_ERROR_REASONS as readonly string[]).includes(value);
}

/** The message for a `reason` query value; anything unrecognised reads as a generic failure. */
export function shopifyInstallErrorMessage(reason: string | null | undefined): string {
  return reason && isInstallErrorReason(reason)
    ? SHOPIFY_INSTALL_ERROR_MESSAGES[reason]
    : SHOPIFY_INSTALL_ERROR_MESSAGES.install_failed;
}
