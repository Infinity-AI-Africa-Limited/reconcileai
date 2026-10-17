/**
 * The Shopify embedded App Home may guide a merchant to the separate
 * ReconcileAI Dev Store exception workspace, but it must never turn an App
 * Bridge identity into a
 * dashboard authorization grant or expose tenant/store/exception identifiers.
 */
export const SHOPIFY_EXCEPTION_WORKSPACE_PATH = "/exceptions";

export const SHOPIFY_EXCEPTION_WORKSPACE_HANDOFF = {
  href: SHOPIFY_EXCEPTION_WORKSPACE_PATH,
  target: "_top",
  rel: "noreferrer",
} as const;
