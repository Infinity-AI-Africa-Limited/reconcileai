import { describe, expect, it } from "vitest";
import fs from "node:fs";

const schema = fs.readFileSync("drizzle/schema.ts", "utf8");
const db = fs.readFileSync("server/db.ts", "utf8");
const router = fs.readFileSync("server/routers.ts", "utf8");
const migration = fs.readFileSync("drizzle/0085_tenant_ai_assistance_control.sql", "utf8");

describe("Financial Services per-tenant AI control", () => {
  it("persists an explicit per-tenant AI-assistance switch", () => {
    expect(schema).toContain('aiAssistanceEnabled: boolean("aiAssistanceEnabled").default(true).notNull()');
    expect(migration).toContain("ADD COLUMN `aiAssistanceEnabled`");
  });

  it("fails closed before the deferred analysis reads exception context or calls a model", () => {
    expect(db).toContain("isOrganizationAiAssistanceEnabled");
    const gate = router.indexOf("has AI assistance disabled; skipping deferred model analysis");
    const pendingLookup = router.indexOf("getJobExceptionsNeedingAi(jobId, tenantId)");
    expect(gate).toBeGreaterThan(-1);
    expect(pendingLookup).toBeGreaterThan(gate);
  });

  it("limits tenant AI configuration changes to the super-admin control plane and records an audit event", () => {
    expect(router).toContain("setOrganizationAiAssistance: superAdminProcedure");
    expect(router).toContain('"update_org_ai_assistance"');
    expect(router).toContain('eventType: "org_ai_assistance_updated"');
    expect(schema).toContain('"org_ai_assistance_updated"');
  });
});
