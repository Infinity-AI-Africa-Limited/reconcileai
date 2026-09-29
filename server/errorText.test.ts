import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { errorSummary, stackFrames } from "./errorText";

const EMAIL = "owner@example.com";

function drizzleDuplicate(): DrizzleQueryError {
  const driver = Object.assign(new Error(`Duplicate entry '${EMAIL}' for key 'users.email'`), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
    sqlMessage: `Duplicate entry '${EMAIL}' for key 'users.email'`,
  });
  return new DrizzleQueryError("insert into `users` (`email`) values (?)", [EMAIL], driver);
}

describe("when an error's text is to be stored or returned", () => {
  it("should describe a database error by its code, never its query or parameters", () => {
    const summary = errorSummary(drizzleDuplicate());
    expect(summary).toBe("database error (ER_DUP_ENTRY)");
    expect(summary).not.toMatch(/owner@example\.com|insert into|params/i);
  });

  it("should describe a raw driver error the same way", () => {
    const driver = Object.assign(new Error(`Unknown column in ${EMAIL}`), { code: "ER_BAD_FIELD_ERROR", sql: "select 1" });
    expect(errorSummary(driver)).toBe("database error (ER_BAD_FIELD_ERROR)");
  });

  it("should keep an application error's message, bounded", () => {
    expect(errorSummary(new Error("SFTP connection refused"))).toBe("SFTP connection refused");
    expect(errorSummary(new Error("x".repeat(500)))).toHaveLength(200);
  });

  it("should describe a thrown non-error by its type, never its value", () => {
    expect(errorSummary(EMAIL)).toBe("non-error value thrown (string)");
  });
});

describe("when an unexpected error's frames are logged", () => {
  it("should give where it was thrown and none of what it said", () => {
    const error = drizzleDuplicate();
    const frames = stackFrames(error);

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.startsWith("at "))).toBe(true);
    expect(frames.join("\n")).toContain("errorText.test.ts");
    expect(frames.join("\n")).not.toMatch(/owner@example\.com|Failed query|params/);
  });

  it("should not mistake a message line that looks like a frame for one", () => {
    // A parameter can contain a newline followed by anything, "    at " included.
    const error = new Error(`Failed query: select ?\nparams: x\n    at ${EMAIL} (evil.ts:1:1)`);
    expect(stackFrames(error).join("\n")).not.toContain(EMAIL);
    expect(stackFrames(error).length).toBeGreaterThan(0);
  });

  it("should give nothing when the stack no longer begins with the message", () => {
    const error = new Error(`first ${EMAIL}`);
    // V8 formats a stack on first read, so it is read here before the message
    // changes: the stack now holds the old text, the message does not.
    expect(error.stack).toContain(EMAIL);
    error.message = "changed after capture";
    expect(stackFrames(error)).toEqual([]);
  });

  it("should read an error with an empty message, and give nothing for a non-error", () => {
    expect(stackFrames(new Error("")).length).toBeGreaterThan(0);
    expect(stackFrames(EMAIL)).toEqual([]);
  });

  it("should stop at the limit", () => {
    expect(stackFrames(new Error("deep"), 2)).toHaveLength(2);
  });
});
