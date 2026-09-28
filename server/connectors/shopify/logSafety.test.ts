/**
 * Ratchet: no Shopify connector log prints an error's raw text.
 *
 * A database error's text is `Failed query: <sql>\nparams: <values>` (drizzle)
 * or names the offending value (MySQL), so logging it writes tenant data —
 * merchant emails, digests — into the logs. Logs use `loggableError`, which
 * reports a database error by its code alone. This scan keeps it that way.
 *
 * Every shape that puts the text in a log counts, not only `error.message`: an
 * error object handed to `console` whole (Node prints its message, and a
 * drizzle error's query and params with it), coerced to a string, or read under
 * another name (`err.message`, `e.stack`). And the text must not be laundered
 * into a NEW error's message first, where it would reach the log as ordinary
 * application text.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname);

/** How this connector names a caught error. */
const ERROR_NAME = String.raw`(?:e|err|error|caught|cause|lastError|\w+Error|\w+Err)`;

const RAW_ERROR_IN_LOG = [
  /\.(?:message|stack)\b/,
  new RegExp(String.raw`String\(\s*${ERROR_NAME}\s*\)`),
  new RegExp(String.raw`\$\{\s*${ERROR_NAME}\s*\}`),
  // Handed to console whole: an argument, a shorthand property, or a value.
  new RegExp(String.raw`[,(]\s*${ERROR_NAME}\s*[,)]`),
  new RegExp(String.raw`[{,]\s*${ERROR_NAME}\s*[,}]`),
  new RegExp(String.raw`:\s*${ERROR_NAME}\s*[,}]`),
];

/** Error text copied into a template literal — a new error's message, typically. */
const TEXT_INTO_TEMPLATE = [
  /\$\{[^}]*\.(?:message|stack)\b[^}]*\}/,
  new RegExp(String.raw`\$\{\s*${ERROR_NAME}\s*\}`),
];

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

function leaksRawError(call: string): boolean {
  // The one sanctioned way to put an error in a log.
  const rest = call.replace(/loggableError\(\s*\w+\s*\)/g, "");
  return RAW_ERROR_IN_LOG.some((pattern) => pattern.test(rest));
}

describe("when the ratchet judges a log call", () => {
  it.each([
    'console.error("x", error.message)',
    'console.error("x", err.message)',
    'console.warn("x", { detail: e.message })',
    'console.error("x", { stack: caught.stack })',
    'console.error("x", error)',
    'console.error(err)',
    'console.error("x", { error })',
    'console.error("x", { reason, cause })',
    'console.error("x", { detail: err })',
    'console.warn("x", String(error))',
    'console.warn(`x ${err}`)',
  ])("should flag %s", (call) => {
    expect(leaksRawError(call)).toBe(true);
  });

  it.each([
    'console.error("x", { code: "durable_queue_unavailable", ...loggableError(error) })',
    'console.error("x", {\n  storeId,\n  ...loggableError(lastError),\n})',
    'console.error("x", { code: error instanceof ShopifyOnboardingError ? error.code : undefined })',
    'console.error("x", { code: "artifact_discard_deferred" })',
  ])("should allow %s", (call) => {
    expect(leaksRawError(call)).toBe(false);
  });
});

describe("when the Shopify connector logs an error", () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.includes("testkit"));
  const sources = files.map((name) => ({ name, source: readFileSync(path.join(DIR, name), "utf8") }));

  it("should scan real connector modules, so a clean result means something", () => {
    expect(files).toEqual(expect.arrayContaining(["webhooks.ts", "onboarding.ts", "routes.ts", "privacyQueue.ts"]));
    const total = sources.reduce((sum, { source }) => sum + logCalls(source).length, 0);
    expect(total).toBeGreaterThan(20);
  });

  it("should never print an error's raw text", () => {
    const offenders = sources.flatMap(({ name, source }) =>
      logCalls(source)
        .filter(leaksRawError)
        .map((call) => `${name}: ${call.split("\n")[0]}`),
    );
    expect(offenders, "log loggableError(error), never the error or its text").toEqual([]);
  });

  it("should never copy an error's text into a new message", () => {
    const offenders = sources.flatMap(({ name, source }) =>
      source
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => TEXT_INTO_TEMPLATE.some((pattern) => pattern.test(line)))
        .map(({ line, index }) => `${name}:${index + 1}: ${line.trim()}`),
    );
    expect(offenders, "keep static text; pass the failure as { cause }").toEqual([]);
  });
});
