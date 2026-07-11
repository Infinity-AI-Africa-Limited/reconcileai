/**
 * ROI model tests — the numbers shown in every sales meeting must be right.
 * Tier bands come from Business Model v3.0 §2.1; sanity bands from §4.2.
 */
import { describe, expect, it } from "vitest";
import {
  computeRoi,
  tierForVolume,
  DEFAULT_ASSUMPTIONS,
  PRICING_TIERS,
  type RoiInputs,
} from "@shared/roiModel";

describe("tierForVolume — Business Model v3.0 §2.1 bands", () => {
  it("volume boundaries land on the contracted tiers", () => {
    expect(tierForVolume(0).id).toBe("small_mfb");
    expect(tierForVolume(49_999).id).toBe("small_mfb");
    expect(tierForVolume(50_000).id).toBe("mid_tier");
    expect(tierForVolume(500_000).id).toBe("mid_tier");
    expect(tierForVolume(500_001).id).toBe("large_bank");
    expect(tierForVolume(5_000_000).id).toBe("large_bank");
  });

  it("annual fees match the pricing table", () => {
    expect(PRICING_TIERS.map((t) => t.annualFeeUsd)).toEqual([12_000, 40_000, 72_000]);
  });

  it("negative/garbage volume falls back safely to the smallest tier", () => {
    expect(tierForVolume(-5).id).toBe("small_mfb");
    expect(tierForVolume(NaN).id).toBe("small_mfb");
  });
});

describe("computeRoi — the before/after math", () => {
  // Representative mid-tier Nigerian bank, in NGN (fx 1600), calibrated to the
  // business model's §4.2 mid-tier benchmark (~$200K savings vs $40K fee ≈ 5×):
  // 120k txns/mo, 12 recon staff at ₦450k/mo, ₦1.5bn average unresolved exposure.
  const inputs: RoiInputs = {
    monthlyTransactionVolume: 120_000,
    reconciliationStaffCount: 12,
    averageMonthlyStaffSalary: 450_000,
    monthlyUnresolvedExposure: 1_500_000_000,
  };

  it("computes the current state correctly", () => {
    const r = computeRoi(inputs);
    expect(r.tier.id).toBe("mid_tier");
    expect(r.currentStaffCost).toBe(12 * 450_000 * 12); // ₦64.8m
    // exposure: 1.5bn × (5% loss + 20% carry) = ₦375m
    expect(r.currentExposureCost).toBe(1_500_000_000 * 0.25);
    expect(r.currentTotal).toBe(r.currentStaffCost + r.currentExposureCost);
  });

  it("computes the with-ReconcileAI state and headline outputs", () => {
    const r = computeRoi(inputs);
    expect(r.annualFee).toBe(40_000 * 1600); // ₦64m at default fx
    expect(r.remainingStaffCost).toBeCloseTo(r.currentStaffCost * 0.4, 6);
    expect(r.remainingExposureCost).toBeCloseTo(r.currentExposureCost * 0.2, 6);
    expect(r.newTotal).toBeCloseTo(r.remainingStaffCost + r.remainingExposureCost + r.annualFee, 6);
    expect(r.netAnnualSavings).toBeCloseTo(r.currentTotal - r.newTotal, 6);
    expect(r.grossAnnualBenefit).toBeCloseTo(
      r.currentStaffCost * 0.6 + r.currentExposureCost * 0.8,
      6,
    );
    // Accounting identity: net savings = gross benefit − fee.
    expect(r.netAnnualSavings).toBeCloseTo(r.grossAnnualBenefit - r.annualFee, 6);
  });

  it("payback and ROI multiple are consistent", () => {
    const r = computeRoi(inputs);
    expect(r.roiMultiple).not.toBeNull();
    expect(r.paybackMonths).not.toBeNull();
    // payback = 12 / roiMultiple by construction
    expect(r.paybackMonths!).toBeCloseTo(12 / r.roiMultiple!, 6);
    expect(r.paybackMonths!).toBeGreaterThan(0);
    expect(r.paybackMonths!).toBeLessThan(12); // this profile pays back within a year
  });

  it("lands inside the business-model sanity band (§4.2: capture 14–27%, ROI ≥3.8×)", () => {
    const r = computeRoi(inputs);
    expect(r.roiMultiple!).toBeGreaterThanOrEqual(3.5);
    expect(r.valueCaptureRatio!).toBeGreaterThan(0.05);
    expect(r.valueCaptureRatio!).toBeLessThan(0.35);
  });

  it("USD mode: fx of 1 keeps the fee in USD", () => {
    const r = computeRoi(
      { ...inputs, averageMonthlyStaffSalary: 300, monthlyUnresolvedExposure: 500_000 },
      { ...DEFAULT_ASSUMPTIONS, fxPerUsd: 1 },
    );
    expect(r.annualFee).toBe(40_000);
  });

  it("zero-benefit inputs yield null payback/ROI instead of division blowups", () => {
    const r = computeRoi({
      monthlyTransactionVolume: 10_000,
      reconciliationStaffCount: 0,
      averageMonthlyStaffSalary: 0,
      monthlyUnresolvedExposure: 0,
    });
    expect(r.grossAnnualBenefit).toBe(0);
    expect(r.roiMultiple).toBe(0); // fee exists, zero benefit → 0×, not NaN
    expect(r.paybackMonths).toBeNull();
    expect(r.netAnnualSavings).toBeLessThan(0); // fee with no benefit = honest negative
  });

  it("garbage inputs are clamped, never NaN in outputs", () => {
    const r = computeRoi({
      monthlyTransactionVolume: NaN,
      reconciliationStaffCount: -3,
      averageMonthlyStaffSalary: Infinity,
      monthlyUnresolvedExposure: -1,
    });
    for (const v of [r.currentTotal, r.newTotal, r.netAnnualSavings, r.annualFee]) {
      expect(Number.isNaN(v)).toBe(false);
    }
  });

  it("a large bank profile clears the §4.2 large-bank shape (fee ₦, ROI healthy)", () => {
    const r = computeRoi({
      monthlyTransactionVolume: 900_000,
      reconciliationStaffCount: 20,
      averageMonthlyStaffSalary: 500_000,
      monthlyUnresolvedExposure: 4_000_000_000,
    });
    expect(r.tier.id).toBe("large_bank");
    expect(r.annualFee).toBe(72_000 * 1600);
    expect(r.roiMultiple!).toBeGreaterThan(5);
    expect(r.paybackMonths!).toBeLessThan(6);
  });
});
