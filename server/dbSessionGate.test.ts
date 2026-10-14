/**
 * Every pool on the server's own database is built by createAppPool, so every
 * session runs in UTC (server/dbSession.ts). A pool opened any other way runs
 * in the database server's default zone and shifts every timestamp written
 * through it — silently, and only on a server whose default is not UTC, which
 * is exactly the on-premise case no CI run exercises.
 *
 * Read as syntax, not text: a call is found by what it calls, however it is
 * formatted or imported.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SERVER = __dirname;
const OPENERS = new Set(["createPool", "createConnection", "createPoolCluster"]);

/** The only files that may open a connection directly, and why. */
const DIRECT_OPENERS: Record<string, string> = {
  "dbSession.ts": "createAppPool itself: the one place an app pool is built and pinned.",
  "woodcoreDb.ts": "Woodcore's own Fineract database, not ours: its dates are read raw, in its own zone.",
};

function serverSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : serverSources(full);
    return /\.ts$/.test(entry.name) && !/\.(test|spec|testkit)\.ts$/.test(entry.name) ? [full] : [];
  });
}

type Call = { file: string; line: number; callee: string; firstArgument: ts.Expression | undefined };

function calls(): Call[] {
  const found: Call[] = [];
  for (const file of serverSources(SERVER)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : undefined;
        if (callee) {
          found.push({
            file: path.relative(SERVER, file).replace(/\\/g, "/"),
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            callee,
            firstArgument: node.arguments[0],
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const all = calls();
const where = (call: Call) => `${call.file}:${call.line} ${call.callee}(…)`;

describe("when the server opens a database connection", () => {
  it("should open one directly only where the allow-list says why", () => {
    const offenders = all
      .filter(call => OPENERS.has(call.callee) && !(call.file in DIRECT_OPENERS))
      .map(where);
    expect(offenders, "build app pools with createAppPool (server/dbSession.ts)").toEqual([]);
  });

  it("should hand drizzle only a pool that createAppPool built", () => {
    const offenders = all
      .filter(call => call.callee === "drizzle")
      .filter(call => {
        const argument = call.firstArgument;
        return !(
          argument &&
          ts.isCallExpression(argument) &&
          ts.isIdentifier(argument.expression) &&
          argument.expression.text === "createAppPool"
        );
      })
      .map(where);
    expect(offenders, "drizzle(createAppPool(url), …), never drizzle(url)").toEqual([]);
  });

  it("should actually see the calls it guards, so an empty result means something", () => {
    // A scanner that silently found nothing would pass both rules above.
    expect(all.some(call => call.file === "dbSession.ts" && call.callee === "createPool")).toBe(true);
    expect(all.some(call => call.file === "woodcoreDb.ts" && call.callee === "createPool")).toBe(true);
    expect(all.some(call => call.file === "db.ts" && call.callee === "drizzle")).toBe(true);
    expect(all.some(call => call.file === "woodcoreSync.ts" && call.callee === "createAppPool")).toBe(true);
  });
});
