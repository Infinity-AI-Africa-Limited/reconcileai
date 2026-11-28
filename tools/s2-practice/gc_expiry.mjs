#!/usr/bin/env node
/**
 * Optional, slow (about 25 minutes): what an export pinned to an EXPIRED point
 * does. Made-up data only, on the practice cluster (cluster.sh up <workdir>).
 *
 *   node tools/s2-practice/gc_expiry.mjs <workdir>
 *
 * TiDB keeps old versions for tidb_gc_life_time (10 minutes, also Starter's
 * hosted window, which Support says cannot be extended or held open). This
 * captures a point, waits until garbage collection has passed it, then runs the
 * profile's pinned mysqldump at that point. Expected: mysqldump refuses, with
 * TiDB's "snapshot too old" error (8055), and leaves no completed file; the
 * attempt is INVALID and the partial file is deleted. Writes
 * <workdir>/gc-expiry.json. Set S2_GC_POINT to reuse a point already captured.
 */
import mysql from "mysql2/promise";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_PROFILE, DUMP_PROFILE, dumpCompleted, exactTsoProblem, parseSafePoint, physicalMsOfTso } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !fs.existsSync(path.join(WORK, "certs", "ca.pem"))) {
  console.error("usage: gc_expiry.mjs <workdir>  (start the cluster first: cluster.sh up <workdir>)");
  process.exit(2);
}
delete process.env.DATABASE_URL;
const DB = "reconcileai_gc";
const TIMEOUT_MS = Number(process.env.S2_GC_TIMEOUT_MS ?? 40 * 60 * 1000);
const exact = { host: "127.0.0.1", port: 4000, supportBigNumbers: true, bigNumberStrings: true };


async function main() {
  const root = await mysql.createConnection({ ...exact, user: "root" });
  const password = randomBytes(18).toString("base64url");
  await root.query(`CREATE DATABASE IF NOT EXISTS ${DB}`);
  await root.query(`CREATE TABLE IF NOT EXISTS ${DB}.t (id INT PRIMARY KEY, v VARCHAR(32))`);
  await root.query(`REPLACE INTO ${DB}.t VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
  await root.query("DROP USER IF EXISTS 's2gc'@'%'");
  await root.query("CREATE USER 's2gc'@'%' IDENTIFIED BY ? REQUIRE SSL", [password]);
  await root.query(`GRANT ALL PRIVILEGES ON ${DB}.* TO 's2gc'@'%'`);

  let point = process.env.S2_GC_POINT;
  if (!point) [[{ Position: point }]] = await root.query("SHOW MASTER STATUS");
  const problem = exactTsoProblem(point);
  if (problem) throw new Error(problem);
  const pointAt = physicalMsOfTso(point);
  console.log(`point ${point} (${new Date(pointAt).toISOString()}); waiting for garbage collection to pass it…`);

  const started = Date.now();
  let safePoint;
  for (;;) {
    const [[row]] = await root.query("SELECT VARIABLE_VALUE AS v FROM mysql.tidb WHERE VARIABLE_NAME = 'tikv_gc_safe_point'");
    safePoint = parseSafePoint(row?.v);
    if (safePoint > pointAt) break;
    if (Date.now() - started > TIMEOUT_MS) throw new Error("garbage collection did not pass the point in time");
    await new Promise((r) => setTimeout(r, 15000));
  }
  console.log(`safe point ${new Date(safePoint).toISOString()} has passed the point`);

  const file = path.join(WORK, "dumps", "expired.sql");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const args = [
    "mysqldump", ...CLIENT_PROFILE, "--host=s2-source", "--port=4000", "--user=s2gc", "--password",
    ...DUMP_PROFILE, `--init-command=SET SESSION tidb_snapshot = '${point}'`, "--result-file=/dumps/expired.sql", DB,
  ];
  const docker = ["run", "--rm", "-i", "-t", "--network", "s2net", "--user", `${process.getuid()}:${process.getgid()}`,
    "-v", `${path.join(WORK, "certs")}:/certs:ro`, "-v", `${path.join(WORK, "dumps")}:/dumps`,
    process.env.S2_CLIENT_IMAGE ?? "mirror.gcr.io/library/mysql:8.4", ...args];
  const result = await new Promise((resolve) => {
    const child = spawn("python3", [path.join(HERE, "pty_prompt.py"), "docker", ...docker], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.stdin.end(`${password}\n`);
    child.on("close", (code) => resolve({ code, output: output.replace(/\r/g, "").trim() }));
  });
  const error = result.output.split("\n").find((l) => /mysqldump:|ERROR/.test(l)) ?? "";
  const completed = fs.existsSync(file) && dumpCompleted(fs.readFileSync(file, "utf8"));
  const verdict = result.code !== 0 && !completed ? "INVALID_AS_EXPECTED" : "UNEXPECTED";
  fs.rmSync(file, { force: true }); // a partial file is discarded, never used
  const receipt = {
    synthetic: true,
    point,
    pointAt: new Date(pointAt).toISOString(),
    safePointAt: new Date(safePoint).toISOString(),
    mysqldumpExit: result.code,
    error,
    snapshotTooOld8055: /\b8055\b/.test(error),
    completedFileLeft: completed,
    verdict,
  };
  fs.writeFileSync(path.join(WORK, "gc-expiry.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
  await root.query("DROP USER IF EXISTS 's2gc'@'%'");
  await root.end();
  process.exit(verdict === "INVALID_AS_EXPECTED" && receipt.snapshotTooOld8055 ? 0 : 1);
}

main().catch((error) => {
  console.error(`gc expiry demo stopped: ${error.message}`);
  process.exit(1);
});
