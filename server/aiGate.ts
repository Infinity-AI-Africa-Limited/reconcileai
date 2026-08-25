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
 * TWO tenant policies are enforced here, not one. The organisation switch
 * (`organizations.aiAssistanceEnabled`) applies to every segment. The Corporate
 * B2B controlled-pilot boundary (gate B5) applies on top of it for
 * `corporate_b2b` tenants and is the same argument one level down: it shipped
 * guarding exactly one procedure, so it is folded in here instead.
 *
 * Not every model call is tenant-scoped. The public POC/demo engines
 * (poc-engine, mobileMoney-engine, woodcore-engine) run on demo fixtures with
 * no owning organisation and are intentionally NOT gated — gating them on a
 * fail-closed rule would simply disable the public demos. The ratchet records
 * that exemption explicitly rather than leaving it to be re-derived.
 */
import * as db from "./db";

/**
 * Why a model entry point was refused.
 *
 * Three distinct reasons, not a boolean, because the REMEDY differs and telling
 * an operator the wrong one wastes their day. "A super admin can re-enable it
 * in organisation settings" is correct advice for `assistance_disabled` and
 * actively misleading for `b2b_boundary_unapproved`, where the organisation
 * switch is already on and the missing thing is a recorded private-route
 * approval in the Corporate B2B Pilot Controls workspace.
 */
export type TenantAiRefusal = "no_tenant" | "assistance_disabled" | "b2b_boundary_unapproved";

const REFUSAL_REMEDY: Record<TenantAiRefusal, string> = {
  no_tenant:
    "This account is not linked to an organisation, so no tenant AI policy could be read. Link the account to its organisation first.",
  assistance_disabled:
    "AI assistance is disabled for this organisation. A super admin can re-enable it in organisation settings.",
  b2b_boundary_unapproved:
    "This Corporate B2B pilot has not recorded an approved private AI route. Record the route and its sign-off reference in Pilot Controls (gate B5), or leave AI disabled.",
};

/** Thrown when a tenant policy refuses a model entry point. */
export class TenantAiDisabledError extends Error {
  readonly organizationId: number | null;
  readonly surface: string;
  readonly reason: TenantAiRefusal;
  /** What the operator should actually do — safe to surface to a user. */
  readonly remedy: string;

  constructor(
    organizationId: number | null,
    surface: string,
    reason: TenantAiRefusal = "assistance_disabled",
  ) {
    super(
      organizationId == null
        ? `AI assistance refused for "${surface}": no owning organisation could be determined`
        : reason === "b2b_boundary_unapproved"
          ? `Corporate B2B organisation ${organizationId} has no approved private AI route — "${surface}" refused`
          : `AI assistance is disabled for organisation ${organizationId} — "${surface}" refused`,
    );
    this.name = "TenantAiDisabledError";
    this.organizationId = organizationId;
    this.surface = surface;
    this.reason = reason;
    this.remedy = REFUSAL_REMEDY[reason];
  }
}

function normaliseOrgId(organizationId: number | null | undefined): number | null {
  return Number.isInteger(organizationId) && (organizationId as number) > 0
    ? (organizationId as number)
    : null;
}

/**
 * The Corporate B2B controlled-pilot boundary (gate B5), applied to EVERY model
 * entry point rather than to one procedure.
 *
 * It shipped as an inline check inside `superAgent.diagnose` alone, described in
 * the B0–B8 status document as "server-side policy, not a UI-only indicator".
 * That was true and insufficient: the same tenant's exceptions, transactions and
 * learned resolution history still reached a model through `superAgent.query`,
 * `anomalies.detect`, the public `/api/v1/exceptions/analyze` endpoint and the
 * deferred background pass. A boundary honoured on one of five doors is, from
 * the customer's side, indistinguishable from no boundary — the identical
 * argument that put `organizations.aiAssistanceEnabled` in this module.
 *
 * FAILS CLOSED, and specifically: a MISSING pilot configuration is not consent.
 * The default for a controlled pilot is AI off, so "we have not recorded a
 * decision yet" resolves to refuse.
 *
 * Applies only to `corporate_b2b`. Every other segment returns true here and is
 * governed by the organisation switch alone.
 */
async function corporateB2BBoundaryApproved(organizationId: number): Promise<boolean> {
  const org = await db.getOrganizationById(organizationId);
  if (org?.segment !== "corporate_b2b") return true;
  const boundary = await db.getCorporateB2BAiBoundary(organizationId);
  return (
    boundary?.aiAssistanceMode === "private_approved" &&
    (boundary.aiBoundaryReference ?? "").trim().length > 0
  );
}

/** Resolve the tenant's AI policy, naming the refusal rather than returning a bare false. */
async function resolveTenantAi(
  organizationId: number | null | undefined,
): Promise<{ allowed: true; organizationId: number } | { allowed: false; organizationId: number | null; reason: TenantAiRefusal }> {
  const orgId = normaliseOrgId(organizationId);
  if (orgId === null) return { allowed: false, organizationId: null, reason: "no_tenant" };
  if (!(await db.isOrganizationAiAssistanceEnabled(orgId))) {
    return { allowed: false, organizationId: orgId, reason: "assistance_disabled" };
  }
  if (!(await corporateB2BBoundaryApproved(orgId))) {
    return { allowed: false, organizationId: orgId, reason: "b2b_boundary_unapproved" };
  }
  return { allowed: true, organizationId: orgId };
}

/**
 * Non-throwing form, for background passes that should skip quietly rather
 * than surface an error to a user (the deferred analysis pass).
 */
export async function isTenantAiAllowed(organizationId: number | null | undefined): Promise<boolean> {
  return (await resolveTenantAi(organizationId)).allowed;
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
  const decision = await resolveTenantAi(organizationId);
  if (!decision.allowed) {
    throw new TenantAiDisabledError(decision.organizationId, surface, decision.reason);
  }
  return decision.organizationId;
}
