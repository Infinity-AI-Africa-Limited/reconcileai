/**
 * Who the operator is must have exactly ONE definition.
 *
 * Two controls need to tell the operator's own organisation apart from a tenant,
 * and both originally answered with `segment === "super_admin"` — a mutable
 * property any admin can reassign. Both failed in the unsafe direction: SLA
 * alerting would have gone silent on a retyped customer, and the reviewer gate
 * would have kept a cross-tenant link live over that customer's data.
 *
 * They were fixed a day apart, in separate pull requests, and each briefly
 * declared its own copy of the answer. That is the shape CLAUDE.md §18 warns
 * about in a different context: two values holding one thing IS the drift
 * surface. A future correction applied to one copy and not the other reproduces
 * exactly the bug that was just fixed, in whichever control was missed.
 *
 * This file exists so that cannot happen quietly.
 *
 * It lives in `server/` deliberately. `shared/**` is NOT in the vitest include
 * list, so the natural home next to the module would have been collected by
 * nothing — an uncollected test is the same as no test.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { OPERATOR_ORG_CODE, isOperatorOrg } from "@shared/operatorOrg";
import { OPERATOR_ORG_CODE as SLA_OPERATOR_ORG_CODE } from "./slaMonitoringService";

const ROOT = path.join(__dirname, "..");

/** Every source file that could hold a second copy of the answer. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  for (const dir of ["server", "shared", "client/src", "scripts", "tools"]) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) walk(full);
  }
  return out;
}

describe("when code needs to know which organisation is the operator", () => {
  it("should define the code in exactly one place", () => {
    // The literal, not the identifier. Importing the constant is the point;
    // re-typing its VALUE somewhere else is the drift.
    const declarers = sourceFiles()
      .filter((f) => fs.readFileSync(f, "utf8").includes(`"${OPERATOR_ORG_CODE}"`))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));

    expect(
      declarers,
      `"${OPERATOR_ORG_CODE}" must be written once, in shared/operatorOrg.ts, and imported everywhere else. ` +
        `Found in: ${declarers.join(", ")}`,
    ).toEqual(["shared/operatorOrg.ts"]);
  });

  it("should give SLA monitoring and the reviewer gate the same answer", () => {
    // slaMonitoringService re-exports rather than declaring, so its importers
    // kept working. This asserts the re-export is actually wired to the shared
    // module and not a same-looking string.
    expect(SLA_OPERATOR_ORG_CODE).toBe(OPERATOR_ORG_CODE);
  });

  it("should not answer the question with a segment", () => {
    // The defect, named. A segment is a category anything can be moved into;
    // identity has to be a property of the one organisation.
    const identity = fs.readFileSync(path.join(ROOT, "shared/operatorOrg.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(identity).toContain("code");
    expect(identity).not.toContain("segment");
  });

  it("should treat a missing code as a tenant, not as the operator", () => {
    // Direction matters: "we could not tell" must land on "this is a tenant",
    // because the alternative drops an organisation out of a control because a
    // field happened to be empty.
    expect(isOperatorOrg({ code: null })).toBe(false);
    expect(isOperatorOrg({ code: undefined })).toBe(false);
    expect(isOperatorOrg({ code: "" })).toBe(false);
  });
});
