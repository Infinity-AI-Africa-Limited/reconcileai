/**
 * Which roles may WRITE reconciliation, as one rule for the client and the
 * server.
 *
 * `operationsProcedure` refuses these roles on the server; the Daily Control
 * page withholds its Start action from them. Two copies of the list could
 * disagree, and the failure is not symmetric: a page that offers an action the
 * API refuses hands the user a button that always answers FORBIDDEN — and on
 * Daily Control it does so on a day the page itself has just reported as
 * ready, which reads as a broken control rather than a role boundary.
 *
 * A CFO legitimately READS this page (see `navItems.ts`), so the fix is never
 * to take the page away; only the action that writes.
 */
export const RECONCILIATION_READ_ONLY_ROLES = ["cfo", "compliance"] as const;

export type ReconciliationReadOnlyRole =
  (typeof RECONCILIATION_READ_ONLY_ROLES)[number];

/**
 * Mirrors the server exactly, including treating an unrecorded or unknown role
 * as permitted.
 *
 * That default is deliberate here and is NOT the usual fail-closed rule. This
 * predicate's job is to agree with `operationsProcedure`, which refuses a
 * named deny-list and lets everything else through: `admin`, `operations`,
 * `user` and any role added later all write successfully today. A client that
 * failed closed would hide a button the API would have honoured, which is the
 * same class of disagreement in the other direction. Whether that deny-list
 * should become an allow-list is a decision about who may start a run, not a
 * fix to a button, and belongs to whoever makes it — in ONE place, this one.
 */
export function roleCanWriteReconciliation(
  role: string | null | undefined
): boolean {
  if (!role) return true;
  return !(RECONCILIATION_READ_ONLY_ROLES as readonly string[]).includes(role);
}
