/**
 * One rule, on purpose: react-hooks/rules-of-hooks.
 *
 * This is not a general lint sweep. There was no ESLint in the repo at all, and
 * turning on a recommended preset across ~150 files would produce hundreds of
 * findings that nobody triages, which is how a blocking check gets switched off
 * again a week later. A gate is only worth having if a red result always means
 * something is actually broken.
 *
 * The rule earns that. Two real defects shipped in the same week, both invisible
 * to `tsc` and to the test suite:
 *
 *   AuditorDashboard          — a segment-based redirect sat between hooks, so
 *                               the render after the segment resolved called
 *                               fewer hooks. React threw instead of redirecting,
 *                               on exactly the cold-load path the redirect
 *                               existed to cover. (d050f90)
 *   ComplianceAssessmentResult— two useState below the loading guard, so the
 *                               render after the fetch called MORE hooks. Every
 *                               visitor with a valid token got the error instead
 *                               of their report, on a public page. (PR #57)
 *
 * Neither is a type error and neither has a unit test that could see it — there
 * is no jsdom or testing-library here, so components are not rendered in CI at
 * all. Static analysis is the only thing standing between this class and
 * production.
 *
 * ⚠️ This rule catches the SECOND of those and is blind to the FIRST. It
 * identifies a hook by shape, not by name: a member expression counts only when
 * its object is a PascalCase identifier, as in `React.useState`. So
 * `trpc.dashboard.stats.useQuery()` — a nested member expression rooted at a
 * lowercase identifier, and the way most hooks are written in this codebase —
 * is not a hook as far as this rule is concerned. Fed the real pre-fix
 * AuditorDashboard, it reported nothing.
 *
 * `tools/hookOrder.ts` covers that half, parsing with this same parser and
 * matching on the hook NAME at any member depth, and its test fails the build
 * the same way. Keep both: this rule is the more rigorous of the two wherever
 * it can see, and the companion reaches where it cannot.
 *
 * `exhaustive-deps` is deliberately OFF. It is advisory, it fires heavily on an
 * existing codebase, and mixing it in would bury the rule that always matters.
 * Turn it on later as a warning if someone wants to work through it.
 *
 * Scope is client/src only: hooks are a React concept and the server has none.
 */
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["client/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    // The codebase already carries `eslint-disable` comments written for a
    // linter that was never actually configured — for exhaustive-deps (off
    // here) and for @typescript-eslint/no-unused-vars. Registering the TS
    // plugin without enabling any of its rules is what makes that second name
    // RESOLVE; an unresolvable name in a disable comment is a hard error, and
    // would fail this gate for a reason that has nothing to do with hooks.
    plugins: { "react-hooks": reactHooks, "@typescript-eslint": tsPlugin },
    linterOptions: {
      // Those stale directives are now no-ops. Reporting them would add noise
      // to a check whose whole value is that red means broken.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "client/src/components/ui/**"],
  },
];
