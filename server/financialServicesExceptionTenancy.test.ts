import { describe, expect, it } from "vitest";
import fs from "node:fs";

const schema = fs.readFileSync("drizzle/schema.ts", "utf8");
const db = fs.readFileSync("server/db.ts", "utf8");
const router = fs.readFileSync("server/routers.ts", "utf8");
const migration = fs.readFileSync("drizzle/0084_exception_ownership_required.sql", "utf8");

describe("Financial Services exception tenancy hardening", () => {
  it("requires an organization owner for every new exception row", () => {
    const exceptionBlock = schema.split("export const exceptions")[1].split("export type Exception")[0];
    expect(exceptionBlock).toContain('organizationId: int("organizationId").notNull()');
    expect(db).toContain("assertExceptionTenantOwnership(data)");
    expect(db).toContain("for (const data of dataArray) assertExceptionTenantOwnership(data)");
  });

  it("scopes the deferred AI candidate query to the job tenant", () => {
    expect(db).toContain("getJobExceptionsNeedingAi(jobId: number, organizationId: number)");
    expect(db).toContain("eq(exceptions.organizationId, organizationId)");
    expect(router).toContain("getJobExceptionsNeedingAi(jobId, tenantId)");
    expect(router).toContain("refusing deferred analysis");
  });

  it("refuses to create exceptions from an organization-less reconciliation job", () => {
    expect(router).toContain("has no owning organization; refusing to run");
    expect(router).toContain("has no owning organization; refusing deferred analysis");
  });

  it("refuses demo seeds that would create unauditable exception records", () => {
    const demoSeed = fs.readFileSync("server/demoSeedEngine.ts", "utf8");
    const finservSeed = fs.readFileSync("server/demoSeedFinServ.ts", "utf8");
    expect(demoSeed).toContain("Financial Services demo seed requires an owning organizationId");
    expect(demoSeed).toContain("Corporate B2B demo seed requires an owning organizationId");
    expect(finservSeed).toContain("Financial Services demo seed requires an owning organizationId");
  });

  it("preserves unattributable legacy exceptions outside tenant-visible operational data", () => {
    expect(migration).toContain("exception_ownership_quarantine");
    expect(migration).toContain("INSERT IGNORE INTO `exception_ownership_quarantine`");
    expect(migration).toContain("DELETE FROM `exceptions` WHERE `organizationId` IS NULL");
    expect(migration).toContain("MODIFY COLUMN `organizationId` int NOT NULL");
  });
});
