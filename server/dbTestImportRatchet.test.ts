/**
 * A *.db.test.ts suite runs only when DATABASE_URL is provably local, but its
 * module-scope imports run whenever the file is collected. Importing the main
 * router starts its boot services: the scheduler, the pollers, and the demo
 * pre-warm, which writes. So a static import of it in such a suite starts them
 * against wherever DATABASE_URL points, production included, while every test
 * reports "skipped" (Greptile, #222). Load it inside the guarded beforeAll:
 *
 *   ({ appRouter } = await import("./routers"));
 *
 * Only the suites that gate on the database are scanned. Other tests that
 * import the router at module scope carry the same hazard; the structural fix
 * is to stop the router starting services when it is imported.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SERVER = path.resolve(__dirname);
const STATIC_ROUTER_IMPORT = /^\s*import\s+(?:[^;]*?\s+from\s+)?["'](?:\.\.?\/)+routers(?:\.ts)?["']/m;

function dbSuites(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : dbSuites(full);
    return entry.name.endsWith(".db.test.ts") ? [full] : [];
  });
}

describe("when a database suite needs the router", () => {
  it("should load it only after the suite's guard, never at module scope", () => {
    const offenders = dbSuites(SERVER)
      .filter((file) => STATIC_ROUTER_IMPORT.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SERVER, file));
    expect(offenders, "Import the router inside the guarded beforeAll; see this file's header.").toEqual([]);
  });

  it("should recognise the import it forbids", () => {
    expect(STATIC_ROUTER_IMPORT.test('import { appRouter } from "./routers";')).toBe(true);
    expect(STATIC_ROUTER_IMPORT.test('import "../routers";')).toBe(true);
    expect(STATIC_ROUTER_IMPORT.test('import { x } from "./routers/shared";')).toBe(false);
    expect(STATIC_ROUTER_IMPORT.test('type AppRouter = (typeof import("./routers"))["appRouter"];')).toBe(false);
  });
});
