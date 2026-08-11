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
  return useOrgSegmentStatus().segment;
}

/**
 * The same answer, plus whether it is an answer yet.
 *
 * `useOrgSegment` returns null for three different situations — the query is
 * still in flight, the query failed, or the caller genuinely has no
 * organization. Most callers are right not to care: they gate on a positive
 * match, so null hides a vertical-specific surface and the worst case is one
 * frame of a missing menu item.
 *
 * A caller that must not GUESS needs them apart. The module page is the case:
 * its rule defaults to the wide set on an unknown segment (correct — see
 * shared/moduleScope, where narrowing would silently disable a capability for
 * every legacy org), so "not resolved" and "resolved to nothing" produce the
 * same wide answer for very different reasons. Failing to resolve then reads as
 * "this org gets everything", and a merchant is offered a module built for a
 * general ledger they do not run.
 *
 * `retry: false` is what makes that more than a flicker: one failed request and
 * the answer stays null for the life of the page.
 */
export function useOrgSegmentStatus(opts: { enabled?: boolean } = {}): {
  segment: Segment | null;
  isPending: boolean;
  isFailed: boolean;
} {
  const { viewAsOrg } = usePortalContext();
  // `enabled` exists for pages a SIGNED-OUT visitor may legitimately open.
  //
  // `auth.mySegment` is a protectedProcedure, and main.tsx subscribes to the
  // query cache and sends the browser to /login on any UNAUTHORIZED error. So
  // merely ASKING for the segment without a session navigates the user away.
  // On the SHOPLINE install callback that is fatal: SHOPLINE redirects the
  // merchant to /shopline/welcome with no cookie set, and the page they were
  // sent to would bounce them to a login screen they have no account for yet.
  //
  // Callers on such a page pass `enabled: isAuthenticated`. With the query
  // switched off there is no request, so no 401 and no redirect — and the
  // answer is reported as a RESOLVED null rather than a pending one, so guards
  // decide instead of waiting forever on a query that will never run.
  const enabled = opts.enabled ?? true;
  const { data, isPending, isError } = trpc.auth.mySegment.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60 * 1000,
    enabled,
  });
  if (!enabled && !viewAsOrg) {
    return { segment: null, isPending: false, isFailed: false };
  }

  // viewAsOrg is non-null exactly when a super admin is inside a portal, so it
  // is the whole condition — the separate isViewingAs flag this used to also
  // check is defined as `viewAsOrg !== null`. It also resolves synchronously
  // from context, so the query's own state says nothing about it.
  if (viewAsOrg) {
    return { segment: toSegment(viewAsOrg.segment), isPending: false, isFailed: false };
  }
  return { segment: toSegment(data?.segment), isPending, isFailed: isError };
}
