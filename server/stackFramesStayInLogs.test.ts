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

function namesStackFrames(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "stackFrames";
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "stackFrames";
}

/** Lines in `text` that build stack frames, or read a stack, outside a console call. */
function stacksOutsideLogs(file: string, text: string): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    const handlesStack =
      (ts.isCallExpression(node) && namesStackFrames(node)) ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "stack");
    if (handlesStack && !insideConsoleCall(node)) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
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
