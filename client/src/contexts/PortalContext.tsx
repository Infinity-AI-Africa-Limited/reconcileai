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

export type OrgSegment = "financial_services" | "corporate_b2b" | "super_admin";

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

const SESSION_KEY = "reconcileai_view_as_org";

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

  const enterPortal = useCallback((org: ViewAsOrg) => {
    setViewAsOrg(org);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(org));
    } catch {}
  }, []);

  const exitPortal = useCallback(() => {
    setViewAsOrg(null);
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {}
  }, []);

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
export const SEGMENT_LABELS: Record<OrgSegment, string> = {
  financial_services: "Financial Services",
  corporate_b2b: "Corporate B2B",
  super_admin: "Infinity AI (Internal)",
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
};
