/**
 * The portal tenant travels with every request (lib/portalRequest.ts). The
 * server makes it a super admin's organisation for the request, so these
 * helpers decide what reaches every tRPC call and the monitoring stream.
 */
import { describe, it, expect } from "vitest";
import { PORTAL_ORG_HEADER, portalHeaders, portalOrgIdFromSession, withPortalOrg } from "./portalRequest";

const stored = (org: unknown) => JSON.stringify(org);

describe("when a super admin is inside a portal", () => {
  it("should send the tenant's id in the header the server reads", () => {
    expect(PORTAL_ORG_HEADER).toBe("x-portal-org"); // server/_core/portalView.ts
    expect(portalHeaders(stored({ id: 30001, name: "BrightGoods" }))).toEqual({ "x-portal-org": "30001" });
  });

  it("should put the same id on the monitoring stream, which cannot send headers", () => {
    expect(withPortalOrg("/api/monitoring/stream", stored({ id: 1 }))).toBe("/api/monitoring/stream?portalOrg=1");
    expect(withPortalOrg("/x?a=1", stored({ id: 1 }))).toBe("/x?a=1&portalOrg=1");
  });
});

describe("when no portal is open, or the stored value is unusable", () => {
  it("should send nothing, so the server answers for the signed-in organisation", () => {
    for (const raw of [null, "", "not json", stored({}), stored({ id: 0 }), stored({ id: -3 }), stored({ id: "7" }), stored({ id: 1.5 })]) {
      expect(portalOrgIdFromSession(raw), String(raw)).toBeNull();
      expect(portalHeaders(raw)).toEqual({});
      expect(withPortalOrg("/api/monitoring/stream", raw)).toBe("/api/monitoring/stream");
    }
  });
});
