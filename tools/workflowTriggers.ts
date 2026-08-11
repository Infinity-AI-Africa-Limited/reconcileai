/**
 * Does a GitHub workflow restrict which PR base branches trigger it?
 *
 * DELIBERATELY NOT A YAML PARSER. It is a lint, and the distinction is the whole
 * design.
 *
 * The first three versions of this tried to READ the filter — find `branches`,
 * extract its value, decide. Each was defeated by a shape it had not been
 * written against: a four-space indent, then the block-sequence form
 * (`branches:` with the list beneath it), then a space before the colon. Every
 * miss failed the same way — the filter was not recognised, so the workflow was
 * reported as UNRESTRICTED, and a workflow that genuinely skipped CI would have
 * been waved through by the check written to catch it. A guard with a false
 * negative is worse than no guard: it turns an unexamined case into a green tick.
 *
 * Extracting a value needs to understand YAML. Answering "is there a filter
 * here, and does it allow everything?" does not. So this asks the second
 * question:
 *
 *   the word `branches` appears in the trigger block  ->  something is filtered
 *   `**` appears in the trigger block                 ->  it allows every base
 *
 * `branches`, `branches :`, `branches-ignore:`, `"branches":`, flow style, block
 * sequence and any indentation all contain the substring, so no spelling escapes
 * it. Comments are stripped first so prose cannot trip it.
 *
 * The trade-off is deliberate and points the safe way: this can produce a FALSE
 * POSITIVE — a workflow flagged because the word appears somewhere unrelated —
 * which fails loudly and is fixed in a minute. It cannot produce the silent false
 * negative that let the original bug exist, which is the failure that matters.
 */

/** Leading-whitespace width, used to decide what is inside a block. */
function indentOf(line: string): number {
  return /^[ ]*/.exec(line)![0].length;
}

export type PullRequestTrigger =
  /** No `pull_request:` key, so the workflow never runs on pull requests. */
  | { kind: "absent" }
  /** Runs on pull requests against any base branch. */
  | { kind: "unrestricted" }
  /** Runs only for some bases — the case that silently skips stacked PRs. */
  | { kind: "restricted"; block: string };

/**
 * The text of the `pull_request:` trigger block, comments removed.
 *
 * Tolerant about the key itself (`pull_request :` is valid YAML) because being
 * strict here reintroduces exactly the miss this module exists to prevent.
 */
function pullRequestBlock(source: string): string | null {
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = /^([ ]*)pull_request[ ]*:(.*)$/.exec(lines[i]);
    if (!header) continue;

    const indent = header[1].length;
    const collected = [header[2]];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") continue;
      if (indentOf(line) <= indent) break; // the block ended
      collected.push(line);
    }
    // Strip comments: a note mentioning branches is not a filter.
    return collected.map((l) => l.replace(/#.*$/, "")).join("\n");
  }
  return null;
}

/**
 * Does this block allow EVERY base branch?
 *
 * Only a bare `**` does. `release/**` contains the same two characters and is a
 * narrowing pattern — testing for the substring accepted it and called the
 * workflow unrestricted, which is the false negative this module exists to
 * prevent, reintroduced by the fix for the previous one.
 *
 * Quotes, brackets and commas become spaces so `['**']`, `[ "**" ]` and a
 * `- '**'` list item all reduce to a standalone token, while `release/**` keeps
 * the slash that disqualifies it.
 */
function allowsEveryBase(block: string): boolean {
  const normalized = block.replace(/["'[\],]/g, " ");
  return /(?:^|\s)\*\*(?:\s|$)/.test(normalized);
}

export function readPullRequestTrigger(source: string): PullRequestTrigger {
  const block = pullRequestBlock(source);
  if (block === null) return { kind: "absent" };

  const restricted = (): PullRequestTrigger => ({
    kind: "restricted",
    block: block.trim().replace(/\s+/g, " ").slice(0, 120),
  });

  // No filter of any kind: every base fires.
  if (!/branches/.test(block)) return { kind: "unrestricted" };

  // `branches-ignore` only ever subtracts, so it always narrows — including
  // `branches-ignore: ['**']`, which excludes every pull request there is. A
  // match-all glob inside an ignore list is the opposite of permissive, and
  // reading it as `**` = "allows everything" inverts its meaning entirely.
  if (/branches-ignore/.test(block)) return restricted();

  return allowsEveryBase(block) ? { kind: "unrestricted" } : restricted();
}

/** Does this workflow skip pull requests based on some branches? */
export function restrictsBaseBranches(source: string): boolean {
  return readPullRequestTrigger(source).kind === "restricted";
}
