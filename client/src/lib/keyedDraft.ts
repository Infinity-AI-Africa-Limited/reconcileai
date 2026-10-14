/**
 * Text drafts that each belong to one subject — one exception, one workflow
 * attempt — and cannot be read under any other.
 *
 * Clearing a draft when the subject changes is not enough: the clear runs in an
 * effect, after the first render of the new subject, so for that render the old
 * text is on screen and on the button that submits it, and a clear someone
 * forgets to add leaks the text indefinitely. Here every draft is filed under
 * its key, so text written for case A reads as empty for case B by
 * construction, and going back to case A finds A's draft where it was left.
 */
export type KeyedDrafts = Readonly<Record<string, string>>;

/** The draft for `key`; empty when nothing was written for it. */
export function readKeyedDraft(drafts: KeyedDrafts, key: string): string {
  return Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : "";
}

/**
 * The drafts after a write made while `key` was current. Only that key's draft
 * changes, and an updater sees only that key's text: the end of case A's
 * request (`clearIfStill`) can neither clear nor overwrite case B's draft. An
 * emptied draft is dropped, so the record holds only text still being written.
 */
export function writeKeyedDraft(
  drafts: KeyedDrafts,
  key: string,
  next: string | ((current: string) => string)
): KeyedDrafts {
  const text = typeof next === "function" ? next(readKeyedDraft(drafts, key)) : next;
  const { [key]: _previous, ...others } = drafts;
  return text === "" ? others : { ...others, [key]: text };
}
