/**
 * Words that mark a transaction as a reversal — one list, shared.
 *
 * The matching engine reads them in a transaction's description: to pair a
 * reversal with the opposite-direction row it undoes, and to label an
 * unmatched one a reversal rather than a missing payment. Settlement-file
 * imports use the same list to keep that reading while discarding the file's
 * free text: a merchant's description column can hold a customer's name or
 * address, which the platform must not store.
 *
 * The words never set a row's direction. "Chargeback reversal" and "Refund
 * reversed" are word-marked rows where money comes back IN; only the amount's
 * sign can say which way money moved.
 */
const REVERSAL_SIGNALS: ReadonlyArray<{ pattern: RegExp; word: string }> = [
  { pattern: /reversal/i, word: "reversal" },
  { pattern: /reversed/i, word: "reversed" },
  { pattern: /rvsl/i, word: "rvsl" },
  { pattern: /refund/i, word: "refund" },
  { pattern: /chargeback/i, word: "chargeback" },
  { pattern: /return/i, word: "return" },
  { pattern: /cancel/i, word: "cancel" },
  { pattern: /void/i, word: "void" },
  { pattern: /rvs/i, word: "rvs" },
  { pattern: /rev\//i, word: "rev/" },
];

/** The patterns the matching engine tests a description against. */
export const REVERSAL_PATTERNS: readonly RegExp[] = REVERSAL_SIGNALS.map(({ pattern }) => pattern);

/**
 * The reversal words found in `text`, as OUR canonical vocabulary — never the
 * text's own words — in a fixed order, each once. Every returned word matches
 * the pattern it stands for, so text built from them triggers the same
 * detection the original did.
 */
export function reversalSignals(text: string | null | undefined): string[] {
  if (!text) return [];
  return REVERSAL_SIGNALS.filter(({ pattern }) => pattern.test(text)).map(({ word }) => word);
}
