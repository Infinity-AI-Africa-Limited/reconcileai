/**
 * The workload check's database reader against a REAL MySQL: CI's database
 * only, gated like the other *.db.test.ts files, because the local .env names
 * production and this suite writes one row (and deletes it).
 *
 * Every catalogue statement runs against the migrated schema, so a renamed table
 * or column, or a statement the server refuses, fails here rather than on the
 * maintenance page.
 */
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dataDeletionRequests } from "../../drizzle/schema";
import { getDb } from "../db";
import { classifyDatabaseTarget } from "../dbTarget";
import { runWorkloadCheck, type WorkloadCheckDependencies } from "./workloadCheck";
import { openAppDatabase } from "./workloadReaders";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function databaseOnly(): WorkloadCheckDependencies {
  return {
    openDatabase: openAppDatabase,
    openRedis: async () => null,
    monotonicMs: () => performance.now(),
    wallClock: () => new Date(),
    replica: () => ({
      lifecycle: "running",
      trackedOperations: 0,
      uptimeSeconds: 0,
      commit: null,
      deploymentId: null,
      replicaId: null,
    }),
  };
}

describe.runIf(localDatabase)("when the check reads a real database", () => {
  let db: Db;
  const created: number[] = [];

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;
  });

  afterAll(async () => {
    if (db && created.length > 0) await db.delete(dataDeletionRequests).where(inArray(dataDeletionRequests.id, created));
  });

  it("should run every catalogue statement on the migrated schema and end its snapshot", async () => {
    const report = await runWorkloadCheck(databaseOnly());
    expect(report.database.snapshot).toBe("consistent_snapshot");
    expect(report.database.cleanup).toBe("ok");
    for (const s of report.database.surfaces) expect(Number.isSafeInteger(s.count), s.id).toBe(true);
    for (const s of report.database.intake) expect(Number.isSafeInteger(s.count), s.id).toBe(true);
    // Other suites write concurrently, so recent intake may be seen. Nothing else may fail.
    expect(report.errors.filter(code => code !== "redis_not_configured" && code !== "intake_observed")).toEqual([]);
  });

  it("should count an open data deletion request, with the age of the oldest", async () => {
    // Ten minutes and more: the column keeps whole seconds and rounds, so the
    // margin keeps the assertion off the rounding boundary.
    const [result] = await db
      .insert(dataDeletionRequests)
      .values({ requestedByUserId: 1, status: "pending", createdAt: new Date(Date.now() - 900_000) });
    created.push(Number((result as { insertId?: number }).insertId));
    const report = await runWorkloadCheck(databaseOnly());
    const open = report.database.surfaces.find(s => s.id === "data_deletion_requests.open");
    expect(open?.count).toBeGreaterThanOrEqual(1);
    expect(open?.oldestAgeSeconds).toBeGreaterThanOrEqual(600);
    expect(report.verdict).toBe("no_go_unfinished_work");
  });

  it("should leave the pool usable after several readings", async () => {
    for (let i = 0; i < 3; i++) expect((await runWorkloadCheck(databaseOnly())).database.cleanup).toBe("ok");
    const [rows] = await db.$client.promise().query("SELECT 1 AS one");
    expect(rows).toEqual([{ one: 1 }]);
  });
});
