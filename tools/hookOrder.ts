/**
 * Finds hooks called after a conditional return — the tRPC-shaped ones that
 * `react-hooks/rules-of-hooks` cannot see.
 *
 * The ESLint rule is the primary gate and stays. But it identifies a hook by
 * shape, not by name: a member expression only counts when its object is a
 * PascalCase identifier, as in `React.useState`. `trpc.dashboard.stats
 * .useQuery()` is a nested member expression rooted at a lowercase identifier,
 * so the rule does not treat it as a hook at all.
 *
 * That is most of the hooks in this codebase. Verified, not assumed: fed the
 * pre-fix AuditorDashboard — whose violating calls were both tRPC queries — the
 * rule reported nothing, while the same run flagged the plain `useState` calls
 * in ComplianceAssessmentResult. One real production defect from each half of
 * that split, in the same week.
 *
 * ── Why this parses instead of reading lines ──────────────────────────────
 *
 * The first version was a line-based heuristic, and review found two defects in
 * it, both of the same kind: it was reasoning about structure it could not see.
 *
 *   1. It asked whether the word `return` appeared within seven lines of a
 *      guard. A guard that merely called something, followed by
 *      `items.map((i) => { return i.name; })`, looked like an early return —
 *      and the next legitimate hook was reported. The worst case flagged
 *      `useCallback` for the `return` inside the callback it declares.
 *   2. Fixing that widened its reach and exposed the same problem one level up:
 *      `export function Foo()` was not recognised as a declaration, so a
 *      helper's early return leaked into the component below it.
 *
 * Both are questions about ownership — which function does this return belong
 * to, which function does this hook belong to — and a line scanner cannot
 * answer them. This walks the real tree instead, so ownership is not inferred.
 * Nested functions are never crossed, which makes both defects unrepresentable
 * rather than merely fixed.
 *
 * The parser is already a dependency here: it is what lets ESLint read TSX.
 */
import { parse } from "@typescript-eslint/parser";

export type HookOrderFinding = {
  /** 1-indexed line of the conditional return that precedes the hook. */
  returnLine: number;
  /** 1-indexed line of the offending hook call. */
  hookLine: number;
  hook: string;
};

type Loc = { start: { line: number } };
type Node = { type: string; loc?: Loc } & Record<string, unknown>;

/** Every node type that opens a new scope for hooks and for returns alike. */
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/**
 * Depth-first walk. `visitor` returns true to stop descending into that node —
 * which is how every caller below refuses to cross a function boundary.
 */
function visit(value: unknown, visitor: (node: Node) => boolean | void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, visitor);
    return;
  }
  if (!isNode(value)) return;
  if (visitor(value) === true) return;
  for (const key of Object.keys(value)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    visit(value[key], visitor);
  }
}

/** The hook name a call expression invokes, at any member depth, or null. */
function hookNameOf(node: Node): string | null {
  if (node.type !== "CallExpression") return null;
  const callee = node.callee;
  if (!isNode(callee)) return null;

  let name: unknown = null;
  if (callee.type === "Identifier") {
    name = callee.name;
  } else if (callee.type === "MemberExpression" && callee.computed !== true) {
    // The LAST property is the name — `trpc.dashboard.stats.useQuery` is
    // `useQuery`, however deep the chain. Declining to walk that chain is
    // precisely what makes the ESLint rule blind to it.
    const property = callee.property;
    if (isNode(property) && property.type === "Identifier") name = property.name;
  }
  return typeof name === "string" && /^use[A-Z]/.test(name) ? name : null;
}

/**
 * Does this statement return, in the function that OWNS it?
 *
 * Stops at any function node, including the statement itself — a nested
 * helper's returns are its own business, which is the leak that condemned
 * SettlementFileImport.
 */
function returnsFromOwner(statement: Node): boolean {
  let found = false;
  visit(statement, (node) => {
    if (found) return true;
    if (FUNCTIONS.has(node.type)) return true;
    if (node.type === "ReturnStatement") {
      found = true;
      return true;
    }
  });
  return found;
}

/** The first hook call belonging to this statement, not to a callback in it. */
function hookCallIn(statement: Node): Node | null {
  let hit: Node | null = null;
  visit(statement, (node) => {
    if (hit) return true;
    if (FUNCTIONS.has(node.type)) return true;
    if (hookNameOf(node)) {
      hit = node;
      return true;
    }
  });
  return hit;
}

function lineOf(node: Node): number {
  return node.loc?.start.line ?? 0;
}

/**
 * Every function in the source, including nested ones.
 *
 * The rule applies per function body, so components and custom hooks are both
 * covered without having to guess which is which — a function that calls no
 * hooks simply yields no findings.
 */
function functionsIn(ast: unknown): Node[] {
  const out: Node[] = [];
  visit(ast, (node) => {
    if (FUNCTIONS.has(node.type)) out.push(node);
  });
  return out;
}

export function hooksCalledAfterConditionalReturn(source: string): HookOrderFinding[] {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: { jsx: true },
    loc: true,
  }) as unknown;

  const lines = source.split(/\r?\n/);
  const findings: HookOrderFinding[] = [];

  for (const fn of functionsIn(ast)) {
    const body = fn.body;
    if (!isNode(body) || body.type !== "BlockStatement" || !Array.isArray(body.body)) continue;

    let returnLine: number | null = null;
    for (const statement of body.body) {
      if (!isNode(statement)) continue;

      if (returnLine !== null) {
        const hook = hookCallIn(statement);
        if (hook) {
          findings.push({
            returnLine,
            hookLine: lineOf(hook),
            hook: (lines[lineOf(hook) - 1] ?? "").trim(),
          });
          break; // one finding per function is enough to fail the build
        }
      }

      // An unconditional return ends the function; whatever follows is dead
      // code and cannot affect how many hooks a render calls.
      if (statement.type === "ReturnStatement") break;

      if (returnLine === null && returnsFromOwner(statement)) returnLine = lineOf(statement);
    }
  }

  return findings;
}
