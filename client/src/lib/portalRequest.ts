/**
 * How the browser tells the server which tenant's portal a super admin is in.
 *
 * The portal is chosen in PortalContext and kept in sessionStorage. Every tRPC
 * request carries it in the `x-portal-org` header, and the server makes that
 * tenant the request's effective organisation — for a super admin only (see
 * server/_core/portalView.ts). The live monitoring stream is an EventSource,
 * which cannot set headers, so it carries the same id as `?portalOrg=`.
 *
 * Read from sessionStorage at REQUEST time rather than from React state, so a
 * request issued in the same tick as "Enter Portal" is already scoped.
 */

/** Where PortalContext keeps the portal tenant. */
export const PORTAL_SESSION_KEY = "reconcileai_view_as_org";

/** Must match PORTAL_ORG_HEADER in server/_core/portalView.ts. */
export const PORTAL_ORG_HEADER = "x-portal-org";

/** The portal tenant's id from the stored value, or null if none or malformed. */
export function portalOrgIdFromSession(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const id = (JSON.parse(raw) as { id?: unknown })?.id;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** The header to send, or nothing outside a portal. */
export function portalHeaders(raw: string | null): Record<string, string> {
  const id = portalOrgIdFromSession(raw);
  return id === null ? {} : { [PORTAL_ORG_HEADER]: String(id) };
}

/** `url` with the portal tenant appended as `portalOrg`, or unchanged outside a portal. */
export function withPortalOrg(url: string, raw: string | null): string {
  const id = portalOrgIdFromSession(raw);
  if (id === null) return url;
  return `${url}${url.includes("?") ? "&" : "?"}portalOrg=${id}`;
}

/** The stored portal value, or null when sessionStorage is unavailable. */
export function readPortalSession(): string | null {
  try {
    return sessionStorage.getItem(PORTAL_SESSION_KEY);
  } catch {
    return null;
  }
}
