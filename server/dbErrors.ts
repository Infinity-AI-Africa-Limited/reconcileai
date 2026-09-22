/**
 * Classifying database errors by what MySQL/TiDB said, not by message text.
 *
 * drizzle-orm (0.44+) wraps every failed query in a `DrizzleQueryError` whose
 * own message is `Failed query: <sql>\nparams: …`. The driver's error — with
 * `code: "ER_DUP_ENTRY"` and `errno: 1062` — is its `cause`. A check that reads
 * the outer message (`/duplicate/i.test(err.message)`) therefore never sees a
 * real duplicate, and matches any statement whose SQL merely contains the word,
 * such as `ON DUPLICATE KEY UPDATE`. Read the structured fields, down the chain.
 */

const ER_DUP_ENTRY = 1062;

/** How far down a `cause` chain to look; guards against a cyclic chain. */
const MAX_CAUSE_DEPTH = 5;

/** True when the error, or anything it wraps, is a unique-key violation. */
export function isDuplicateKeyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    if (typeof current !== "object") return false;
    const { code, errno, cause } = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (code === "ER_DUP_ENTRY" || errno === ER_DUP_ENTRY) return true;
    current = cause;
  }
  return false;
}
