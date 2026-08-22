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

  it("preserves unattributable legacy exceptions instead of deleting them on deploy", () => {
    // The quarantine table is still defined by the migration — it is where the
    // operator drain writes. What changed is WHO empties it: this migration used
    // to copy the rows and then issue an unconditional
    // `DELETE FROM exceptions WHERE organizationId IS NULL`, unattended, as a
    // Railway pre-deploy step and inside on-premise bank installations. Exceptions
    // are financial control records; a deploy hook may not destroy them without an
    // impact assertion or an operator saying so.
    expect(migration).toContain("exception_ownership_quarantine");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+`exceptions`/i);

    // Instead the migration asserts nothing is left unattributable and fails
    // closed, stopping the deploy, before the column is tightened.
    expect(migration).toContain("_migration_0084_ownership_assertion");
    expect(migration).toContain("MODIFY COLUMN `organizationId` int NOT NULL");

    // The destructive half is a deliberate, dry-run-by-default operator step.
    const drain = fs.readFileSync("scripts/drain-unattributable-exceptions.mjs", "utf8");
    expect(drain).toContain("INSERT IGNORE INTO");
    expect(drain).toContain("exception_ownership_quarantine");
    expect(drain).toContain("--execute");
    expect(drain).toContain("DRY RUN");
  });

  it("derives legacy ownership from the reconciliation job and never guesses one", () => {
    // Runtime exception ownership comes from the parent job, and migration 0078
    // backfilled the same column the same way. Where the job cannot name an
    // owner nothing else may: the transaction's tenant can differ from the
    // job's, and with the job gone there is nothing to check it against.
    expect(migration).toContain("JOIN `reconciliation_jobs` AS `j`");
    expect(migration).not.toContain("JOIN `transactions`");
  });
});
