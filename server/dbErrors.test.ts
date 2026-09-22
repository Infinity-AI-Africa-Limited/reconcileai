import { describe, expect, it } from "vitest";
import { isDuplicateKeyError } from "./dbErrors";

/** A driver error shaped like mysql2's. */
function driverError(code: string, errno: number, message: string): Error {
  return Object.assign(new Error(message), { code, errno });
}

/** drizzle-orm 0.44 wraps every failed query like this. */
function wrappedByDrizzle(cause: Error, sql = "insert into `organizations` (`code`) values (?)"): Error {
  return Object.assign(new Error(`Failed query: ${sql}\nparams: SHP_X`), { cause });
}

describe("isDuplicateKeyError", () => {
  describe("when drizzle wraps a unique-key violation", () => {
    it("should recognise it through the cause chain", () => {
      const error = wrappedByDrizzle(driverError("ER_DUP_ENTRY", 1062, "Duplicate entry 'SHP_X' for key 'code'"));
      expect(isDuplicateKeyError(error)).toBe(true);
    });

    it("should recognise it by errno alone", () => {
      expect(isDuplicateKeyError(wrappedByDrizzle(driverError("UNKNOWN", 1062, "")))).toBe(true);
    });

    it("should find it more than one wrapper deep", () => {
      const inner = wrappedByDrizzle(driverError("ER_DUP_ENTRY", 1062, "Duplicate entry"));
      expect(isDuplicateKeyError(Object.assign(new Error("transaction failed"), { cause: inner }))).toBe(true);
    });
  });

  describe("when the error is not a unique-key violation", () => {
    it("should not match a different driver error", () => {
      expect(isDuplicateKeyError(wrappedByDrizzle(driverError("ECONNRESET", -4077, "socket hang up")))).toBe(false);
    });

    it("should not match merely because the SQL mentions duplicates", () => {
      // The message-regex approach matched this: an upsert that failed for an
      // unrelated reason carries "on duplicate key update" in its SQL text.
      const error = wrappedByDrizzle(
        driverError("ER_LOCK_DEADLOCK", 1213, "Deadlock found"),
        "insert into `t` (`a`) values (?) on duplicate key update `a` = `a`",
      );
      expect(isDuplicateKeyError(error)).toBe(false);
    });

    it("should not match a plain error that only says 'duplicate'", () => {
      expect(isDuplicateKeyError(new Error("Duplicate entry"))).toBe(false);
    });

    it("should tolerate values that are not errors", () => {
      expect(isDuplicateKeyError(undefined)).toBe(false);
      expect(isDuplicateKeyError("Duplicate entry")).toBe(false);
      expect(isDuplicateKeyError(null)).toBe(false);
    });

    it("should terminate on a cyclic cause chain", () => {
      const a: { cause?: unknown } = {};
      const b: { cause?: unknown } = { cause: a };
      a.cause = b;
      expect(isDuplicateKeyError(a)).toBe(false);
    });
  });
});
