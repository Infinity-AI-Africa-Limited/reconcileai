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
 * Parsed with a regex rather than a YAML library. The workflow has exactly one
 * `pull_request:` key and the assertion is narrow, so a dependency for this would
 * cost more than it explains.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const WORKFLOW_DIR = path.join(__dirname, "..", ".github", "workflows");
const CI = fs.readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8");

/** The `branches:` line belonging to `on.pull_request`, if it has one. */
function pullRequestBranchFilter(source: string): string | null {
  const at = source.indexOf("\n  pull_request:");
  if (at === -1) return null;
  // Look only as far as the next top-level key, so a `branches:` under `push:`
  // or a later job cannot be mistaken for this one.
  const rest = source.slice(at + 1);
  const end = rest.search(/\n[a-z_]+:/);
  const block = end === -1 ? rest : rest.slice(0, end);
  const match = block.match(/^\s*branches:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

describe("when a pull request is opened", () => {
  it("should trigger CI on any base branch, not only main", () => {
    const filter = pullRequestBranchFilter(CI);
    // Either no filter at all (every base) or an explicit match-all.
    if (filter !== null) {
      expect(
        filter,
        `on.pull_request.branches is ${filter} — a PR based on anything else gets NO CI`,
      ).toMatch(/\[\s*['"]\*\*['"]\s*\]/);
    }
  });

  it("should not restrict pull requests to a named branch list", () => {
    const filter = pullRequestBranchFilter(CI);
    if (filter === null) return;
    expect(filter, "a named base-branch list silently skips stacked PRs").not.toMatch(/main/);
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
  it("should be checked for the same base-branch trap", () => {
    // Not an assertion about content — a list, so that a new workflow with a
    // pull_request trigger has to be looked at rather than assumed fine.
    const workflows = fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    const restricted = workflows.filter((f) => {
      const source = fs.readFileSync(path.join(WORKFLOW_DIR, f), "utf8");
      const filter = pullRequestBranchFilter(source);
      return filter !== null && !/\*\*/.test(filter);
    });
    expect(
      restricted,
      `workflows whose pull_request trigger skips non-main bases: ${restricted.join(", ")}`,
    ).toEqual([]);
  });
});
