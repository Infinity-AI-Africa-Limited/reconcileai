/**
 * Segment identity checks.
 *
 * The behaviour that matters is what happens at the boundaries: an unknown
 * string, and a segment that has not resolved yet. Both must come out as null /
 * false rather than accidentally matching, because a wrong answer here renders
 * a perfectly-formed screen belonging to another vertical.
 */
import { describe, it, expect } from "vitest";
import {
  toSegment,
  isFinancialServices,
  isCorporateB2B,
  isRetailCommerce,
  type Segment,
} from "./segments";

const ALL: Segment[] = ["financial_services", "corporate_b2b", "retail_commerce", "super_admin"];

describe("toSegment", () => {
  describe("when given a known segment", () => {
    it("should return it unchanged", () => {
      for (const s of ALL) expect(toSegment(s)).toBe(s);
    });
  });

  describe("when given a value that is not a segment", () => {
    it("should return null rather than passing the value through", () => {
      // A cast would let a renamed or misspelled segment flow onward, and every
      // check would then quietly return false — indistinguishable from a
      // correctly hidden surface.
      expect(toSegment("retail")).toBeNull();
      expect(toSegment("Financial_Services")).toBeNull();
      expect(toSegment("")).toBeNull();
    });
  });

  describe("when the segment has not resolved yet", () => {
    it("should return null for null and undefined", () => {
      expect(toSegment(null)).toBeNull();
      expect(toSegment(undefined)).toBeNull();
    });
  });
});

describe("isFinancialServices", () => {
  describe("when the org is a financial institution", () => {
    it("should be true", () => {
      expect(isFinancialServices("financial_services")).toBe(true);
    });
  });

  describe("when the org belongs to any other vertical", () => {
    it("should be false", () => {
      for (const s of ALL.filter((x) => x !== "financial_services")) {
        expect(isFinancialServices(s), `${s} is not a financial institution`).toBe(false);
      }
    });
  });

  describe("when the segment has not resolved yet", () => {
    it("should be false, so a CBN status is never asserted on a guess", () => {
      expect(isFinancialServices(null)).toBe(false);
    });
  });
});

describe("isCorporateB2B", () => {
  describe("when the org is an FMCG / corporate B2B tenant", () => {
    it("should be true", () => {
      expect(isCorporateB2B("corporate_b2b")).toBe(true);
    });
  });

  describe("when the org belongs to any other vertical", () => {
    it("should be false", () => {
      for (const s of ALL.filter((x) => x !== "corporate_b2b")) {
        expect(isCorporateB2B(s), `${s} has no distributor registry`).toBe(false);
      }
    });
  });

  describe("when the segment has not resolved yet", () => {
    it("should be false", () => {
      expect(isCorporateB2B(null)).toBe(false);
    });
  });
});

describe("isRetailCommerce", () => {
  describe("when the org is a retail merchant", () => {
    it("should be true", () => {
      expect(isRetailCommerce("retail_commerce")).toBe(true);
    });
  });

  describe("when the org belongs to any other vertical", () => {
    it("should be false", () => {
      for (const s of ALL.filter((x) => x !== "retail_commerce")) {
        expect(isRetailCommerce(s)).toBe(false);
      }
    });
  });

  describe("when the segment has not resolved yet", () => {
    it("should be false, so a negated caller keeps showing navigation while loading", () => {
      // The Auditor menu item is gated on `!isRetailCommerce(segment)`.
      // Returning false here is what keeps that item visible during load, which
      // is the intended trade: briefly showing a nav item beats briefly removing
      // one from someone entitled to it.
      expect(isRetailCommerce(null)).toBe(false);
    });
  });
});
