// One-off production DB diagnostic — reads DATABASE_URL from env, reports the
// drizzle migration state and which expected tables already exist. Read-only.
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }

const u = new URL(url);
const conn = await mysql.createConnection({
  host: u.hostname,
  port: Number(u.port || 3306),
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ""),
  ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
});

console.log("connected to", u.hostname, "db:", u.pathname.replace(/^\//, ""));

// __drizzle_migrations state
try {
  const [rows] = await conn.query(
    "SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM `__drizzle_migrations`",
  );
  console.log("__drizzle_migrations: rows =", rows[0].n, "latest =", rows[0].latest);
  const [recent] = await conn.query(
    "SELECT id, hash, created_at FROM `__drizzle_migrations` ORDER BY id DESC LIMIT 5",
  );
  console.log("recent applied (id, created_at):");
  for (const r of recent) console.log("  ", r.id, new Date(Number(r.created_at)).toISOString(), r.hash.slice(0, 12));
} catch (e) {
  console.log("__drizzle_migrations: NOT FOUND or unreadable —", e.message);
}

// Which expected tables exist?
const expect = [
  "transactions", "exceptions", "audit_logs",
  "exception_intelligence_settings", "exception_pattern_signatures", "shared_exception_patterns",
  "poc_uploads", "poc_runs", "poc_exceptions", "poc_share_tokens", "poc_file_uploads",
  "exception_aging_settings",
  "cfo_report_schedules",
];
const [tbls] = await conn.query("SHOW TABLES");
const key = Object.keys(tbls[0])[0];
const present = new Set(tbls.map((t) => t[key]));
console.log("total tables:", present.size);
console.log("expected-table presence:");
for (const t of expect) console.log("  ", present.has(t) ? "✓" : "✗ MISSING", t);

// New columns we added on existing tables (additive)
async function hasCol(table, col) {
  try {
    const [c] = await conn.query(
      "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?",
      [u.pathname.replace(/^\//, ""), table, col],
    );
    return c[0].n > 0;
  } catch { return null; }
}
console.log("new columns on existing tables:");
console.log("   uploadBatches.detectedFormat:", await hasCol("upload_batches", "detectedFormat"));
console.log("   cbnReportSubmissions.signature:", await hasCol("cbnReportSubmissions", "signature"));
console.log("   audit_logs.recordHash:", await hasCol("audit_logs", "recordHash"));
console.log("   reconciliation_jobs.multiRunId:", await hasCol("reconciliation_jobs", "multiRunId"));

await conn.end();
console.log("done");
