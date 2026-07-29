/**
 * ROI model tests — the numbers shown in every sales meeting must be right.
 * Tiers, bands and volume cut-offs come from the "Anchored to Confirmed
 * Budgets" pricing model (Starter / Growth / Enterprise, quoted monthly).
 */
import { describe, expect, it } from "vitest";
import {
  annualFeeUsd,
  computeRoi,
  monthlyFeeUsd,
  tierForVolume,
  DEFAULT_ASSUMPTIONS,
  PRICING_TIERS,
  type RoiInputs,
} from "@shared/roiModel";

describe("tierForVolume — pricing-model volume bands", () => {
  it("volume boundaries land on the contracted tiers", () => {
    expect(tierForVolume(0).id).toBe("starter");
    expect(tierForVolume(500_000).id).toBe("starter");
    expect(tierForVolume(2_000_000).id).toBe("starter");
    expect(tierForVolume(2_000_001).id).toBe("growth");
    expect(tierForVolume(10_000_000).id).toBe("growth");
    expect(tierForVolume(10_000_001).id).toBe("enterprise");
    expect(tierForVolume(50_000_000).id).toBe("enterprise");
  });

  it("monthly fee bands match the pricing table", () => {
    expect(PRICING_TIERS.map((t) => [t.monthlyFeeUsdMin, t.monthlyFeeUsdMax])).toEqual([
      [1_000, 2_000],
      [2_500, 5_000],
      [7_000, 14_000],
    ]);
  });

  it("the bands are contiguous — no volume falls between two tiers", () => {
    for (let i = 1; i < PRICING_TIERS.length; i++) {
      expect(PRICING_TIERS[i].minMonthlyTxns).toBe(PRICING_TIERS[i - 1].maxMonthlyTxns! + 1);
    }
    expect(PRICING_TIERS[0].minMonthlyTxns).toBe(0);
    expect(PRICING_TIERS[PRICING_TIERS.length - 1].maxMonthlyTxns).toBeNull();
  });

  it("negative/garbage volume falls back safely to the smallest tier", () => {
    expect(tierForVolume(-5).id).toBe("starter");
    expect(tierForVolume(NaN).id).toBe("starter");
  });
});

describe("fee band positions", () => {
  const growth = PRICING_TIERS[1];

  it("entry / mid / top pick the right point of the band", () => {
    expect(monthlyFeeUsd(growth, "entry")).toBe(2_500);
    expect(monthlyFeeUsd(growth, "mid")).toBe(3_750);
    expect(monthlyFeeUsd(growth, "top")).toBe(5_000);
  });

  it("defaults to the top of the band — ROI is never overstated", () => {
    expect(monthlyFeeUsd(growth)).toBe(growth.monthlyFeeUsdMax);
    expect(DEFAULT_ASSUMPTIONS.feeBandPosition).toBe("top");
  });

  it("annualises as 12 monthly payments", () => {
    expect(annualFeeUsd(growth, "top")).toBe(5_000 * 12);
  });
});

describe("computeRoi — the before/after math", () => {
  // Representative mid-tier MFB / FinTech (the Growth tier), in NGN at the
  // pricing model's ₦1,400/USD: 3m txns/mo, 12 recon staff at ₦450k/mo,
  // ₦1.5bn average unresolved exposure.
  const inputs: RoiInputs = {
    monthlyTransactionVolume: 3_000_000,
    reconciliationStaffCount: 12,
    averageMonthlyStaffSalary: 450_000,
    monthlyUnresolvedExposure: 1_500_000_000,
  };

  it("computes the current state correctly", () => {
    const r = computeRoi(inputs);
    expect(r.tier.id).toBe("growth");
    expect(r.currentStaffCost).toBe(12 * 450_000 * 12); // ₦64.8m
    // exposure: 1.5bn × (5% loss + 20% carry) = ₦375m
    expect(r.currentExposureCost).toBe(1_500_000_000 * 0.25);
    expect(r.currentTotal).toBe(r.currentStaffCost + r.currentExposureCost);
  });

  it("computes the with-ReconcileAI state and headline outputs", () => {
    const r = computeRoi(inputs);
    expect(r.annualFee).toBe(5_000 * 12 * 1400); // ₦84m at top of the Growth band
    expect(r.monthlyFee).toBe(r.annualFee / 12);
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

  it("reports the quoted band around the priced fee", () => {
    const r = computeRoi(inputs);
    expect(r.annualFeeLow).toBe(2_500 * 12 * 1400);
    expect(r.annualFeeHigh).toBe(5_000 * 12 * 1400);
    expect(r.annualFee).toBeGreaterThanOrEqual(r.annualFeeLow);
    expect(r.annualFee).toBeLessThanOrEqual(r.annualFeeHigh);
  });

  it("pricing at the entry of the band lowers the fee and lifts ROI", () => {
    const top = computeRoi(inputs);
    const entry = computeRoi(inputs, { ...DEFAULT_ASSUMPTIONS, feeBandPosition: "entry" });
    expect(entry.annualFee).toBe(2_500 * 12 * 1400);
    expect(entry.annualFee).toBeLessThan(top.annualFee);
    expect(entry.roiMultiple!).toBeGreaterThan(top.roiMultiple!);
    // The band itself is unchanged — only where we price inside it.
    expect(entry.annualFeeHigh).toBe(top.annualFeeHigh);
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

  it("lands inside the business-model sanity band (capture 14–27%, ROI ≥3.8×)", () => {
    const r = computeRoi(inputs);
    expect(r.roiMultiple!).toBeGreaterThanOrEqual(3.8);
    expect(r.valueCaptureRatio!).toBeGreaterThan(0.14);
    expect(r.valueCaptureRatio!).toBeLessThan(0.27);
  });

  it("USD mode: fx of 1 keeps the fee in USD", () => {
    const r = computeRoi(
      { ...inputs, averageMonthlyStaffSalary: 300, monthlyUnresolvedExposure: 500_000 },
      { ...DEFAULT_ASSUMPTIONS, fxPerUsd: 1 },
    );
    expect(r.annualFee).toBe(60_000); // $5K/mo × 12
    expect(r.monthlyFee).toBe(5_000);
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

  it("a payment-processor profile clears the Enterprise shape", () => {
    const r = computeRoi({
      monthlyTransactionVolume: 12_000_000,
      reconciliationStaffCount: 30,
      averageMonthlyStaffSalary: 500_000,
      monthlyUnresolvedExposure: 8_000_000_000,
    });
    expect(r.tier.id).toBe("enterprise");
    expect(r.annualFee).toBe(14_000 * 12 * 1400); // ₦235.2m at top of band
    expect(r.roiMultiple!).toBeGreaterThan(5);
    expect(r.paybackMonths!).toBeLessThan(6);
  });
});
