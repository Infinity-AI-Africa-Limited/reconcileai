/**
 * The class, not the instance: nothing may derive the client address itself.
 *
 * Six call sites each read `X-Forwarded-For`'s first entry, which is the entry
 * the caller controls. They were fixed together; this keeps the seventh from
 * being written. The rule is simple enough to scan for — a file that wants the
 * client's address asks `_core/clientIp.ts` for it, and nothing else splits the
 * header.
 *
 * Proven to fail: restoring the old expression in any scanned file turns this
 * red (see the PR). A ratchet nobody has watched fail is decoration.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SERVER_DIR = path.resolve(__dirname);

/**
 * `_core/clientIp.ts` is the one file allowed to mention the shape: its own
 * doc comment explains what it replaced. Tests may build request fixtures.
 */
const EXEMPT = new Set([path.join("_core", "clientIp.ts")]);

/** `…["x-forwarded-for"]…split(",")[0]` — the expression being retired. */
const FIRST_ENTRY = /x-forwarded-for[\s\S]{0,120}?split\(\s*["'],["']\s*\)\s*(?:\?\.)?\[\s*0\s*\]/i;

/** The four files whose call sites were rewritten — the positive half of the rule. */
const MUST_USE_HELPER = [
  path.join("_core", "index.ts"),
  path.join("_core", "sso.ts"),
  path.join("_core", "storageProxy.ts"),
  path.join("routers", "shared.ts"),
  path.join("api", "gateway.ts"),
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".spec.ts")) continue;
    if (EXEMPT.has(path.relative(SERVER_DIR, full))) continue;
    acc.push(full);
  }
  return acc;
}

describe("when a file needs the client's address", () => {
  const files = sourceFiles(SERVER_DIR);

  it("should scan a meaningful number of files", () => {
    // Guards the guard: a broken walk would pass this suite vacuously.
    expect(files.length).toBeGreaterThan(50);
  });

  it("should never read the first X-Forwarded-For entry", () => {
    const offenders = files
      .filter(f => FIRST_ENTRY.test(readFileSync(f, "utf8")))
      .map(f => path.relative(SERVER_DIR, f));
    expect(offenders, "use clientIp()/clientIpOrUnknown() from _core/clientIp.ts instead").toEqual([]);
  });

  it("should recognise the retired expression when it sees one", () => {
    // The negative assertion above is only worth its runtime if the pattern
    // actually matches the code it is meant to catch.
    expect(
      FIRST_ENTRY.test(
        '        const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress;',
      ),
    ).toBe(true);
    expect(FIRST_ENTRY.test('const ip = clientIpOrUnknown(req);')).toBe(false);
  });

  it("should get it from the shared helper in every file that was fixed", () => {
    for (const rel of MUST_USE_HELPER) {
      const src = readFileSync(path.join(SERVER_DIR, rel), "utf8");
      expect(src, rel).toMatch(/from "(?:\.\.\/_core|\.)\/clientIp"/);
    }
  });
});
