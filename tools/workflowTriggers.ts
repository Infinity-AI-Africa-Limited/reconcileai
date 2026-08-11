/**
 * Read a GitHub workflow's `pull_request` base-branch filter.
 *
 * Exists as its own module so the parser can be tested against YAML shapes that
 * are not in the repository yet. The first version of this lived inside the test
 * and looked for the literal string "\n  pull_request:", which recognised only a
 * two-space indent. A workflow indented any other way — equally valid YAML —
 * read as "no filter found", which the caller scores as UNRESTRICTED. So the
 * check meant to catch a workflow skipping CI would have waved that workflow
 * through, which is worse than not having it.
 *
 * Hand-written rather than pulled from a YAML library: the repository has no
 * parser dependency, and adding one to read a single key would cost more than it
 * saves. The trade-off is that this handles the shapes GitHub actually accepts
 * for this key and is not a general YAML reader — which is why it is tested
 * against those shapes explicitly.
 */

/** Leading-whitespace width, used to decide what is inside a block. */
function indentOf(line: string): number {
  return /^[ ]*/.exec(line)![0].length;
}

/**
 * The raw `branches:` value under `on.pull_request`, or null.
 *
 * Null means "no base-branch restriction", and covers two situations that are
 * the same for the caller: the workflow has no `pull_request` trigger at all
 * (so it never runs on pull requests and cannot silently skip one), or it has
 * one with no `branches` filter (so it runs on every base).
 */
export function pullRequestBranchFilter(source: string): string | null {
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const header = /^([ ]*)pull_request:[ ]*(.*)$/.exec(lines[i]);
    if (!header) continue;

    const indent = header[1].length;
    const inline = header[2].trim();

    // Flow style, all on one line: `pull_request: {branches: [main]}`
    if (inline.startsWith("{")) {
      const flow = /branches:\s*(\[[^\]]*\]|[^,}]+)/.exec(inline);
      return flow ? flow[1].trim() : null;
    }

    // Block style: anything indented deeper belongs to this key.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || /^[ ]*#/.test(line)) continue;
      if (indentOf(line) <= indent) break; // the block ended
      const branches = /^[ ]*branches:[ ]*(.+)$/.exec(line);
      if (branches) return branches[1].trim();
    }
    return null; // a pull_request trigger with no branches filter
  }

  return null; // no pull_request trigger in this workflow
}

/** Does this filter restrict which base branches trigger the workflow? */
export function restrictsBaseBranches(filter: string | null): boolean {
  if (filter === null) return false;
  return !filter.includes("**");
}
