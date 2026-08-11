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
 * The reason this is worth a test rather than a comment: it fails SILENTLY, and
 * it looks fine. Greptile is a GitHub App and does not read the workflow file, so
 * it reviews and approves as normal — a stacked PR shows a green "Greptile
 * Review" tick and reads as verified while the suite never ran. #73 was caught
 * only by counting the checks on the head SHA (1, not 3) instead of reading their
 * conclusions, which is not a habit worth relying on.
 *
 * The parser is exercised against YAML shapes that are NOT in this repository,
 * because the first version of it recognised only the two-space indent it was
 * written against and silently reported every other shape as unrestricted — the
 * exact blind spot this file exists to close, reproduced inside the check itself.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pullRequestBranchFilter, restrictsBaseBranches } from "./workflowTriggers";

const WORKFLOW_DIR = path.join(__dirname, "..", ".github", "workflows");
const CI = fs.readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8");

describe("when reading a workflow's pull_request filter", () => {
  it("should find it at the indentation this repo happens to use", () => {
    expect(pullRequestBranchFilter("on:\n  pull_request:\n    branches: [main]\n")).toBe("[main]");
  });

  it("should find it at any OTHER valid indentation", () => {
    // The bug in the first version: a four-space indent read as "no filter",
    // which the scan below scores as unrestricted — passing a workflow that
    // genuinely skips stacked PRs.
    expect(pullRequestBranchFilter("on:\n    pull_request:\n        branches: [main]\n")).toBe("[main]");
    expect(pullRequestBranchFilter("on:\n pull_request:\n  branches: [main]\n")).toBe("[main]");
  });

  it("should read the flow-style form on one line", () => {
    expect(pullRequestBranchFilter("on:\n  pull_request: {branches: [main]}\n")).toBe("[main]");
  });

  it("should read the BLOCK SEQUENCE form", () => {
    // The most ordinary style there is, and the second thing this helper missed:
    //
    //   branches:
    //     - main
    //
    // Nothing follows the colon, so a pattern demanding a value on the same line
    // finds no filter and calls the workflow unrestricted — while it is
    // restricted to main.
    const yaml = "on:\n  pull_request:\n    branches:\n      - main\n      - release/*\n";
    expect(pullRequestBranchFilter(yaml)).toBe("[main, release/*]");
    expect(restrictsBaseBranches(pullRequestBranchFilter(yaml))).toBe(true);
  });

  it("should read a block sequence that allows every base", () => {
    const yaml = "on:\n  pull_request:\n    branches:\n      - '**'\n";
    expect(restrictsBaseBranches(pullRequestBranchFilter(yaml))).toBe(false);
  });

  it("should treat branches-ignore as a restriction too", () => {
    // It narrows which bases fire just as `branches` does. Reading it as
    // unfiltered is the same false negative wearing a different name.
    for (const yaml of [
      "on:\n  pull_request:\n    branches-ignore: [docs/*]\n",
      "on:\n  pull_request:\n    branches-ignore:\n      - docs/*\n",
      "on:\n  pull_request: {branches-ignore: [docs/*]}\n",
    ]) {
      expect(restrictsBaseBranches(pullRequestBranchFilter(yaml)), yaml).toBe(true);
    }
  });

  it("should not run past the branches block into unrelated keys", () => {
    // A `types:` list after the branches sequence must not be swallowed into it.
    const yaml = "on:\n  pull_request:\n    branches:\n      - main\n    types:\n      - opened\n";
    expect(pullRequestBranchFilter(yaml)).toBe("[main]");
  });

  it("should report no restriction when there is no branches key", () => {
    expect(pullRequestBranchFilter("on:\n  pull_request:\n    types: [opened]\n")).toBeNull();
  });

  it("should report no restriction when the workflow has no pull_request trigger", () => {
    expect(pullRequestBranchFilter("on:\n  schedule:\n    - cron: '0 3 * * *'\n")).toBeNull();
  });

  it("should not mistake a LATER top-level key's branches for this one", () => {
    // `push` follows `pull_request` here; its filter must not be attributed to
    // the pull_request block, which would report a restriction that is not there.
    const yaml = "on:\n  pull_request:\n    types: [opened]\n  push:\n    branches: [main]\n";
    expect(pullRequestBranchFilter(yaml)).toBeNull();
  });

  it("should treat a match-all filter as no restriction", () => {
    expect(restrictsBaseBranches("['**']")).toBe(false);
    expect(restrictsBaseBranches('["**"]')).toBe(false);
    expect(restrictsBaseBranches(null)).toBe(false);
    expect(restrictsBaseBranches("[main]")).toBe(true);
    expect(restrictsBaseBranches("[main, develop]")).toBe(true);
  });
});

describe("when a pull request is opened", () => {
  it("should trigger CI on any base branch, not only main", () => {
    const filter = pullRequestBranchFilter(CI);
    expect(
      restrictsBaseBranches(filter),
      `on.pull_request.branches is ${filter} — a PR based on anything else gets NO CI`,
    ).toBe(false);
  });
});

describe("when the workflow keeps its other triggers", () => {
  it("should still run on pushes to main", () => {
    // Widening pull_request must not cost the post-merge run on main, which is
    // what proves the merged result — not just the PR head — is green.
    expect(CI).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  it("should keep the manual dispatch escape hatch", () => {
    // Still needed: GitHub occasionally drops a pull_request event entirely.
    expect(CI).toMatch(/workflow_dispatch:/);
  });
});

describe("when other workflows are added", () => {
  it("should hold every workflow to the same rule", () => {
    // The trap belongs to the trigger syntax, not to ci.yml. shopline-sync.yml
    // and woodcore-sync.yml are clean today; a new workflow could reintroduce it.
    const workflows = fs.readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
    expect(workflows.length, "no workflows found — is the path right?").toBeGreaterThan(0);

    const restricted = workflows.filter((f) =>
      restrictsBaseBranches(pullRequestBranchFilter(fs.readFileSync(path.join(WORKFLOW_DIR, f), "utf8"))),
    );
    expect(
      restricted,
      `workflows whose pull_request trigger skips non-main bases: ${restricted.join(", ")}`,
    ).toEqual([]);
  });
});
