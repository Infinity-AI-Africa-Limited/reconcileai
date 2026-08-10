/**
 * CBN compliance health thresholds.
 *
 * This decides whether an institution's dashboard reads "CBN Compliant" or
 * "CBN At Risk", so the interesting cases are the boundaries and the empty
 * tenant — where a naive implementation divides by zero and reports a verdict
 * it has no basis for.
 */
import { describe, it, expect } from "vitest";
import { evaluateCbnHealth, CBN_THRESHOLDS } from "./cbnHealth";

describe("evaluateCbnHealth", () => {
  describe("when the tenant has no transactions", () => {
    const health = evaluateCbnHealth({
      totalTransactions: 0,
      matchedTransactions: 0,
      openExceptions: 0,
    });

    it("should report that there is nothing to assess", () => {
      expect(health.hasData).toBe(false);
    });

    it("should not produce NaN ratios", () => {
      // 0/0 is NaN, and `NaN >= 95` is false — so an empty tenant would render
      // "CBN At Risk" instead of no verdict at all.
      expect(Number.isNaN(health.matchRatePct)).toBe(false);
      expect(Number.isNaN(health.exceptionRatioPct)).toBe(false);
    });
  });

  describe("when every threshold is met", () => {
    it("should report compliant", () => {
      const health = evaluateCbnHealth({
        totalTransactions: 1000,
        matchedTransactions: 990, // 99%
        openExceptions: 10, // 1% ratio, under the 50 cap
      });
      expect(health.hasData).toBe(true);
      expect(health.compliant).toBe(true);
    });
  });

  describe("when the match rate sits exactly on the threshold", () => {
    it("should report compliant, since the rule is 'at least'", () => {
      const health = evaluateCbnHealth({
        totalTransactions: 100,
        matchedTransactions: CBN_THRESHOLDS.minMatchRatePct, // exactly 95%
        openExceptions: 0,
      });
      expect(health.compliant).toBe(true);
    });
  });

  describe("when the match rate falls a hair below the threshold", () => {
    it("should report non-compliant", () => {
      const health = evaluateCbnHealth({
        totalTransactions: 1000,
        matchedTransactions: 949, // 94.9%
        openExceptions: 0,
      });
      expect(health.compliant).toBe(false);
    });
  });

  describe("when the open-exception COUNT breaches the cap despite a good ratio", () => {
    it("should report non-compliant", () => {
      // 100k transactions makes 60 exceptions a 0.06% ratio — well inside the
      // ratio rule. The absolute cap is what catches it, and it is easy to drop
      // when someone "simplifies" this to a single percentage.
      const health = evaluateCbnHealth({
        totalTransactions: 100_000,
        matchedTransactions: 99_900,
        openExceptions: CBN_THRESHOLDS.maxOpenExceptions + 10,
      });
      expect(health.exceptionRatioPct).toBeLessThan(CBN_THRESHOLDS.maxExceptionRatioPct);
      expect(health.compliant).toBe(false);
    });
  });

  describe("when the exception RATIO breaches the threshold", () => {
    it("should report non-compliant", () => {
      const health = evaluateCbnHealth({
        totalTransactions: 100,
        matchedTransactions: 100,
        openExceptions: 10, // 10% ratio
      });
      expect(health.compliant).toBe(false);
    });
  });
});
