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
  STARTER_LIMITS,
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

describe("when a holding transaction is checked against Starter's limits", () => {
  it("should pass inside 30 minutes and 340 seconds of idleness", () => {
    expect(holderWithinLimits({ openMs: 60_000, maxIdleMs: 30_000 }).ok).toBe(true);
  });

  it("should fail at the transaction limit and at the idle limit", () => {
    expect(holderWithinLimits({ openMs: STARTER_LIMITS.transactionMs, maxIdleMs: 1 }).ok).toBe(false);
    expect(holderWithinLimits({ openMs: 1, maxIdleMs: STARTER_LIMITS.idleMs }).ok).toBe(false);
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
