import { describe, it, expect } from "vitest";
import { statusFor, BENCHMARKS } from "./pocKpi";

describe("pocKpi — statusFor benchmark classification", () => {
  it("no value yields no_data", () => {
    expect(statusFor(null, 95, 85, true)).toBe("no_data");
  });

  describe("higher-is-better metrics (e.g. Auto-Match Rate: target 95, floor 85)", () => {
    it("at or above target → above_target", () => {
      expect(statusFor(95, 95, 85, true)).toBe("above_target");
      expect(statusFor(99, 95, 85, true)).toBe("above_target");
    });
    it("between floor and target → between", () => {
      expect(statusFor(90, 95, 85, true)).toBe("between");
      expect(statusFor(85, 95, 85, true)).toBe("between"); // floor is inclusive
    });
    it("below floor → below_floor", () => {
      expect(statusFor(80, 95, 85, true)).toBe("below_floor");
    });
  });

  describe("lower-is-better metrics (e.g. False Positive Rate: target 2, floor 5)", () => {
    it("at or below target → above_target (on target)", () => {
      expect(statusFor(2, 2, 5, false)).toBe("above_target");
      expect(statusFor(0, 2, 5, false)).toBe("above_target");
    });
    it("between target and floor → between", () => {
      expect(statusFor(4, 2, 5, false)).toBe("between");
      expect(statusFor(5, 2, 5, false)).toBe("between"); // floor is inclusive
    });
    it("above floor → below_floor", () => {
      expect(statusFor(10, 2, 5, false)).toBe("below_floor");
    });
  });

  it("benchmark table marks rate metrics' direction correctly", () => {
    expect(BENCHMARKS.autoMatchRate.higherIsBetter).toBe(true);
    expect(BENCHMARKS.falsePositiveRate.higherIsBetter).toBe(false);
    expect(BENCHMARKS.escalationRate.higherIsBetter).toBe(false);
    expect(BENCHMARKS.auditTrailComplete.target).toBe(100);
  });
});
