import { useCallback } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useOrgSegmentStatus } from "@/hooks/useOrgSegment";
import { usePortalContext } from "@/contexts/PortalContext";
import { canReachPath } from "@/lib/routeAccess";

/**
 * `href` if the viewer can open it, otherwise null — decided by the SAME rule
 * the route guard applies (`canReachPath`, with the same segment, role and
 * portal inputs as SegmentGuard in App.tsx).
 *
 * A dashboard count is shown to roles the page behind it refuses: a CFO sees
 * "Open Exceptions" but Payment Exceptions is built for admin and operations.
 * Linking it anyway would send them to a redirect that looks like a broken
 * link, so the count stays plain text for them.
 */
export function useReachableHref(): (href: string) => string | null {
  const { segment, isPending } = useOrgSegmentStatus();
  const { user, loading } = useAuth();
  const { viewAsOrg } = usePortalContext();

  return useCallback(
    (href: string) => {
      // Undecided is not allowed: the guard would bounce the click anyway.
      if (isPending || loading) return null;
      const path = href.split("?")[0];
      return canReachPath(path, segment, user?.role, { portal: viewAsOrg !== null }) ? href : null;
    },
    [isPending, loading, segment, user?.role, viewAsOrg],
  );
}
