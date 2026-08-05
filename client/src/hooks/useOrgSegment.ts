/**
 * Which vertical's UI to render.
 *
 * One rule: a super admin who has entered a tenant's portal sees THAT tenant's
 * segment; everyone else sees their own. Without it, Infinity AI staff reviewing
 * a SHOPLINE merchant would be shown financial-services chrome.
 *
 * Returns null while the lookup is in flight, or when the caller has no
 * organization. See lib/segments for what null means to callers.
 */
import { trpc } from "@/lib/trpc";
import { usePortalContext } from "@/contexts/PortalContext";
import { toSegment, type Segment } from "@/lib/segments";

export function useOrgSegment(): Segment | null {
  const { viewAsOrg } = usePortalContext();
  const { data } = trpc.auth.mySegment.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  // viewAsOrg is non-null exactly when a super admin is inside a portal, so it
  // is the whole condition — the separate isViewingAs flag this used to also
  // check is defined as `viewAsOrg !== null`.
  return viewAsOrg ? toSegment(viewAsOrg.segment) : toSegment(data?.segment);
}
