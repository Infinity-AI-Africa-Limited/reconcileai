/**
 * Tenant AI boundary — ONE gate, every model entry point.
 *
 * `organizations.aiAssistanceEnabled` is a contractual control, not a UI
 * preference: a bank that switches AI assistance off is asserting that its
 * operational data does not leave for a third-party model. Honouring that on
 * one code path and not the others is indistinguishable, from the institution's
 * side, from not honouring it at all.
 *
 * The switch shipped guarding exactly one of the platform's model entry points
 * (the deferred analysis pass). Four org-scoped surfaces still submitted tenant
 * exceptions, transactions and learned resolution history to `invokeLLM` after
 * the opt-out:
 *
 *   - superAgent.query    — exception/job context + institutional memory
 *   - superAgent.diagnose — a transaction plus recalled agent memory
 *   - anomalies.detect    — transaction descriptions
 *   - POST /api/v1/exceptions/analyze (public API) — exception + network guidance
 *
 * So the gate lives here rather than being re-typed at each call site, and
 * `aiGateRatchet.test.ts` fails the build when a new org-scoped model entry
 * point appears without it.
 *
 * FAIL CLOSED. An absent, zero or non-integer organizationId refuses the call.
 * That is deliberate and is the opposite default to `featureAppliesTo`
 * (shared/verticalFeatures.ts), which fails OPEN so a missing segment never
 * silently withdraws a capability. The asymmetry is the same one recorded in
 * CLAUDE.md §9C: withdrawing a READ on unknown tenancy is the wrong direction,
 * but this decision authorises an EGRESS of tenant data to an external model.
 * "We could not determine the tenant" must never resolve to "send it anyway".
 *
 * Not every model call is tenant-scoped. The public POC/demo engines
 * (poc-engine, mobileMoney-engine, woodcore-engine) run on demo fixtures with
 * no owning organisation and are intentionally NOT gated — gating them on a
 * fail-closed rule would simply disable the public demos. The ratchet records
 * that exemption explicitly rather than leaving it to be re-derived.
 */
import * as db from "./db";

/** Thrown when a tenant with AI assistance disabled reaches a model entry point. */
export class TenantAiDisabledError extends Error {
  readonly organizationId: number | null;
  readonly surface: string;

  constructor(organizationId: number | null, surface: string) {
    super(
      organizationId == null
        ? `AI assistance refused for "${surface}": no owning organisation could be determined`
        : `AI assistance is disabled for organisation ${organizationId} — "${surface}" refused`,
    );
    this.name = "TenantAiDisabledError";
    this.organizationId = organizationId;
    this.surface = surface;
  }
}

function normaliseOrgId(organizationId: number | null | undefined): number | null {
  return Number.isInteger(organizationId) && (organizationId as number) > 0
    ? (organizationId as number)
    : null;
}

/**
 * Non-throwing form, for background passes that should skip quietly rather
 * than surface an error to a user (the deferred analysis pass).
 */
export async function isTenantAiAllowed(organizationId: number | null | undefined): Promise<boolean> {
  const orgId = normaliseOrgId(organizationId);
  if (orgId === null) return false;
  return db.isOrganizationAiAssistanceEnabled(orgId);
}

/**
 * Throwing form, for request-scoped surfaces. Call BEFORE loading the context
 * that would be sent to the model — the opt-out covers reading the tenant's
 * operational data for model input, not merely the network call.
 */
export async function assertTenantAiAllowed(
  organizationId: number | null | undefined,
  surface: string,
): Promise<number> {
  const orgId = normaliseOrgId(organizationId);
  if (orgId === null) throw new TenantAiDisabledError(null, surface);
  if (!(await db.isOrganizationAiAssistanceEnabled(orgId))) {
    throw new TenantAiDisabledError(orgId, surface);
  }
  return orgId;
}
