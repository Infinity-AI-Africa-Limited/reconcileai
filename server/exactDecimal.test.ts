/**
 * The exact-decimal reader in shared/money.ts: the strict counterpart of
 * parseMoney, for totals a contract states and that must compare exactly.
 * (Tests live here because vitest does not collect shared/.)
 */
import { describe, expect, it } from "vitest";
import { exactDecimalsEqual, parseExactDecimal } from "../shared/money";

function equal(left: string, right: string): boolean {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  if (!a || !b) throw new Error(`fixture is not canonical: ${left} / ${right}`);
  return exactDecimalsEqual(a, b);
}

describe("when a canonical decimal is read", () => {
  it.each([
    ["1250.10", 125010n, 2],
    ["1250.125", 1250125n, 3],
    ["0", 0n, 0],
    ["-12.5", -125n, 1],
    ["+7", 7n, 0],
    [" 42.00 ", 4200n, 2],
  ] as const)("should read %s exactly", (raw, units, scale) => {
    expect(parseExactDecimal(raw)).toEqual({ units, scale });
  });

  it.each([
    ["grouping", "1,250.10"],
    ["a currency symbol", "₦1250.10"],
    ["an accounting negative", "(12.30)"],
    ["a decimal comma", "1250,10"],
    ["two points", "1.2.3"],
    ["no whole part", ".5"],
    ["no fraction after the point", "5."],
    ["an exponent", "1e3"],
    ["nothing", ""],
    ["only spaces", "   "],
    ["an absurd length", "9".repeat(65)],
  ])("should refuse %s", (_label, raw) => {
    expect(parseExactDecimal(raw)).toBeNull();
  });

  it.each([
    ["a number, which has already been through a float", 1250.1],
    ["null", null],
    ["undefined", undefined],
  ])("should refuse %s", (_label, raw) => {
    expect(parseExactDecimal(raw)).toBeNull();
  });
});

describe("when two exact decimals are compared", () => {
  it("should treat the same amount at different scales as equal", () => {
    expect(equal("1250.1", "1250.10")).toBe(true);
    expect(equal("1250.1", "1250.100")).toBe(true);
    expect(equal("-0", "0.00")).toBe(true);
  });

  it("should tell apart amounts that differ in any decimal place", () => {
    expect(equal("1250.125", "1250.126")).toBe(false);
    expect(equal("1250.10", "-1250.10")).toBe(false);
  });

  it("should stay exact beyond the range a float can hold", () => {
    // 2^53 + 1 rounds to 2^53 as a float, so a float comparison calls these
    // equal; as money they are a whole unit apart.
    expect(Number("9007199254740993.00")).toBe(Number("9007199254740992.00"));
    expect(equal("9007199254740993.00", "9007199254740992.00")).toBe(false);
    expect(equal("9007199254740993.00", "9007199254740993.000")).toBe(true);
  });
});
