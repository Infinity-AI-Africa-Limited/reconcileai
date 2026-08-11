/**
 * Does a GitHub workflow restrict which PR base branches trigger it?
 *
 * Parsed with a real YAML parser, after four hand-rolled versions were each
 * defeated by a shape they had not been written against:
 *
 *   1. a four-space indent            — the key was not found
 *   2. `branches:` with a list beneath — no value on the line, so no filter seen
 *   3. `branches :`                    — whitespace before the colon
 *   4. `release/**`                    — a narrowing glob containing `**`
 *   5. a sibling `paths-ignore: ['**']` — a match-all belonging to another key
 *
 * Every one failed the same direction: the filter went unrecognised, the
 * workflow was reported UNRESTRICTED, and a workflow genuinely skipping CI would
 * have been waved through by the check written to catch it.
 *
 * The pattern in that list is not five unlucky edge cases. Deciding whether a
 * filter allows everything requires knowing which KEY a value belongs to and
 * what the value IS — both of which are YAML structure. Text matching can
 * approximate that and will keep approximating it wrongly. `yaml` is a
 * devDependency, so it never reaches the bundle.
 *
 * The earlier objection to a dependency — "too much to read one key" — was
 * wrong, and expensively: five review rounds cost far more than one small
 * package.
 */
import { parse } from "yaml";

export type PullRequestTrigger =
  /** No `pull_request` trigger, so the workflow never runs on pull requests. */
  | { kind: "absent" }
  /** Runs on pull requests against any base branch. */
  | { kind: "unrestricted" }
  /** Runs only for some bases — the case that silently skips stacked PRs. */
  | { kind: "restricted"; detail: string }
  /** Could not be read. Counted as restricted so it is looked at, not ignored. */
  | { kind: "unparsable"; detail: string };

/** Match-all: only a bare `**`, never `release/**`. */
function allowsEveryBase(branches: unknown): boolean {
  const list = Array.isArray(branches) ? branches : [branches];
  return list.some((b) => String(b).trim() === "**");
}

export function readPullRequestTrigger(source: string): PullRequestTrigger {
  let doc: Record<string, unknown>;
  try {
    doc = (parse(source) ?? {}) as Record<string, unknown>;
  } catch (err) {
    // A workflow GitHub cannot read will not run either. Flagging is the safe
    // direction: it is loud, and silence is the failure that started all this.
    return { kind: "unparsable", detail: err instanceof Error ? err.message : String(err) };
  }

  // `on` is a YAML 1.1 boolean. The parser defaults to 1.2, where it stays a
  // string, but a file carrying a %YAML 1.1 directive would land under `true`
  // instead — and reading that as "no triggers" is another silent pass.
  const on = doc.on ?? (doc as Record<string, unknown>)["true"] ?? doc[true as unknown as string];
  if (on == null) return { kind: "absent" };

  // `on: pull_request` and `on: [push, pull_request]` admit no filters at all.
  if (typeof on === "string") {
    return on === "pull_request" ? { kind: "unrestricted" } : { kind: "absent" };
  }
  if (Array.isArray(on)) {
    return on.includes("pull_request") ? { kind: "unrestricted" } : { kind: "absent" };
  }
  if (typeof on !== "object") return { kind: "absent" };

  const events = on as Record<string, unknown>;
  if (!("pull_request" in events)) return { kind: "absent" };

  const pr = events.pull_request;
  // `pull_request:` with nothing under it fires for every base.
  if (pr == null || typeof pr !== "object") return { kind: "unrestricted" };

  const filters = pr as Record<string, unknown>;

  // `branches-ignore` only ever subtracts, so it always narrows — including
  // `branches-ignore: ['**']`, which excludes every pull request there is.
  if (filters["branches-ignore"] != null) {
    return { kind: "restricted", detail: `branches-ignore: ${JSON.stringify(filters["branches-ignore"])}` };
  }

  const branches = filters.branches;
  if (branches == null) return { kind: "unrestricted" };

  // Scoped to the `branches` VALUE. Searching the whole block meant a sibling
  // key's match-all — `paths-ignore: ['**']`, which filters FILES and says
  // nothing about base branches — made `branches: [main]` look unrestricted.
  return allowsEveryBase(branches)
    ? { kind: "unrestricted" }
    : { kind: "restricted", detail: `branches: ${JSON.stringify(branches)}` };
}

/** Does this workflow skip pull requests based on their base branch? */
export function restrictsBaseBranches(source: string): boolean {
  const kind = readPullRequestTrigger(source).kind;
  return kind === "restricted" || kind === "unparsable";
}
