#!/usr/bin/env node
/**
 * Synthetic S2 practice run: made-up data only, never production.
 *
 *   node tools/s2-practice/practice.mjs <workdir>
 *
 * Expects tools/s2-practice/cluster.sh to have started the local cluster in
 * <workdir>. Writes <workdir>/receipt.json and prints a summary. Exits 0 only
 * when every expected outcome was observed, the deliberate failures included.
 * See README.md for what each check proves and what it does not.
 */
import mysql from "mysql2/promise";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
  CLIENT_PROFILE,
  DUMP_PROFILE,
  buildRanges,
  checkCoverage,
  chooseRangeKey,
  compareDigests,
  createRowHasher,
  dataOnlyChunkProblems,
  dumpCompleted,
  exactTsoProblem,
  exportProfileProblems,
  normaliseCreateTable,
  parseGeneralLog,
  parseSqlDigests,
  SNAPSHOT_BUDGET_MS,
  snapshotWithinBudget,
  sqlDigestStatement,
  statementEndingTransaction,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const WORK = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !fs.existsSync(path.join(WORK, "certs", "ca.pem"))) {
  console.error("usage: practice.mjs <workdir>  (start the cluster first: cluster.sh up <workdir>)");
  process.exit(2);
}
const CERTS = path.join(WORK, "certs");
const DUMPS = path.join(WORK, "dumps");
const CA = fs.readFileSync(path.join(CERTS, "ca.pem"));
const NET = "s2net";
const CLIENT_IMAGE = process.env.S2_CLIENT_IMAGE ?? "mirror.gcr.io/library/mysql:8.4";
const DB = "reconcileai";
const SOURCE = { host: "127.0.0.1", port: 4000, tlsName: "s2-source" };
const TARGET = { host: "127.0.0.1", port: 4001, tlsName: "s2-target" };
const ROW_COUNTS = { transactions: 60000, matches: 10000, exceptions: 3000, agentMemory: 1000 };
const DEFAULT_ROWS = 25;
const ARCHIVES = {
  transactions_legacy_archive: { like: "transactions", rows: 80000 },
  matches_legacy_archive: { like: "matches", rows: 5000 },
  exceptions_legacy_archive: { like: "exceptions", rows: 700 },
  distributors_legacy_archive: { like: "distributors", rows: 44 },
};
const DRIFT_TABLE = "s2_drift_archive";
const KEYLESS_TABLE = "s2_keyless_archive";
const GUARD_TABLE = "s2_guard";
const CHUNK_KEYS = 20000;
/** Production has no read-only login: the practice uses one that may write, as the project login can. */
const SOURCE_USER = "s2proj";
const BUDGET_MS = Number(process.env.S2_SNAPSHOT_BUDGET_MS ?? SNAPSHOT_BUDGET_MS);

/** This script reaches only the two local containers, and never reads DATABASE_URL. */
delete process.env.DATABASE_URL;

const receipt = {
  methods: {
    optionA: "LIVE_ONLY_ONE_POINT: SHOW MASTER STATUS + mysqldump --init-command tidb_snapshot, writers running, 10-minute window",
    optionB: "FULL_UNDER_WRITER_FREEZE: every session pinned to a fresh point for write refusal; consistency from the freeze",
  },
  startedAt: new Date().toISOString(),
  synthetic: true,
  versions: {},
  timings: {},
  checks: [],
  findings: [],
};

function check(name, expected, observed, detail = undefined) {
  const pass = expected === observed;
  receipt.checks.push({ name, expected, observed, result: pass ? "PASS" : "FAIL", ...(detail ? { detail } : {}) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  return pass;
}

function secret() {
  return randomBytes(18).toString("base64url");
}

function connectionFor(endpoint, user, password, extra = {}) {
  // A TSO is beyond 2^53: read every big integer as exact text, never as a number.
  const base = { host: endpoint.host, port: endpoint.port, user, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true, ...extra };
  if (!password) return mysql.createConnection(base);
  return mysql.createConnection({
    ...base,
    password,
    ssl: { ca: CA, servername: endpoint.tlsName, checkServerIdentity: (_host, cert) => tls.checkServerIdentity(endpoint.tlsName, cert) },
  });
}

async function assertLocalPractice(conn, label) {
  const [[row]] = await conn.query("SELECT VERSION() AS version, tidb_version() AS v");
  if (!/-TiDB-/.test(row.version)) throw new Error(`${label} is not a TiDB server (${row.version})`);
  const inspected = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", label === "source" ? "s2-source" : "s2-target"]);
  if (String(inspected.stdout).trim() !== "true") throw new Error(`the ${label} container is not running`);
  return row.v.split("\n")[0];
}

// ─── Synthetic data ──────────────────────────────────────────────────────────

const isoDate = (i) => new Date(Date.UTC(2026, 0, 1) + (i % 3650) * 86400000).toISOString().slice(0, 10);
const isoDateTime = (i) => new Date(Date.UTC(2026, 0, 1) + (i % 315360000) * 1000).toISOString().slice(0, 19).replace("T", " ");
const enumValues = (columnType) => [...columnType.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));

function syntheticValue(col, i, table) {
  const type = col.DATA_TYPE.toLowerCase();
  if (col.COLUMN_NAME === "organizationId") return (i % 5) + 1;
  switch (type) {
    case "tinyint":
      return /^tinyint\(1\)/.test(col.COLUMN_TYPE) ? i % 2 : i % 100;
    case "smallint":
      return i % 30000;
    case "mediumint":
    case "int":
    case "integer":
    case "bigint":
      return i;
    case "decimal": {
      const scale = Math.min(Number(col.NUMERIC_SCALE ?? 0), 6);
      const whole = Math.max(1, Number(col.NUMERIC_PRECISION ?? 10) - Number(col.NUMERIC_SCALE ?? 0));
      const integer = i % 10 ** Math.min(whole, 9);
      return scale > 0 ? `${integer}.${String(i % 10 ** scale).padStart(scale, "0")}` : String(integer);
    }
    case "float":
    case "double":
      return (i % 100000) * 1.25;
    case "char":
    case "varchar":
    case "tinytext":
    case "text":
    case "mediumtext":
    case "longtext": {
      const text = `syn-${table}-${col.COLUMN_NAME}-${i}`;
      const max = Number(col.CHARACTER_MAXIMUM_LENGTH ?? 255);
      return text.length > max ? text.slice(-max) : text;
    }
    case "enum": {
      const values = enumValues(col.COLUMN_TYPE);
      return values[i % values.length];
    }
    case "set":
      return enumValues(col.COLUMN_TYPE)[0];
    case "json":
      return JSON.stringify({ synthetic: true, i, note: `made-up row ${i}` });
    case "date":
      return isoDate(i);
    case "datetime":
    case "timestamp":
      return isoDateTime(i);
    case "time":
      return "01:02:03";
    case "year":
      return 2026;
    case "binary":
    case "varbinary":
    case "blob":
    case "tinyblob":
    case "mediumblob":
    case "longblob": {
      const bytes = Buffer.alloc(8);
      bytes.writeBigUInt64BE(BigInt(i));
      return bytes.subarray(0, Math.min(8, Number(col.CHARACTER_MAXIMUM_LENGTH ?? 8)));
    }
    case "bit":
      return 0;
    default:
      throw new Error(`no synthetic value for ${table}.${col.COLUMN_NAME} (${type})`);
  }
}

async function columnsOf(conn, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, EXTRA, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [table],
  );
  return rows;
}

async function primaryKeyOf(conn, table) {
  const [rows] = await conn.query(
    `SELECT k.COLUMN_NAME AS \`column\`, c.DATA_TYPE AS dataType
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.COLUMNS c
         ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY k.ORDINAL_POSITION`,
    [table],
  );
  return rows;
}

function insertableColumns(columns) {
  return columns.filter((c) => !/auto_increment|GENERATED/i.test(c.EXTRA));
}

async function seedTable(conn, table, count, offset = 0, knownColumns = undefined) {
  const columns = knownColumns ?? insertableColumns(await columnsOf(conn, table));
  const names = columns.map((c) => c.COLUMN_NAME);
  let inserted = 0;
  for (let start = 0; start < count; start += 500) {
    const rows = [];
    for (let i = start; i < Math.min(count, start + 500); i++) {
      const n = offset + i + 1;
      rows.push(columns.map((c) => (c.IS_NULLABLE === "YES" && n % 7 === 0 ? null : syntheticValue(c, n, table))));
    }
    const [result] = await conn.query("INSERT IGNORE INTO ?? (??) VALUES ?", [table, names, rows]);
    inserted += result.affectedRows;
  }
  return inserted;
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

/** Streams a table (or a key range) in primary-key order and hashes its rows. */
async function digestTable(conn, table, range = undefined) {
  const pk = (await primaryKeyOf(conn, table)).map((c) => c.column);
  const order = pk.length > 0 ? pk : (await columnsOf(conn, table)).map((c) => c.COLUMN_NAME);
  let sql = "SELECT * FROM ??";
  const values = [table];
  if (range) {
    sql += " WHERE ?? >= ? AND ?? < ?";
    values.push(range.key, range.lo, range.key, range.hi);
  }
  sql += ` ORDER BY ${order.map(() => "??").join(", ")}`;
  values.push(...order);
  const hasher = createRowHasher();
  await new Promise((resolve, reject) => {
    conn.connection
      .query({ sql, values, rowsAsArray: true, typeCast: (field) => field.buffer() })
      .stream({ highWaterMark: 500 })
      .on("data", (row) => hasher.add(row))
      .on("error", reject)
      .on("end", resolve);
  });
  return hasher.result();
}

async function digestAll(conn, tables) {
  const out = {};
  for (const table of tables) out[table] = await digestTable(conn, table);
  return out;
}

// ─── The client tools, through a terminal so the password is typed, not passed ─

function clientRun(password, args, { shell = false } = {}) {
  const docker = [
    "run", "--rm", "-i", "-t", "--network", NET,
    "--user", `${process.getuid()}:${process.getgid()}`,
    "-v", `${CERTS}:/certs:ro`, "-v", `${DUMPS}:/dumps`,
    CLIENT_IMAGE,
    ...(shell ? ["sh", "-c", args] : args),
  ];
  return new Promise((resolve) => {
    const child = spawn("python3", [path.join(HERE, "pty_prompt.py"), "docker", ...docker], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.stdin.end(`${password}\n`);
    const started = Date.now();
    child.on("close", (code) => resolve({ code, output: output.replace(/\r/g, "").trim(), ms: Date.now() - started }));
  });
}

function mysqldump(password, endpointName, user, extra, resultFile, { snapshotExport = false } = {}) {
  const args = [
    ...CLIENT_PROFILE,
    `--host=${endpointName}`, "--port=4000", `--user=${user}`, "--password",
    ...DUMP_PROFILE, ...extra, `--result-file=/dumps/${resultFile}`,
  ];
  // Every export that stands in for a production one must fit the profile exactly.
  if (snapshotExport) {
    const problems = exportProfileProblems(args);
    if (problems.length) throw new Error(`export profile: ${problems.join("; ")}`);
  }
  return clientRun(password, ["mysqldump", ...args]);
}

function mysqlImport(password, user, file, schema = DB) {
  const command = [
    "exec mysql", ...CLIENT_PROFILE,
    "--host=s2-target", "--port=4000", `--user=${user}`, "--password",
    "--skip-reconnect", "--default-character-set=utf8mb4", schema, `< /dumps/${file}`,
  ].join(" ");
  return clientRun(password, command, { shell: true });
}


const shellQuote = (arg) => `'${String(arg).replace(/'/g, "'\\''")}'`;

/**
 * Runs a SQL file in the stock `mysql` client, the password typed at its own prompt, a
 * dropped connection fatal (--skip-reconnect), and, with a point, the session pinned from
 * its first statement. This is how production would validate: no custom tool holds the
 * password.
 */
function mysqlScript(password, endpointName, user, file, { point, database = DB } = {}) {
  const command = [
    "exec mysql", ...CLIENT_PROFILE,
    `--host=${endpointName}`, "--port=4000", `--user=${user}`, "--password",
    "--skip-reconnect", "--batch", "--skip-column-names", "--default-character-set=utf8mb4",
    ...(point ? [shellQuote(pinFlag(point))] : []), database, `< /dumps/${file}`,
  ].join(" ");
  return clientRun(password, command, { shell: true });
}

/** The validation script: UTC, then one server-side digest per table. Written from metadata only. */
async function writeDigestScript(conn, tables, file) {
  const lines = ["SET SESSION time_zone = '+00:00';"];
  for (const table of tables) lines.push(sqlDigestStatement(table, await columnsOf(conn, table)));
  fs.writeFileSync(path.join(DUMPS, file), `${lines.join("\n")}\n`);
}

// ─── One point in time, as TiDB Cloud Support describes it ───────────────────

/** SHOW MASTER STATUS's Position is the cluster's latest TSO. Kept as exact text. */
async function capturePoint(conn) {
  const [[row]] = await conn.query("SHOW MASTER STATUS");
  const problem = exactTsoProblem(row.Position);
  if (problem) throw new Error(problem);
  return { point: row.Position, capturedAt: Date.now() };
}

/** A session pinned to one point. TiDB refuses every write in it, whatever the login's grants. */
async function openPinned(password, point, database = DB) {
  const conn = await connectionFor(SOURCE, SOURCE_USER, password, { database });
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query("SET SESSION tidb_snapshot = ?", [point]);
  return conn;
}

const pinFlag = (point) => `--init-command=SET SESSION tidb_snapshot = '${point}'`;

// ─── The run ─────────────────────────────────────────────────────────────────

async function main() {
  const sourcePassword = secret();
  const importPassword = secret();
  fs.mkdirSync(path.join(DUMPS, "chunks"), { recursive: true });

  // Setup as root, on the two local containers only.
  const root = await connectionFor(SOURCE, "root", undefined);
  const targetRoot = await connectionFor(TARGET, "root", undefined);
  receipt.versions.source = await assertLocalPractice(root, "source");
  receipt.versions.target = await assertLocalPractice(targetRoot, "target");
  for (const c of [root, targetRoot]) {
    // Index builds here would need 100 GiB of scratch disk; this is setup only.
    await c.query("SET GLOBAL tidb_enable_dist_task = OFF");
    await c.query("SET GLOBAL tidb_ddl_enable_fast_reorg = OFF");
    for (const schema of [DB, `${DB}_control`, `${DB}_full`]) {
      await c.query(`DROP DATABASE IF EXISTS ${schema}`);
      await c.query(`CREATE DATABASE ${schema}`);
    }
  }
  await root.query(`USE ${DB}`);
  await targetRoot.query(`USE ${DB}`);
  receipt.versions.mysqldump = String(spawnSync("docker", ["run", "--rm", CLIENT_IMAGE, "mysqldump", "--version"]).stdout).trim();

  console.log("Applying the app's migrations to the synthetic source…");
  const migrate = spawnSync(path.join(REPO, "node_modules", ".bin", "drizzle-kit"), ["migrate"], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: `mysql://root@${SOURCE.host}:${SOURCE.port}/${DB}` },
    encoding: "utf8",
  });
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${String(migrate.stdout).slice(-2000)}\n${migrate.stderr}`);
  const [[migrations]] = await root.query("SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM __drizzle_migrations");
  receipt.migrations = { applied: Number(migrations.n), latest: String(migrations.latest) };

  // Out-of-band objects, as production has them.
  for (const [table, spec] of Object.entries(ARCHIVES)) await root.query("CREATE TABLE ?? LIKE ??", [table, spec.like]);
  await root.query("CREATE TABLE ?? LIKE distributors", [DRIFT_TABLE]);
  await root.query("CREATE TABLE ?? (id BIGINT NOT NULL, payload VARCHAR(64))", [KEYLESS_TABLE]);
  await root.query("CREATE TABLE ?? (id INT PRIMARY KEY, v VARCHAR(32))", [GUARD_TABLE]);
  const archives = [...Object.keys(ARCHIVES), DRIFT_TABLE, KEYLESS_TABLE];
  const outOfBand = [...archives, GUARD_TABLE];

  const [tableRows] = await root.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    [DB],
  );
  const liveTables = tableRows.map((r) => r.t).filter((t) => !outOfBand.includes(t));

  console.log(`Seeding made-up rows into ${liveTables.length} live tables and ${archives.length} archive tables…`);
  const seeded = {};
  for (const table of liveTables) {
    if (table === "__drizzle_migrations") continue;
    seeded[table] = await seedTable(root, table, ROW_COUNTS[table] ?? DEFAULT_ROWS);
  }
  for (const [table, spec] of Object.entries(ARCHIVES)) seeded[table] = await seedTable(root, table, spec.rows, 1_000_000);
  seeded[DRIFT_TABLE] = await seedTable(root, DRIFT_TABLE, 3000, 2_000_000);
  const keyless = Array.from({ length: 100 }, (_, i) => [i + 1, `keyless-${i + 1}`]);
  await root.query("INSERT INTO ?? (id, payload) VALUES ?", [KEYLESS_TABLE, keyless]);
  seeded[KEYLESS_TABLE] = keyless.length;
  await root.query("INSERT INTO ?? VALUES (1, 'guard-a'), (2, 'guard-b'), (3, 'guard-c')", [GUARD_TABLE]);
  receipt.synthetic = { liveTables: liveTables.length, archiveTables: archives.length, rowsSeeded: seeded };

  // No read-only login exists in production, so the practice's login may write, like the project login.
  await root.query("DROP USER IF EXISTS ?@'%'", [SOURCE_USER]);
  await targetRoot.query("DROP USER IF EXISTS 's2imp'@'%'");
  await root.query("CREATE USER ?@'%' IDENTIFIED BY ? REQUIRE SSL", [SOURCE_USER, sourcePassword]);
  await root.query(`GRANT ALL PRIVILEGES ON ${DB}.* TO ?@'%'`, [SOURCE_USER]);
  await targetRoot.query("CREATE USER 's2imp'@'%' IDENTIFIED BY ? REQUIRE SSL", [importPassword]);
  for (const schema of [DB, `${DB}_control`, `${DB}_full`]) await targetRoot.query(`GRANT ALL PRIVILEGES ON ${schema}.* TO 's2imp'@'%'`);
  receipt.identity = {
    source: `${SOURCE_USER}: ALL PRIVILEGES on the schema (production has no read-only login), TLS required`,
    target: "s2imp: the target schemas only",
  };

  // Routines, triggers and events may be skipped only if there are none.
  const [[absent]] = await root.query(
    `SELECT (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?) AS routines,
            (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?) AS triggers,
            (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?) AS events,
            (SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?) AS views`,
    [DB, DB, DB, DB],
  );
  check("no routines, triggers, events or views exist, so skipping them loses nothing", "0/0/0/0",
    `${absent.routines}/${absent.triggers}/${absent.events}/${absent.views}`);

  // ── 1. Why --single-transaction fails on TiDB ──────────────────────────────
  console.log("\n1. mysqldump --single-transaction against TiDB, with the general log on…");
  await root.query("SET GLOBAL tidb_general_log = 1");
  const logSince = new Date(Date.now() - 1000).toISOString();
  const single = await mysqldump(sourcePassword, "s2-source", SOURCE_USER, ["--single-transaction", DB, "organizations"], "single.sql");
  await root.query("SET GLOBAL tidb_general_log = 0");
  const singleError = single.output.split("\n").find((l) => /mysqldump:/.test(l)) ?? "";
  check("--single-transaction fails on TiDB, as Support warned", "fails", single.code === 0 ? "succeeds" : "fails", singleError);
  const logs = spawnSync("docker", ["logs", "--since", logSince, "s2-source"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const entries = parseGeneralLog(`${logs.stdout}\n${logs.stderr}`).filter((e) => e.user === SOURCE_USER);
  const ended = statementEndingTransaction(entries);
  check("the transaction ends at mysqldump's own UNLOCK TABLES, before any table is read", "UNLOCK TABLES",
    ended.found ? ended.statement : `not found (${ended.reason})`);
  const readsOutside = entries.filter((e) => /SELECT \/\*!40001 SQL_NO_CACHE \*\//.test(e.sql) && e.txnStartTS === "0").length;
  check("every table read then runs outside any transaction", true, readsOutside > 0, `${readsOutside} data read(s) with txnStartTS=0`);
  receipt.findings.push({
    id: "single-transaction-unusable-on-tidb",
    summary:
      "mysqldump 8.4 issues UNLOCK TABLES straight after START TRANSACTION WITH CONSISTENT SNAPSHOT. TiDB ends the transaction there, " +
      "so every later read is a separate autocommit read and the first ROLLBACK TO SAVEPOINT fails (1305). --single-transaction cannot " +
      "produce one consistent snapshot on TiDB.",
  });

  // ── 2. Without a read-only login: what the session itself refuses ─────────
  console.log("\n2. Write protection without a read-only login…");
  const guardBefore = await digestTable(root, GUARD_TABLE);
  const probe = await connectionFor(SOURCE, SOURCE_USER, sourcePassword, { database: DB });
  const { point: guardPoint } = await capturePoint(probe);
  const pinned = await openPinned(sourcePassword, guardPoint);
  const writes = [
    `INSERT INTO ${GUARD_TABLE} VALUES (9, 'w')`,
    `UPDATE ${GUARD_TABLE} SET v = 'x' WHERE id = 1`,
    `DELETE FROM ${GUARD_TABLE} WHERE id = 2`,
    `REPLACE INTO ${GUARD_TABLE} VALUES (1, 'z')`,
    "CREATE TABLE s2_guard_new (id INT PRIMARY KEY)",
    `ALTER TABLE ${GUARD_TABLE} ADD COLUMN z INT`,
    `TRUNCATE TABLE ${GUARD_TABLE}`,
    `DROP TABLE ${GUARD_TABLE}`,
  ];
  const refused = [];
  for (const sql of writes) {
    try {
      await pinned.query(sql);
    } catch (error) {
      if (/can not execute write statement when 'tidb_snapshot' is set/.test(error.message)) refused.push(sql.split(" ")[0]);
    }
  }
  // Could a write that changes nothing, whatever happens, show the pin works on production? No: TiDB checks
  // the table and the grant first, so a write aimed where it cannot land never reaches the pin's check.
  const harmless = {
    "a missing table": `INSERT INTO ${DB}.s2_no_such_table VALUES (1)`,
    "a schema the login may not write": "CREATE TABLE s2_no_such_schema.s2_t (a INT)",
  };
  const harmlessAnswers = [];
  for (const [target, sql] of Object.entries(harmless)) {
    try {
      await pinned.query(sql);
      harmlessAnswers.push(`${target}: accepted`);
    } catch (error) {
      harmlessAnswers.push(`${target}: ${error.errno}`);
    }
  }
  const [[pinShown]] = await pinned.query("SELECT @@tidb_snapshot AS point");
  await pinned.end();
  const guardAfterPinned = await digestTable(root, GUARD_TABLE);
  check("a session pinned with tidb_snapshot refuses every write, though the login may write", `${writes.length}/${writes.length}`,
    `${refused.length}/${writes.length}`, `refused: ${refused.join(", ")}; the table is unchanged: ${guardBefore.sha256 === guardAfterPinned.sha256}`);
  check("no write can safely test the pin: one that cannot land is refused for that reason first (1146, 1142)",
    "a missing table: 1146; a schema the login may not write: 1142", harmlessAnswers.join("; "));
  check("the pin can be confirmed by reading it instead", guardPoint, String(pinShown.point));
  // The same login, unpinned, can write: the protection is the session setting, not the grant.
  await probe.query(`INSERT INTO ${GUARD_TABLE} VALUES (99, 'unpinned')`);
  const [[unpinnedRow]] = await root.query(`SELECT COUNT(*) AS n FROM ${GUARD_TABLE} WHERE id = 99`);
  check("the same login, unpinned, can write (so every operator session must be pinned)", "1", String(unpinnedRow.n));
  await root.query(`DELETE FROM ${GUARD_TABLE} WHERE id = 99`);
  let readOnly = "accepted";
  try {
    await probe.query("START TRANSACTION READ ONLY");
    await probe.query("ROLLBACK");
  } catch (error) {
    readOnly = error.errno === 1235 ? "refused (1235, noop)" : `refused (${error.errno})`;
  }
  check("START TRANSACTION READ ONLY cannot be relied on: TiDB refuses it as a no-op", "refused (1235, noop)", readOnly);
  await probe.end();
  receipt.findings.push({
    id: "session-pinned-write-refusal",
    summary:
      "With tidb_snapshot set, TiDB refuses INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, TRUNCATE and DROP (1105) for a login that " +
      "holds ALL PRIVILEGES. The same login unpinned can write. READ ONLY transactions are refused as no-ops (1235). Without a read-only " +
      "login, pinning every operator session is the database-enforced protection; it holds per session, not per login.",
  });
  receipt.findings.push({
    id: "no-harmless-write-probe",
    summary:
      "TiDB checks the table and the grant before the pin, so a pinned write to a missing table answers 1146 and one to a schema the " +
      "login may not write answers 1142. Only a write that would change data if the pin failed reaches the pin's check. On production, " +
      "confirm the pin by reading @@tidb_snapshot in each session; never send a write to test it.",
  });

  // ── 3. Option A: live tables only, at one point, while a writer runs ───────
  console.log("\n3. Option A: the live tables at one point, writers running…");
  const txColumns = await columnsOf(root, "transactions");
  const txInsertable = insertableColumns(txColumns);
  const textColumn = txColumns.find((c) => c.DATA_TYPE === "varchar" && c.COLUMN_NAME !== "id" && Number(c.CHARACTER_MAXIMUM_LENGTH) >= 32)?.COLUMN_NAME;
  const [[{ minId }]] = await root.query("SELECT MIN(id) AS minId FROM transactions");
  const writer = await connectionFor(SOURCE, "root", undefined, { database: DB });
  const writesA = { inserts: 0, updates: 0, deletes: 0 };
  let writing = true;
  const writerLoop = (async () => {
    let n = 0;
    while (writing) {
      n += 1;
      await seedTable(writer, "transactions", 1, 9_000_000 + n, txInsertable);
      writesA.inserts += 1;
      if (textColumn) {
        await writer.query("UPDATE transactions SET ?? = ? WHERE id = ?", [textColumn, `w-upd-${n}`, Number(minId) + 1000 + (n % 5000)]);
        writesA.updates += 1;
      }
      if (n % 5 === 0) {
        await writer.query("DELETE FROM transactions WHERE id = ?", [Number(minId) + n]);
        writesA.deletes += 1;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  })();
  await new Promise((r) => setTimeout(r, 500));

  const capturer = await connectionFor(SOURCE, SOURCE_USER, sourcePassword, { database: DB });
  const { point, capturedAt } = await capturePoint(capturer);
  await capturer.end();
  receipt.optionA = { point, excludedTables: archives };
  const ignore = outOfBand.map((t) => `--ignore-table=${DB}.${t}`);
  const dump = await mysqldump(sourcePassword, "s2-source", SOURCE_USER, [pinFlag(point), ...ignore, DB], "live.sql", { snapshotExport: true });
  receipt.timings.optionADumpMs = dump.ms;
  check("Option A: the pinned dump completes", 0, dump.code, dump.code === 0 ? undefined : dump.output.slice(-400));
  const liveSql = fs.readFileSync(path.join(DUMPS, "live.sql"), "utf8");
  check("Option A: the dump carries mysqldump's completion trailer", true, dumpCompleted(liveSql));
  // Control: the same table dumped WITHOUT the pin, while writes continue.
  const control = await mysqldump(sourcePassword, "s2-source", SOURCE_USER, [DB, "transactions"], "control.sql");

  const validateStarted = Date.now();
  const validator = await openPinned(sourcePassword, point);
  const atPoint = await digestAll(validator, liveTables);
  const tenantSql = "SELECT organizationId AS org, COUNT(*) AS n FROM transactions GROUP BY organizationId ORDER BY organizationId";
  const [sourceTenants] = await validator.query(tenantSql);
  const excludedCounts = {};
  for (const table of archives) {
    const [[row]] = await validator.query("SELECT COUNT(*) AS n FROM ??", [table]);
    excludedCounts[table] = String(row.n);
  }
  // The validator production would use: the stock client, pinned to the same point, has the
  // server digest every live table. Its script is written from the column list AT the point.
  await writeDigestScript(validator, liveTables, "digest-live.sql");
  await validator.end();
  const sqlAtPoint = await mysqlScript(sourcePassword, "s2-source", SOURCE_USER, "digest-live.sql", { point });
  const lastReadAt = Date.now();
  receipt.timings.optionAStockClientDigestMs = sqlAtPoint.ms;
  const sourceSqlDigests = sqlAtPoint.code === 0 ? parseSqlDigests(sqlAtPoint.output) : {};
  check("Option A: the stock client, pinned to the point, has the server digest every live table", liveTables.length,
    Object.keys(sourceSqlDigests).length, sqlAtPoint.code === 0 ? `${sqlAtPoint.ms} ms` : sqlAtPoint.output.slice(-400));
  receipt.timings.optionAValidationMs = lastReadAt - validateStarted;
  receipt.timings.optionACaptureToLastReadMs = lastReadAt - capturedAt;
  receipt.optionA.excludedRowCountsAtPoint = excludedCounts;
  writing = false;
  await writerLoop;
  await writer.end();
  receipt.optionA.writesDuringExport = writesA;
  const budget = snapshotWithinBudget(lastReadAt - capturedAt, BUDGET_MS);
  check(`Option A: every read at the point ended inside the ${BUDGET_MS / 1000}-second budget, counted from capture`, true, budget.ok,
    budget.problems.join("; ") || `${lastReadAt - capturedAt} ms from capture to the last snapshot read`);
  const nowDigest = await digestTable(root, "transactions");
  check("Option A: writes really happened during the export (the live table moved on)", true,
    nowDigest.sha256 !== atPoint.transactions.sha256, `${writesA.inserts} inserts, ${writesA.updates} updates, ${writesA.deletes} deletes`);

  const restore = await mysqlImport(importPassword, "s2imp", "live.sql");
  receipt.timings.optionARestoreMs = restore.ms;
  check("Option A: the restore succeeds with --skip-reconnect and no --force", 0, restore.code, restore.code === 0 ? undefined : restore.output.slice(-400));
  const target = await connectionFor(TARGET, "s2imp", importPassword, { database: DB });
  await target.query("SET SESSION time_zone = '+00:00'");
  const restored = await digestAll(target, liveTables);
  const liveMismatches = compareDigests(atPoint, restored);
  check("Option A: every live table's rows and full-row SHA-256 equal the source at the point", 0, liveMismatches.length,
    liveMismatches.length ? liveMismatches.slice(0, 5) : `${liveTables.length} tables`);
  const controlRestore = control.code === 0 ? await mysqlImport(importPassword, "s2imp", "control.sql", `${DB}_control`) : control;
  const controlConn = await connectionFor(TARGET, "s2imp", importPassword, { database: `${DB}_control` });
  await controlConn.query("SET SESSION time_zone = '+00:00'");
  const controlDigest = controlRestore.code === 0 ? await digestTable(controlConn, "transactions") : undefined;
  await controlConn.end();
  check("control: the same export without the pin does NOT match (so the comparison has teeth)", true,
    Boolean(controlDigest) && controlDigest.sha256 !== atPoint.transactions.sha256,
    controlDigest ? `${controlDigest.rows} rows unpinned vs ${atPoint.transactions.rows} at the point` : "control dump or restore failed");
  const sqlRestored = await mysqlScript(importPassword, "s2-target", "s2imp", "digest-live.sql");
  const restoredSqlDigests = sqlRestored.code === 0 ? parseSqlDigests(sqlRestored.output) : {};
  const sqlMismatches = liveTables.filter((t) => !sourceSqlDigests[t] || sourceSqlDigests[t] !== restoredSqlDigests[t]);
  check("Option A: the stock client's digests of the copy equal the source's at the point", 0, sqlMismatches.length,
    sqlMismatches.length ? sqlMismatches.slice(0, 5).join(", ") : `${liveTables.length} tables`);
  await writeDigestScript(root, ["transactions"], "digest-control.sql");
  const sqlControl = await mysqlScript(importPassword, "s2-target", "s2imp", "digest-control.sql", { database: `${DB}_control` });
  const controlSqlDigest = sqlControl.code === 0 ? parseSqlDigests(sqlControl.output).transactions : undefined;
  check("control: the stock client's digest also tells the unpinned copy apart", true,
    Boolean(controlSqlDigest) && controlSqlDigest !== sourceSqlDigests.transactions,
    controlSqlDigest ? `${controlSqlDigest.split("/")[0]} rows unpinned vs ${String(sourceSqlDigests.transactions).split("/")[0]} at the point` : "control digest failed");
  const [[restoredMigrations]] = await target.query("SELECT MAX(created_at) AS latest FROM __drizzle_migrations");
  check("Option A: the restored migrations watermark equals the source's", receipt.migrations.latest, String(restoredMigrations.latest));
  let schemaDiffs = 0;
  for (const table of liveTables) {
    const [[a]] = await root.query("SHOW CREATE TABLE ??", [table]);
    const [[b]] = await target.query("SHOW CREATE TABLE ??", [table]);
    if (normaliseCreateTable(a["Create Table"]) !== normaliseCreateTable(b["Create Table"])) schemaDiffs += 1;
  }
  check("Option A: the restored schema equals the source's, table by table", 0, schemaDiffs);
  const [targetTenants] = await target.query(tenantSql);
  check("Option A: per-organisation transaction counts are equal", JSON.stringify(sourceTenants), JSON.stringify(targetTenants));
  const [[{ n: archivesInTarget }]] = await target.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?)", [DB, archives]);
  check("Option A: the excluded archive tables are absent from the copy, as the exclusion manifest says", "0", String(archivesInTarget));
  await target.end();

  // ── 4. A schema change after the point does not leak into the dump ────────
  console.log("\n4. A schema change after the point…");
  const ddlProbe = await connectionFor(SOURCE, SOURCE_USER, sourcePassword, { database: DB });
  const { point: ddlPoint } = await capturePoint(ddlProbe);
  await ddlProbe.end();
  await root.query("ALTER TABLE channels ADD COLUMN s2_late_column INT NULL");
  const ddlDump = await mysqldump(sourcePassword, "s2-source", SOURCE_USER, [pinFlag(ddlPoint), DB, "channels"], "ddl.sql", { snapshotExport: true });
  const ddlSql = fs.readFileSync(path.join(DUMPS, "ddl.sql"), "utf8");
  await root.query("ALTER TABLE channels DROP COLUMN s2_late_column");
  check("the dump reads the schema as it was at the point", true, ddlDump.code === 0 && dumpCompleted(ddlSql) && !/s2_late_column/.test(ddlSql),
    "the column added after the point is absent from both CREATE TABLE and the rows");

  // ── 5. A point the server refuses stops the dump ───────────────────────────
  console.log("\n5. A point the server refuses…");
  const future = (BigInt(Date.now() + 3600_000) << 18n).toString();
  const refusedDump = await mysqldump(sourcePassword, "s2-source", SOURCE_USER, [pinFlag(future), DB, "organizations"], "refused.sql", { snapshotExport: true });
  check("mysqldump refuses to run when the point cannot be set (fail closed)", true, refusedDump.code !== 0,
    refusedDump.output.split("\n").find((l) => /mysqldump:|ERROR/.test(l)) ?? "");
  const rounded = String(Number(point));
  check("a point copied through a floating-point number no longer names the same point", true, rounded !== point,
    `${point} becomes ${rounded}: copy it as text`);

  // ── 6. Option B: the whole database under a writer freeze ──────────────────
  console.log("\n6. Option B: the whole database, writers frozen…");
  // Consistency comes from the freeze (no writer runs from here). Every session is still
  // pinned, to a fresh point when needed, so that none of them can write.
  const allTables = [...liveTables, ...archives];
  const freshPin = async () => {
    const c = await connectionFor(SOURCE, SOURCE_USER, sourcePassword, { database: DB });
    const { point: p } = await capturePoint(c);
    await c.end();
    return p;
  };
  const startPoint = await freshPin();
  const startReader = await openPinned(sourcePassword, startPoint);
  const atFreezeStart = await digestAll(startReader, allTables);
  // The reference schema, read at the same point as the reference digests.
  const schemaAtStart = {};
  for (const table of allTables) {
    const [[row]] = await startReader.query("SHOW CREATE TABLE ??", [table]);
    schemaAtStart[table] = normaliseCreateTable(row["Create Table"]);
  }
  await startReader.end();

  const fullLive = await mysqldump(sourcePassword, "s2-source", SOURCE_USER,
    [pinFlag(await freshPin()), ...ignore, DB], "full-live.sql", { snapshotExport: true });
  const plan = {};
  for (const table of archives) {
    const key = chooseRangeKey(await primaryKeyOf(root, table));
    if (!key.ok) {
      plan[table] = { status: "REDESIGN_REQUIRED", reason: key.reason, redesign: "small table: one whole-table export instead of ranges" };
      continue;
    }
    const [[bounds]] = await root.query("SELECT MIN(??) AS lo, MAX(??) AS hi FROM ??", [key.column, key.column, table]);
    const ranges = buildRanges(Number(bounds.lo), Number(bounds.hi), CHUNK_KEYS);
    plan[table] = { key: key.column, ranges, coverage: checkCoverage(ranges, Number(bounds.lo), Number(bounds.hi)) };
  }
  check("a table with no usable range key stops for redesign instead of being guessed at", "REDESIGN_REQUIRED", plan[KEYLESS_TABLE].status);
  const ranged = archives.filter((t) => plan[t].ranges);
  check("every range manifest covers its key range exactly once", true, ranged.every((t) => plan[t].coverage.ok),
    ranged.flatMap((t) => plan[t].coverage.problems.map((p) => `${t}: ${p}`)).join("; ") || undefined);

  const schemaOnly = await mysqldump(sourcePassword, "s2-source", SOURCE_USER,
    [pinFlag(await freshPin()), "--no-data", DB, ...archives], "archive-schema.sql", { snapshotExport: true });
  const problems = [];
  if (fullLive.code !== 0) problems.push(`live export exited ${fullLive.code}`);
  if (schemaOnly.code !== 0) problems.push(`archive schema export exited ${schemaOnly.code}`);
  const files = ["full-live.sql", "archive-schema.sql"];
  let wroteDuringFreeze = false;
  for (const table of archives) {
    const pieces = plan[table].ranges ?? [null];
    for (const [i, range] of pieces.entries()) {
      const file = `chunks/${table}.${String(i).padStart(4, "0")}.sql`;
      const where = range ? [`--where=${plan[table].key} >= ${range.lo} AND ${plan[table].key} < ${range.hi}`] : [];
      const chunk = await mysqldump(sourcePassword, "s2-source", SOURCE_USER,
        [pinFlag(await freshPin()), "--no-create-info", "--skip-add-drop-table", ...where, DB, table], file, { snapshotExport: true });
      const chunkProblems = chunk.code === 0 ? dataOnlyChunkProblems(fs.readFileSync(path.join(DUMPS, file), "utf8")) : [`exited ${chunk.code}`];
      if (chunkProblems.length) problems.push(`${file}: ${chunkProblems.join(", ")}`);
      files.push(file);
      // The deliberate failure: a writer nobody stopped (the Manus copy, say) changes a row mid-freeze.
      if (table === DRIFT_TABLE && !wroteDuringFreeze) {
        const driftColumn = (await columnsOf(root, DRIFT_TABLE)).find((c) => /char/.test(c.DATA_TYPE) && c.COLUMN_NAME !== plan[table].key);
        await root.query("UPDATE ?? SET ?? = ? WHERE ?? = ?", [DRIFT_TABLE, driftColumn.COLUMN_NAME, "written-during-freeze", plan[table].key, range.lo]);
        wroteDuringFreeze = true;
      }
    }
  }
  check("every Option B export completed, and every data-only piece carried no DROP, CREATE or LOCK", 0, problems.length,
    problems.slice(0, 5).join("; ") || `${files.length} files`);

  const endReader = await openPinned(sourcePassword, await freshPin());
  const atFreezeEnd = await digestAll(endReader, allTables);
  await endReader.end();
  const changed = Object.keys(atFreezeStart).filter((t) => atFreezeStart[t].sha256 !== atFreezeEnd[t].sha256);
  check("the freeze held for every table no writer touched", 0, changed.filter((t) => t !== DRIFT_TABLE).length,
    changed.filter((t) => t !== DRIFT_TABLE).join(", ") || undefined);
  check("a writer left running during the freeze is caught (the copy is then INVALID)", true, changed.includes(DRIFT_TABLE),
    changed.includes(DRIFT_TABLE) ? `${DRIFT_TABLE} changed between the start and the end of the freeze` : "not caught");

  let restoreProblems = 0;
  for (const file of files) {
    const result = await mysqlImport(importPassword, "s2imp", file, `${DB}_full`);
    if (result.code !== 0) restoreProblems += 1;
  }
  check("Option B: every file restores, schema once and then the data", 0, restoreProblems, `${files.length} files`);
  const fullTarget = await connectionFor(TARGET, "s2imp", importPassword, { database: `${DB}_full` });
  await fullTarget.query("SET SESSION time_zone = '+00:00'");
  const restoredFull = await digestAll(fullTarget, allTables);
  const fullMismatches = compareDigests(atFreezeStart, restoredFull);
  check("Option B: every table, archives included, equals the source at the start of the freeze", 0, fullMismatches.length,
    fullMismatches.length ? fullMismatches.slice(0, 5) : `${allTables.length} tables`);
  let fullSchemaDiffs = 0;
  for (const table of allTables) {
    const [[row]] = await fullTarget.query("SHOW CREATE TABLE ??", [table]);
    if (normaliseCreateTable(row["Create Table"]) !== schemaAtStart[table]) fullSchemaDiffs += 1;
  }
  check("Option B: every restored table's schema equals the source's at the start of the freeze", 0, fullSchemaDiffs);

  // Completeness is judged on whole tables, not on the planned ranges: a row outside every
  // range, or a range missing from the copy, changes the table's digest. Shown on the copy, then undone.
  const extraTable = "matches_legacy_archive"; // its only unique key is the primary key, so a copied row fits
  const extraKey = plan[extraTable].key;
  const extraColumns = (await columnsOf(fullTarget, extraTable)).map((c) => c.COLUMN_NAME);
  const [[{ templateId, beyond }]] = await fullTarget.query(
    "SELECT MIN(??) AS templateId, MAX(??) + 1000 AS beyond FROM ??", [extraKey, extraKey, extraTable]);
  await fullTarget.query(
    `INSERT INTO ?? (??) SELECT ${extraColumns.map((c) => (c === extraKey ? "?" : "??")).join(", ")} FROM ?? WHERE ?? = ?`,
    [extraTable, extraColumns, ...extraColumns.map((c) => (c === extraKey ? beyond : c)), extraTable, extraKey, templateId],
  );
  const withExtra = await digestTable(fullTarget, extraTable);
  await fullTarget.query("DELETE FROM ?? WHERE ?? = ?", [extraTable, extraKey, beyond]);
  check("a row in the copy outside every planned range is caught", true, withExtra.sha256 !== atFreezeStart[extraTable].sha256,
    `${withExtra.rows} rows in the copy against ${atFreezeStart[extraTable].rows} at the start`);
  const gapTable = "transactions_legacy_archive";
  const gapIndex = Math.floor(plan[gapTable].ranges.length / 2);
  const gap = plan[gapTable].ranges[gapIndex];
  await fullTarget.query("DELETE FROM ?? WHERE ?? >= ? AND ?? < ?", [gapTable, plan[gapTable].key, gap.lo, plan[gapTable].key, gap.hi]);
  const withGap = await digestTable(fullTarget, gapTable);
  const refill = await mysqlImport(importPassword, "s2imp", `chunks/${gapTable}.${String(gapIndex).padStart(4, "0")}.sql`, `${DB}_full`);
  const refilled = await digestTable(fullTarget, gapTable);
  check("a range missing from the copy is caught, and re-applying its piece restores equality", true,
    withGap.sha256 !== atFreezeStart[gapTable].sha256 && refill.code === 0 && refilled.sha256 === atFreezeStart[gapTable].sha256,
    `${withGap.rows} rows with one range missing, ${refilled.rows} after re-applying it, ${atFreezeStart[gapTable].rows} at the start`);
  await fullTarget.end();
  receipt.findings.push({
    id: "freeze-evidence-is-operational",
    summary:
      "The copy is proved equal to the reference read at the start of the freeze, by whole-table digests and schemas, so a missing " +
      "range or an extra row fails it. Here the reference is read at one point; if production's cannot be read inside one window, " +
      "its reads span several points and only the freeze makes them one. The start-to-end comparison catches a write still present " +
      "at the end, not one made and undone in between, so whether the freeze held is shown by evidence that every writer stopped.",
  });
  receipt.optionB = {
    tables: allTables.length,
    files: files.length,
    plan: Object.fromEntries(Object.entries(plan).map(([t, p]) => [t, p.status ?? { key: p.key, ranges: p.ranges.length }])),
  };

  await root.end();
  await targetRoot.end();

  receipt.finishedAt = new Date().toISOString();
  const failed = receipt.checks.filter((c) => c.result !== "PASS");
  receipt.result = failed.length === 0 ? "ALL_EXPECTED_OUTCOMES_OBSERVED" : "UNEXPECTED_OUTCOMES";
  fs.writeFileSync(path.join(WORK, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`\n${receipt.result}: ${receipt.checks.length - failed.length}/${receipt.checks.length} checks as expected.`);
  console.log(`Receipt: ${path.join(WORK, "receipt.json")}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`practice run stopped: ${error.message}`);
  receipt.result = "STOPPED";
  receipt.error = error.message;
  try {
    fs.writeFileSync(path.join(WORK, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  } catch {}
  process.exit(1);
});
