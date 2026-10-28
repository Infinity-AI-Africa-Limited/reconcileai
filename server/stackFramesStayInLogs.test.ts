/**
 * Stack frames go to the server log, never into a response.
 *
 * The SHOPLINE scheduled handlers returned `frames: stackFrames(err)` in their
 * 500 bodies until 2026-10-28. The scheduler prints those bodies into the
 * Actions log of a PUBLIC repository, so every failed run published bundle
 * paths, line numbers and dependency versions — several times an hour during
 * the database incident that began on 2026-10-26.
 *
 * The rule here is structural, so a new endpoint cannot bring it back: in
 * server code, a `stackFrames(...)` call or a read of an error's `.stack` must
 * sit inside the arguments of a `console.*` call. Read as syntax, not text: a
 * comment or a string does not count, and a frame list built into a variable
 * first counts as outside, because nothing then stops it reaching a response.
 * The scanner is tested on those forms first, then run over the server.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SERVER = __dirname;

/** Files that may handle a stack outside a log call, and why. */
const STACK_HANDLERS: Record<string, string> = {
  "errorText.ts": "Defines stackFrames, which reads error.stack to strip the message from it.",
};

function isConsoleCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "console"
  );
}

/** True when `node` is an argument (at any depth) of a console call, within the same function. */
function insideConsoleCall(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (isConsoleCall(current)) return true;
    if (ts.isFunctionLike(current)) return false;
  }
  return false;
}

/**
 * The key a node reads, when it is written out: `x.key`, `x["key"]`, or a
 * destructuring `{ key }` / `{ key: name }`.
 */
function keyRead(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return key.text;
  }
  return undefined;
}

/**
 * Every local name `stackFrames` goes by in a file: its own, and any it is
 * imported or destructured under (`import { stackFrames as sf }`,
 * `const { stackFrames: sf } = await import(...)`).
 */
function stackFramesNames(source: ts.SourceFile): Set<string> {
  const names = new Set(["stackFrames"]);
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "stackFrames") {
      names.add(node.name.text);
    }
    if (ts.isBindingElement(node) && keyRead(node) === "stackFrames" && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** An identifier that USES one of those names, rather than declaring it or naming a property. */
function usesName(node: ts.Identifier, names: Set<string>): boolean {
  if (!names.has(node.text)) return false;
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) return false;
  if (ts.isBindingElement(parent)) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  // `x.stackFrames` is judged as the whole access, once.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  return true;
}

/** Lines in `text` that build stack frames, or read a stack, outside a console call. */
function stacksOutsideLogs(file: string, text: string): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const names = stackFramesNames(source);
  const lines = new Set<number>();
  const visit = (node: ts.Node) => {
    const key = keyRead(node);
    const handlesStack =
      key === "stack" ||
      // A namespace access, `t.stackFrames` or `t["stackFrames"]`. Destructuring it is an import.
      (key === "stackFrames" && !ts.isBindingElement(node)) ||
      (ts.isIdentifier(node) && usesName(node, names));
    if (handlesStack && !insideConsoleCall(node)) {
      lines.add(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...lines];
}

function serverSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : serverSources(full);
    return /\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) && !entry.name.endsWith(".testkit.ts")
      ? [full]
      : [];
  });
}

describe("when the scanner reads a file", () => {
  it.each([
    ["frames in a response body", "res.status(500).json({ error: 'x', frames: stackFrames(err) });"],
    ["frames kept in a variable", "const frames = stackFrames(err);\nconsole.error('failed', { frames });"],
    ["frames through a namespace", "import * as t from './errorText';\nres.json({ frames: t.stackFrames(err) });"],
    ["a raw stack in a response", "res.json({ stack: (err as Error).stack });"],
    ["a stack read with brackets", "res.json({ stack: err['stack'] });"],
    ["a stack read by destructuring", "const { stack } = err as Error;\nres.json({ stack });"],
    ["a stack destructured under another name", "const { stack: trace } = err as Error;\nres.json({ trace });"],
    [
      "frames through a renamed import",
      "import { stackFrames as frames } from './errorText';\nres.json({ f: frames(err) });",
    ],
    [
      "frames through a renamed dynamic import",
      "const { stackFrames: sf } = await import('./errorText');\nres.json({ f: sf(err) });",
    ],
    ["frames passed on as a function", "res.json({ f: errors.map(stackFrames) });"],
    [
      "frames in a callback handed to a log call",
      "console.error('x', () => res.json({ frames: stackFrames(err) }));",
    ],
  ])("should find %s", (_label, text) => {
    expect(stacksOutsideLogs("fixture.ts", text).length).toBeGreaterThan(0);
  });

  it.each([
    ["frames in a log call", "console.error('failed', { ...loggableError(err), frames: stackFrames(err) });"],
    ["frames on a later line of a log call", "console.warn(\n  'failed',\n  {\n    frames: stackFrames(err),\n  },\n);"],
    ["a raw stack in a log call", "console.error(err.stack);"],
    [
      "a renamed import used only in a log call",
      "import { stackFrames as sf } from './errorText';\nconsole.error('x', { frames: sf(err) });",
    ],
    ["an import of it on its own", "import { loggableError } from './dbErrors';\nimport { stackFrames } from './errorText';"],
    ["a mention in a comment or a string", "// stackFrames(err) is not called here\nconst s = 'err.stack';"],
  ])("should allow %s", (_label, text) => {
    expect(stacksOutsideLogs("fixture.ts", text)).toEqual([]);
  });
});

describe("when server code handles an error's stack", () => {
  it("should keep it inside a console call, unless its file is listed with a reason", () => {
    const offenders = serverSources(SERVER).flatMap((full) => {
      const relative = path.relative(SERVER, full).split(path.sep).join("/");
      if (relative in STACK_HANDLERS) return [];
      return stacksOutsideLogs(relative, fs.readFileSync(full, "utf8")).map((line) => `${relative}:${line}`);
    });
    expect(offenders).toEqual([]);
  });

  it("should list only files that exist and still handle a stack outside a log", () => {
    const stale = Object.keys(STACK_HANDLERS).filter((relative) => {
      const full = path.join(SERVER, relative);
      return !fs.existsSync(full) || stacksOutsideLogs(relative, fs.readFileSync(full, "utf8")).length === 0;
    });
    expect(stale).toEqual([]);
  });
});
