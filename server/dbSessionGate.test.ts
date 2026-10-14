/**
 * Every pool on the server's own database is built by createAppPool, so every
 * session runs in UTC (server/dbSession.ts). A pool opened any other way runs
 * in the database server's default zone and shifts every timestamp written
 * through it — silently, and only on a server whose default is not UTC, which
 * is exactly the on-premise case no CI run exercises.
 *
 * Read as syntax, not text, and through renames: `import { createPool as
 * openPool }` is still createPool (Greptile #193). The scanner is tested on
 * those forms below, then run over the server.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SERVER = __dirname;
const OPENERS = new Set(["createPool", "createConnection", "createPoolCluster"]);
const GUARDED = new Set([...OPENERS, "drizzle"]);

/** The only files that may open a connection directly, and why. */
const DIRECT_OPENERS: Record<string, string> = {
  "dbSession.ts": "createAppPool itself: the one place an app pool is built and pinned.",
  "woodcoreDb.ts": "Woodcore's own Fineract database, not ours: its dates are read raw, in its own zone.",
};

/** Modules whose exports open connections, or wrap one in drizzle. */
function isGuardedModule(specifier: string): boolean {
  return specifier === "mysql2" || specifier === "mysql2/promise" || specifier.startsWith("drizzle-orm/");
}

type Call = { file: string; line: number; callee: string; firstArgument: ts.Expression | undefined };

/**
 * Every call in `text` to an opener or to drizzle, by the name it was IMPORTED
 * as. Renamed imports, destructuring a module object, and local aliases (even
 * chained) all resolve back to the guarded name.
 */
function scan(file: string, text: string): Call[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const aliases = new Map<string, string>();
  const modules = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isGuardedModule(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name) modules.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (GUARDED.has(imported)) aliases.set(element.name.text, imported);
      }
    }
  }

  const guardedNameOf = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? (GUARDED.has(expression.text) ? expression.text : undefined);
    if (ts.isPropertyAccessExpression(expression) && GUARDED.has(expression.name.text)) return expression.name.text;
    return undefined;
  };
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(source);
  // Repeat until nothing new resolves, so `const a = createPool; const b = a;` reaches b.
  for (let changed = true; changed; ) {
    changed = false;
    for (const declaration of declarations) {
      const initializer = declaration.initializer!;
      if (
        ts.isIdentifier(declaration.name) &&
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "require" &&
        initializer.arguments[0] &&
        ts.isStringLiteral(initializer.arguments[0]) &&
        isGuardedModule(initializer.arguments[0].text) &&
        !modules.has(declaration.name.text)
      ) {
        modules.add(declaration.name.text);
        changed = true;
      }
      if (ts.isIdentifier(declaration.name) && !aliases.has(declaration.name.text)) {
        const guarded = guardedNameOf(initializer);
        if (guarded) {
          aliases.set(declaration.name.text, guarded);
          changed = true;
        }
      }
      if (ts.isObjectBindingPattern(declaration.name) && ts.isIdentifier(initializer) && modules.has(initializer.text)) {
        for (const element of declaration.name.elements) {
          const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : undefined;
          if (imported && GUARDED.has(imported) && ts.isIdentifier(element.name) && !aliases.has(element.name.text)) {
            aliases.set(element.name.text, imported);
            changed = true;
          }
        }
      }
    }
  }

  const found: Call[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = guardedNameOf(node.expression);
      if (callee) {
        found.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          callee,
          firstArgument: node.arguments[0],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function serverSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : serverSources(full);
    return /\.ts$/.test(entry.name) && !/\.(test|spec|testkit)\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** The two rules, over any set of calls. */
function openedDirectly(calls: Call[]): string[] {
  return calls.filter(call => OPENERS.has(call.callee) && !(call.file in DIRECT_OPENERS)).map(where);
}
function drizzleWithoutAppPool(calls: Call[]): string[] {
  return calls
    .filter(call => call.callee === "drizzle")
    .filter(call => {
      const argument = call.firstArgument;
      return !(argument && ts.isCallExpression(argument) && ts.isIdentifier(argument.expression) && argument.expression.text === "createAppPool");
    })
    .map(where);
}
const where = (call: Call) => `${call.file}:${call.line} ${call.callee}(…)`;

describe("when the scanner reads code that hides an opener behind another name", () => {
  it.each<[string, string, string]>([
    ["a renamed named import", 'import { createPool as openPool } from "mysql2";\nopenPool(url);', "createPool"],
    ["a renamed promise-API import", 'import { createConnection as connect } from "mysql2/promise";\nconnect(url);', "createConnection"],
    ["a default import's method", 'import mysql from "mysql2/promise";\nmysql.createPool(url);', "createPool"],
    ["destructuring a module object", 'import mysql from "mysql2/promise";\nconst { createPool: make } = mysql;\nmake(url);', "createPool"],
    ["a namespace import kept in a variable", 'import * as mysql from "mysql2";\nconst make = mysql.createPoolCluster;\nmake();', "createPoolCluster"],
    ["a chain of local aliases", 'import { createPool } from "mysql2";\nconst a = createPool;\nconst b = a;\nb(url);', "createPool"],
    ["a CommonJS require", 'const mysql = require("mysql2");\nconst { createConnection: open } = mysql;\nopen(url);', "createConnection"],
  ])("should still see the opener through %s", (_label, code, expected) => {
    const calls = scan("fixture.ts", code);
    expect(calls.map(call => call.callee)).toEqual([expected]);
    expect(openedDirectly(calls)).toHaveLength(1);
  });

  it("should see drizzle renamed, and refuse it when not handed an app pool", () => {
    const renamed = scan("fixture.ts", 'import { drizzle as orm } from "drizzle-orm/mysql2";\norm(process.env.DATABASE_URL);');
    expect(drizzleWithoutAppPool(renamed)).toEqual(["fixture.ts:2 drizzle(…)"]);

    const pinned = scan("fixture.ts", 'import { drizzle as orm } from "drizzle-orm/mysql2";\norm(createAppPool(url), {});');
    expect(drizzleWithoutAppPool(pinned)).toEqual([]);
  });

  it("should leave unrelated calls alone", () => {
    expect(scan("fixture.ts", 'import { open } from "./files";\nopen(path);\nservice.create(x);')).toEqual([]);
  });
});

const all = serverSources(SERVER).flatMap(file =>
  scan(path.relative(SERVER, file).replace(/\\/g, "/"), fs.readFileSync(file, "utf8"))
);

describe("when the server opens a database connection", () => {
  it("should open one directly only where the allow-list says why", () => {
    expect(openedDirectly(all), "build app pools with createAppPool (server/dbSession.ts)").toEqual([]);
  });

  it("should hand drizzle only a pool that createAppPool built", () => {
    expect(drizzleWithoutAppPool(all), "drizzle(createAppPool(url), …), never drizzle(url)").toEqual([]);
  });

  it("should actually see the calls it guards, so an empty result means something", () => {
    // A scanner that silently found nothing would pass both rules above.
    expect(all.some(call => call.file === "dbSession.ts" && call.callee === "createPool")).toBe(true);
    expect(all.some(call => call.file === "woodcoreDb.ts" && call.callee === "createPool")).toBe(true);
    expect(all.some(call => call.file === "db.ts" && call.callee === "drizzle")).toBe(true);
  });
});
