import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("SHOPLINE retail portal data scope", () => {
  const settlementMonitor = readFileSync("client/src/pages/SettlementMonitor.tsx", "utf8");
  const syncStatusPage = readFileSync("client/src/pages/ShoplineSyncStatus.tsx", "utf8");
  const connectorRouter = readFileSync("server/routers/shoplineConnector.ts", "utf8");

  it("passes the active portal organisation to Settlement Monitor reads", () => {
    expect(settlementMonitor).toContain("const { viewAsOrg } = usePortalContext()");
    expect(settlementMonitor).toContain("trpc.shoplineConnector.listStores.useQuery(portalScope)");
    expect(settlementMonitor).toContain("trpc.shoplineConnector.syncStatus.useQuery(portalScope");
  });

  it("passes the active portal organisation to Sync Status reads and manual sync", () => {
    expect(syncStatusPage).toContain("trpc.shoplineConnector.listStores.useQuery(portalScope)");
    expect(syncStatusPage).toContain("{ limit: 50, ...portalScope }");
    expect(syncStatusPage).toContain("triggerSync.mutate({ storeId: store.id, ...portalScope })");
  });

  it("uses the existing server-side super-admin tenancy resolver for every portal-scoped procedure", () => {
    expect(connectorRouter).toContain('import { resolveOrgScope } from "../_core/tenancy"');
    expect(connectorRouter).toContain("const orgId = resolveOrgId(ctx.user, input.organizationId);");
    expect(connectorRouter).toContain("syncStatus: protectedProcedure\n    .input(z.object({ organizationId:");
    expect(connectorRouter).toContain("recentWebhookEvents: protectedProcedure\n    .input(z.object({ limit:");
    expect(connectorRouter).toContain("triggerManualSync: protectedProcedure\n    .input(z.object({ storeId:");
  });
});
