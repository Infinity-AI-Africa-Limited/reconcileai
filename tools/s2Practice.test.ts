/**
 * The rules behind the synthetic S2 practice run (tools/s2-practice). The run
 * itself needs Docker and a TiDB cluster, so it has its own workflow; these
 * tests pin the pure rules on every pull request.
 */
import { describe, expect, it } from "vitest";
import {
  CLIENT_PROFILE,
  DUMP_PROFILE,
  FORBIDDEN_EXPORT_OPTIONS,
  SNAPSHOT_BUDGET_MS,
  STARTER_LIMITS,
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
  parseSafePoint,
  parseSqlDigests,
  physicalMsOfTso,
  quoteIdentifier,
  snapshotWithinBudget,
  sqlDigestStatement,
  statementEndingTransaction,
} from "./s2-practice/lib.mjs";

const digestOf = (rows: Array<Array<string | Buffer | null>>) => {
  const hasher = createRowHasher();
  for (const row of rows) hasher.add(row);
  return hasher.result();
};

const SNAPSHOT_EXPORT = [
  ...CLIENT_PROFILE,
  "--host=s2-source",
  "--port=4000",
  "--user=s2ro",
  "--password",
  ...DUMP_PROFILE,
  "--init-command=SET SESSION tidb_snapshot = '470729595142275076'",
  "reconcileai",
];

describe("when rows are hashed", () => {
  it("should give the same digest for the same rows in the same order", () => {
    expect(digestOf([["1", "a"], ["2", "b"]])).toEqual(digestOf([["1", "a"], ["2", "b"]]));
  });

  it("should tell NULL from an empty string", () => {
    expect(digestOf([["1", null]]).sha256).not.toBe(digestOf([["1", ""]]).sha256);
  });

  it("should not let a value slide across a column boundary", () => {
    expect(digestOf([["ab", "c"]]).sha256).not.toBe(digestOf([["a", "bc"]]).sha256);
  });

  it("should not let rows run together", () => {
    expect(digestOf([["a"], ["b"]]).sha256).not.toBe(digestOf([["a", "b"]]).sha256);
  });

  it("should depend on row order, and count the rows", () => {
    const forward = digestOf([["1"], ["2"]]);
    expect(forward.sha256).not.toBe(digestOf([["2"], ["1"]]).sha256);
    expect(forward.rows).toBe(2);
  });

  it("should hash binary values byte for byte", () => {
    expect(digestOf([[Buffer.from([0, 1])]]).sha256).not.toBe(digestOf([[Buffer.from([0, 2])]]).sha256);
  });
});

describe("when a key range is cut into chunks", () => {
  it("should cover the whole range with half-open ranges, the last one clipped", () => {
    const ranges = buildRanges(1, 45, 20);
    expect(ranges).toEqual([
      { lo: 1, hi: 21 },
      { lo: 21, hi: 41 },
      { lo: 41, hi: 46 },
    ]);
    expect(checkCoverage(ranges, 1, 45)).toEqual({ ok: true, problems: [] });
  });

  it("should refuse a size below one, a non-integer bound or an inverted range", () => {
    expect(() => buildRanges(1, 10, 0)).toThrow();
    expect(() => buildRanges(1.5, 10, 2)).toThrow();
    expect(() => buildRanges(10, 1, 2)).toThrow();
  });

  it("should report a gap, an overlap, a wrong start and a wrong end", () => {
    expect(checkCoverage([{ lo: 1, hi: 5 }, { lo: 6, hi: 11 }], 1, 10).problems).toContain("gap: [5, 6) is in no range");
    expect(checkCoverage([{ lo: 1, hi: 6 }, { lo: 5, hi: 11 }], 1, 10).problems).toContain("overlap: 5 is in two ranges");
    expect(checkCoverage([{ lo: 2, hi: 11 }], 1, 10).problems).toContain("starts at 2, not 1");
    expect(checkCoverage([{ lo: 1, hi: 10 }], 1, 10).problems).toContain("ends at 10, not 11");
  });

  it("should reject an empty manifest and an empty range", () => {
    expect(checkCoverage([], 1, 10).ok).toBe(false);
    expect(checkCoverage([{ lo: 1, hi: 1 }, { lo: 1, hi: 11 }], 1, 10).ok).toBe(false);
  });
});

describe("when choosing the key to cut a table by", () => {
  it("should accept a single integer primary key", () => {
    expect(chooseRangeKey([{ column: "id", dataType: "bigint" }])).toEqual({ ok: true, column: "id" });
  });

  it("should stop for redesign without a primary key, with a composite one, or with a non-integer one", () => {
    expect(chooseRangeKey([]).reason).toMatch(/^REDESIGN_REQUIRED/);
    expect(chooseRangeKey([{ column: "a", dataType: "int" }, { column: "b", dataType: "int" }]).reason).toMatch(/composite/);
    expect(chooseRangeKey([{ column: "ref", dataType: "varchar" }]).reason).toMatch(/not an integer/);
  });
});

describe("when a dump or a chunk is checked", () => {
  const trailer = "-- Dump completed on 2026-11-26 11:07:16\n";

  it("should require mysqldump's completion trailer", () => {
    expect(dumpCompleted(`INSERT INTO t VALUES (1);\n${trailer}`)).toBe(true);
    expect(dumpCompleted("INSERT INTO t VALUES (1);\n")).toBe(false);
  });

  it("should pass a clean data-only chunk", () => {
    expect(dataOnlyChunkProblems(`INSERT INTO \`t\` VALUES (1);\n${trailer}`)).toEqual([]);
  });

  it("should flag a chunk that would drop, create or lock a table", () => {
    const problems = dataOnlyChunkProblems(`DROP TABLE IF EXISTS \`t\`;\nCREATE TABLE \`t\` (id int);\nLOCK TABLES \`t\` WRITE;\n${trailer}`);
    expect(problems).toEqual(["contains DROP TABLE", "contains CREATE TABLE", "contains LOCK TABLES"]);
  });

  it("should flag a chunk that was cut short", () => {
    expect(dataOnlyChunkProblems("INSERT INTO `t` VALUES (1);\n")).toContain("has no '-- Dump completed' trailer");
  });
});

describe("when the source and the restored copy are compared", () => {
  it("should ignore counters that legitimately differ in SHOW CREATE TABLE", () => {
    expect(normaliseCreateTable("CREATE TABLE `t` (id int) ENGINE=InnoDB AUTO_INCREMENT=99 AUTO_ID_CACHE=1")).toBe(
      "CREATE TABLE `t` (id int) ENGINE=InnoDB",
    );
  });

  it("should list a missing table, an extra table, a count difference and a content difference", () => {
    const expected = { a: { rows: 1, sha256: "x" }, b: { rows: 2, sha256: "y" }, c: { rows: 3, sha256: "z" } };
    const actual = { b: { rows: 3, sha256: "y" }, c: { rows: 3, sha256: "w" }, d: { rows: 1, sha256: "v" } };
    expect(compareDigests(expected, actual)).toEqual([
      { table: "a", problem: "missing from the restored copy" },
      { table: "b", problem: "rows 3, expected 2" },
      { table: "c", problem: "same row count, different content" },
      { table: "d", problem: "present only in the restored copy" },
    ]);
  });
});

describe("when an export is checked against the hosted 10-minute window", () => {
  it("should keep the planning budget inside Support's 10-minute window", () => {
    expect(STARTER_LIMITS.snapshotWindowMs).toBe(600_000);
    expect(SNAPSHOT_BUDGET_MS).toBeLessThan(STARTER_LIMITS.snapshotWindowMs);
  });

  it("should pass when the last snapshot read ends inside the budget, counted from capture", () => {
    expect(snapshotWithinBudget(SNAPSHOT_BUDGET_MS)).toEqual({ ok: true, problems: [] });
  });

  it("should fail one millisecond over the budget", () => {
    expect(snapshotWithinBudget(SNAPSHOT_BUDGET_MS + 1).ok).toBe(false);
  });

  it("should refuse a budget that is not inside the window", () => {
    expect(snapshotWithinBudget(1, STARTER_LIMITS.snapshotWindowMs).problems[0]).toMatch(/not inside/);
  });
});

describe("when the snapshot point is copied", () => {
  const point = "470780533441036289";

  it("should accept the exact digits as text", () => {
    expect(exactTsoProblem(point)).toBeNull();
  });

  it("should refuse a number, because a TSO is beyond 2^53 and comes back rounded", () => {
    expect(String(Number(point))).not.toBe(point);
    expect(exactTsoProblem(Number(point))).toMatch(/not text/);
  });

  it("should refuse anything that is not a plain run of digits, or beyond 64 bits", () => {
    expect(exactTsoProblem("4.7078053344103629e17")).toMatch(/digits/);
    expect(exactTsoProblem(" 470780533441036289")).toMatch(/digits/);
    expect(exactTsoProblem("18446744073709551616")).toMatch(/64 bits/);
  });
});

describe("when garbage collection's progress is read", () => {
  it("should read TiDB's safe-point format as epoch milliseconds", () => {
    expect(new Date(parseSafePoint("20261128-16:49:06.077 +0000")).toISOString()).toBe("2026-11-28T16:49:06.077Z");
    expect(new Date(parseSafePoint("20261128-17:49:06 +0100")).toISOString()).toBe("2026-11-28T16:49:06.000Z");
  });

  it("should give NaN, never a date, for anything it cannot read", () => {
    expect(parseSafePoint("2026-11-28 16:49:06")).toBeNaN();
    expect(parseSafePoint(undefined)).toBeNaN();
  });

  it("should take a TSO's physical time from its upper bits", () => {
    expect(new Date(physicalMsOfTso("470780533441036289")).toISOString()).toBe("2026-11-28T17:00:13.627Z");
  });
});

describe("when TiDB's general log is read", () => {
  // The shape TiDB v8.5 writes, with the sequence mysqldump 8.4 produced.
  const line = (conn: number, ts: string, sql: string) =>
    `[2026/11/26 11:00:00.315 +00:00] [INFO] [session.go:4354] [GENERAL_LOG] [conn=${conn}] [session_alias=] [user=s2ro@172.18.0.6] [schemaVersion=57] [txnStartTS=${ts}] [forUpdateTS=0] [isReadConsistency=false] [sql="${sql}"]`;
  const log = [
    line(7, "0", "SHOW VARIABLES LIKE 'gtid_mode'"),
    line(7, "0", "START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */"),
    line(7, "470729569150435336", "UNLOCK TABLES"),
    line(7, "0", "SAVEPOINT sp"),
    line(7, "0", "SELECT /*!40001 SQL_NO_CACHE */ * FROM `t1`"),
    line(7, "0", "ROLLBACK TO SAVEPOINT sp"),
  ].join("\n");

  it("should parse each entry's connection, user, start_ts and statement", () => {
    expect(parseGeneralLog(log)[2]).toEqual({ conn: "7", user: "s2ro", txnStartTS: "470729569150435336", sql: "UNLOCK TABLES" });
  });

  it("should name UNLOCK TABLES as the statement that ended mysqldump's transaction", () => {
    expect(statementEndingTransaction(parseGeneralLog(log))).toEqual({
      found: true,
      statement: "UNLOCK TABLES",
      statementsInsideTransaction: 1,
    });
  });

  it("should say so when there is no transaction, or when it never ends", () => {
    expect(statementEndingTransaction([]).found).toBe(false);
    const open = parseGeneralLog([line(7, "0", "START TRANSACTION"), line(7, "5", "SELECT 1")].join("\n"));
    expect(statementEndingTransaction(open).found).toBe(false);
  });
});

describe("when an export command line is checked against the profile", () => {
  it("should accept the snapshot export the practice runs", () => {
    expect(exportProfileProblems(SNAPSHOT_EXPORT)).toEqual([]);
  });

  it("should require --no-defaults first and --no-login-paths second", () => {
    const swapped = ["--no-login-paths", "--no-defaults", ...SNAPSHOT_EXPORT.slice(2)];
    expect(exportProfileProblems(swapped)).toEqual(
      expect.arrayContaining(["--no-defaults is not the first option", "--no-login-paths is not the second option"]),
    );
  });

  it("should refuse every forbidden option, --single-transaction included", () => {
    for (const option of FORBIDDEN_EXPORT_OPTIONS) {
      expect(exportProfileProblems([...SNAPSHOT_EXPORT, option])).toContain(`${option} is forbidden`);
    }
    expect(exportProfileProblems([...SNAPSHOT_EXPORT, "--source-data=2"])).toContain("--source-data is forbidden");
  });

  it("should refuse a password on the command line, and a run with nothing to prompt", () => {
    expect(exportProfileProblems([...SNAPSHOT_EXPORT, "--password=hunter2"])).toContain("a password is on the command line");
    expect(exportProfileProblems([...SNAPSHOT_EXPORT, "-phunter2"])).toContain("a password is on the command line");
    expect(exportProfileProblems(SNAPSHOT_EXPORT.filter((a) => a !== "--password"))).toContain("no bare --password, so nothing prompts");
  });

  it("should refuse an export that is not pinned to a snapshot", () => {
    expect(exportProfileProblems(SNAPSHOT_EXPORT.filter((a) => !a.startsWith("--init-command")))).toContain(
      "no --init-command pinning tidb_snapshot to a start_ts",
    );
  });

  it("should keep the export profile free of --single-transaction", () => {
    expect(DUMP_PROFILE).not.toContain("--single-transaction");
  });
});

describe("when the stock client validates a copy with server-side digests", () => {
  const columns = [
    { COLUMN_NAME: "id", DATA_TYPE: "bigint" },
    { COLUMN_NAME: "amount", DATA_TYPE: "decimal" },
    { COLUMN_NAME: "reference", DATA_TYPE: "varchar" },
    { COLUMN_NAME: "payload", DATA_TYPE: "json" },
    { COLUMN_NAME: "blob", DATA_TYPE: "longblob" },
  ];

  it("should hash text and bytes as stored, and everything else as its text form", () => {
    const sql = sqlDigestStatement("transactions", columns);
    expect(sql).toContain("IFNULL(HEX(`reference`), '-')");
    expect(sql).toContain("IFNULL(HEX(`blob`), '-')");
    expect(sql).toContain("IFNULL(HEX(CAST(`amount` AS CHAR)), '-')");
    expect(sql).toContain("IFNULL(HEX(CAST(`payload` AS CHAR)), '-')");
    expect(sql).not.toMatch(/HEX\(`amount`\)/);
  });

  it("should give every column's NULL a mark no hex value can be, so NULL and an empty value differ", () => {
    // HEX('') is '' and HEX(NULL) is NULL; IFNULL turns only the NULL into '-'.
    const marks = sqlDigestStatement("t", columns).match(/IFNULL\(HEX\(.+?\), '-'\)/g) ?? [];
    expect(marks).toHaveLength(columns.length);
  });

  it("should count rows, so a duplicated row is not cancelled out by the XOR", () => {
    const sql = sqlDigestStatement("t", columns);
    expect(sql).toContain("COUNT(*)");
    expect(sql).toContain("SUM(CAST(CONV(SUBSTRING(h, 1, 15), 16, 10) AS UNSIGNED))");
    expect(sql).toContain("BIT_XOR(CAST(CONV(SUBSTRING(h, 16, 15), 16, 10) AS UNSIGNED))");
  });

  it("should refuse a name that is not plain, before it can reach SQL", () => {
    expect(() => sqlDigestStatement("t`; DROP TABLE x; --", columns)).toThrow(/not a plain identifier/);
    expect(() => sqlDigestStatement("t", [{ COLUMN_NAME: "a'b", DATA_TYPE: "int" }])).toThrow(/not a plain identifier/);
    expect(() => sqlDigestStatement("t", [])).toThrow(/no columns/);
    expect(quoteIdentifier("transactions_legacy_archive")).toBe("`transactions_legacy_archive`");
  });

  it("should read only well-formed digest lines from the client's output", () => {
    const output = ["Enter password: ", "digest\tusers\t3\t12\t7", "warning: something", "digest\tbad\t3\tNULL\t7", "digest\tempty\t0\t0\t0"].join("\n");
    expect(parseSqlDigests(output)).toEqual({ users: "3/12/7", empty: "0/0/0" });
  });

  it("should refuse output that digests one table twice", () => {
    expect(() => parseSqlDigests("digest\tusers\t1\t1\t1\ndigest\tusers\t2\t2\t2")).toThrow(/twice/);
  });
});
