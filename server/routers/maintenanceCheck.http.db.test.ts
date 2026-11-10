/**
 * The maintenance check through the real door: an HTTP request carrying a
 * signed session cookie, the real context (sdk.authenticateRequest against real
 * user rows), the real procedure chain and the real database reader. CI's
 * database only, gated like the other *.db.test.ts files; the suite writes its
 * own user rows and deletes them. Nothing here leaves the machine: no email, no
 * provider call, and Redis is left out.
 *
 * It also pins what authenticating writes, so "the check writes nothing" is
 * never read as "the request writes nothing": every authenticated request
 * updates the user's lastSignedIn.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import superjson from "superjson";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ENV is a frozen snapshot, so the signing secret must exist before it loads.
vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "maintenance-check-http-test-secret-0123456789";
});

import { COOKIE_NAME } from "@shared/const";
import { users } from "../../drizzle/schema";
import { createContext } from "../_core/context";
import { sdk } from "../_core/sdk";
import { router } from "../_core/trpc";
import { getDb } from "../db";
import { classifyDatabaseTarget } from "../dbTarget";
import { appWorkloadDependencies } from "../maintenance/workloadReaders";
import { maintenanceCheckRouter, setWorkloadCheckDependenciesForTests } from "./maintenanceCheck";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

const door = router({ maintenanceCheck: maintenanceCheckRouter });
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Seed = { id: number; openId: string; cookie: string };

describe.runIf(localDatabase)("when the check is called over HTTP with a real session", () => {
  let db: Db;
  let server: Server;
  let base = "";
  let runs = 0;
  const seeded: Seed[] = [];
  const run = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  async function seed(key: string, values: Partial<typeof users.$inferInsert>): Promise<Seed> {
    const openId = `mwc_http_${run}_${key}`;
    const [result] = await db
      .insert(users)
      .values({ openId, name: key, email: `${key}.${run}@example.invalid`, loginMethod: "magic_link", ...values });
    const cookie = `${COOKIE_NAME}=${await sdk.createSessionToken(openId, { name: key })}`;
    const row = { id: Number((result as { insertId?: number }).insertId), openId, cookie };
    seeded.push(row);
    return row;
  }

  const as = (cookie?: string) =>
    createTRPCClient<typeof door>({
      links: [httpLink({ url: `${base}/api/trpc`, transformer: superjson, headers: () => (cookie ? { cookie } : {}) })],
    }).maintenanceCheck.runWorkloadCheck.mutate();

  /** Fresh gates for each admitted call; count every reading that starts. */
  function armCheck(): void {
    setWorkloadCheckDependenciesForTests(() => {
      runs++;
      return { ...appWorkloadDependencies(), openRedis: async () => null };
    });
  }

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;
    const app = express();
    app.use("/api/trpc", createExpressMiddleware({ router: door, createContext }));
    await new Promise<void>(resolve => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    armCheck();
  });

  afterAll(async () => {
    setWorkloadCheckDependenciesForTests(null);
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (db && seeded.length > 0) await db.delete(users).where(inArray(users.id, seeded.map(s => s.id)));
  });

  it("should refuse every caller who is not active platform staff, before any reading starts", async () => {
    const tenantAdmin = await seed("tenant_admin", { role: "admin" });
    const reviewer = await seed("read_only_staff", { role: "super_admin", isReadOnly: true });
    const deactivated = await seed("deactivated_staff", { role: "super_admin", isActive: false });
    const forged = `${COOKIE_NAME}=${(await sdk.createSessionToken(`mwc_http_${run}_nobody`, { name: "nobody" })).slice(0, -4)}AAAA`;

    await expect(as()).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
    await expect(as(forged)).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
    await expect(as(deactivated.cookie)).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
    await expect(as(tenantAdmin.cookie)).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await expect(as(reviewer.cookie)).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect(runs).toBe(0);
  });

  it("should run one reading for active staff, and record the sign-in that authentication always writes", async () => {
    const staff = await seed("staff", { role: "super_admin", lastSignedIn: new Date("2026-01-01T00:00:00Z") });
    armCheck();
    const report = await as(staff.cookie);
    expect(runs).toBe(1);
    expect(report.hold).toBe(true);
    expect(report.database.snapshot).toBe("consistent_snapshot");
    expect(report.database.cleanup).toBe("ok");
    expect(report.errors).toContain("redis_not_configured");
    const [row] = await db.select({ lastSignedIn: users.lastSignedIn }).from(users).where(eq(users.id, staff.id));
    expect(row.lastSignedIn.getTime()).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("should follow a session's account as it changes: demoted, then deactivated", async () => {
    const staff = await seed("changing_staff", { role: "super_admin" });
    armCheck();
    const before = runs;
    await expect(as(staff.cookie)).resolves.toMatchObject({ hold: true });
    expect(runs).toBe(before + 1);

    await db.update(users).set({ role: "admin" }).where(eq(users.id, staff.id));
    armCheck();
    await expect(as(staff.cookie)).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });

    await db.update(users).set({ role: "super_admin", isActive: false }).where(eq(users.id, staff.id));
    await expect(as(staff.cookie)).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
    expect(runs).toBe(before + 1);
  });
});
