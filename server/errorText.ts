/**
 * Error text that may leave the process, and where an error was thrown.
 *
 * A database error's text is `Failed query: <sql>\nparams: <values>` (drizzle)
 * or names the offending value (MySQL's duplicate-key message quotes it, an
 * email address included).
 * Logs use `loggableError` (dbErrors.ts). These are its companions for the two
 * other places error text goes, both built on it so they cannot disagree about
 * what a database error is:
 *
 * - `errorSummary` — text that is STORED (a status column, a log table) or
 *   RETURNED (a response body, a client-visible message).
 * - `stackFrames` — where an unexpected error was thrown, for the catch-all
 *   logs that printed a whole stack before, without the message a stack
 *   begins with.
 */
import type { TRPCError } from "@trpc/server";
import { loggableError } from "./dbErrors";

/** True when the error, or anything it wraps, came from the database. */
export function isDatabaseError(error: unknown): boolean {
  return loggableError(error).error === "database";
}

/**
 * One line describing an error, safe to store or return: a database error by
 * its code alone, anything else by its bounded message, a thrown non-error by
 * its type.
 */
export function errorSummary(error: unknown): string {
  const logged = loggableError(error);
  if (logged.error === "database") return logged.errorCode ? `database error (${logged.errorCode})` : "database error";
  if (logged.message !== undefined) return logged.message;
  return `non-error value thrown (${logged.error})`;
}

/**
 * tRPC's `onError`: a procedure that failed unexpectedly, logged once by its
 * code and where it was thrown, never its text. Refusals (NOT_FOUND,
 * FORBIDDEN…) are answers, not failures, and are not logged.
 */
export function logProcedureFailure({ error, path }: { error: TRPCError; path?: string }): void {
  if (error.code !== "INTERNAL_SERVER_ERROR") return;
  console.error(`[trpc] ${path ?? "unknown"} failed:`, {
    ...loggableError(error),
    frames: stackFrames(error.cause ?? error),
  });
}

/** How far into a stack its `Name: ` prefix may run before the message starts. */
const MAX_HEADER_PREFIX = 200;

/**
 * The frame lines of an error's stack (`at fn (file:line:col)`), never its
 * message.
 *
 * A stack begins with `Name: message`, and a database error's message runs
 * over several lines, so a line cannot be judged a frame by how it looks: a
 * parameter could read `    at …`. The message is therefore removed by exact
 * match first, and only what follows it is read. A stack whose header does not
 * hold the error's current message (rewritten, or the message changed after
 * the stack was captured) yields no frames: fail closed.
 */
export function stackFrames(error: unknown, max = 8): string[] {
  if (!(error instanceof Error) || typeof error.stack !== "string") return [];
  const { stack, message } = error;
  let headerEnd: number;
  if (message === "") {
    const newline = stack.indexOf("\n");
    headerEnd = newline < 0 ? stack.length : newline;
  } else {
    const marker = `: ${message}`;
    const at = stack.indexOf(marker);
    if (at >= 0 && at <= MAX_HEADER_PREFIX) headerEnd = at + marker.length;
    else if (stack.startsWith(message)) headerEnd = message.length;
    else return [];
  }
  const rest = stack.slice(headerEnd);
  if (rest !== "" && !rest.startsWith("\n")) return [];
  return rest
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, max);
}
