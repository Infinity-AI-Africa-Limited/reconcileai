/**
 * PortalContext — Super Admin Portal Switcher
 *
 * Allows a super_admin to "enter" any organisation's portal and see the app
 * scoped to that tenant's data and segment-specific navigation.
 *
 * State is persisted in sessionStorage so it survives page refreshes but
 * is cleared when the browser tab is closed.
 */

import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PORTAL_SESSION_KEY } from "@/lib/portalRequest";

export type OrgSegment = "financial_services" | "corporate_b2b" | "super_admin" | "retail_commerce";

export interface ViewAsOrg {
  id: number;
  name: string;
  code: string;
  segment: OrgSegment;
  country: string;
  baseCurrency: string;
}

interface PortalContextValue {
  /** The org currently being viewed as. null = super admin home view. */
  viewAsOrg: ViewAsOrg | null;
  /** Enter a specific org's portal. */
  enterPortal: (org: ViewAsOrg) => void;
  /** Exit back to super admin home view. */
  exitPortal: () => void;
  /** Whether the super admin is currently viewing as another org. */
  isViewingAs: boolean;
}

// Shared with the request layer, which reads it on every tRPC call
// (client/src/lib/portalRequest.ts) — one key, so the two cannot disagree.
const SESSION_KEY = PORTAL_SESSION_KEY;

function loadFromSession(): ViewAsOrg | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ViewAsOrg;
  } catch {
    return null;
  }
}

const PortalContext = createContext<PortalContextValue>({
  viewAsOrg: null,
  enterPortal: () => {},
  exitPortal: () => {},
  isViewingAs: false,
});

export function PortalProvider({ children }: { children: ReactNode }) {
  const [viewAsOrg, setViewAsOrg] = useState<ViewAsOrg | null>(loadFromSession);
  const queryClient = useQueryClient();

  // Every tRPC request now carries the portal tenant in a header, and the
  // server answers for it — but query cache keys do not include it. Without a
  // reset, entering a portal would keep showing whatever the previous view had
  // cached until each query happened to refetch: Infinity AI's data under a
  // tenant's name, or one tenant's under another's. Storage is written FIRST,
  // so the refetches this triggers already carry the new tenant.
  const rescope = useCallback(() => {
    void queryClient.cancelQueries().then(() => queryClient.resetQueries());
  }, [queryClient]);

  const enterPortal = useCallback((org: ViewAsOrg) => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(org));
    } catch {}
    setViewAsOrg(org);
    rescope();
  }, [rescope]);

  const exitPortal = useCallback(() => {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {}
    setViewAsOrg(null);
    rescope();
  }, [rescope]);

  return (
    <PortalContext.Provider
      value={{
        viewAsOrg,
        enterPortal,
        exitPortal,
        isViewingAs: viewAsOrg !== null,
      }}
    >
      {children}
    </PortalContext.Provider>
  );
}

export function usePortalContext(): PortalContextValue {
  return useContext(PortalContext);
}

/** Segment display labels */
/**
 * The portal tenant's id, or undefined when the viewer is not inside a portal.
 *
 * No longer what scopes a query. Every tRPC request now carries the portal
 * tenant in a header, and the server makes it the request's organisation for a
 * super admin (server/_core/portalView.ts) — so a query that does not pass this
 * is scoped all the same. The pages that pass it as `viewAsOrgId` still do; the
 * server resolves both to the same tenant, and they also keep one tenant's
 * cached results from ever being served under another's query key.
 */
export function useViewAsOrgId(): number | undefined {
  return usePortalContext().viewAsOrg?.id;
}

export const SEGMENT_LABELS: Record<OrgSegment, string> = {
  financial_services: "Financial Services",
  corporate_b2b: "Corporate B2B",
  super_admin: "Infinity AI (Internal)",
  retail_commerce: "Retail Commerce",
};

/** Segment accent colours (Tailwind classes) */
export const SEGMENT_COLORS: Record<OrgSegment, { bg: string; text: string; border: string; badge: string }> = {
  financial_services: {
    bg: "bg-blue-50 dark:bg-blue-950/30",
    text: "text-blue-700 dark:text-blue-300",
    border: "border-blue-200 dark:border-blue-800",
    badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  },
  corporate_b2b: {
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    text: "text-emerald-700 dark:text-emerald-300",
    border: "border-emerald-200 dark:border-emerald-800",
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  super_admin: {
    bg: "bg-violet-50 dark:bg-violet-950/30",
    text: "text-violet-700 dark:text-violet-300",
    border: "border-violet-200 dark:border-violet-800",
    badge: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  },
  retail_commerce: {
    bg: "bg-amber-50 dark:bg-amber-950/30",
    text: "text-amber-700 dark:text-amber-300",
    border: "border-amber-200 dark:border-amber-800",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  },
};
