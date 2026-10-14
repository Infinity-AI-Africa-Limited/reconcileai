/**
 * The server's sessions against a REAL MySQL — CI's database only, gated like
 * the other *.db.test.ts files because the local .env names production and
 * this suite writes rows.
 *
 * The defect only shows on a server whose default zone is not UTC, which CI's
 * is not. So the suite asserts the session itself (`@@session.time_zone` reads
 * `SYSTEM` unless something set it, so the pin is visible even on a UTC
 * server) AND the instants a shifted session corrupts, which a non-UTC server
 * — such as the local proof run at +01:00 — exercises.
 */
import { eq, inArray, sql } from "drizzle-orm";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations } from "../drizzle/schema";
import { getDb } from "./db";
import { classifyDatabaseTarget } from "./dbTarget";
import { createAppPool, SESSION_TIME_ZONE } from "./dbSession";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Session = { tz: string; offsetSeconds: number | string; connectionId: number | string };

/** One session's zone, offset from UTC and identity, held open briefly so concurrent calls need separate connections. */
const SESSION_PROBE =
  "SELECT @@session.time_zone AS tz, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS offsetSeconds, CONNECTION_ID() AS connectionId, SLEEP(0.3) AS held";

function expectAllUtc(sessions: Session[]) {
  // Concurrent calls, so the pool had to open more than one connection.
  expect(new Set(sessions.map(session => String(session.connectionId))).size).toBeGreaterThan(1);
  for (const session of sessions) {
    expect(session.tz).toBe(SESSION_TIME_ZONE);
    expect(Number(session.offsetSeconds)).toBe(0);
  }
}

describe.runIf(localDatabase)("when the server's sessions meet a real database", () => {
  let db: Db;
  const createdOrganizations: number[] = [];
  const code = () => `TZPROOF_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  async function newOrganization(values: Partial<typeof organizations.$inferInsert> = {}): Promise<number> {
    const [result] = await db.insert(organizations).values({ name: "Session time-zone proof", code: code(), isDemo: true, ...values });
    const id = Number((result as { insertId?: number }).insertId);
    createdOrganizations.push(id);
    return id;
  }

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;
  });

  afterAll(async () => {
    if (db && createdOrganizations.length > 0) {
      await db.delete(organizations).where(inArray(organizations.id, createdOrganizations));
    }
  });

  it("should face a server session that is not already pinned, or say why the proof is weaker", async context => {
    // The control: an unpinned session runs in the server's default. If that
    // default were already +00:00 the pin could not be told apart here.
    const raw = await mysql.createConnection({ uri: url });
    try {
      const [rows] = await raw.query<mysql.RowDataPacket[]>("SELECT @@session.time_zone AS tz");
      if (rows[0].tz === SESSION_TIME_ZONE) context.skip();
      expect(rows[0].tz).not.toBe(SESSION_TIME_ZONE);
    } finally {
      await raw.end();
    }
  });

  it("should run every session of the app's pool in UTC", async () => {
    const sessions = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const [rows] = (await db.execute(sql.raw(SESSION_PROBE))) as unknown as [Session[]];
        return rows[0];
      })
    );
    expectAllUtc(sessions);
  });

  it("should run every session of any other app pool in UTC too", async () => {
    // The Woodcore mirror sync writes our database through its own pool.
    const pool = createAppPool(url!).promise();
    try {
      const sessions = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const [rows] = await pool.query<mysql.RowDataPacket[]>(SESSION_PROBE);
          return rows[0] as Session;
        })
      );
      expectAllUtc(sessions);
    } finally {
      await pool.end();
    }
  });

  it("should store the instant drizzle was given", async () => {
    const instant = new Date("2026-01-02T03:04:05.000Z");
    const id = await newOrganization({ createdAt: instant });

    // UNIX_TIMESTAMP of a TIMESTAMP column is the stored instant itself, whatever the session zone.
    const [rows] = (await db.execute(
      sql`SELECT UNIX_TIMESTAMP(createdAt) AS epoch FROM organizations WHERE id = ${id}`
    )) as unknown as [Array<{ epoch: number | string }>];
    expect(Number(rows[0].epoch)).toBe(instant.getTime() / 1000);
  });

  it("should read a time the database stamped back as the instant it happened", async () => {
    const before = Date.now();
    const id = await newOrganization();

    const [row] = await db.select({ createdAt: organizations.createdAt }).from(organizations).where(eq(organizations.id, id));
    // DEFAULT now() stores the true instant; a shifted session would read it back hours off.
    expect(Math.abs(row.createdAt.getTime() - before)).toBeLessThan(60_000);
  });
});
