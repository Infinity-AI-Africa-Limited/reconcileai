/**
 * Ratchet: no server module puts an error's raw text in a log, a stored
 * column, or a response.
 *
 * A database error's text is `Failed query: <sql>\nparams: <values>` (drizzle)
 * or names the offending value (MySQL: `Duplicate entry 'owner@example.com'`).
 * So logging it writes tenant data into the logs, and storing or returning it
 * hands the same data, and the schema, to whoever reads that column or
 * response. The sanctioned forms are:
 *
 * - logs: `loggableError(error)` (dbErrors.ts), with `stackFrames(error)` where
 *   an unexpected failure needs to say where it was thrown;
 * - stored or returned text: `errorSummary(error)` (errorText.ts).
 *
 * Three scans, each proven able to fail (see the "judges" blocks):
 *
 * 1. log calls: an error handed to `console` whole, its `.message`/`.stack`,
 *    `String(err)`, or `${err}`;
 * 2. error text copied into a template literal, typically a new error's or a
 *    stored row's message;
 * 3. an error's text read anywhere else: the stored and returned paths.
 *
 * An error is recognised by its conventional names AND by whatever name each
 * file binds a caught error to, so `catch (problem)` is scanned like
 * `catch (err)`.
 *
 * The Shopify connector and its routers are left to their own ratchet
 * (server/connectors/shopify/logSafety.test.ts, #162), which scans them by the
 * same rules. It ships in PR #160; until that merges they are not clean on
 * main, and fixing them here would conflict with it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SERVER = path.resolve(__dirname);

/** How this codebase names a caught error, by convention. */
const CONVENTIONAL_NAMES = ["e", "err", "error", "caught", "cause", "lastError", String.raw`\w+Error`, String.raw`\w+Err`];

/**
 * The names a source actually binds to a caught error, whatever they are: a
 * statement `catch (x)`, `.catch((x) => …)`, and the error of an
 * `.on("error" | "failed", …)` handler.
 */
function caughtNames(source: string): string[] {
  const binders = [
    // Not `.catch(fn)`: a function passed by reference is not an error.
    /(?<!\.)\bcatch\s*\(\s*(\w+)/g,
    /\.catch\(\s*(?:async\s*)?\(?\s*(\w+)\s*(?::\s*\w+\s*)?\)?\s*=>/g,
    /\.on\(\s*["'](?:error|failed)["']\s*,\s*(?:async\s*)?\(\s*(?:\w+\s*,\s*)?(\w+)/g,
  ];
  const names = new Set<string>();
  for (const binder of binders) for (const match of source.matchAll(binder)) names.add(match[1]);
  return [...names];
}

interface ScanPatterns {
  /** A log call leaking an error. */
  log: RegExp[];
  /** Error text copied into a template literal. */
  template: RegExp[];
  /** An error's text read anywhere: `err.message`, `(err as Error).stack`, `String(err)`. */
  reads: RegExp[];
}

/** The three scans' patterns, for the error names in play in one source. */
function patternsFor(source: string): ScanPatterns {
  const name = `(?:${[...CONVENTIONAL_NAMES, ...caughtNames(source)].join("|")})`;
  return {
    log: [
      /\.(?:message|stack)\b/,
      new RegExp(String.raw`String\(\s*${name}\s*\)`),
      new RegExp(String.raw`\$\{\s*${name}\s*\}`),
      // Handed to console whole: an argument, a shorthand property, or a value.
      new RegExp(String.raw`[,(]\s*${name}\s*[,)]`),
      new RegExp(String.raw`[{,]\s*${name}\s*[,}]`),
      new RegExp(String.raw`:\s*${name}\s*[,}]`),
    ],
    template: [/\$\{[^}]*\.(?:message|stack)\b[^}]*\}/, new RegExp(String.raw`\$\{\s*${name}\s*\}`)],
    reads: [
      new RegExp(String.raw`\b${name}\??\.(?:message|stack)\b`),
      new RegExp(String.raw`\(\s*${name}\s+as\s+\w+\s*\)\??\.(?:message|stack)\b`),
      new RegExp(String.raw`\bString\(\s*${name}\s*\)`),
    ],
  };
}

/** The sanctioned calls: their argument is safe by construction, so they are removed before judging. */
const SANCTIONED_CALLS = /\b(?:loggableError|errorSummary|stackFrames)\([^()]*\)/g;

/**
 * Exact expressions a file may contain although a scan would flag them, each
 * with the reason it is safe. Scoped to one file and one expression, never a
 * name or a pattern.
 */
const SANCTIONED: Record<string, { expression: string; reason: string }[]> = {
  "connectors/cbs/csvImport.ts": [
    { expression: "${e.message}", reason: "`e` is a papaparse row error from the tenant's own file, returned to that tenant; papaparse's messages are its own static text" },
  ],
  "ingest/fileParser.ts": [
    { expression: "${e.message}", reason: "`e` is a papaparse row error from the tenant's own file, returned to that tenant; papaparse's messages are its own static text" },
  ],
  "connectors/shopline/auth.ts": [
    { expression: "${json.message}", reason: "SHOPLINE's token-endpoint response body, not a caught error" },
    { expression: "${second.json.message ?? second.text}", reason: "SHOPLINE's token-endpoint response body, not a caught error" },
  ],
  "routers.ts": [
    { expression: '${input.message ?? "None"}', reason: "a contact form's message field, not an error" },
  ],
  "connectors/shopline/settlementImportRequest.ts": [
    { expression: "error.message.slice(0, 2000)", reason: "narrowed by `error instanceof TRPCError`: messages this import constructs, never a database error's" },
  ],
  "demoTimelineRoll.ts": [
    { expression: "reason: err.message", reason: "narrowed by `err instanceof RollAborted`, whose messages are this module's static text" },
  ],
  "routers/poc.ts": [
    { expression: "message: err.message", reason: "narrowed by `err instanceof poc.PocNotFoundError`, whose messages are static" },
  ],
  "routers/woodcoreConnector.ts": [
    { expression: "message: err.message", reason: "narrowed by `err instanceof OnboardingError`: messages built from the operator's own input (email, organisation code)" },
  ],
  "poc-engine.ts": [
    { expression: 'String(err?.message ?? "")', reason: "read only to classify the LLM provider's failure; never logged, stored or returned (the log uses loggableError, the prospect gets fixed text)" },
  ],
};

function withoutSanctioned(text: string, file: string): string {
  let rest = text.replace(SANCTIONED_CALLS, "");
  for (const { expression } of SANCTIONED[file] ?? []) rest = rest.split(expression).join("");
  return rest;
}

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

/** `patterns` come from the whole file the call sits in, so its catch bindings count. */
function leaksInLog(call: string, file = "", patterns = patternsFor(call)): boolean {
  const rest = withoutSanctioned(call, file);
  return patterns.log.some((pattern) => pattern.test(rest));
}

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

function flaggedLines(source: string, file: string, pick: (patterns: ScanPatterns) => RegExp[]): string[] {
  const patterns = pick(patternsFor(source));
  return source
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !isComment(line))
    .filter(({ line }) => {
      const rest = withoutSanctioned(line, file);
      return patterns.some((pattern) => pattern.test(rest));
    })
    .map(({ line, index }) => `${file}:${index + 1}: ${line.trim()}`);
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
    'console.error("x", { detail: err })',
    'console.warn("x", String(error))',
    'console.warn(`x ${err}`)',
    'console.error("x", { ...loggableError(err), stack: err.stack })',
  ])("should flag %s", (call) => {
    expect(leaksInLog(call)).toBe(true);
  });

  it.each([
    'console.error("x", loggableError(err))',
    'console.error("x", { ...loggableError(error), frames: stackFrames(error) })',
    'console.error("x", {\n  storeId,\n  ...loggableError(lastError),\n})',
    'console.error(`[trpc] ${path} failed:`, { ...loggableError(error), frames: stackFrames(error.cause ?? error) })',
    'console.error(`[Scheduler] Task ${task.id} failed: ${result.error}`)',
  ])("should allow %s", (call) => {
    expect(leaksInLog(call)).toBe(false);
  });
});

describe("when an error is caught under a name no convention predicts", () => {
  // Greptile #166: the scans knew only conventional names, so `catch (problem)`
  // logging or storing `problem` would have passed.
  const flaggedLog = (source: string) => logCalls(source).some((call) => leaksInLog(call, "", patternsFor(source)));

  it.each([
    'try { run(); } catch (problem) {\n  console.error("x", problem);\n}',
    "try { run(); } catch (problem: unknown) {\n  console.warn(`x ${problem}`);\n}",
    'run().catch((failure) => console.error("x", failure));',
    'run().catch(async (failure) => {\n  console.error("x", { failure });\n});',
    'worker.on("failed", async (job, reason) => console.error("x", reason));',
  ])("should flag the error logged in %s", (source) => {
    expect(flaggedLog(source)).toBe(true);
  });

  it("should flag the same error's text stored under that name", () => {
    const source = "try { run(); } catch (problem) {\n  row.lastError = problem.message;\n}";
    expect(flaggedLines(source, "", (p) => p.reads)).toHaveLength(1);
  });

  it("should not treat a name as an error unless the code binds one to it", () => {
    expect(flaggedLog('const problem = describeRun();\nconsole.error("x", problem);')).toBe(false);
    // A handler passed by reference names a function, not an error.
    expect(flaggedLog('run().catch(reportFailure);\nconsole.error("x", reportFailure);')).toBe(false);
  });
});

describe("when the ratchet judges a line outside a log", () => {
  it.each([
    "return { success: false, error: String(error) };",
    "errorMessage: error.message,",
    "reason: (e as Error).message };",
    'message: err?.message || "Reconciliation failed."',
    "stack: err instanceof Error ? err.stack : undefined,",
    "throw new Error(`sync failed: ${err.message}`);",
    "errors.push(`${day}: ${err}`);",
  ])("should flag %s", (line) => {
    expect(flaggedLines(line, "", (p) => [...p.reads, ...p.template])).toHaveLength(1);
  });

  it.each([
    "errorMessage: errorSummary(error),",
    "frames: stackFrames(err),",
    'throw new Error("Could not secure tokens", { cause: err });',
    "// a comment may say err.message",
    "const text = json.message;",
  ])("should allow %s", (line) => {
    expect(flaggedLines(line, "", (p) => [...p.reads, ...p.template])).toHaveLength(0);
  });

  it("should allow a sanctioned expression only in the file it is sanctioned for", () => {
    const line = 'if (err instanceof RollAborted) return { status: "refused", reason: err.message } as const;';
    expect(flaggedLines(line, "demoTimelineRoll.ts", (p) => p.reads)).toHaveLength(0);
    expect(flaggedLines(line, "reviewerAccess.ts", (p) => p.reads)).toHaveLength(1);
  });
});

describe("when any server module handles an error", () => {
  const ownRatchet = (rel: string) => rel.startsWith("connectors/shopify/") || /^routers\/shopify\w*\.ts$/.test(rel);
  const helpers = new Set(["dbErrors.ts", "errorText.ts"]);
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.includes("testkit") ? [full] : [];
    });
  }
  const sources = walk(SERVER)
    .map((file) => ({ rel: path.relative(SERVER, file).split(path.sep).join("/"), file }))
    .filter(({ rel }) => !ownRatchet(rel) && !helpers.has(rel))
    .map(({ rel, file }) => ({ rel, source: readFileSync(file, "utf8").replace(/\r\n/g, "\n") }));

  it("should scan the real server, so a clean result means something", () => {
    const names = sources.map(({ rel }) => rel);
    expect(names).toEqual(
      expect.arrayContaining(["routers.ts", "jobQueue.ts", "_core/index.ts", "connectors/shopline/routes.ts", "sftpService.ts"]),
    );
    expect(names.some((rel) => rel.startsWith("connectors/shopify/"))).toBe(false);
    const logs = sources.reduce((sum, { source }) => sum + logCalls(source).length, 0);
    expect(logs).toBeGreaterThan(200);
    // The derived names are really derived: the server binds errors under
    // names no convention lists.
    const unconventional = new Set(sources.flatMap(({ source }) => caughtNames(source)));
    for (const conventional of ["e", "err", "error"]) unconventional.delete(conventional);
    expect(unconventional.size).toBeGreaterThan(0);
  });

  it("should never log an error's raw text", () => {
    const offenders = sources.flatMap(({ rel, source }) => {
      const patterns = patternsFor(source);
      return logCalls(source)
        .filter((call) => leaksInLog(call, rel, patterns))
        .map((call) => `${rel}: ${call.split("\n")[0]}`);
    });
    expect(offenders, "log loggableError(error), never the error or its text").toEqual([]);
  });

  it("should never copy an error's text into a new message", () => {
    const offenders = sources.flatMap(({ rel, source }) => flaggedLines(source, rel, (p) => p.template));
    expect(offenders, "keep static text; pass the failure as { cause }").toEqual([]);
  });

  it("should never store or return an error's text", () => {
    const offenders = sources.flatMap(({ rel, source }) => flaggedLines(source, rel, (p) => p.reads));
    expect(offenders, "store or return errorSummary(error)").toEqual([]);
  });

  it("should sanction only expressions that are still there", () => {
    // A stale entry would silently license the next line that happens to match it.
    const stale = Object.entries(SANCTIONED).flatMap(([rel, entries]) => {
      const source = sources.find((s) => s.rel === rel)?.source ?? "";
      return entries.filter(({ expression }) => !source.includes(expression)).map(({ expression }) => `${rel}: ${expression}`);
    });
    expect(stale).toEqual([]);
  });
});
