/**
 * Where Shopify App Home sends a merchant who wants to work their exceptions:
 * the Payment Exceptions page of the ReconcileAI platform, which has its own
 * sign-in. The App Bridge identity authorises App Home and nothing else, so the
 * link carries no Shopify session, token, shop, tenant, store or exception
 * identifier: only this page's own origin and a fixed path.
 *
 * It is ABSOLUTE and opens in a NEW TAB on purpose. Inside Shopify Admin, App
 * Bridge treats a relative path as a route of the embedded app and loads it in
 * Admin's frame, where the platform's sign-in cannot work. Shopify's guidance
 * for a destination that leaves the embedded app is `target="_blank"`, which
 * also keeps Admin open. `noreferrer` keeps App Home's own URL, which Shopify
 * loads with session parameters, out of the request.
 */
export const SHOPIFY_EXCEPTION_WORKSPACE_PATH = "/exceptions";

export interface ShopifyExceptionWorkspaceHandoff {
  href: string;
  target: "_blank";
  rel: "noopener noreferrer";
}

/** The only hosts a plain-http origin may be: a developer's own machine. */
const LOCAL_DEVELOPMENT_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The handoff for this page's origin, or null when that origin is not one to
 * send a merchant to: a sandboxed page's `"null"` origin, anything that is not
 * a bare origin, a non-web scheme, or plain http anywhere but a local
 * development host. Null hides the link, because a broken handoff is worse
 * than none.
 */
export function shopifyExceptionWorkspaceHandoff(origin: string): ShopifyExceptionWorkspaceHandoff | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  // A bare origin only: a path, query, fragment, credentials or trailing slash
  // means this was not `location.origin`, and none of it may be carried along.
  if (parsed.origin !== origin) return null;
  const secure = parsed.protocol === "https:";
  const localDevelopment = parsed.protocol === "http:" && LOCAL_DEVELOPMENT_HOSTS.has(parsed.hostname);
  if (!secure && !localDevelopment) return null;
  return {
    href: `${parsed.origin}${SHOPIFY_EXCEPTION_WORKSPACE_PATH}`,
    target: "_blank",
    rel: "noopener noreferrer",
  };
}
