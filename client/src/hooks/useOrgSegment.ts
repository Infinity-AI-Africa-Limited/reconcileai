/**
 * The segment whose UI should be rendered right now.
 *
 * Two sources, and the order matters: a super admin who has entered a tenant's
 * portal must see THAT tenant's segment, not their own. Otherwise Infinity AI
 * staff reviewing a SHOPLINE merchant would be shown the financial-services
 * dashboard for a retail org.
 *
 * Extracted because the same derivation was already inlined in
 * ExceptionGlossary and is now needed by the dashboard and its view switcher.
 * Three copies of "which segment am I?" is how one of them ends up disagreeing —
 * and the failure is silent, since a wrong segment renders a plausible-looking
 * screen rather than an error.
 *
 * Returns `null` when the caller has no organization or the lookup has not
 * resolved yet. The visibility rules in lib/segmentVisibility treat `null` as
 * "unknown" and gate on explicit matches, so a pending lookup never flashes a
 * surface the tenant should not see.
 */
import { trpc } from "@/lib/trpc";
import { usePortalContext, type OrgSegment } from "@/contexts/PortalContext";

export { showsCbnCompliance, showsPilotReadiness, showsAuditorView, dashboardViewsFor } from "@/lib/segmentVisibility";

export function useOrgSegment(): OrgSegment | null {
  const { viewAsOrg, isViewingAs } = usePortalContext();
  const { data } = trpc.auth.mySegment.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const segment = isViewingAs ? viewAsOrg?.segment : (data?.segment as OrgSegment | undefined);
  return segment ?? null;
}
