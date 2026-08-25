/**
 * Corporate B2B external-model boundary (pilot gate B5) — BEHAVIOURAL evidence.
 *
 * The B0–B8 status document says this control "fails closed unless a tenant
 * records a private_approved AI route" and is "server-side policy, not a UI-only
 * indicator". Both were true of exactly ONE procedure: an inline check inside
 * `superAgent.diagnose`. The same tenant's data still reached a model through
 * `superAgent.query`, `anomalies.detect`, the public `/api/v1/exceptions/analyze`
 * endpoint and the deferred background pass, none of which consulted it.
 *
 * The rule now lives in server/aiGate.ts, so every gated entry point inherits
 * it. These tests assert the RULE; aiGateRatchet.test.ts asserts that the entry
 * points still consult the gate.
 *
 * Every refusal is paired with the permitting case, so a test cannot pass by
 * the code path being broken and nothing running at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Org = { segment: string; aiAssistanceEnabled: boolean } | undefined;
type Boundary = { aiAssistanceMode: string; aiBoundaryReference: string | null } | null;

let org: Org = { segment: "corporate_b2b", aiAssistanceEnabled: true };
let boundary: Boundary = null;

const getOrganizationById = vi.fn(async (_id: number): Promise<Org> => org);
const getCorporateB2BAiBoundary = vi.fn(async (_id: number): Promise<Boundary> => boundary);

vi.mock("./db", () => ({
  getOrganizationById: (id: number) => getOrganizationById(id),
  isOrganizationAiAssistanceEnabled: async (id: number) =>
    (await getOrganizationById(id))?.aiAssistanceEnabled === true,
  getCorporateB2BAiBoundary: (id: number) => getCorporateB2BAiBoundary(id),
}));

const { isTenantAiAllowed, assertTenantAiAllowed, TenantAiDisabledError } = await import("./aiGate");

const APPROVED: Boundary = { aiAssistanceMode: "private_approved", aiBoundaryReference: "DPIA-2026-014" };

beforeEach(() => {
  org = { segment: "corporate_b2b", aiAssistanceEnabled: true };
  boundary = null;
  getOrganizationById.mockClear();
  getCorporateB2BAiBoundary.mockClear();
});

describe("when a Corporate B2B tenant has not recorded a private AI route", () => {
  it("should refuse even though the organisation switch is on", () => {
    // The organisation-level switch and the pilot boundary are two policies.
    // Passing the first is not passing the second.
    expect(org?.aiAssistanceEnabled).toBe(true);
    return expect(isTenantAiAllowed(7)).resolves.toBe(false);
  });

  it("should refuse when NO pilot configuration exists at all", async () => {
    // A missing register is not consent. A controlled pilot starts with AI off,
    // so "no decision has been recorded" resolves to refuse — the same
    // fail-closed direction as an absent organisation.
    boundary = null;
    expect(await isTenantAiAllowed(7)).toBe(false);
  });

  it("should refuse when the route is approved but the sign-off reference is blank", async () => {
    // " " is not a sign-off. The mutation trims this field on the way in; the
    // gate agrees rather than trusting that it always will.
    boundary = { aiAssistanceMode: "private_approved", aiBoundaryReference: "   " };
    expect(await isTenantAiAllowed(7)).toBe(false);
  });

  it("should refuse when the pilot has deliberately set AI to disabled", async () => {
    boundary = { aiAssistanceMode: "disabled", aiBoundaryReference: null };
    expect(await isTenantAiAllowed(7)).toBe(false);
  });

  it("should permit once the route and its reference are recorded — proving the above are real", async () => {
    boundary = APPROVED;
    expect(await isTenantAiAllowed(7)).toBe(true);
    await expect(assertTenantAiAllowed(7, "superAgent.query")).resolves.toBe(7);
  });
});

describe("what the refusal tells the operator", () => {
  it("should name the pilot boundary, not the organisation switch", async () => {
    // "A super admin can re-enable it in organisation settings" is the correct
    // remedy for the org switch and actively misleading here: the switch is
    // already on, and the missing thing is a recorded route in Pilot Controls.
    boundary = null;
    const error = await assertTenantAiAllowed(7, "superAgent.diagnose").catch((e) => e);
    expect(error).toBeInstanceOf(TenantAiDisabledError);
    expect(error.reason).toBe("b2b_boundary_unapproved");
    expect(error.remedy).toMatch(/Pilot Controls/);
    expect(error.remedy).not.toMatch(/organisation settings/);
  });

  it("should still name the organisation switch when that is what refused", async () => {
    org = { segment: "corporate_b2b", aiAssistanceEnabled: false };
    boundary = APPROVED;
    const error = await assertTenantAiAllowed(7, "superAgent.diagnose").catch((e) => e);
    expect(error.reason).toBe("assistance_disabled");
    expect(error.remedy).toMatch(/organisation settings/);
  });
});

describe("the boundary applies to Corporate B2B and to nothing else", () => {
  it.each(["financial_services", "retail_commerce", "super_admin"])(
    "should not impose a pilot boundary on a %s tenant",
    async (segment) => {
      org = { segment, aiAssistanceEnabled: true };
      boundary = null;
      expect(await isTenantAiAllowed(7)).toBe(true);
      // The pilot register is not even consulted for a segment it does not govern.
      expect(getCorporateB2BAiBoundary).not.toHaveBeenCalled();
    },
  );

  it("should refuse the same tenant once its segment IS corporate_b2b", async () => {
    org = { segment: "corporate_b2b", aiAssistanceEnabled: true };
    boundary = null;
    expect(await isTenantAiAllowed(7)).toBe(false);
    expect(getCorporateB2BAiBoundary).toHaveBeenCalledWith(7);
  });
});
