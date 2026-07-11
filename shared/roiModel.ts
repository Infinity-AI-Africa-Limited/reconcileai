/**
 * ReconcileAI ROI model — the institution-specific "before and after".
 *
 * Source of truth: ReconcileAI Business Model v3.0 (Execution-Ready, July 2026)
 * — pricing tiers §2.1, customer-ROI benchmarks §4.2 (ROI multiples 3.8×–6.9×,
 * value capture 14–27% of savings). Used by the public /roi-calculator page
 * (sales meetings + website self-service). Pure and dependency-free so the
 * client computes everything locally — the public page needs no API call and
 * captures no data.
 *
 * Inputs (per the sales-process spec):
 *   monthly transaction volume · reconciliation staff count · average staff
 *   salary · estimated monthly unresolved exposure (average outstanding).
 * Outputs:
 *   annual cost of current state vs annual cost with ReconcileAI, net savings,
 *   ROI multiple, payback period.
 */

// ─── Pricing tiers (Business Model v3.0 §2.1 — USD, annual) ─────────────────
export interface PricingTier {
  id: "small_mfb" | "mid_tier" | "large_bank";
  label: string;
  annualFeeUsd: number;
  /** Monthly transaction volume band. */
  minMonthlyTxns: number;
  maxMonthlyTxns: number | null; // null = unbounded
}

export const PRICING_TIERS: PricingTier[] = [
  { id: "small_mfb", label: "Small MFB", annualFeeUsd: 12_000, minMonthlyTxns: 0, maxMonthlyTxns: 49_999 },
  { id: "mid_tier", label: "Mid-tier Bank", annualFeeUsd: 40_000, minMonthlyTxns: 50_000, maxMonthlyTxns: 500_000 },
  { id: "large_bank", label: "Large Bank", annualFeeUsd: 72_000, minMonthlyTxns: 500_001, maxMonthlyTxns: null },
];

export function tierForVolume(monthlyTxns: number): PricingTier {
  // Garbage in must fail toward the SMALLEST tier — a NaN volume silently
  // quoting the Large Bank fee in a sales meeting is the wrong failure mode.
  const v = Number.isFinite(monthlyTxns) ? Math.max(0, Math.floor(monthlyTxns)) : 0;
  return (
    PRICING_TIERS.find(
      (t) => v >= t.minMonthlyTxns && (t.maxMonthlyTxns === null || v <= t.maxMonthlyTxns),
    ) ?? PRICING_TIERS[0]
  );
}

// ─── Adjustable assumptions (defaults are the CONSERVATIVE case) ─────────────
// Every assumption is shown and editable on the page — the calculator's
// credibility in a bank meeting depends on the CFO being able to challenge and
// change each number.
export interface RoiAssumptions {
  /**
   * Share of reconciliation staff effort removed by automation. The platform
   * matches 95%+ automatically; 60% is the conservative planning figure for
   * redeployable staff time (people do more than pure matching).
   */
  staffEffortReduction: number;
  /**
   * Reduction in the average unresolved-exposure balance once exceptions are
   * detected and resolved in hours instead of weeks.
   */
  exposureReduction: number;
  /**
   * Portion of the unresolved balance ultimately written off each year
   * (aged, unrecoverable items). Conservative default 5%.
   */
  exposureAnnualLossRate: number;
  /**
   * Annual carrying/opportunity cost of cash trapped in unreconciled
   * positions (cost of funds; Nigerian MPR environment). Default 20%.
   */
  costOfFundsRate: number;
  /** Display-currency units per USD (editable; NGN default). 1 for USD. */
  fxPerUsd: number;
}

export const DEFAULT_ASSUMPTIONS: RoiAssumptions = {
  staffEffortReduction: 0.6,
  exposureReduction: 0.8,
  exposureAnnualLossRate: 0.05,
  costOfFundsRate: 0.2,
  fxPerUsd: 1600, // NGN per USD — editable on the page
};

// ─── Inputs & result ─────────────────────────────────────────────────────────
export interface RoiInputs {
  /** Monthly transaction volume across reconciled channels. */
  monthlyTransactionVolume: number;
  /** Head-count doing reconciliation work today. */
  reconciliationStaffCount: number;
  /** Average MONTHLY salary per reconciliation staff, in display currency. */
  averageMonthlyStaffSalary: number;
  /** Average unresolved/unreconciled exposure balance, in display currency. */
  monthlyUnresolvedExposure: number;
}

export interface RoiResult {
  tier: PricingTier;
  /** All money fields below are in the DISPLAY currency. */
  annualFee: number;

  // Current state (annual)
  currentStaffCost: number;
  currentExposureCost: number; // write-offs + carrying cost on the balance
  currentTotal: number;

  // With ReconcileAI (annual)
  remainingStaffCost: number;
  remainingExposureCost: number;
  newTotal: number; // remaining costs + annual fee

  // Headline outputs
  netAnnualSavings: number; // currentTotal − newTotal
  grossAnnualBenefit: number; // savings before the fee (staff + exposure deltas)
  roiMultiple: number | null; // grossAnnualBenefit ÷ annualFee (null if fee 0)
  paybackMonths: number | null; // annualFee ÷ monthly gross benefit (null if no benefit)
  /** Fee as a share of gross benefit — business model targets 14–27%. */
  valueCaptureRatio: number | null;
}

function clampNonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function computeRoi(
  inputs: RoiInputs,
  assumptions: RoiAssumptions = DEFAULT_ASSUMPTIONS,
): RoiResult {
  const volume = clampNonNegative(inputs.monthlyTransactionVolume);
  const staff = clampNonNegative(inputs.reconciliationStaffCount);
  const salary = clampNonNegative(inputs.averageMonthlyStaffSalary);
  const exposure = clampNonNegative(inputs.monthlyUnresolvedExposure);
  const fx = assumptions.fxPerUsd > 0 ? assumptions.fxPerUsd : 1;

  const tier = tierForVolume(volume);
  const annualFee = tier.annualFeeUsd * fx;

  // ── Current state ──
  const currentStaffCost = staff * salary * 12;
  // The exposure input is an average outstanding BALANCE (not a monthly flow):
  // annual cost = write-off share + carrying cost on the balance.
  const currentExposureCost =
    exposure * (assumptions.exposureAnnualLossRate + assumptions.costOfFundsRate);
  const currentTotal = currentStaffCost + currentExposureCost;

  // ── With ReconcileAI ──
  const remainingStaffCost = currentStaffCost * (1 - assumptions.staffEffortReduction);
  const remainingExposureCost = currentExposureCost * (1 - assumptions.exposureReduction);
  const newTotal = remainingStaffCost + remainingExposureCost + annualFee;

  const grossAnnualBenefit =
    currentStaffCost - remainingStaffCost + (currentExposureCost - remainingExposureCost);
  const netAnnualSavings = currentTotal - newTotal;

  const roiMultiple = annualFee > 0 ? grossAnnualBenefit / annualFee : null;
  const paybackMonths =
    grossAnnualBenefit > 0 ? annualFee / (grossAnnualBenefit / 12) : null;
  const valueCaptureRatio = grossAnnualBenefit > 0 ? annualFee / grossAnnualBenefit : null;

  return {
    tier,
    annualFee,
    currentStaffCost,
    currentExposureCost,
    currentTotal,
    remainingStaffCost,
    remainingExposureCost,
    newTotal,
    netAnnualSavings,
    grossAnnualBenefit,
    roiMultiple,
    paybackMonths,
    valueCaptureRatio,
  };
}

// ─── Currency presets for the page ───────────────────────────────────────────
export const CURRENCY_PRESETS = [
  { code: "NGN", symbol: "₦", label: "Nigerian Naira", defaultFxPerUsd: 1600 },
  { code: "USD", symbol: "$", label: "US Dollar", defaultFxPerUsd: 1 },
  { code: "KES", symbol: "KSh", label: "Kenyan Shilling", defaultFxPerUsd: 130 },
  { code: "GHS", symbol: "GH₵", label: "Ghanaian Cedi", defaultFxPerUsd: 15 },
] as const;

export type CurrencyCode = (typeof CURRENCY_PRESETS)[number]["code"];
