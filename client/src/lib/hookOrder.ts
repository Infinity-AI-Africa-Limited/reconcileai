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
const DECLARATION = /^(export\s+default\s+)?(async\s+)?function\s+\w+|^(export\s+)?const\s+\w+\s*[:=]/;
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
    if (!tracking) continue;

    if (IF_AT_TOP.test(line)) {
      // Does this guard return? Either on the same line, or inside a short
      // block before it closes. Six lines is generous for a guard clause and
      // keeps this from reaching across unrelated code.
      const guard = lines.slice(i, i + 7).join("\n");
      if (/\breturn\b/.test(guard) && earlyReturn < 0) earlyReturn = i;
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
