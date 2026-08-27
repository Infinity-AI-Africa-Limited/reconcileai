/**
 * Documentation must LINK to an operational script, never reproduce it.
 *
 * `scripts/bootstrap-admin.mjs` mints a super_admin and prints a working sign-in
 * link. It was gated on `DEPLOYMENT_MODE=on_premise`, and the gate held — but
 * two documents carried a full paste-me copy of the script, and those copies
 * kept the old behaviour. The runbook literally instructed the operator to
 * "Create scripts/bootstrap-admin.mjs", so following the documentation produced
 * an ungated twin of a privilege-granting tool. The file has shipped in the
 * repository and in the on-prem image for some time; the instruction was stale.
 *
 * Patching each copy to carry the gate would have recreated the same drift on
 * the next change, so the copies were removed. This keeps them gone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Prose about a script is fine. An executable reproduction of one is not. */
const EXECUTABLE_MARKERS = [
  "mysql.createConnection",
  "await conn.execute",
  'from "mysql2/promise"',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(md|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("when documentation describes an operational script", () => {
  it("should not embed an executable copy of it", () => {
    // Scoped to the documentation surfaces: docs/ and the token-gated pages
    // served from server/content/. Both held a copy.
    const files = [
      ...walk(path.join(ROOT, "docs")),
      ...walk(path.join(ROOT, "server", "content")),
    ];

    const offenders = files.filter((f) => {
      const text = readFileSync(f, "utf8");
      if (!/bootstrap-admin/.test(text)) return false;
      // A copy is recognisable by doing the script's actual work, not by
      // mentioning it. Two markers, so a one-line illustrative snippet passes.
      return EXECUTABLE_MARKERS.filter((m) => text.includes(m)).length >= 2;
    });

    expect(
      offenders.map((f) => path.relative(ROOT, f)),
      "These documents reproduce bootstrap-admin.mjs instead of pointing at it. " +
        "A copy cannot inherit the DEPLOYMENT_MODE=on_premise gate, so following " +
        "the document yields an ungated tool that grants super_admin. Link to the " +
        "shipped script — it is in the repo and in the on-prem image.",
    ).toEqual([]);
  });

  it("should not instruct the reader to create a script that already ships", () => {
    // The specific stale instruction that produced the ungated twin.
    const files = [
      ...walk(path.join(ROOT, "docs")),
      ...walk(path.join(ROOT, "server", "content")),
    ];
    const offenders = files.filter((f) =>
      /Create\s+`?scripts\/bootstrap-admin\.mjs`?/i.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
