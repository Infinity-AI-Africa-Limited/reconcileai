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
 * So this covers the half ESLint structurally cannot. It matches on the NAME
 * `use[A-Z]…` wherever it appears in the call, which is exactly the check the
 * rule declines to make.
 *
 * Deliberately line-based and conservative rather than an AST pass. It only
 * looks at component top level (two-space indent), so a hook inside a nested
 * callback or a nested component cannot trip it. It will miss unusual
 * formatting; it should never cry wolf, because a gate that produces false
 * positives gets switched off.
 */
export type HookOrderFinding = {
  /** 1-indexed line of the conditional return that precedes the hook. */
  returnLine: number;
  /** 1-indexed line of the offending hook call. */
  hookLine: number;
  hook: string;
};

/** A top-level declaration — resets the component we are tracking. */
const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?(?:default\s+)?const\s+\w+\s*[:=]/;
/**
 * A closing brace in column 0 — the end of a top-level declaration.
 *
 * Belt to DECLARATION's braces. Tracking must not survive the function it
 * started in, whatever the next thing is called or how it is written. Without
 * this, a helper's legitimate early return leaked into the component declared
 * after it and condemned that component's first hook.
 */
const END_OF_DECLARATION = /^\}/;
/**
 * A hook call at component top level, by NAME, at any member depth.
 *
 * `^ {2}\S` is load-bearing twice over. Requiring a NON-space third character
 * pins this to exactly two spaces of indent, so a hook inside a nested callback
 * (four or more) cannot match. And matching the name anywhere in the line —
 * rather than only after an assignment character — is what reaches
 * `trpc.a.b.useQuery()`, whose dots are precisely what ESLint's shape check
 * refuses to walk.
 */
const HOOK_CALL = /^ {2}\S.*\buse[A-Z]\w*\s*[(<]/;
/** `if (…)` at component top level. */
const IF_AT_TOP = /^ {2}(?:\}\s*else\s+)?if\s*\(/;
/** A comment line — never a hook call, whatever it mentions. */
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

/**
 * Does the guard starting at `start` actually return?
 *
 * Ownership, not proximity. This used to ask whether the word `return` appeared
 * anywhere in the next seven lines, which is a different question and answers
 * yes far too often: a guard that merely calls something, followed by
 * `items.map((i) => { return i.name; })`, looked like an early return, and the
 * next legitimate top-level hook was reported as an offender. The worst version
 * flagged `const cb = useCallback(() => {` for the `return` inside its own body
 * — a hook rejected because of code it contains. In a blocking gate that fails
 * CI on correct components, which is exactly how a check like this gets turned
 * off.
 *
 * A return counts only when it belongs to this `if`: on the same line, or at the
 * guard body's own indent (four spaces) inside its block. Anything nested deeper
 * belongs to a callback, not to the guard.
 */
function guardReturns(lines: string[], start: number): boolean {
  // `  if (cond) return X;` — body on the same line.
  if (/\breturn\b/.test(lines[start])) return true;

  // `  if (cond)` with a single unbraced statement on the next line.
  if (!/\{\s*$/.test(lines[start])) return /^ {4}return\b/.test(lines[start + 1] ?? "");

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A closing brace at the guard's own indent ends the chain — unless it
    // hands off to `else`, whose branch returning is equally an early return.
    if (/^ {2}\}(?!\s*else)/.test(line)) return false;
    if (/^ {4}return\b/.test(line)) return true;
  }
  return false;
}

export function hooksCalledAfterConditionalReturn(source: string): HookOrderFinding[] {
  const lines = source.split(/\r?\n/);
  const findings: HookOrderFinding[] = [];
  let tracking = false;
  let earlyReturn = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT.test(line)) continue;

    // A new top-level declaration starts a new component to reason about.
    if (DECLARATION.test(line)) {
      tracking = true;
      earlyReturn = -1;
      continue;
    }
    // ...and the end of one stops all reasoning about it.
    if (END_OF_DECLARATION.test(line)) {
      tracking = false;
      earlyReturn = -1;
      continue;
    }
    if (!tracking) continue;

    if (IF_AT_TOP.test(line)) {
      if (earlyReturn < 0 && guardReturns(lines, i)) earlyReturn = i;
      continue;
    }

    if (earlyReturn >= 0 && HOOK_CALL.test(line)) {
      findings.push({
        returnLine: earlyReturn + 1,
        hookLine: i + 1,
        hook: line.trim(),
      });
      earlyReturn = -1; // one finding per component is enough to fail the build
    }
  }

  return findings;
}
