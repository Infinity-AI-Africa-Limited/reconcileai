import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("SHOPLINE settlement-file retail portal scope", () => {
  const settlementImporter = readFileSync("client/src/components/SettlementFileImport.tsx", "utf8");
  const connectorRouter = readFileSync("server/routers/shoplineConnector.ts", "utf8");

  it("passes the active portal organisation to settlement-file preview and import", () => {
    expect(settlementImporter).toContain("const { viewAsOrg } = usePortalContext()");
    expect(settlementImporter).toContain("organizationId: viewAsOrg?.id");
  });

  it("resolves settlement-file import scope through the server-side super-admin guard", () => {
    expect(connectorRouter).toContain("organizationId: z.number().int().positive().optional()");
    expect(connectorRouter).toContain("const orgId = resolveOrgId(ctx.user, input.organizationId);");
  });
});
