/**
 * CI must run on every pull request, whatever it is based on.
 *
 * `on.pull_request.branches` filters on the pull request's BASE branch. While it
 * read `[main]`, a PR opened against any other branch produced no CI run at all —
 * no typecheck, no build, no tests, none of the tenancy ratchets. This repo
 * stacks PRs (#8–#11 were a four-deep stack; #73 was based on #72), and a stacked
 * PR merges into its parent and reaches main inside the parent's merge, so the
 * code lands on production having never been checked.
 *
 * It fails SILENTLY and it looks fine: Greptile is a GitHub App and does not read
 * the workflow file, so a stacked PR carries a green "Greptile Review" tick while
 * the suite never ran. #73 was caught only by counting the checks on the head SHA
 * (1, not 3) rather than reading their conclusions.
 *
 * The cases below are the shapes that defeated the three previous versions of the
 * checker, each of which reported a genuinely restricted workflow as
 * unrestricted. They are kept as a list because the lesson is that the shape you
 * happen to be looking at is never the whole set.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readPullRequestTrigger, restrictsBaseBranches } from "./workflowTriggers";

const WORKFLOW_DIR = path.join(__dirname, "..", ".github", "workflows");
const CI = fs.readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8");

/** Every spelling of "restricted to main" that is valid YAML. */
const RESTRICTED_SHAPES: Record<string, string> = {
  "flow sequence": "on:\n  pull_request:\n    branches: [main]\n",
  "block sequence": "on:\n  pull_request:\n    branches:\n      - main\n",
  "four-space indent": "on:\n    pull_request:\n        branches: [main]\n",
  "one-space indent": "on:\n pull_request:\n  branches: [main]\n",
  "space before the colon": "on:\n  pull_request:\n    branches : [main]\n",
  "flow mapping on the trigger line": "on:\n  pull_request: {branches: [main]}\n",
  "quoted key": 'on:\n  pull_request:\n    "branches": [main]\n',
  "branches-ignore": "on:\n  pull_request:\n    branches-ignore: [docs/*]\n",
  "branches-ignore, block": "on:\n  pull_request:\n    branches-ignore:\n      - docs/*\n",
  "space before the pull_request colon": "on:\n  pull_request :\n    branches: [main]\n",
  // A narrowing glob that happens to CONTAIN `**`. Testing for the substring
  // accepted these and called the workflow unrestricted — the same false
  // negative, reintroduced by the fix for the previous one.
  "a scoped glob": "on:\n  pull_request:\n    branches: ['release/**']\n",
  "a scoped glob, block": "on:\n  pull_request:\n    branches:\n      - 'release/**'\n",
  "a single-level star": "on:\n  pull_request:\n    branches: ['*']\n",
  "branches-ignore with a scoped glob": "on:\n  pull_request:\n    branches-ignore: ['release/**']\n",
  // The worst of them: this excludes EVERY pull request, so the workflow runs on
  // none of them. Reading `**` as "allows everything" inverts its meaning.
  "branches-ignore matching everything": "on:\n  pull_request:\n    branches-ignore: ['**']\n",
  "branches plus an ignore list": "on:\n  pull_request:\n    branches: ['**']\n    branches-ignore: [docs/*]\n",
};

/** Shapes that genuinely place no restriction on the base branch. */
const UNRESTRICTED_SHAPES: Record<string, string> = {
  "match-all glob": "on:\n  pull_request:\n    branches: ['**']\n",
  "match-all, block sequence": "on:\n  pull_request:\n    branches:\n      - '**'\n",
  "match-all, double-quoted": 'on:\n  pull_request:\n    branches: ["**"]\n',
  "match-all beside a narrower pattern": "on:\n  pull_request:\n    branches: ['**', 'release/*']\n",
  "no branches key at all": "on:\n  pull_request:\n    types: [opened]\n",
  "bare trigger": "on:\n  pull_request:\n",
  "a comment mentioning branches": "on:\n  pull_request:\n    # runs for all branches\n    types: [opened]\n",
};

describe("when a workflow restricts which bases trigger it", () => {
  it.each(Object.entries(RESTRICTED_SHAPES))("should catch it written as %s", (_name, yaml) => {
    expect(restrictsBaseBranches(yaml)).toBe(true);
  });
});

describe("when a workflow places no restriction", () => {
  it.each(Object.entries(UNRESTRICTED_SHAPES))("should accept %s", (_name, yaml) => {
    expect(restrictsBaseBranches(yaml)).toBe(false);
  });

  it("should report a workflow with no pull_request trigger as absent", () => {
    expect(readPullRequestTrigger("on:\n  schedule:\n    - cron: '0 3 * * *'\n").kind).toBe("absent");
  });

  it("should not read a LATER top-level key's filter as this trigger's", () => {
    // `push` follows and has its own branches list; attributing it here would
    // report a restriction that does not exist — the same error, mirrored.
    const yaml = "on:\n  pull_request:\n    types: [opened]\n  push:\n    branches: [main]\n";
    expect(restrictsBaseBranches(yaml)).toBe(false);
  });
});

describe("when this repository's CI workflow is read", () => {
  it("should trigger on any base branch, not only main", () => {
    const trigger = readPullRequestTrigger(CI);
    expect(
      trigger.kind,
      trigger.kind === "restricted"
        ? `ci.yml restricts PR bases (${trigger.block}) — PRs based on anything else get NO CI`
        : "",
    ).toBe("unrestricted");
  });

  it("should still run on pushes to main", () => {
    // Widening pull_request must not cost the post-merge run, which is what
    // proves the MERGED result is green rather than just the PR head.
    expect(CI).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  it("should keep the manual dispatch escape hatch", () => {
    // Still needed: GitHub occasionally drops a pull_request event entirely.
    expect(CI).toMatch(/workflow_dispatch:/);
  });
});

describe("when any other workflow is added", () => {
  it("should hold every workflow to the same rule", () => {
    // The trap belongs to the trigger syntax, not to ci.yml. shopline-sync.yml
    // and woodcore-sync.yml are clean today; a new workflow could reintroduce it.
    const workflows = fs.readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
    expect(workflows.length, "no workflows found — is the path right?").toBeGreaterThan(0);

    const restricted = workflows.filter((f) =>
      restrictsBaseBranches(fs.readFileSync(path.join(WORKFLOW_DIR, f), "utf8")),
    );
    expect(
      restricted,
      `workflows whose pull_request trigger skips non-main bases: ${restricted.join(", ")}`,
    ).toEqual([]);
  });
});
