/**
 * What the Module Configuration page should show.
 *
 * The rule it wraps (`modulesForSegment`) answers an unknown segment with the
 * WIDE set, and that is right where it is used to provision a tenant: narrowing
 * on missing data would silently disable account_level for every legacy org
 * whose segment was never set. Taking a capability away on missing data is the
 * wrong direction to fail.
 *
 * Reading a screen is the other direction. There, "unknown" arrives for a third
 * reason the provisioner never sees — the lookup did not come back — and
 * answering it with the wide set offers a retail merchant a module built for a
 * general ledger they do not run, described in the card's own copy as delivering
 * "CBN compliance" and "zero licence revocations" to a reader who answers to no
 * regulator. They cannot actually enable it (assertModuleAvailable refuses on
 * the server), so the visible outcome is an inapplicable card and a FORBIDDEN
 * toast — but not offering it is the entire point of scoping the page.
 *
 * So this does not guess. Neither default is safe once the segment is genuinely
 * unavailable: wide offers a merchant a module they cannot use, narrow strips a
 * bank of one they can. It reports the uncertainty instead and lets the page say
 * so.
 */
import { modulesForSegment, type ModuleType } from "@shared/moduleScope";

export type ModulePanel =
  | { kind: "loading" }
  | { kind: "unresolved" }
  | { kind: "ready"; modules: ModuleType[] };

/**
 * `isPending` is "no answer yet", `isFailed` is "no answer coming". They are
 * separate because only the first is worth a spinner; the second needs to be
 * told to the user, since `retry: false` means it will not fix itself.
 *
 * A resolved `null` segment is NOT uncertainty — it is a legacy or org-less
 * account, genuinely answered, and it keeps the wide set exactly as the
 * provisioner does.
 */
export function modulePanelFor(status: {
  segment: string | null;
  isPending: boolean;
  isFailed: boolean;
}): ModulePanel {
  if (status.isPending) return { kind: "loading" };
  if (status.isFailed) return { kind: "unresolved" };
  return { kind: "ready", modules: modulesForSegment(status.segment) };
}
