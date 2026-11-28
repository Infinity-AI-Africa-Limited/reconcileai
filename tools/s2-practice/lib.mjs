/**
 * Pure helpers for the synthetic S2 practice run (tools/s2-practice/README.md).
 * No I/O, so tools/s2Practice.test.ts covers every rule here.
 */
import { createHash } from "node:crypto";

/**
 * The client profile, shared by mysqldump and mysql. The two option-file
 * switches are honoured only at the very start, in this order: placed later,
 * mysqldump rejects --no-login-paths as an unknown option.
 */
export const CLIENT_PROFILE = Object.freeze([
  "--no-defaults",
  "--no-login-paths",
  "--ssl-mode=VERIFY_IDENTITY",
  "--ssl-ca=/certs/ca.pem",
]);

/**
 * The export profile. There is deliberately no --single-transaction: on TiDB it
 * yields no snapshot (see the receipt's finding). Consistency comes from
 * --init-command pinning tidb_snapshot to one point taken from SHOW MASTER
 * STATUS, which is also the profile TiDB Cloud Support describes for Starter.
 */
export const DUMP_PROFILE = Object.freeze([
  "--skip-lock-tables",
  "--skip-add-locks",
  "--quick",
  "--column-statistics=0",
  "--set-gtid-purged=OFF",
  "--no-tablespaces",
  "--skip-routines",
  "--skip-triggers",
  "--skip-events",
  "--hex-blob",
  "--default-character-set=utf8mb4",
]);

/** Options that must never reach a production export. */
export const FORBIDDEN_EXPORT_OPTIONS = Object.freeze([
  "--single-transaction", // no snapshot on TiDB
  "--source-data", // the next four request FLUSH TABLES WITH READ LOCK
  "--master-data",
  "--flush-logs",
  "--lock-all-tables",
  "--force", // would carry on past errors
]);

/** What is wrong with an export command line, or [] when it fits the profile. */
export function exportProfileProblems(args) {
  const problems = [];
  if (args[0] !== "--no-defaults") problems.push("--no-defaults is not the first option");
  if (args[1] !== "--no-login-paths") problems.push("--no-login-paths is not the second option");
  for (const option of FORBIDDEN_EXPORT_OPTIONS) {
    if (args.some((a) => a === option || a.startsWith(`${option}=`))) problems.push(`${option} is forbidden`);
  }
  if (args.some((a) => /^--password=|^-p\S/.test(a))) problems.push("a password is on the command line");
  if (!args.includes("--password")) problems.push("no bare --password, so nothing prompts");
  if (!args.some((a) => /^--init-command=SET SESSION tidb_snapshot = '\d+'$/.test(a))) {
    problems.push("no --init-command pinning tidb_snapshot to a start_ts");
  }
  for (const required of DUMP_PROFILE) if (!args.includes(required)) problems.push(`${required} is missing`);
  return problems;
}

/**
 * A streaming SHA-256 over rows taken in a fixed order.
 *
 * Each column is length-prefixed (4 bytes, big-endian) and NULL has its own
 * marker, so NULL differs from the empty string and no two rows can run
 * together. The values hashed are the server's text-protocol bytes, which is
 * exact only when both sides run the same engine version with the same session
 * time zone: the practice compares TiDB with the same TiDB.
 */
export function createRowHasher() {
  const hash = createHash("sha256");
  const prefix = Buffer.alloc(4);
  let rows = 0;
  return {
    add(columns) {
      for (const value of columns) {
        if (value === null || value === undefined) {
          prefix.writeUInt32BE(0xffffffff);
          hash.update(prefix);
          continue;
        }
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
        prefix.writeUInt32BE(bytes.length);
        hash.update(prefix);
        hash.update(bytes);
      }
      hash.update(ROW_END);
      rows += 1;
    },
    result() {
      return { rows, sha256: hash.digest("hex") };
    },
  };
}
const ROW_END = Buffer.from([0x1e]);

/** Half-open ranges [lo, hi) of at most `size` keys that cover min..max. */
export function buildRanges(min, max, size) {
  for (const [name, value] of [["min", min], ["max", max], ["size", size]]) {
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer, got ${value}`);
  }
  if (size < 1) throw new Error(`size must be at least 1, got ${size}`);
  if (max < min) throw new Error(`max ${max} is below min ${min}`);
  const ranges = [];
  for (let lo = min; lo <= max; lo += size) ranges.push({ lo, hi: Math.min(lo + size, max + 1) });
  return ranges;
}

/**
 * Proves a manifest covers min..max exactly once: it starts at min, ends at
 * max + 1, and each range starts where the previous one ended.
 */
export function checkCoverage(ranges, min, max) {
  const problems = [];
  if (ranges.length === 0) return { ok: false, problems: ["the manifest is empty"] };
  if (ranges[0].lo !== min) problems.push(`starts at ${ranges[0].lo}, not ${min}`);
  ranges.forEach((range, i) => {
    if (!(range.lo < range.hi)) problems.push(`range ${i} [${range.lo}, ${range.hi}) is empty or inverted`);
    if (i === 0) return;
    const previous = ranges[i - 1];
    if (range.lo > previous.hi) problems.push(`gap: [${previous.hi}, ${range.lo}) is in no range`);
    if (range.lo < previous.hi) problems.push(`overlap: ${range.lo} is in two ranges`);
  });
  const last = ranges[ranges.length - 1];
  if (last.hi !== max + 1) problems.push(`ends at ${last.hi}, not ${max + 1}`);
  return { ok: problems.length === 0, problems };
}

const INTEGER_TYPES = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint"]);

/**
 * A table can be cut into ranges only by a single-column integer primary key.
 * Anything else stops the table for redesign rather than guessing a key.
 */
export function chooseRangeKey(primaryKey) {
  if (primaryKey.length === 0) return { ok: false, reason: "REDESIGN_REQUIRED: the table has no primary key" };
  if (primaryKey.length > 1) {
    return { ok: false, reason: `REDESIGN_REQUIRED: composite primary key (${primaryKey.map((c) => c.column).join(", ")})` };
  }
  const [{ column, dataType }] = primaryKey;
  if (!INTEGER_TYPES.has(String(dataType).toLowerCase())) {
    return { ok: false, reason: `REDESIGN_REQUIRED: primary key ${column} is ${dataType}, not an integer` };
  }
  return { ok: true, column };
}

/** mysqldump's own last line. A dump without it was cut short. */
export function dumpCompleted(sqlText) {
  return /^-- Dump completed/m.test(sqlText);
}

/**
 * A data-only chunk must neither drop nor create a table: replayed after the
 * first chunk, either would erase ranges already restored.
 */
export function dataOnlyChunkProblems(sqlText) {
  const problems = [];
  if (/^\s*DROP\s+TABLE/im.test(sqlText)) problems.push("contains DROP TABLE");
  if (/^\s*CREATE\s+TABLE/im.test(sqlText)) problems.push("contains CREATE TABLE");
  if (/^\s*LOCK\s+TABLES/im.test(sqlText)) problems.push("contains LOCK TABLES");
  if (!dumpCompleted(sqlText)) problems.push("has no '-- Dump completed' trailer");
  return problems;
}

/**
 * SHOW CREATE TABLE without the counters that legitimately differ between a
 * source and a restored copy.
 */
export function normaliseCreateTable(ddl) {
  return String(ddl)
    .replace(/\s+AUTO_INCREMENT=\d+/g, "")
    .replace(/\s+AUTO_ID_CACHE=\d+/g, "")
    .replace(/\s+AUTO_RANDOM_BASE=\d+/g, "")
    .trim();
}

/** Every table whose row count or hash differs, and every table on one side only. */
export function compareDigests(expected, actual) {
  const mismatches = [];
  for (const [table, want] of Object.entries(expected)) {
    const got = actual[table];
    if (!got) {
      mismatches.push({ table, problem: "missing from the restored copy" });
      continue;
    }
    if (got.rows !== want.rows) mismatches.push({ table, problem: `rows ${got.rows}, expected ${want.rows}` });
    else if (got.sha256 !== want.sha256) mismatches.push({ table, problem: "same row count, different content" });
  }
  for (const table of Object.keys(actual)) {
    if (!(table in expected)) mismatches.push({ table, problem: "present only in the restored copy" });
  }
  return mismatches;
}

/**
 * TiDB Cloud Starter's limits. The first two are from tidb-cloud/serverless-limitations.md
 * (read 2026-11-24). The snapshot window is Support's statement of 27 November 2026:
 * "Old data is kept for 10 minutes. This window can't be extended or held open."
 */
export const STARTER_LIMITS = Object.freeze({
  transactionMs: 30 * 60 * 1000,
  idleMs: 340 * 1000,
  snapshotWindowMs: 10 * 60 * 1000,
});

/** The planning budget inside the 10-minute window: 8 minutes, leaving 2 for setup and margin. */
export const SNAPSHOT_BUDGET_MS = 8 * 60 * 1000;

/**
 * Whether every read at the snapshot finished inside the budget, counted from
 * the moment the point was captured (not from the start of the dump), to the
 * last read that must see that same point.
 */
export function snapshotWithinBudget(elapsedMs, budgetMs = SNAPSHOT_BUDGET_MS, limits = STARTER_LIMITS) {
  const problems = [];
  if (!(budgetMs < limits.snapshotWindowMs)) problems.push(`budget ${budgetMs} ms is not inside the ${limits.snapshotWindowMs} ms window`);
  if (!(elapsedMs <= budgetMs)) problems.push(`the last snapshot read ended ${elapsedMs} ms after capture, budget ${budgetMs} ms`);
  return { ok: problems.length === 0, problems };
}

/**
 * A TSO is an unsigned 64-bit integer, beyond the 2^53 that a floating-point
 * number holds exactly. Copied through a tool that turns it into a number (a
 * spreadsheet, JavaScript, some drivers), it comes back rounded: a later value
 * is refused as "a future time", an earlier one silently names another point.
 * So the point travels as text, and only as exact digits.
 */
export function exactTsoProblem(value) {
  if (typeof value !== "string") return `the snapshot point is a ${typeof value}, not text: a number cannot hold it exactly`;
  if (!/^[1-9]\d{0,19}$/.test(value)) return "the snapshot point is not a plain run of digits";
  if (BigInt(value) > 18446744073709551615n) return "the snapshot point is beyond 64 bits";
  return null;
}

/**
 * From TiDB general-log entries of one session (in order), the statement after
 * which its transaction ended: the last statement that ran with a non-zero
 * txnStartTS before the session ran with zero again.
 */
export function statementEndingTransaction(entries) {
  let started = -1;
  for (let i = 0; i < entries.length; i++) {
    if (/^\s*START\s+TRANSACTION/i.test(entries[i].sql)) {
      started = i;
      break;
    }
  }
  if (started < 0) return { found: false, reason: "no START TRANSACTION in the log" };
  for (let i = started + 1; i < entries.length; i++) {
    if (entries[i].txnStartTS === "0") {
      return i === started + 1
        ? { found: true, statement: entries[started].sql, note: "the transaction was not visible after it started" }
        : { found: true, statement: entries[i - 1].sql, statementsInsideTransaction: i - started - 1 };
    }
  }
  return { found: false, reason: "the transaction stayed open to the end of the log" };
}

/** Parses TiDB GENERAL_LOG lines into {conn, user, txnStartTS, sql}. */
export function parseGeneralLog(text) {
  const entries = [];
  for (const line of String(text).split("\n")) {
    if (!line.includes("[GENERAL_LOG]")) continue;
    const conn = /\[conn=(\d+)\]/.exec(line)?.[1];
    const user = /\[user=([^@\]]+)@/.exec(line)?.[1];
    const txnStartTS = /\[txnStartTS=(\d+)\]/.exec(line)?.[1];
    const sql = /\[sql="?(.*?)"?\]\s*$/.exec(line)?.[1];
    if (conn && txnStartTS !== undefined && sql !== undefined) entries.push({ conn, user, txnStartTS, sql });
  }
  return entries;
}

/** A TSO's physical part: milliseconds since the epoch, in its upper 46 bits. */
export function physicalMsOfTso(tso) {
  return Number(BigInt(tso) >> 18n);
}

/**
 * TiDB records its GC safe point as "20261128-16:49:06.077 +0000" (in mysql.tidb,
 * tikv_gc_safe_point). Returns epoch milliseconds, or NaN for anything else, so a
 * value that cannot be read never looks like a passed safe point.
 */
export function parseSafePoint(text) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? ([+-])(\d{2})(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, frac = "0", sign, oh, om] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.${frac.padEnd(3, "0").slice(0, 3)}${sign}${oh}:${om}`);
}

/**
 * Backquotes a table or column name. Only plain names (letters, digits, _ and $) are
 * accepted, which every name in the app's schema is, so a name can also sit inside a
 * string literal unescaped.
 */
export function quoteIdentifier(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_$]{1,64}$/.test(name)) {
    throw new Error(`not a plain identifier: ${JSON.stringify(name)}`);
  }
  return `\`${name}\``;
}

/** Column types whose stored value is text or bytes: hashed as those bytes, whatever the collation. */
const BYTE_TYPES = new Set([
  "char", "varchar", "tinytext", "text", "mediumtext", "longtext",
  "binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "enum", "set",
]);

/**
 * One statement that has the server digest every row of a table, so the stock `mysql`
 * client can validate a copy and no custom tool ever holds the password. Each row becomes
 * the SHA-256 of its values, every value as hex and NULL as "-", which no hex can be:
 * no delimiter or NULL collisions. The table's digest is its row count plus the sum and
 * the XOR of two 60-bit slices of those hashes, so row order does not matter and a
 * duplicated row still counts. Run it with the session time zone at UTC on both sides.
 */
export function sqlDigestStatement(table, columns) {
  if (!Array.isArray(columns) || columns.length === 0) throw new Error(`${table}: no columns to digest`);
  const values = columns.map((c) => {
    const column = quoteIdentifier(c.COLUMN_NAME);
    const asStored = BYTE_TYPES.has(String(c.DATA_TYPE).toLowerCase());
    return `IFNULL(HEX(${asStored ? column : `CAST(${column} AS CHAR)`}), '-')`;
  });
  const quoted = quoteIdentifier(table);
  return (
    `SELECT 'digest', '${table}', COUNT(*), ` +
    "IFNULL(SUM(CAST(CONV(SUBSTRING(h, 1, 15), 16, 10) AS UNSIGNED)), 0), " +
    "BIT_XOR(CAST(CONV(SUBSTRING(h, 16, 15), 16, 10) AS UNSIGNED)) " +
    `FROM (SELECT SHA2(CONCAT_WS(',', ${values.join(", ")}), 256) AS h FROM ${quoted}) AS d;`
  );
}

/** Reads the stock client's batch output of sqlDigestStatement lines: table → "count/sum/xor". */
export function parseSqlDigests(output) {
  const digests = {};
  for (const line of String(output).split("\n")) {
    const fields = line.split("\t");
    if (fields[0] !== "digest" || fields.length !== 5) continue;
    const [, table, count, sum, xor] = fields;
    if (![count, sum, xor].every((v) => /^\d+$/.test(v))) continue;
    if (table in digests) throw new Error(`${table} digested twice`);
    digests[table] = `${count}/${sum}/${xor}`;
  }
  return digests;
}
