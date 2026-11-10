/**
 * Who may run the maintenance workload check, and how often.
 *
 * Runs the real procedure through the real base procedure (lifecycle, request
 * scope, read-only ban, super-admin gate). The check's connections are fakes:
 * these tests are about the door, not the reading. routers.ts cannot be
 * imported in a test (it boots services against the configured database), so
 * the mount is pinned by its source text.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

import type { WorkloadCheckDependencies } from "../maintenance/workloadCheck";
import { maintenanceCheckRouter, setWorkloadCheckDependenciesForTests } from "./maintenanceCheck";

type Who = { id: number; role: string; organizationId: number | null; isReadOnly?: boolean };
const as = (user: Who | null) =>
  maintenanceCheckRouter.createCaller({
    user: user ? { isReadOnly: false, ...user } : null,
    viewingAs: null,
    req: { headers: {} },
    res: {},
  } as never);

const staff: Who = { id: 1, role: "super_admin", organizationId: 30002 };
const reviewer: Who = { id: 2, role: "super_admin", organizationId: null, isReadOnly: true };
const tenantAdmin: Who = { id: 3, role: "admin", organizationId: 4 };
const tenantOps: Who = { id: 4, role: "operations", organizationId: 4 };

let opened = 0;
let gate: Promise<void> = Promise.resolve();
function fakes(): WorkloadCheckDependencies {
  return {
    openDatabase: async () => {
      opened++;
      await gate;
      return null;
    },
    openRedis: async () => null,
    monotonicMs: () => Date.now(),
    wallClock: () => new Date("2026-11-10T12:00:00.000Z"),
    replica: () => ({ lifecycle: "running", trackedOperations: 1, uptimeSeconds: 1, commit: null, deploymentId: null, replicaId: null }),
  };
}

beforeEach(() => {
  opened = 0;
  gate = Promise.resolve();
  setWorkloadCheckDependenciesForTests(fakes);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  setWorkloadCheckDependenciesForTests(null);
  vi.restoreAllMocks();
});

describe("when someone who is not platform staff asks", () => {
  it.each([
    ["nobody signed in", null, "UNAUTHORIZED"],
    ["a tenant's admin", tenantAdmin, "FORBIDDEN"],
    ["a tenant's operations user", tenantOps, "FORBIDDEN"],
    ["a read-only reviewer session, even a platform one", reviewer, "FORBIDDEN"],
  ] as const)("should refuse %s before reading anything", async (_who, user, code) => {
    await expect(as(user).runWorkloadCheck()).rejects.toMatchObject({ code });
    expect(opened).toBe(0);
  });
});

describe("when a super admin runs it", () => {
  it("should return the reading, held, and log only who ran it and the verdict", async () => {
    const report = await as(staff).runWorkloadCheck();
    expect(report.hold).toBe(true);
    expect(report.verdict).toBe("no_go_incomplete_evidence");
    expect(report.errors).toEqual(["database_unavailable", "redis_not_configured"]);
    expect(opened).toBe(1);
    const lines = vi.mocked(console.info).mock.calls;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([expect.stringMatching(/^\[maintenance-check\] user 1: no_go_incomplete_evidence in \d+ms$/)]);
  });

  it("should refuse a second check while one is running", async () => {
    let finish = (): void => {};
    gate = new Promise(resolve => {
      finish = resolve;
    });
    const first = as(staff).runWorkloadCheck();
    await vi.waitFor(() => expect(opened).toBe(1));
    await expect(as(staff).runWorkloadCheck()).rejects.toMatchObject({ code: "CONFLICT" });
    finish();
    await first;
    expect(opened).toBe(1);
  });

  it("should refuse a check started less than ten seconds after the last", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await as(staff).runWorkloadCheck();
      vi.setSystemTime(Date.now() + 9_000);
      await expect(as(staff).runWorkloadCheck()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
      vi.setSystemTime(Date.now() + 1_000);
      await expect(as(staff).runWorkloadCheck()).resolves.toMatchObject({ hold: true });
      expect(opened).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("when the application router is assembled", () => {
  it("should mount the check as maintenanceCheck", () => {
    const source = readFileSync(path.resolve(__dirname, "..", "routers.ts"), "utf8");
    expect(source).toContain('import { maintenanceCheckRouter } from "./routers/maintenanceCheck";');
    expect(source).toContain("  maintenanceCheck: maintenanceCheckRouter,");
  });
});
