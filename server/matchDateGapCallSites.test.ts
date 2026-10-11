/**
 * The call sites, not just the formatter.
 *
 * `shared/matchDateGap.ts` has its own tests, but the defect was never in a
 * formatter — it was three call sites each coercing a null date gap to `0`
 * with `?? 0` or `|| 0`. A test of the helper alone would have stayed green
 * through the entire bug, and would stay green again if someone wrote the
 * coercion back.
 *
 * So this reads the source of the surfaces that render a match's date gap and
 * asserts none of them flattens it. A regex ratchet is brittle by nature, so
 * it is deliberately narrow: it looks only for a coercion applied to
 * `dateDifference`, and the export procedures live too deep inside
 * `server/routers.ts` (tRPC + a full reconciliation report) to be invoked from
 * a unit test, which is the same reason `moduleScope.test.ts` guards its rule
 * this way.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Every surface that renders or exports a match's date gap. */
const SURFACES = [
  "server/routers.ts",
  "client/src/pages/Reconciliation.tsx",
] as const;

/**
 * `dateDifference ?? 0`, `dateDifference || 0`, and the same through a member
 * access such as `m.dateDifference ?? 0`. Whitespace and the variable prefix
 * vary; the coercion is what matters.
 */
const COERCION = /dateDifference\s*(\?\?|\|\|)\s*0/;

describe("when a surface renders a match's date gap", () => {
  for (const file of SURFACES) {
    it(`should not coerce an unknown gap to zero in ${file}`, () => {
      // Zero days is the strongest claim available about a date gap — it says
      // the two legs agree exactly — so asserting it where nothing is known is
      // a confident wrong number, which in an export is worse than a blank.
      expect(read(file)).not.toMatch(COERCION);
    });
  }

  it("should route each surface through the shared rule", () => {
    // Not merely "no coercion": a surface that dropped the field entirely
    // would also pass the check above.
    const routers = read("server/routers.ts");
    expect(routers).toContain("dateGapCsvCell(m.dateDifference)");
    expect(routers).toContain("dateGapSheetCell(m.dateDifference)");
    expect(read("client/src/pages/Reconciliation.tsx")).toContain(
      "dateGapLabel(m.dateDifference)"
    );
  });

  it("should prove the pattern can actually fail", () => {
    // A ratchet nobody has seen fail is decoration. These are the three forms
    // the bug took in the three files it was found in.
    expect("dateDifference ?? 0").toMatch(COERCION);
    expect("m.dateDifference || 0").toMatch(COERCION);
    expect("{m.dateDifference||0} days").toMatch(COERCION);
    // And a legitimate use must not trip it.
    expect("dateGapSheetCell(m.dateDifference)").not.toMatch(COERCION);
  });
});
