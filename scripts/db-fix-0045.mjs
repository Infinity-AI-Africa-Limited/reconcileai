// Surgical fix: mark migration 0045 (poc_file_uploads) as already-applied in
// __drizzle_migrations. The table already exists in prod (created under the
// pre-renumber migration), but drizzle-kit's timestamp bookkeeping thinks 0045
// is pending and tries to re-CREATE it → ER_TABLE_EXISTS_ERROR → deploy fails.
// Inserting the applied record with the journal's `when` timestamp makes
// `drizzle-kit migrate` skip it. Idempotent + safe (no schema change).
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }

// 0045_careful_living_tribunal: the journal `when` value (ms) for idx 45.
const WHEN_0045 = 1781902972073;
const sql0045 = readFileSync("drizzle/0045_careful_living_tribunal.sql", "utf8");
const hash = crypto.createHash("sha256").update(sql0045).digest("hex");

const u = new URL(url);
const conn = await mysql.createConnection({
  host: u.hostname, port: Number(u.port || 3306),
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ""),
  ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
});

const [before] = await conn.query("SELECT COUNT(*) AS n, MAX(created_at) AS maxc FROM `__drizzle_migrations`");
console.log("before: rows =", before[0].n, "max created_at =", String(before[0].maxc));

if (Number(before[0].maxc) >= WHEN_0045) {
  console.log("already marked applied (max >= 0045 when) — nothing to do.");
} else {
  // Does a row with this hash already exist?
  const [dupe] = await conn.query("SELECT COUNT(*) AS n FROM `__drizzle_migrations` WHERE hash = ?", [hash]);
  if (dupe[0].n > 0) {
    console.log("hash already present — nothing to do.");
  } else {
    await conn.query("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)", [hash, WHEN_0045]);
    console.log("inserted applied record for 0045 (created_at =", WHEN_0045, ")");
  }
}

const [after] = await conn.query("SELECT COUNT(*) AS n, MAX(created_at) AS maxc FROM `__drizzle_migrations`");
console.log("after:  rows =", after[0].n, "max created_at =", String(after[0].maxc));
await conn.end();
console.log("done");
