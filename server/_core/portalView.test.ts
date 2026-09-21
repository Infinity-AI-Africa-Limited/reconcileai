/**
 * The super-admin portal, decided once per request (server/_core/portalView.ts).
 *
 * The security property: only a super admin may view as another organisation,
 * and a bad or unknown tenant fails CLOSED — to no organisation, never to the
 * operator's own, where a write meant for the tenant on screen would land.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyPortalView, parsePortalOrgHeader, PORTAL_ORG_HEADER } from "./portalView";

vi.mock("./sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));
vi.mock("../db", () => ({ getOrganizationById: vi.fn() }));
import { sdk } from "./sdk";
import { getOrganizationById } from "../db";
import { createContext } from "./context";

const OPERATOR_ORG = 30002;
const staff = { id: 1, role: "super_admin", organizationId: OPERATOR_ORG } as never;
const tenantAdmin = { id: 2, role: "admin", organizationId: 1 } as never;
const exists = (ids: number[]) => async (id: number) => ids.includes(id);

describe("when the portal header is read", () => {
  it("should accept only a positive whole organisation id", () => {
    expect(parsePortalOrgHeader("30001")).toBe(30001);
    expect(parsePortalOrgHeader([" 7 "])).toBe(7);
    for (const bad of [undefined, "", "0", "-1", "1.5", "7abc", "1e3", "12345678901"]) {
      expect(parsePortalOrgHeader(bad), String(bad)).toBeNull();
    }
  });
});

describe("when a super admin is inside a tenant's portal", () => {
  it("should act as that tenant for the request, keeping who they are", async () => {
    const view = await applyPortalView(staff, "30001", exists([30001]));
    expect(view.user).toMatchObject({ id: 1, role: "super_admin", organizationId: 30001 });
    expect(view.actor).toBe(staff);
    expect(view.viewingAs).toBe(30001);
  });

  it("should fail closed to NO organisation for an unknown or malformed tenant — never the operator's own", async () => {
    for (const header of ["999999", "abc", "0"]) {
      const view = await applyPortalView(staff, header, exists([30001]));
      expect(view.user?.organizationId, header).toBeNull();
      expect(view.viewingAs).toBeNull();
      expect(view.actor).toBe(staff);
    }
  });

  it("should leave a super admin outside a portal exactly as they are", async () => {
    const view = await applyPortalView(staff, undefined, exists([30001]));
    expect(view).toEqual({ user: staff, actor: staff, viewingAs: null });
  });
});

describe("when anyone who is not a super admin sends the header", () => {
  it("should ignore it — not refuse it — so the attempt reveals nothing", async () => {
    const lookup = vi.fn(exists([30001]));
    for (const role of ["admin", "operations", "cfo", "compliance", "user"]) {
      const user = { id: 3, role, organizationId: 1 } as never;
      const view = await applyPortalView(user, "30001", lookup);
      expect(view.user, role).toBe(user);
      expect(view.viewingAs).toBeNull();
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("should give an unauthenticated request nothing to act as", async () => {
    expect(await applyPortalView(null, "30001", exists([30001]))).toEqual({ user: null, actor: null, viewingAs: null });
  });
});

describe("when a tRPC request context is created", () => {
  beforeEach(() => vi.clearAllMocks());
  const req = (headers: Record<string, string>) => ({ req: { headers } as never, res: {} as never });

  it("should apply the portal header to a super admin's session", async () => {
    vi.mocked(sdk.authenticateRequest).mockResolvedValue(staff);
    vi.mocked(getOrganizationById).mockResolvedValue({ id: 30001 } as never);
    const ctx = await createContext(req({ [PORTAL_ORG_HEADER]: "30001" }) as never);
    expect(ctx.user?.organizationId).toBe(30001);
    expect(ctx.actor?.organizationId).toBe(OPERATOR_ORG);
    expect(ctx.viewingAs).toBe(30001);
    expect(getOrganizationById).toHaveBeenCalledWith(30001);
  });

  it("should not let a tenant user's header change anything", async () => {
    vi.mocked(sdk.authenticateRequest).mockResolvedValue(tenantAdmin);
    const ctx = await createContext(req({ [PORTAL_ORG_HEADER]: "30001" }) as never);
    expect(ctx.user?.organizationId).toBe(1);
    expect(ctx.viewingAs).toBeNull();
    expect(getOrganizationById).not.toHaveBeenCalled();
  });

  it("should stay signed out when authentication fails", async () => {
    vi.mocked(sdk.authenticateRequest).mockRejectedValue(new Error("no cookie"));
    const ctx = await createContext(req({ [PORTAL_ORG_HEADER]: "30001" }) as never);
    expect(ctx.user).toBeNull();
    expect(ctx.actor).toBeNull();
  });
});
