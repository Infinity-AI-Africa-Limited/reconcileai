import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { isDuplicateKeyError, isTransactionTooLargeError, loggableError } from "./dbErrors";

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

describe("loggableError", () => {
  describe("when a query fails through drizzle", () => {
    it("should report the driver's code and never the query or its parameters", () => {
      const driver = Object.assign(new Error("Duplicate entry 'owner@example.com' for key 'users.email'"), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
        sqlMessage: "Duplicate entry 'owner@example.com' for key 'users.email'",
      });
      const wrapped = new DrizzleQueryError("insert into `users` (`email`) values (?)", ["owner@example.com"], driver);

      const logged = loggableError(wrapped);

      expect(logged).toEqual({ error: "database", errorCode: "ER_DUP_ENTRY" });
      expect(JSON.stringify(logged)).not.toMatch(/owner@example\.com|insert into|params/i);
    });
  });

  describe("when the driver fails without drizzle's wrapper", () => {
    it("should still treat it as a database error", () => {
      const driver = Object.assign(new Error("secret value"), { code: "ECONNRESET", sql: "select 1" });
      expect(loggableError(driver)).toEqual({ error: "database", errorCode: "ECONNRESET" });
    });
  });

  describe("when the error is the application's own", () => {
    it("should keep its name and a bounded message", () => {
      const logged = loggableError(new TypeError("x".repeat(500)));
      expect(logged.error).toBe("TypeError");
      expect(logged.message).toHaveLength(200);
    });

    it("should describe a thrown non-error by its type only", () => {
      expect(loggableError("owner@example.com")).toEqual({ error: "string" });
    });
  });
});

describe("when loggableError is spread into a log that names its own operation", () => {
  const driver = Object.assign(new Error("Deadlock found; params: owner@example.com"), {
    code: "ER_LOCK_DEADLOCK",
    sqlMessage: "Deadlock found",
  });

  it("should never replace the operation's code with the driver's", () => {
    const logged = { code: "durable_queue_unavailable", ...loggableError(driver) };
    expect(logged).toMatchObject({ code: "durable_queue_unavailable", errorCode: "ER_LOCK_DEADLOCK" });
  });

  it("should report the driver's code through an application error that carries its own", () => {
    const wrapped = Object.assign(
      new Error("Could not secure Shopify access tokens", {
        cause: new DrizzleQueryError("update `shopify_connector_tokens` set ?", ["owner@example.com"], driver),
      }),
      { code: "TOKEN_STORE_FAILED" },
    );
    expect(loggableError(wrapped)).toEqual({ error: "database", errorCode: "ER_LOCK_DEADLOCK" });
  });
});

describe("when TiDB refuses a transaction as too large", () => {
  it("should be recognised through drizzle's wrapper, and nothing else mistaken for it", () => {
    const tooLarge = Object.assign(new Error("Failed query: …"), {
      cause: Object.assign(new Error("Transaction is too large"), { errno: 8004 }),
    });
    expect(isTransactionTooLargeError(tooLarge)).toBe(true);
    expect(isTransactionTooLargeError(Object.assign(new Error("dup"), { errno: 1062 }))).toBe(false);
    expect(isTransactionTooLargeError("8004")).toBe(false);
  });
});
