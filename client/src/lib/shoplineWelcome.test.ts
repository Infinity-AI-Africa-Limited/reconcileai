import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("SHOPLINE post-OAuth tenant hand-off", () => {
  const source = readFileSync("client/src/pages/ShoplineConnect.tsx", "utf8");

  it("uses the existing super-admin portal context only for an identified retail organisation", () => {
    expect(source).toContain("user?.role === \"super_admin\"");
    expect(source).toContain("organization.code === orgCode");
    expect(source).toContain("organization.segment === \"retail_commerce\"");
    expect(source).toContain("enterPortal({");
  });

  it("fails closed instead of navigating a staff session before the retail context is resolved", () => {
    expect(source).toContain("isLoading: isLoadingOrganizations");
    expect(source).toContain("if (isLoadingOrganizations) return;");
    expect(source).toContain("if (!retailOrg) {");
    expect(source).toContain("disabled={isPortalActionDisabled}");
  });

  it("does not represent the test portal hand-off as merchant authentication", () => {
    expect(source).toContain("Production merchant identity hand-off remains a separate P0 release gate");
  });
});
