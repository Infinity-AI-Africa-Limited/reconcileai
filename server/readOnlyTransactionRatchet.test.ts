/**
 * No read-only transactions: CI cannot catch this one, so a scan does.
 *
 * Drizzle turns `{ accessMode: "read only" }` into `START TRANSACTION READ
 * ONLY`. CI's MySQL 8.0 accepts it. TiDB, which production runs, refuses it
 * with ErrFunctionsNoopImpl ("function READ ONLY has only noop implementation")
 * unless `tidb_enable_noop_functions` is on, and that is OFF by default
 * (pingcap/tidb: pkg/executor/simple.go; DefTiDBEnableNoopFuncs). So the
 * construct passes every test and fails on the one database it was written for.
 * It was caught in review of server/duplicateRetailExceptions.ts on 2026-11-04.
 *
 * The same holds for `SET TRANSACTION READ ONLY` and the read-only session
 * variables. To keep a path from writing, make it only read, and test that.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCANNED = ["server", "scripts", "shared", "tools"];
const READ_ONLY = /accessMode\s*:\s*["']read only["']|TRANSACTION\s+READ\s+ONLY|\b(?:transaction|tx)_read_only\b/i;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    // Tests and this scan may name the construct; production code may not.
    if (/\.test\.ts$/.test(entry.name)) return [];
    return /\.(ts|mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

describe("when the code opens a transaction", () => {
  it("should never ask for a read-only one, which production's TiDB refuses", () => {
    const offenders = SCANNED.flatMap((dir) => sourceFiles(path.join(ROOT, dir)))
      .flatMap((file) =>
        fs
          .readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            READ_ONLY.test(line) && !/^\s*(\*|\/\/)/.test(line) ? [`${path.relative(ROOT, file)}:${index + 1}`] : [],
          ),
      );
    expect(offenders, "Read-only transactions fail on TiDB; see this file's header.").toEqual([]);
  });
});
