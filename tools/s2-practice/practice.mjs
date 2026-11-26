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
  exportProfileProblems,
  holderWithinLimits,
  normaliseCreateTable,
  parseGeneralLog,
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
const CHUNK_KEYS = 20000;

/** This script reaches only the two local containers, and never reads DATABASE_URL. */
delete process.env.DATABASE_URL;

const receipt = {
  method: "SNAPSHOT_MYSQLDUMP_INIT_COMMAND",
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
  const base = { host: endpoint.host, port: endpoint.port, user, multipleStatements: false, ...extra };
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

/** A transaction that fixes the snapshot and keeps GC behind it while open. */
async function openHolder(password) {
  const conn = await connectionFor(SOURCE, "s2ro", password, { database: DB });
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
  const [[{ ts }]] = await conn.query("SELECT @@tidb_current_ts AS ts");
  const opened = Date.now();
  let last = Date.now();
  let maxIdleMs = 0;
  const touch = () => {
    const now = Date.now();
    maxIdleMs = Math.max(maxIdleMs, now - last);
    last = now;
  };
  // Starter drops a public-endpoint connection idle for 340 s; keep it busy.
  const keepAlive = setInterval(() => {
    touch();
    conn.query("SELECT 1").catch(() => {});
  }, 30000);
  return {
    conn,
    ts: String(ts),
    touch,
    async close() {
      clearInterval(keepAlive);
      touch();
      await conn.query("ROLLBACK");
      await conn.end();
      return { openMs: Date.now() - opened, maxIdleMs };
    },
  };
}

// ─── The run ─────────────────────────────────────────────────────────────────

async function main() {
  const roPassword = secret();
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
    await c.query(`DROP DATABASE IF EXISTS ${DB}`);
    await c.query(`CREATE DATABASE ${DB}`);
  }
  await root.query(`USE ${DB}`);
  await targetRoot.query(`USE ${DB}`);
  const versionProbe = spawnSync("docker", ["run", "--rm", CLIENT_IMAGE, "mysqldump", "--version"]);
  receipt.versions.mysqldump = String(versionProbe.stdout).trim();

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
  for (const [table, spec] of Object.entries(ARCHIVES)) await root.query(`CREATE TABLE ?? LIKE ??`, [table, spec.like]);
  await root.query(`CREATE TABLE ?? LIKE distributors`, [DRIFT_TABLE]);
  await root.query(`CREATE TABLE ?? (id BIGINT NOT NULL, payload VARCHAR(64))`, [KEYLESS_TABLE]);
  const outOfBand = [...Object.keys(ARCHIVES), DRIFT_TABLE, KEYLESS_TABLE];

  const [tableRows] = await root.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    [DB],
  );
  const liveTables = tableRows.map((r) => r.t).filter((t) => !outOfBand.includes(t));

  console.log(`Seeding made-up rows into ${liveTables.length} live tables and ${outOfBand.length} out-of-band tables…`);
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
  receipt.synthetic = { liveTables: liveTables.length, outOfBandTables: outOfBand.length, rowsSeeded: seeded };

  // Least privilege: SELECT only, TLS required.
  await root.query("DROP USER IF EXISTS 's2ro'@'%'");
  await targetRoot.query("DROP USER IF EXISTS 's2imp'@'%'");
  await root.query("CREATE USER 's2ro'@'%' IDENTIFIED BY ? REQUIRE SSL", [roPassword]);
  await root.query(`GRANT SELECT ON ${DB}.* TO 's2ro'@'%'`);
  await targetRoot.query("CREATE USER 's2imp'@'%' IDENTIFIED BY ? REQUIRE SSL", [importPassword]);
  await targetRoot.query(`GRANT ALL PRIVILEGES ON ${DB}.* TO 's2imp'@'%'`);
  await targetRoot.query(`DROP DATABASE IF EXISTS ${DB}_control`);
  await targetRoot.query(`CREATE DATABASE ${DB}_control`);
  await targetRoot.query(`GRANT ALL PRIVILEGES ON ${DB}_control.* TO 's2imp'@'%'`);
  receipt.identity = { source: "s2ro: SELECT on the schema only, TLS required", target: "s2imp: the target schema only" };

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
  const single = await mysqldump(roPassword, "s2-source", "s2ro", ["--single-transaction", DB, "organizations"], "single.sql");
  await root.query("SET GLOBAL tidb_general_log = 0");
  const singleError = single.output.split("\n").find((l) => /mysqldump:/.test(l)) ?? "";
  check("--single-transaction fails on TiDB, as Support warned", "fails", single.code === 0 ? "succeeds" : "fails", singleError);
  const logs = spawnSync("docker", ["logs", "--since", logSince, "s2-source"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const entries = parseGeneralLog(`${logs.stdout}\n${logs.stderr}`).filter((e) => e.user === "s2ro");
  const ended = statementEndingTransaction(entries);
  check("the transaction ends at mysqldump's own UNLOCK TABLES, before any table is read", "UNLOCK TABLES",
    ended.found ? ended.statement : `not found (${ended.reason})`);
  const readsOutside = entries.filter((e) => /SELECT \/\*!40001 SQL_NO_CACHE \*\//.test(e.sql) && e.txnStartTS === "0").length;
  check("every table read then runs outside any transaction", true, readsOutside > 0, `${readsOutside} data read(s) with txnStartTS=0`);
  receipt.findings.push({
    id: "single-transaction-unusable-on-tidb",
    summary:
      "mysqldump 8.4 issues UNLOCK TABLES straight after START TRANSACTION WITH CONSISTENT SNAPSHOT. TiDB ends the transaction there, " +
      "so every later read is a separate autocommit read and the first ROLLBACK TO SAVEPOINT fails (1305). With --single-transaction, " +
      "mysqldump cannot produce one consistent snapshot on TiDB. The S2 method is withdrawn.",
  });

  // ── 2. The snapshot route, under concurrent writes ─────────────────────────
  console.log("\n2. Snapshot export of the live tables while a writer runs…");
  const txColumns = await columnsOf(root, "transactions");
  const txInsertable = insertableColumns(txColumns);
  const textColumn = txColumns.find((c) => c.DATA_TYPE === "varchar" && c.COLUMN_NAME !== "id" && Number(c.CHARACTER_MAXIMUM_LENGTH) >= 32)?.COLUMN_NAME;
  const [[{ minId }]] = await root.query("SELECT MIN(id) AS minId FROM transactions");
  const writer = await connectionFor(SOURCE, "root", undefined, { database: DB });
  let writes = { inserts: 0, updates: 0, deletes: 0 };
  let writing = true;
  const writerLoop = (async () => {
    let n = 0;
    while (writing) {
      n += 1;
      await seedTable(writer, "transactions", 1, 9_000_000 + n, txInsertable);
      writes.inserts += 1;
      if (textColumn) {
        await writer.query("UPDATE transactions SET ?? = ? WHERE id = ?", [textColumn, `w-upd-${n}`, Number(minId) + 1000 + (n % 5000)]);
        writes.updates += 1;
      }
      if (n % 5 === 0) {
        await writer.query("DELETE FROM transactions WHERE id = ?", [Number(minId) + n]);
        writes.deletes += 1;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  })();
  await new Promise((r) => setTimeout(r, 500));

  const holder = await openHolder(roPassword);
  receipt.snapshot = { ts: holder.ts };
  const ignore = outOfBand.map((t) => `--ignore-table=${DB}.${t}`);
  const dump = await mysqldump(roPassword, "s2-source", "s2ro",
    [`--init-command=SET SESSION tidb_snapshot = '${holder.ts}'`, ...ignore, DB], "live.sql", { snapshotExport: true });
  holder.touch();
  receipt.timings.dumpMs = dump.ms;
  check("the snapshot dump completes", 0, dump.code, dump.code === 0 ? undefined : dump.output.slice(-400));
  const liveSql = fs.readFileSync(path.join(DUMPS, "live.sql"), "utf8");
  check("the dump carries mysqldump's completion trailer", true, dumpCompleted(liveSql));
  // Control: the same table dumped WITHOUT the snapshot pin, while writes continue.
  const control = await mysqldump(roPassword, "s2-source", "s2ro", [DB, "transactions"], "control.sql");
  holder.touch();

  const validateStarted = Date.now();
  const atSnapshot = await digestAll(holder.conn, liveTables);
  const tenantSql = "SELECT organizationId AS org, COUNT(*) AS n FROM transactions GROUP BY organizationId ORDER BY organizationId";
  const [sourceTenants] = await holder.conn.query(tenantSql);
  holder.touch();
  receipt.timings.validationMs = Date.now() - validateStarted;
  writing = false;
  await writerLoop;
  await writer.end();
  receipt.writesDuringExport = writes;
  const holderStats = await holder.close();
  receipt.timings.holderOpenMs = holderStats.openMs;
  receipt.timings.holderMaxIdleMs = holderStats.maxIdleMs;
  const budget = holderWithinLimits(holderStats);
  check("the holding transaction stayed inside Starter's 30-minute and 340-second limits", true, budget.ok, budget.problems.join("; ") || undefined);

  const nowDigest = await digestTable(root, "transactions");
  check("writes really happened during the export (the live table moved on)", true,
    nowDigest.sha256 !== atSnapshot.transactions.sha256, `${writes.inserts} inserts, ${writes.updates} updates, ${writes.deletes} deletes`);

  // ── 3. Restore, with the password typed at a prompt and SQL from the file ──
  console.log("\n3. Restore into the isolated target…");
  const restore = await mysqlImport(importPassword, "s2imp", "live.sql");
  receipt.timings.restoreMs = restore.ms;
  check("the restore succeeds with --skip-reconnect and no --force", 0, restore.code, restore.code === 0 ? undefined : restore.output.slice(-400));
  const target = await connectionFor(TARGET, "s2imp", importPassword, { database: DB });
  await target.query("SET SESSION time_zone = '+00:00'");
  const restored = await digestAll(target, liveTables);
  const controlRestore = control.code === 0 ? await mysqlImport(importPassword, "s2imp", "control.sql", `${DB}_control`) : control;
  const controlConn = await connectionFor(TARGET, "s2imp", importPassword, { database: `${DB}_control` });
  await controlConn.query("SET SESSION time_zone = '+00:00'");
  const controlDigest = controlRestore.code === 0 ? await digestTable(controlConn, "transactions") : undefined;
  await controlConn.end();
  check("control: the same export without the snapshot pin does NOT match (so the comparison has teeth)", true,
    Boolean(controlDigest) && controlDigest.sha256 !== atSnapshot.transactions.sha256,
    controlDigest ? `${controlDigest.rows} rows unpinned vs ${atSnapshot.transactions.rows} at the snapshot` : "control dump or restore failed");
  const liveMismatches = compareDigests(atSnapshot, restored);
  check("every live table's rows and full-row SHA-256 equal the source at the snapshot", 0, liveMismatches.length,
    liveMismatches.length ? liveMismatches.slice(0, 5) : `${liveTables.length} tables`);
  const [[restoredMigrations]] = await target.query("SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM __drizzle_migrations");
  check("the restored migrations watermark equals the source's", receipt.migrations.latest, String(restoredMigrations.latest));
  let schemaDiffs = 0;
  for (const table of liveTables) {
    const [[a]] = await root.query("SHOW CREATE TABLE ??", [table]);
    const [[b]] = await target.query("SHOW CREATE TABLE ??", [table]);
    if (normaliseCreateTable(a["Create Table"]) !== normaliseCreateTable(b["Create Table"])) schemaDiffs += 1;
  }
  check("the restored schema equals the source's, table by table", 0, schemaDiffs);
  const [targetTenants] = await target.query(tenantSql);
  check("per-organisation transaction counts are equal", JSON.stringify(sourceTenants), JSON.stringify(targetTenants));

  // ── 4. A schema change after the snapshot does not leak into the dump ──────
  console.log("\n4. A schema change after the snapshot…");
  const ddlHolder = await openHolder(roPassword);
  await root.query("ALTER TABLE channels ADD COLUMN s2_late_column INT NULL");
  const ddlDump = await mysqldump(roPassword, "s2-source", "s2ro",
    [`--init-command=SET SESSION tidb_snapshot = '${ddlHolder.ts}'`, DB, "channels"], "ddl.sql");
  const ddlSql = fs.readFileSync(path.join(DUMPS, "ddl.sql"), "utf8");
  await ddlHolder.close();
  await root.query("ALTER TABLE channels DROP COLUMN s2_late_column");
  check("the dump reads the schema as it was at the snapshot", true, ddlDump.code === 0 && dumpCompleted(ddlSql) && !/s2_late_column/.test(ddlSql),
    "the column added after the snapshot is absent from both CREATE TABLE and the rows");

  // ── 5. A snapshot that cannot be set stops the dump ────────────────────────
  console.log("\n5. A snapshot the server refuses…");
  const future = (BigInt(Date.now() + 3600_000) << 18n).toString();
  const refused = await mysqldump(roPassword, "s2-source", "s2ro",
    [`--init-command=SET SESSION tidb_snapshot = '${future}'`, DB, "organizations"], "refused.sql");
  check("mysqldump refuses to run when the snapshot cannot be set (fail closed)", true, refused.code !== 0,
    refused.output.split("\n").find((l) => /mysqldump:|ERROR/.test(l)) ?? "");

  // ── 6. Archives: schema once, data-only ranges, each at its own snapshot ───
  console.log("\n6. Archive tables in ranges…");
  const archiveTables = [...Object.keys(ARCHIVES), DRIFT_TABLE, KEYLESS_TABLE];
  const plan = {};
  for (const table of archiveTables) {
    const key = chooseRangeKey(await primaryKeyOf(root, table));
    if (!key.ok) {
      plan[table] = { status: "REDESIGN_REQUIRED", reason: key.reason };
      continue;
    }
    const [[bounds]] = await root.query("SELECT MIN(??) AS lo, MAX(??) AS hi FROM ??", [key.column, key.column, table]);
    const ranges = buildRanges(Number(bounds.lo), Number(bounds.hi), CHUNK_KEYS);
    const coverage = checkCoverage(ranges, Number(bounds.lo), Number(bounds.hi));
    plan[table] = { key: key.column, ranges, coverage };
  }
  check("a table with no usable range key stops for redesign instead of being guessed at", "REDESIGN_REQUIRED", plan[KEYLESS_TABLE].status);
  const archiveRunnable = archiveTables.filter((t) => plan[t].ranges);
  check("every runnable manifest covers its key range exactly once", true, archiveRunnable.every((t) => plan[t].coverage.ok),
    archiveRunnable.flatMap((t) => plan[t].coverage.problems.map((p) => `${t}: ${p}`)).join("; ") || undefined);

  const schemaOnly = await mysqldump(roPassword, "s2-source", "s2ro", ["--no-data", DB, ...archiveRunnable], "archive-schema.sql");
  const schemaRestore = schemaOnly.code === 0 ? await mysqlImport(importPassword, "s2imp", "archive-schema.sql") : schemaOnly;
  check("the archive schema is restored once, before any data", 0, schemaRestore.code);

  const chunkRecords = [];
  let chunkProblems = [];
  let injected = false;
  for (const table of archiveRunnable) {
    for (const [i, range] of plan[table].ranges.entries()) {
      const chunkHolder = await openHolder(roPassword);
      const where = `${plan[table].key} >= ${range.lo} AND ${plan[table].key} < ${range.hi}`;
      const file = `chunks/${table}.${String(i).padStart(4, "0")}.sql`;
      const chunkDump = await mysqldump(roPassword, "s2-source", "s2ro",
        [`--init-command=SET SESSION tidb_snapshot = '${chunkHolder.ts}'`, "--no-create-info", "--skip-add-drop-table", `--where=${where}`, DB, table], file, { snapshotExport: true });
      const atChunk = await digestTable(chunkHolder.conn, table, { key: plan[table].key, ...range });
      await chunkHolder.close();
      const text = fs.readFileSync(path.join(DUMPS, file), "utf8");
      const problems = chunkDump.code === 0 ? dataOnlyChunkProblems(text) : [`mysqldump exited ${chunkDump.code}`];
      if (problems.length) chunkProblems.push(`${file}: ${problems.join(", ")}`);
      const chunkRestore = await mysqlImport(importPassword, "s2imp", file);
      if (chunkRestore.code !== 0) chunkProblems.push(`${file}: restore exited ${chunkRestore.code}`);
      chunkRecords.push({ table, range, ts: chunkHolder.ts, atChunk });
      // The deliberate drift: change one row of the drift table after its range was copied.
      if (table === DRIFT_TABLE && !injected) {
        const driftColumn = (await columnsOf(root, DRIFT_TABLE)).find((c) => /char/.test(c.DATA_TYPE) && c.COLUMN_NAME !== plan[table].key);
        await root.query("UPDATE ?? SET ?? = ? WHERE ?? = ?", [DRIFT_TABLE, driftColumn.COLUMN_NAME, "changed-after-copy", plan[table].key, range.lo]);
        injected = true;
      }
    }
  }
  check("every data-only chunk dumped, carried no DROP or CREATE, and restored", 0, chunkProblems.length,
    chunkProblems.slice(0, 5).join("; ") || `${chunkRecords.length} chunks`);

  // Every range at its own snapshot must equal the same range at one later reference snapshot.
  const reference = await openHolder(roPassword);
  const drift = [];
  const restoredMismatch = [];
  for (const record of chunkRecords) {
    const atReference = await digestTable(reference.conn, record.table, { key: plan[record.table].key, ...record.range });
    if (atReference.sha256 !== record.atChunk.sha256) drift.push(`${record.table} [${record.range.lo}, ${record.range.hi})`);
    const inTarget = await digestTable(target, record.table, { key: plan[record.table].key, ...record.range });
    if (inTarget.sha256 !== record.atChunk.sha256) restoredMismatch.push(`${record.table} [${record.range.lo}, ${record.range.hi})`);
  }
  await reference.close();
  receipt.archive = {
    referenceTs: reference.ts,
    chunks: chunkRecords.length,
    plan: Object.fromEntries(Object.entries(plan).map(([t, p]) => [t, p.status ?? { key: p.key, ranges: p.ranges.length }])),
  };
  check("each restored range equals the source range at the snapshot it was copied at", 0, restoredMismatch.length, restoredMismatch.join("; ") || undefined);
  const realDrift = drift.filter((d) => !d.startsWith(DRIFT_TABLE));
  check("the four real archive tables did not change between their copies and the reference snapshot", 0, realDrift.length, realDrift.join("; ") || undefined);
  check("a row changed after its range was copied is caught (the copy is then INVALID)", true,
    drift.some((d) => d.startsWith(DRIFT_TABLE)), drift.filter((d) => d.startsWith(DRIFT_TABLE)).join("; "));

  await target.end();
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
