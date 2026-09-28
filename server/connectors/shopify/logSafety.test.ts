/**
 * Ratchet: no Shopify connector log prints an error's raw message.
 *
 * A database error's text is `Failed query: <sql>\nparams: <values>` (drizzle)
 * or names the offending value (MySQL), so logging it writes tenant data —
 * merchant emails, digests — into the logs. Logs use `loggableError`, which
 * reports a database error by its code alone. This scan keeps it that way.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname);

function logCalls(source: string): string[] {
  const calls: string[] = [];
  const opener = /console\.(error|warn|info|log)\(/g;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    // Walk to the matching close paren so multi-line argument objects are included.
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(match.index, end + 1));
  }
  return calls;
}

describe("when the Shopify connector logs an error", () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.includes("testkit"));

  it("should scan real connector modules, so a clean result means something", () => {
    expect(files).toEqual(expect.arrayContaining(["webhooks.ts", "onboarding.ts", "routes.ts", "privacyQueue.ts"]));
    const total = files.reduce((sum, name) => sum + logCalls(readFileSync(path.join(DIR, name), "utf8")).length, 0);
    expect(total).toBeGreaterThan(20);
  });

  it("should never print a raw error message", () => {
    const offenders = files.flatMap((name) =>
      logCalls(readFileSync(path.join(DIR, name), "utf8"))
        .filter((call) => /\b\w*[eE]rror\??\.message\b|String\(\w*[eE]rror\)/.test(call))
        .map((call) => `${name}: ${call.split("\n")[0]}`),
    );
    expect(offenders, "log loggableError(error), not its message").toEqual([]);
  });
});
