/**
 * Find Express route handlers whose promise can reject out of the handler.
 *
 * Express 4 does not catch a rejected async handler: the rejection escapes to
 * the process, and Node 22's default (`--unhandled-rejections=throw`) exits.
 * Railway restarts (ON_FAILURE, ≤10 retries), and a caller that retries — a
 * SHOPLINE/Shopify webhook, a scheduler — turns that into a crash loop.
 *
 * A regex cannot answer this: it cannot tell an `await` inside a `try` from one
 * outside it. So this walks the TypeScript AST and reports, per handler:
 *
 *   await             an `await` outside a `try` that has a `catch`.
 *   returned-promise  a returned value that may be a promise. A `try` never
 *                     guards these: `return p` inside a `try` hands `p` back
 *                     unawaited, so it rejects after the try has exited. Only
 *                     `return await p` is caught. Decided by what the callee
 *                     IS (async, or returns something that may be a promise),
 *                     never by its name; a callee it cannot follow counts.
 *   opaque            a handler it cannot see into — a parameter, a package it
 *                     does not know. Reported, never assumed safe.
 *
 * Handlers are followed wherever they are defined: inline, a named `const` or
 * `function`, a static or `await import()` from another file, or the return
 * value of a factory. The scan enumerates what is provably safe and reports the
 * rest, rather than the other way round.
 *
 * Not decided here, by syntax or at all:
 *   - a SYNCHRONOUS throw inside an async handler outside a try (it rejects the
 *     handler just the same). A property read on `undefined` throws too, and on
 *     today's code every candidate call is a builtin or a pure helper.
 *   - a FIRE-AND-FORGET promise — a call neither awaited nor returned. Its
 *     rejection is unhandled too, and neither a try nor asyncHandler catches
 *     it; only its own `.catch` does. Telling a promise from a value for an
 *     unknown callee needs types. Every one in the route files today ends in
 *     `.catch(…)` or is an async IIFE whose body is a try.
 * A handler doing either should be wrapped, or given its `.catch`, on
 * judgement — not because this scan said so.
 *
 * It reports EXPOSURE, not bugs: whether an exposed call can actually reject is
 * a question about that callee. `asyncHandler(...)` makes the question moot.
 *
 * Usage: node --import tsx tools/scanAsyncHandlers.ts [files...]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export type ExposureKind = "await" | "returned-promise" | "opaque";

export interface Exposure {
  file: string;
  route: string;
  line: number;
  expression: string;
  kind: ExposureKind;
  /** Is the handler wrapped in `asyncHandler(...)`, so a rejection is caught? */
  wrapped: boolean;
}

export interface ScanOptions {
  /** Read another file, for following an import. Defaults to the filesystem. */
  read?: (file: string) => string | undefined;
  /** Called for every handler the scan resolved and analysed — proof it looked. */
  onHandler?: (h: { route: string; name: string; file: string; wrapped: boolean }) => void;
}

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use"]);

/**
 * Packages whose middleware is known not to hand Express a rejecting promise.
 * Each entry carries a reason a reader can check; any other package is opaque.
 */
const SAFE_MODULES: Record<string, string> = {
  express: "json/urlencoded/static/Router are synchronous middleware — there is no promise to reject",
  "@trpc/server/adapters/express":
    "createExpressMiddleware runs each request in run(async …).catch(internal_exceptionHandler(…)) and answers its own errors",
  vite: "the dev server's Connect middleware stack: synchronous, and never registered in production",
};

const MAX_DEPTH = 8;

type FnLike = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
interface Ctx {
  file: string;
  sf: ts.SourceFile;
}
type Target =
  | { kind: "fn"; fn: FnLike; ctx: Ctx; wrapped?: boolean }
  | { kind: "safe" }
  | { kind: "opaque"; text: string; node: ts.Node; ctx: Ctx; wrapped?: boolean };

/** A route path — `"/x"`, a template, a regex — rather than a handler. */
function isPathLike(e: ts.Expression): boolean {
  return ts.isStringLiteralLike(e) || ts.isTemplateExpression(e) || ts.isRegularExpressionLiteral(e);
}

/** `"/x"` → `/x`; `["/a", "/b"]` → `/a,/b`; anything else is middleware. */
function pathLabel(first: ts.Expression | undefined): string {
  if (first && ts.isStringLiteralLike(first)) return first.text;
  if (first && ts.isArrayLiteralExpression(first) && first.elements.length > 0 && first.elements.every(ts.isStringLiteralLike)) {
    return first.elements.map(el => (el as ts.StringLiteralLike).text).join(",");
  }
  return "<middleware>";
}

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function isFunctionLike(n: ts.Node): n is FnLike {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}

function isAsync(fn: FnLike): boolean {
  return !!fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function handlerName(fn: FnLike): string {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return "<anonymous>";
}

/** The identifier a call/property chain hangs off: `res.status(1).json()` → `res`. */
function rootIdentifier(e: ts.Expression): ts.Identifier | undefined {
  e = unwrap(e);
  for (;;) {
    if (ts.isIdentifier(e)) return e;
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e) || ts.isAwaitExpression(e)) {
      e = unwrap(e.expression);
    } else {
      return undefined;
    }
  }
}

/** Is this node inside the BLOCK of a try that has a catch, without leaving `stop`? */
function isGuarded(node: ts.Node, stop: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n && n !== stop; n = n.parent) {
    if (ts.isTryStatement(n) && n.catchClause && n.tryBlock.pos <= node.pos && node.end <= n.tryBlock.end) return true;
  }
  return false;
}

/** `await import("x")` / `import("x")` → "x". */
function dynamicImportSpecifier(e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined;
  let x = unwrap(e);
  if (ts.isAwaitExpression(x)) x = unwrap(x.expression);
  if (ts.isCallExpression(x) && x.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = x.arguments[0];
    if (arg && ts.isStringLiteralLike(arg)) return arg.text;
  }
  return undefined;
}

/** For a name bound by a static or dynamic import: the module, and the name it exports there. */
function importOf(binding: ts.Node): { module: string; exported: string } | undefined {
  if (ts.isBindingElement(binding)) {
    // const { a, b: c } = await import("./x")
    const decl = binding.parent.parent;
    const module = ts.isVariableDeclaration(decl) ? dynamicImportSpecifier(decl.initializer) : undefined;
    if (!module) return undefined;
    const exported = binding.propertyName && ts.isIdentifier(binding.propertyName) ? binding.propertyName.text : ts.isIdentifier(binding.name) ? binding.name.text : undefined;
    return exported ? { module, exported } : undefined;
  }
  let decl: ts.Node | undefined = binding;
  while (decl && !ts.isImportDeclaration(decl)) decl = decl.parent;
  if (!decl || !ts.isStringLiteral(decl.moduleSpecifier)) return undefined;
  const module = decl.moduleSpecifier.text;
  if (ts.isImportSpecifier(binding)) return { module, exported: (binding.propertyName ?? binding.name).text };
  if (ts.isImportClause(binding)) return { module, exported: "default" };
  return { module, exported: "*" };
}

export function createScanner(opts: ScanOptions = {}) {
  const read = opts.read ?? ((file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined));
  const cache = new Map<string, Ctx | null>();

  function load(file: string, source?: string): Ctx | null {
    if (source !== undefined) cache.set(file, { file, sf: ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true) });
    if (!cache.has(file)) {
      const text = read(file);
      cache.set(file, text === undefined ? null : { file, sf: ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true) });
    }
    return cache.get(file) ?? null;
  }

  /** A relative import → the file it names; undefined for a package or a miss. */
  function loadModule(spec: string, from: Ctx): Ctx | null {
    if (!spec.startsWith(".")) return null;
    const base = path.resolve(path.dirname(from.file), spec.replace(/\.(js|ts)$/, ""));
    return load(`${base}.ts`) ?? load(path.join(base, "index.ts"));
  }

  /** The declaration `name` refers to at `usage`, searching enclosing scopes outward. */
  function findBinding(name: string, usage: ts.Node): ts.Node | undefined {
    for (let n: ts.Node | undefined = usage.parent; n; n = n.parent) {
      if (isFunctionLike(n)) {
        for (const p of n.parameters) if (ts.isIdentifier(p.name) && p.name.text === name) return p;
      }
      const statements = ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) ? n.statements : undefined;
      if (!statements) continue;
      for (const s of statements) {
        if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name) return d;
            if (ts.isObjectBindingPattern(d.name)) {
              for (const el of d.name.elements) if (ts.isIdentifier(el.name) && el.name.text === name) return el;
            }
          }
        }
        if (ts.isImportDeclaration(s) && s.importClause) {
          const c = s.importClause;
          if (c.name?.text === name) return c;
          const b = c.namedBindings;
          if (b && ts.isNamespaceImport(b) && b.name.text === name) return b;
          if (b && ts.isNamedImports(b)) for (const el of b.elements) if (el.name.text === name) return el;
        }
      }
    }
    return undefined;
  }

  function findExport(name: string, ctx: Ctx): ts.Node | undefined {
    for (const s of ctx.sf.statements) {
      if (!ts.canHaveModifiers(s) || !ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d;
      }
    }
    return undefined;
  }

  /** Follow an import to the declaration it names in the other file. */
  function followImport(binding: ts.Node, ctx: Ctx): { decl: ts.Node; ctx: Ctx } | undefined {
    const imp = importOf(binding);
    const target = imp ? loadModule(imp.module, ctx) : null;
    const decl = target && imp ? findExport(imp.exported, target) : undefined;
    return target && decl ? { decl, ctx: target } : undefined;
  }

  /** The package a chain's root ultimately comes from, following `const x = await f()` and local imports. */
  function originModule(e: ts.Expression, ctx: Ctx, depth = 0): string | undefined {
    const root = rootIdentifier(e);
    if (!root || depth > MAX_DEPTH) return undefined;
    const binding = findBinding(root.text, root);
    if (!binding) return undefined;
    if (ts.isVariableDeclaration(binding) && binding.initializer) return originModule(binding.initializer, ctx, depth + 1);
    const imp = importOf(binding);
    if (!imp) return undefined;
    if (!imp.module.startsWith(".")) return imp.module;
    const followed = followImport(binding, ctx);
    return followed && ts.isVariableDeclaration(followed.decl) && followed.decl.initializer
      ? originModule(followed.decl.initializer, followed.ctx, depth + 1)
      : imp.module;
  }

  function isSafeOrigin(e: ts.Expression, ctx: Ctx): boolean {
    const mod = originModule(e, ctx);
    return mod !== undefined && mod in SAFE_MODULES;
  }

  /** What a route argument — or a factory's return value — actually is. */
  function resolve(expr: ts.Expression, ctx: Ctx, depth: number): Target[] {
    const e = unwrap(expr);
    const opaque = (): Target[] => [{ kind: "opaque", text: e.getText(ctx.sf).replace(/\s+/g, " ").slice(0, 80), node: e, ctx }];
    if (depth > MAX_DEPTH) return opaque();
    if (isPathLike(e)) return [];
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return [{ kind: "fn", fn: e, ctx }];
    if (ts.isIdentifier(e)) return resolveIdentifier(e, ctx, depth);
    // Express flattens arrays of handlers, spread or not, at any depth.
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap(el => resolve(el, ctx, depth + 1));
    if (ts.isSpreadElement(e)) return resolve(e.expression, ctx, depth + 1);
    if (ts.isConditionalExpression(e)) return [...resolve(e.whenTrue, ctx, depth + 1), ...resolve(e.whenFalse, ctx, depth + 1)];
    if (isAsyncHandlerCall(e)) {
      const inner = e.arguments[0];
      return inner ? resolve(inner, ctx, depth + 1).map(t => (t.kind === "safe" ? t : { ...t, wrapped: true })) : [];
    }
    if ((ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) && isSafeOrigin(ts.isCallExpression(e) ? e.expression : e, ctx)) {
      return [{ kind: "safe" }];
    }
    if (ts.isCallExpression(e)) {
      // A factory: the handler is whatever it returns.
      const out: Target[] = [];
      for (const t of resolve(e.expression, ctx, depth + 1)) {
        if (t.kind !== "fn") {
          out.push(t.kind === "safe" ? t : opaque()[0]);
          continue;
        }
        const returned = returnedExpressions(t.fn);
        if (returned.length === 0) out.push(opaque()[0]);
        for (const r of returned) out.push(...resolve(r, t.ctx, depth + 1));
      }
      return out;
    }
    return opaque();
  }

  function resolveIdentifier(id: ts.Identifier, ctx: Ctx, depth: number): Target[] {
    const opaque: Target[] = [{ kind: "opaque", text: id.text, node: id, ctx }];
    const binding = findBinding(id.text, id);
    if (!binding) return opaque;
    if (ts.isFunctionDeclaration(binding)) return [{ kind: "fn", fn: binding, ctx }];
    if (ts.isVariableDeclaration(binding)) return binding.initializer ? resolve(binding.initializer, ctx, depth + 1) : opaque;
    const imp = importOf(binding);
    if (!imp) return opaque; // a parameter, or something we cannot follow
    if (imp.module in SAFE_MODULES) return [{ kind: "safe" }];
    const followed = followImport(binding, ctx);
    if (!followed) return opaque;
    if (ts.isFunctionDeclaration(followed.decl)) return [{ kind: "fn", fn: followed.decl, ctx: followed.ctx }];
    if (ts.isVariableDeclaration(followed.decl) && followed.decl.initializer) {
      return resolve(followed.decl.initializer, followed.ctx, depth + 1);
    }
    return opaque;
  }

  /** What a function returns — its expression body, or its `return`s (not nested functions'). */
  function returnedExpressions(fn: FnLike): ts.Expression[] {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out: ts.Expression[] = [];
    const walk = (n: ts.Node) => {
      if (isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      n.forEachChild(walk);
    };
    fn.body.forEachChild(walk);
    return out;
  }

  /**
   * Does this call answer the request — `res.status(…).json(…)`, `next(err)`?
   * True when the chain hangs off the handler's own `res`/`next` parameter, or
   * off any parameter typed with a type imported from "express" (a helper such
   * as `sendError(res: Response, …)`).
   */
  function isResponseCall(call: ts.CallExpression, handler: FnLike): boolean {
    const root = rootIdentifier(call.expression);
    const binding = root ? findBinding(root.text, root) : undefined;
    if (!binding || !ts.isParameter(binding)) return false;
    if (binding.parent === handler && handler.parameters.indexOf(binding) >= 1) return true;
    return isExpressTyped(binding);
  }

  function isExpressTyped(param: ts.ParameterDeclaration): boolean {
    const type = param.type;
    if (!type || !ts.isTypeReferenceNode(type)) return false;
    const tn = type.typeName;
    const root = ts.isIdentifier(tn) ? tn : ts.isIdentifier(tn.left) ? tn.left : undefined;
    const binding = root ? findBinding(root.text, root) : undefined;
    return !!binding && importOf(binding)?.module === "express";
  }

  /** Could evaluating `expr` produce a promise? Anything it cannot follow counts as yes. */
  function mayBePromise(expr: ts.Expression, ctx: Ctx, fn: FnLike, depth: number): boolean {
    const e = unwrap(expr);
    if (depth > MAX_DEPTH) return true;
    if (ts.isAwaitExpression(e)) return false; // reported as an await, guarded or not
    if (ts.isConditionalExpression(e)) {
      return mayBePromise(e.whenTrue, ctx, fn, depth + 1) || mayBePromise(e.whenFalse, ctx, fn, depth + 1);
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (k === ts.SyntaxKind.CommaToken) return mayBePromise(e.right, ctx, fn, depth + 1);
      if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.AmpersandAmpersandToken) {
        return mayBePromise(e.left, ctx, fn, depth + 1) || mayBePromise(e.right, ctx, fn, depth + 1);
      }
      return false;
    }
    if (ts.isNewExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text === "Promise";
    if (ts.isIdentifier(e)) {
      const binding = findBinding(e.text, e);
      return !!binding && ts.isVariableDeclaration(binding) && !!binding.initializer && mayBePromise(binding.initializer, ctx, fn, depth + 1);
    }
    if (ts.isCallExpression(e)) {
      if (isResponseCall(e, fn) || isSafeOrigin(e.expression, ctx)) return false;
      return resolve(e.expression, ctx, depth + 1).some(t => {
        if (t.kind === "safe") return false;
        if (t.kind === "opaque") return true;
        return isAsync(t.fn) || returnedExpressions(t.fn).some(r => mayBePromise(r, t.ctx, t.fn, depth + 1));
      });
    }
    return false; // literals, templates, object/array literals, `void x`
  }

  function analyze(fn: FnLike, ctx: Ctx, route: string, wrapped: boolean, out: Exposure[]) {
    const push = (n: ts.Node, kind: ExposureKind) =>
      out.push({
        file: ctx.file,
        route,
        line: ctx.sf.getLineAndCharacterOfPosition(n.getStart(ctx.sf)).line + 1,
        expression: n.getText(ctx.sf).replace(/\s+/g, " ").slice(0, 110),
        kind,
        wrapped,
      });
    for (const r of returnedExpressions(fn)) if (mayBePromise(r, ctx, fn, 0)) push(r, "returned-promise");
    // Walk the body whether it is a block or a concise arrow's expression:
    // `async (req, res) => res.json(await load())` awaits just the same.
    const walk = (n: ts.Node) => {
      if (isFunctionLike(n)) return; // a nested function's rejections are its own
      if (!isGuarded(n, fn)) {
        const awaits =
          ts.isAwaitExpression(n) ||
          (ts.isForOfStatement(n) && !!n.awaitModifier) || // for await (…)
          (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing); // await using
        if (awaits) push(n, "await");
      }
      n.forEachChild(walk);
    };
    if (fn.body) walk(fn.body);
  }

  /** An Express app or router: built by, typed from, or `.route()`d off "express". */
  function isExpressReceiver(receiver: ts.Expression, ctx: Ctx): boolean {
    const e = unwrap(receiver);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "route") {
      return isExpressReceiver(e.expression.expression, ctx); // app.route("/x").get(…)
    }
    if (!ts.isIdentifier(e)) return false;
    const binding = findBinding(e.text, e);
    if (!binding) return false;
    if (ts.isParameter(binding)) return isExpressTyped(binding);
    return originModule(e, ctx) === "express";
  }

  function isAsyncHandlerCall(e: ts.Expression): e is ts.CallExpression {
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return false;
    const binding = findBinding(e.expression.text, e.expression);
    const imp = binding ? importOf(binding) : undefined;
    return !!imp && /(^|\/)asyncHandler$/.test(imp.module) && imp.exported === "asyncHandler";
  }

  /**
   * A route registration. Proven by its receiver where possible; otherwise a
   * verb with a "/path" literal and a handler — so a receiver whose type the
   * scan cannot trace (an alias, a contextual type) is still checked.
   */
  function isRouteCall(node: ts.CallExpression, ctx: Ctx): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
    if (!ts.isPropertyAccessExpression(node.expression) || !ROUTE_METHODS.has(node.expression.name.text)) return false;
    if (isExpressReceiver(node.expression.expression, ctx)) return true;
    const first = node.arguments[0];
    return !!first && ts.isStringLiteralLike(first) && first.text.startsWith("/") && node.arguments.length >= 2;
  }

  function scanFile(file: string, source?: string): Exposure[] {
    const ctx = load(file, source);
    if (!ctx) return [];
    const out: Exposure[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && isRouteCall(node, ctx)) {
        const route = `${node.expression.name.text.toUpperCase()} ${pathLabel(node.arguments[0])}`;
        // Every argument goes through resolve(): paths resolve to nothing, and
        // arrays / spreads / asyncHandler(...) are taken apart there.
        for (const t of node.arguments.flatMap(arg => resolve(arg, ctx, 0))) {
          const wrapped = t.kind !== "safe" && !!t.wrapped;
          if (t.kind === "fn") {
            opts.onHandler?.({ route, name: handlerName(t.fn), file: t.ctx.file, wrapped });
            analyze(t.fn, t.ctx, route, wrapped, out);
          } else if (t.kind === "opaque") {
            const line = t.ctx.sf.getLineAndCharacterOfPosition(t.node.getStart(t.ctx.sf)).line + 1;
            out.push({ file: t.ctx.file, route, line, expression: t.text, kind: "opaque", wrapped });
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(ctx.sf);
    return out;
  }

  return { scanFile };
}

export function scanFile(file: string, source?: string, opts?: ScanOptions): Exposure[] {
  return createScanner(opts).scanFile(file, source);
}

if (process.argv[1]?.includes("scanAsyncHandlers")) {
  const files = process.argv.slice(2);
  const scanner = createScanner();
  const all = files.flatMap(f => scanner.scanFile(path.resolve(f)));
  const byRoute = new Map<string, Exposure[]>();
  for (const e of all) {
    const key = `${e.file}  ${e.route}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), e]);
  }
  for (const [key, es] of byRoute) {
    console.log(`\n${key}`);
    for (const e of es) console.log(`  L${e.line} ${e.wrapped ? "[wrapped]" : "[UNWRAPPED]"} [${e.kind}] ${e.expression}`);
  }
  console.log(`\n${byRoute.size} handler(s) with exposure, across ${files.length} file(s).`);
}
