/**
 * No Express route may do async work outside a `try` without `asyncHandler`.
 *
 * Express 4 lets a rejected handler promise reach the process, and Node 22
 * exits on it. The eighth such handler would be as fatal as the first, so this
 * is a rule rather than a one-off fix: every route is either `try`-wrapped end
 * to end (it answers its own failures) or wrapped in `asyncHandler`.
 *
 * The check is an AST walk, not a regex — a regex cannot tell an `await` inside
 * a `try` from one outside it, which is the whole question.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { scanFile } from "../tools/scanAsyncHandlers";

const SERVER = path.resolve(__dirname);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts")) acc.push(full);
  }
  return acc;
}

/** Files that actually register routes — the rest cannot violate the rule. */
function routeFiles(): string[] {
  return sourceFiles(SERVER).filter(f => /\b(app|router|api)\.(get|post|put|patch|delete|all|use)\s*\(/.test(readFileSync(f, "utf8")));
}

describe("when a route handler does async work outside a try", () => {
  it("should find route files to check, so this cannot pass vacuously", () => {
    expect(routeFiles().length).toBeGreaterThan(0);
  });

  it("should be wrapped in asyncHandler, without exception", () => {
    const unwrapped = routeFiles()
      .flatMap(f => scanFile(f))
      .filter(e => !e.wrapped)
      .map(e => `${path.relative(SERVER, e.file)}:${e.line} ${e.route} — ${e.expression}`);

    expect(
      unwrapped,
      "Wrap the handler in asyncHandler(...) from _core/asyncHandler, or move the work inside a try/catch that answers the caller",
    ).toEqual([]);
  });

  it("should recognise an unwrapped handler when it sees one", () => {
    // Guards the guard. Without this, a scanner that silently returned nothing
    // would make the assertion above pass forever.
    const sample = `
      app.get("/x", async (req, res) => {
        const mod = await import("./thing");
        res.json(mod.value);
      });
    `;
    const found = scanFile("sample.ts", sample);
    expect(found).toHaveLength(1);
    expect(found[0].wrapped).toBe(false);

    const wrapped = scanFile("sample.ts", sample.replace("async (req, res)", "asyncHandler(async (req, res)").replace("});\n    ", "}));\n    "));
    expect(wrapped[0]?.wrapped).toBe(true);
  });

  it("should not flag a handler whose body is entirely inside a try", () => {
    const guarded = `
      app.post("/y", async (req, res) => {
        try {
          const mod = await import("./thing");
          res.json(mod.value);
        } catch (err) {
          res.status(500).json({ error: "nope" });
        }
      });
    `;
    expect(scanFile("sample.ts", guarded)).toEqual([]);
  });

  it("should not be fooled by a try WITHOUT a catch", () => {
    // `try { … } finally { … }` re-throws: the rejection still escapes.
    const finallyOnly = `
      app.post("/z", async (req, res) => {
        try {
          await work();
          res.end();
        } finally {
          cleanup();
        }
      });
    `;
    expect(scanFile("sample.ts", finallyOnly)).toHaveLength(1);
  });
});
