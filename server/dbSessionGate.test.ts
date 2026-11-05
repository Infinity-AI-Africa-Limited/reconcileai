/**
 * Every pool on the server's own database is built by createAppPool, so every
 * session runs in UTC (server/dbSession.ts). A pool opened any other way runs
 * in the database server's default zone and shifts every timestamp written
 * through it — silently, and only on a server whose default is not UTC, which
 * is exactly the on-premise case no CI run exercises.
 *
 * Tests are held to the same rule (since 2026-11-05). Until then the scan
 * skipped them, and database tests drifted onto raw pools. On a server whose
 * default is not UTC such a test runs in that zone rather than the app's, so it
 * no longer tests what production does.
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
  "dbSession.db.test.ts": "It proves the pin, so it needs what the pin prevents: an unpinned session as its control, and a pool whose pin fails.",
};

/** The only files that may hand drizzle something other than an app pool, and why. */
const DRIZZLE_WITHOUT_APP_POOL: Record<string, string> = {
  "duplicateKeyDetection.test.ts": "drizzle over a scripted client that records SQL: no connection exists.",
};

/** Modules whose exports open connections, or wrap one in drizzle. */
function isGuardedModule(specifier: string): boolean {
  return specifier === "mysql2" || specifier === "mysql2/promise" || specifier.startsWith("drizzle-orm/");
}

type Call = { file: string; line: number; callee: string; handedAppPool: boolean };

type Retyped = ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.SatisfiesExpression | ts.TypeAssertion;

/** `(x)`, `x as T`, `x!`, `x satisfies T`, `<T>x`: the same value, or the same assignment target, retyped. */
function isRetyped(node: ts.Node): node is Retyped {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

/** Strip every retyping, down to the expression underneath. */
function unwrap(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (isRetyped(inner)) inner = inner.expression;
  return inner;
}

/** `createAppPool(…)`, or the same pool through its promise API: `createAppPool(…).promise()`. */
function isAppPoolCall(expression: ts.Expression): boolean {
  const inner = unwrap(expression);
  if (!ts.isCallExpression(inner)) return false;
  const callee = inner.expression;
  if (ts.isIdentifier(callee)) return callee.text === "createAppPool";
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "promise" &&
    inner.arguments.length === 0 &&
    isAppPoolCall(callee.expression)
  );
}

const isAssignment = (kind: ts.SyntaxKind) => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
/** Assignments whose new value can be the right-hand side; `+=` and the like compute one instead. */
const ASSIGNS_RIGHT = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Every value each name is bound to anywhere in the file, by name. `null` is a
 * value this file does not show: a parameter, an import, a destructured or loop
 * variable, a computed assignment, a change in place. A target is read through
 * any retyping, so `(pool as Pool) = other` and `pool! = other` write pool. A
 * name counts as an app pool only if every one of its values is an app-pool
 * call, and a name with no value seen is refused.
 */
function bindingsOf(source: ts.SourceFile): Map<string, Array<ts.Expression | null>> {
  const bindings = new Map<string, Array<ts.Expression | null>>();
  const bind = (name: string, value: ts.Expression | null) => bindings.set(name, [...(bindings.get(name) ?? []), value]);
  const bindUnseen = (target: ts.Node): void => {
    if (ts.isIdentifier(target)) bind(target.text, null);
    else if (ts.isBindingElement(target)) bindUnseen(target.name);
    else if (ts.isObjectBindingPattern(target) || ts.isArrayBindingPattern(target)) target.elements.forEach(bindUnseen);
    else if (ts.isArrayLiteralExpression(target)) target.elements.forEach(bindUnseen);
    else if (ts.isObjectLiteralExpression(target)) target.properties.forEach(bindUnseen);
    else if (ts.isShorthandPropertyAssignment(target)) bind(target.name.text, null);
    else if (ts.isPropertyAssignment(target)) bindUnseen(target.initializer);
    else if (ts.isSpreadElement(target) || ts.isSpreadAssignment(target) || isRetyped(target)) bindUnseen(target.expression);
    // A default inside a destructuring target: `[pool = fallback] = …`.
    else if (ts.isBinaryExpression(target)) bindUnseen(target.left);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const unseen = ts.isCatchClause(node.parent) || ts.isForOfStatement(node.parent.parent) || ts.isForInStatement(node.parent.parent);
      if (!ts.isIdentifier(node.name)) bindUnseen(node.name);
      else if (node.initializer) bind(node.name.text, node.initializer);
      else if (unseen) bind(node.name.text, null);
    } else if (
      ts.isParameter(node) ||
      ts.isImportClause(node) ||
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      if (node.name) bindUnseen(node.name);
    } else if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      bindUnseen(node.initializer);
    } else if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
      // A retyped target is the same variable: `(pool as Pool) = other` writes pool (Greptile, #223).
      const target = unwrap(node.left);
      if (ts.isIdentifier(target)) bind(target.text, ASSIGNS_RIGHT.has(node.operatorToken.kind) ? node.right : null);
      else bindUnseen(target);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      bindUnseen(node.operand);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

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

  // Read only when the file calls drizzle: most files never do.
  let bindings: Map<string, Array<ts.Expression | null>> | undefined;
  const isAppPool = (argument: ts.Expression | undefined): boolean => {
    if (!argument) return false;
    if (isAppPoolCall(argument)) return true;
    const inner = unwrap(argument);
    if (!ts.isIdentifier(inner)) return false;
    bindings ??= bindingsOf(source);
    const values = bindings.get(inner.text) ?? [];
    return values.length > 0 && values.every(value => value !== null && isAppPoolCall(value));
  };

  const found: Call[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = guardedNameOf(node.expression);
      if (callee) {
        found.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          callee,
          handedAppPool: callee === "drizzle" && isAppPool(node.arguments[0]),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every TypeScript file under the server: its tests, specs and testkits included. */
function serverSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : serverSources(full);
    return /\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** The two rules, over any set of calls. */
function openedDirectly(calls: Call[]): string[] {
  return calls.filter(call => OPENERS.has(call.callee) && !(call.file in DIRECT_OPENERS)).map(where);
}
function drizzleWithoutAppPool(calls: Call[]): string[] {
  return calls
    .filter(call => call.callee === "drizzle" && !call.handedAppPool && !(call.file in DRIZZLE_WITHOUT_APP_POOL))
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

describe("when drizzle is handed a variable rather than the call", () => {
  it.each<[string, string]>([
    ["a constant", "const pool = createAppPool(url);\ndrizzle(pool);"],
    ["a test's pool, assigned before its suite runs", "let pool: Pool;\nbeforeAll(() => {\n  pool = createAppPool(url!).promise();\n  db = drizzle(pool);\n});"],
    ["the promise API of the call", "drizzle(createAppPool(url).promise());"],
    ["a variable assigned the call through a retyping", "let pool: Pool;\n(pool as unknown) = createAppPool(url);\ndrizzle(pool);"],
  ])("should accept %s that only ever holds an app pool", (_label, code) => {
    expect(drizzleWithoutAppPool(scan("fixture.ts", code))).toEqual([]);
  });

  it.each<[string, string]>([
    ["is reassigned", "let pool = createAppPool(url);\npool = other;\ndrizzle(pool);"],
    ["is also a parameter's name", "const pool = createAppPool(url);\nfunction wrap(pool: Pool) {\n  return drizzle(pool);\n}"],
    ["is imported", 'import { pool } from "./elsewhere";\ndrizzle(pool);'],
    ["is destructured", "const { pool } = holder;\ndrizzle(pool);"],
    ["is a loop variable", "const pool = createAppPool(url);\nfor (const pool of pools) drizzle(pool);"],
    ["is assigned through a destructuring", "let pool = createAppPool(url);\n[pool] = others;\ndrizzle(pool);"],
    // Greptile, #223: a retyped target is still the same variable.
    ["is overwritten through `as`", "let pool = createAppPool(url);\n(pool as Pool) = other;\ndrizzle(pool);"],
    ["is overwritten through `!`", "let pool = createAppPool(url);\npool! = other;\ndrizzle(pool);"],
    ["is overwritten through `<T>`", "let pool = createAppPool(url);\n(<Pool>pool) = other;\ndrizzle(pool);"],
    ["is overwritten inside a retyped destructuring", "let pool = createAppPool(url);\n[(pool as Pool)] = others;\ndrizzle(pool);"],
    ["is changed in place", "let pool = createAppPool(url);\npool++;\ndrizzle(pool);"],
    ["is also a function expression's own name", "const pool = createAppPool(url);\nconst wrap = function pool() {\n  return drizzle(pool);\n};"],
    ["is never assigned here", "let pool: Pool;\ndrizzle(pool);"],
  ])("should refuse a name that %s", (_label, code) => {
    expect(drizzleWithoutAppPool(scan("fixture.ts", code))).toHaveLength(1);
  });
});

const all = serverSources(SERVER).flatMap(file =>
  scan(path.relative(SERVER, file).replace(/\\/g, "/"), fs.readFileSync(file, "utf8"))
);

describe("when the server or its tests open a database connection", () => {
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
    expect(all.some(call => call.file === "db.ts" && call.callee === "drizzle" && call.handedAppPool)).toBe(true);
    // ...and the tests: a database test's pool, accepted because createAppPool built it.
    expect(all.some(call => call.file.endsWith(".db.test.ts") && call.callee === "drizzle" && call.handedAppPool)).toBe(true);
  });

  it("should keep no exemption a file has stopped using", () => {
    // An allowance that outlives its reason is a hole left open for the next change.
    for (const file of Object.keys(DIRECT_OPENERS)) {
      expect(all.some(call => call.file === file && OPENERS.has(call.callee)), file).toBe(true);
    }
    for (const file of Object.keys(DRIZZLE_WITHOUT_APP_POOL)) {
      expect(all.some(call => call.file === file && call.callee === "drizzle" && !call.handedAppPool), file).toBe(true);
    }
  });
});
