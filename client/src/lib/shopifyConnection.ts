import { SHOPIFY_INSTALL_ERROR_REASONS, type ShopifyInstallErrorReason } from "@shared/shopifyInstall";

/**
 * What the Shopify welcome page may say about a merchant's connection, decided
 * here so the page only renders (CLAUDE.md §16: pages render; hooks decide).
 */
export type ShopifyConnectionVerdict = "checking" | "connected" | "not_connected" | "confirming";

/** A store's `status` as listStores reports it. */
export type ShopifyStoreStatus = "pending_claim" | "active" | "reauthorization_required" | "uninstalled";

/**
 * The verdict for a signed-in merchant looking at one store.
 *
 * Only an `active` store is "connected". A store that has been taken out of
 * service (reauthorization required, or uninstalled) is "not_connected" — never
 * "confirming", which would invite the merchant to wait for something that is
 * not going to happen. Anything else, including a store not yet visible, is
 * still being confirmed.
 */
export function shopifyConnectionVerdict(input: {
  isLoading: boolean;
  status: ShopifyStoreStatus | null | undefined;
}): ShopifyConnectionVerdict {
  if (input.isLoading) return "checking";
  if (input.status === "active") return "connected";
  if (input.status === "reauthorization_required" || input.status === "uninstalled") return "not_connected";
  return "confirming";
}

export const SHOPIFY_CONNECTION_MESSAGES: Record<ShopifyConnectionVerdict, string> = {
  checking: "Checking the secured connection…",
  connected: "Your Shopify store is connected to this ReconcileAI workspace.",
  not_connected:
    "This store is not currently connected. Reinstall ReconcileAI from Shopify, or contact support if that does not restore it.",
  confirming: "The store connection is being confirmed. Refresh this page in a moment if it does not appear.",
};

/**
 * The error page's copy, one entry per reason the server can send. Typed on the
 * shared list, so a reason added on the server without a message here is a
 * compile error rather than a generic "something went wrong".
 */
const SHOPIFY_INSTALL_ERROR_MESSAGES: Record<ShopifyInstallErrorReason, string> = {
  invalid_shop: "The Shopify store address is not valid. Restart installation from Shopify.",
  not_configured: "The ReconcileAI Shopify connector is not yet configured for this environment.",
  invalid_callback: "The response from Shopify was incomplete. Restart installation from Shopify.",
  security_check_failed: "The Shopify security check could not be completed. Restart installation from Shopify.",
  expired_or_replayed: "This installation session expired or was already used. Restart installation from Shopify.",
  temporarily_unavailable: "ReconcileAI is temporarily unavailable. Please restart installation from Shopify in a few minutes.",
  installation_in_progress:
    "Another installation for this store is already in progress. Wait a minute, then restart installation from Shopify.",
  required_permissions_not_granted: "ReconcileAI needs read-only order access to continue. No Shopify data was changed.",
  ownership_verification_required:
    "This store is already connected to a ReconcileAI workspace, and its current contact email does not match that workspace's administrator. For your protection the connection was not transferred. Contact ReconcileAI support to verify ownership.",
  email_already_registered:
    "This store's contact email already belongs to another ReconcileAI workspace, so a new workspace could not be created for it. Contact ReconcileAI support to connect this store.",
  missing_contact_email:
    "Shopify did not provide a contact email for this store. Add a store contact email in Shopify settings, then restart installation.",
  store_identity_conflict:
    "This store's details conflict with an existing connection, so it was not connected. Contact ReconcileAI support.",
  install_failed: "We could not finish the secure Shopify connection. No changes were made to your store.",
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
