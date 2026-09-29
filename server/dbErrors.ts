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

/** TiDB's "Transaction is too large" (ErrTxnTooLarge): one transaction exceeded its size limit. */
const TIDB_TXN_TOO_LARGE = 8004;

/** How far down a `cause` chain to look; guards against a cyclic chain. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True when the error, or anything it wraps, is TiDB refusing a transaction as
 * too large. Retrying the same work fails the same way; it has to be smaller.
 */
export function isTransactionTooLargeError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    if (typeof current !== "object") return false;
    const { errno, cause } = current as { errno?: unknown; cause?: unknown };
    if (errno === TIDB_TXN_TOO_LARGE) return true;
    current = cause;
  }
  return false;
}

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

/**
 * What a log may say about an error.
 *
 * Never the text of a database error: drizzle's wrapper message is
 * `Failed query: <sql>\nparams: <values>`, and MySQL's own names the offending
 * value (`Duplicate entry 'owner@example.com' for key …`). Either puts tenant
 * data — merchant emails, digests, ids — into logs. A database error is
 * reported by its structured code alone (`ER_DUP_ENTRY`, `ECONNRESET`), which
 * is what diagnosis needs. Any other error keeps a bounded message; this
 * codebase's own errors carry static text by convention.
 *
 * The code is reported as `errorCode`, never `code`: logs here use `code` for
 * the operation that failed (`durable_queue_unavailable`), and spreading this
 * after it must not replace that with the driver's.
 *
 * It is the DEEPEST code on the `cause` chain — the driver's, for a database
 * error wrapped by drizzle and then by an application error that carries a code
 * of its own.
 */
export function loggableError(error: unknown): { error: string; errorCode?: string; message?: string } {
  if (!(error instanceof Error)) return { error: typeof error };
  let errorCode: string | undefined;
  let database = false;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const link = current as { name?: unknown; code?: unknown; sql?: unknown; sqlMessage?: unknown; cause?: unknown };
    if (link.name === "DrizzleQueryError" || "sql" in link || "sqlMessage" in link) database = true;
    if (typeof link.code === "string") errorCode = link.code;
    current = link.cause;
  }
  if (database) return { error: "database", ...(errorCode ? { errorCode } : {}) };
  return { error: error.name, ...(errorCode ? { errorCode } : {}), message: error.message.slice(0, 200) };
}
