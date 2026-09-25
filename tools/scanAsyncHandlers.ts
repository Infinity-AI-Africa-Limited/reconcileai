/**
 * Find Express route handlers whose promise can reject out of the handler.
 *
 * Express 4 does not catch a rejected async handler: the rejection escapes to
 * the process, and Node 22's default (`--unhandled-rejections=throw`) exits.
 * Railway restarts (ON_FAILURE, ≤10 retries), and a caller that retries — a
 * SHOPLINE/Shopify webhook, a scheduler — turns that into a crash loop.
 *
 * A regex cannot answer this: it cannot tell an `await` inside a `try` from one
 * outside it, or see that a handler's body is a block with an early return. So
 * this walks the TypeScript AST and reports, per handler, every `await` (and
 * every returned promise) that is NOT inside a `try` with a `catch`.
 *
 * It reports EXPOSURE, not bugs. Whether an exposed call can actually reject is
 * a question about that callee, answered by reading it.
 *
 * Usage: node --import tsx tools/scanAsyncHandlers.ts [globs...]
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

export interface Exposure {
  file: string;
  route: string;
  line: number;
  expression: string;
  kind: "await" | "returned-promise";
  /** Is the handler wrapped in `asyncHandler(...)`, so a rejection is caught? */
  wrapped: boolean;
}

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use"]);

/** `app.get("/x", handler)` / `router.post("/x", a, handler)` → the route string. */
function routeNameOf(call: ts.CallExpression): string | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  if (!ROUTE_METHODS.has(call.expression.name.text)) return null;
  const first = call.arguments[0];
  if (first && ts.isStringLiteralLike(first)) return `${call.expression.name.text.toUpperCase()} ${first.text}`;
  return `${call.expression.name.text.toUpperCase()} <dynamic>`;
}

/** Is this node inside a try block that has a catch clause, up to `stop`? */
function isGuarded(node: ts.Node, stop: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n && n !== stop; n = n.parent) {
    if (ts.isTryStatement(n) && n.catchClause) {
      // Only the try BLOCK is guarded — a throw in the catch or finally is not.
      if (n.tryBlock.pos <= node.pos && node.end <= n.tryBlock.end) return true;
    }
  }
  return false;
}

export function scanFile(file: string, source?: string): Exposure[] {
  const text = source ?? readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const out: Exposure[] = [];

  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const snippet = (n: ts.Node) => n.getText(sf).replace(/\s+/g, " ").slice(0, 110);

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const route = routeNameOf(node);
      if (route) {
        for (const rawArg of node.arguments) {
          // `asyncHandler(async (req, res) => …)` — unwrap, and remember it.
          const wrapped =
            ts.isCallExpression(rawArg) &&
            ts.isIdentifier(rawArg.expression) &&
            rawArg.expression.text === "asyncHandler";
          const arg = wrapped ? (rawArg as ts.CallExpression).arguments[0] : rawArg;
          if (!arg) continue;

          const isHandler =
            (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) &&
            arg.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
          if (!isHandler) continue;
          const handler = arg as ts.ArrowFunction | ts.FunctionExpression;

          const walk = (n: ts.Node) => {
            // Don't descend into nested functions: their rejections are their own.
            if (n !== handler && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))) return;
            if (ts.isAwaitExpression(n) && !isGuarded(n, handler)) {
              out.push({ file, route, line: lineOf(n), expression: snippet(n), kind: "await", wrapped });
            }
            // `return somePromise()` — rejects the handler's promise just the same.
            if (ts.isReturnStatement(n) && n.expression && !isGuarded(n, handler)) {
              const e = n.expression;
              if (ts.isCallExpression(e) && /^(handle|run|process|sync)/i.test(e.getText(sf).split("(")[0].split(".").pop() ?? "")) {
                out.push({ file, route, line: lineOf(n), expression: snippet(n), kind: "returned-promise", wrapped });
              }
            }
            n.forEachChild(walk);
          };
          handler.body && walk(handler.body);
        }
      }
    }
    node.forEachChild(visit);
  }
  visit(sf);
  return out;
}

if (process.argv[1]?.includes("scanAsyncHandlers")) {
  const files = process.argv.slice(2);
  const all = files.flatMap(f => scanFile(f));
  const byRoute = new Map<string, Exposure[]>();
  for (const e of all) {
    const key = `${e.file}  ${e.route}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), e]);
  }
  for (const [key, es] of byRoute) {
    console.log(`\n${key}`);
    for (const e of es) console.log(`  L${e.line} ${e.wrapped ? "[wrapped]" : "[UNWRAPPED]"} [${e.kind}] ${e.expression}`);
  }
  console.log(`\n${byRoute.size} handler(s) with unguarded async work, across ${files.length} file(s).`);
}
