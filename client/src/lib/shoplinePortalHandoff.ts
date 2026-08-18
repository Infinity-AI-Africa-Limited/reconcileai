/**
 * Whether the post-OAuth screen may hand a support session into a retail portal.
 *
 * SHOPLINE redirects to /shopline/welcome with an `org` code and no session of
 * its own. When an Infinity AI super admin is the one who ran the test install,
 * the buttons on that screen must enter the merchant's portal rather than
 * navigating staff to their own view — a successful reconnect that lands on the
 * staff dashboard reads as a failed store.
 *
 * The rule lives here rather than in the page because it has four outcomes and
 * only one of them is "go", and a page that computes that inline is a page
 * whose failure states are untestable. That is not hypothetical: the first
 * version disabled the buttons whenever the lookup had not resolved AND set the
 * error message only from the click handler, so the message could never render.
 * A truth table over its own predicates has zero reachable states for it. The
 * screen failed closed in silence — two dead buttons and no reason given.
 *
 * NOT authorisation. `superAdmin.allOrganizations` is a super-admin procedure
 * and PortalContext is a client-side view switch; the server re-checks every
 * call independently. This decides what the screen OFFERS.
 */
import type { Segment } from "./segments";

export type PortalHandoff =
  /** Not a support session, or no org code: navigate normally. */
  | { status: "not_required" }
  /** Super admin with an org code, lookup still in flight. */
  | { status: "resolving" }
  /** The retail organisation was found and the portal may be entered. */
  | { status: "ready" }
  /**
   * Cannot proceed. `reason` separates "we asked and it is not there" from "we
   * could not ask", because the operator's next step differs: the first means
   * the store is not connected to the org they think, the second is an outage.
   */
  | { status: "blocked"; reason: "lookup_failed" | "not_retail" };

export interface PortalHandoffInput {
  isSuperAdmin: boolean;
  orgCode: string;
  isLoading: boolean;
  isError: boolean;
  /** The matching organisation, if the lookup returned one. */
  retailOrg: { id: number; name: string; code: string; segment: Segment } | undefined;
}

export function shoplinePortalHandoff(input: PortalHandoffInput): PortalHandoff {
  // A merchant (or any non-staff visitor) never enters a portal — there is
  // nothing to switch into, and the ordinary navigation is correct for them.
  if (!input.isSuperAdmin || !input.orgCode) return { status: "not_required" };

  // Order matters: an errored query also reports "not loading" with no data, so
  // checking the error first is what keeps an outage from being reported as
  // "this store is not a retail tenant".
  if (input.isError) return { status: "blocked", reason: "lookup_failed" };
  if (input.isLoading) return { status: "resolving" };
  if (!input.retailOrg) return { status: "blocked", reason: "not_retail" };

  return { status: "ready" };
}

/** What to tell the operator, or null when there is nothing wrong to say. */
export function portalHandoffMessage(handoff: PortalHandoff): string | null {
  if (handoff.status !== "blocked") return null;
  return handoff.reason === "lookup_failed"
    ? "Could not load the organisation list, so the retail store context is unknown. " +
        "This is usually a transient error — reload the page, and check the platform status if it persists."
    : `No connected retail store matches this organisation code. ` +
        "Open the Super Admin portal and confirm the store is connected to the organisation you expect before retrying.";
}

/**
 * May the buttons navigate?
 *
 * Only when the portal context is ready, or when no portal is involved at all.
 * Navigating a blocked hand-off is the original bug — staff land on their own
 * dashboard and a successful reconnect looks like a broken store.
 *
 * Disabling was never the problem; disabling with nothing said was. The message
 * above is derived from the same state and renders whether or not anyone
 * clicks, so the operator sees the reason without having to discover it.
 */
export function canEnterPortal(handoff: PortalHandoff): boolean {
  return handoff.status === "ready" || handoff.status === "not_required";
}
