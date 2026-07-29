/**
 * ReconcileAI ROI model — the institution-specific "before and after".
 *
 * Source of truth: the "Anchored to Confirmed Budgets" pricing model — three
 * tiers quoted as a MONTHLY USD band, with the volume band that selects them:
 *
 *   Starter     $1K–$2K/mo    MFBs · 2–3 settlement officers   ≤ 2M txns/mo
 *   Growth      $2.5K–$5K/mo  Mid-tier MFBs · FinTechs         2M–10M txns/mo
 *   Enterprise  $7K–$14K/mo   Large MFBs · Payment Processors  10M+ txns/mo
 *
 * Each band is anchored to a confirmed customer budget (CBN-licensed MFB
 * discovery, FinTech discovery, Interswitch operations pre-build), so these
 * are the numbers the calculator must quote — never an older annual list.
 *
 * Used by the public /roi-calculator page (sales meetings + website
 * self-service). Pure and dependency-free so the client computes everything
 * locally — the public page needs no API call and captures no data.
 *
 * Inputs (per the sales-process spec):
 *   monthly transaction volume · reconciliation staff count · average staff
 *   salary · estimated monthly unresolved exposure (average outstanding).
 * Outputs:
 *   annual cost of current state vs annual cost with ReconcileAI, net savings,
 *   ROI multiple, payback period.
 */

// ─── Pricing tiers (USD, quoted monthly) ─────────────────────────────────────
export interface PricingTier {
  id: "starter" | "growth" | "enterprise";
  label: string;
  /** Who the tier is sold to. */
  audience: string;
  /** Contracted monthly fee band, USD. */
  monthlyFeeUsdMin: number;
  monthlyFeeUsdMax: number;
  /** Monthly transaction volume band that selects this tier. */
  minMonthlyTxns: number;
  maxMonthlyTxns: number | null; // null = unbounded
  /** Human-readable form of the volume band. */
  volumeLabel: string;
  /** Headline inclusions, shown on the matched-tier card. */
  highlights: string[];
  /** The tier the pricing model leads with. */
  recommended?: boolean;
}

export const PRICING_TIERS: PricingTier[] = [
  {
    id: "starter",
    label: "Starter",
    audience: "MFBs · 2–3 settlement officers",
    monthlyFeeUsdMin: 1_000,
    monthlyFeeUsdMax: 2_000,
    minMonthlyTxns: 0,
    maxMonthlyTxns: 2_000_000,
    volumeLabel: "500K–2M txns / month",
    highlights: [
      "Up to 2M transactions / month",
      "3 reconciliation channels (NIBSS, POS, USSD)",
      "Automated matching + exception dashboard",
      "WoodCore integration · standard onboarding (5 days)",
    ],
  },
  {
    id: "growth",
    label: "Growth",
    audience: "Mid-tier MFBs · FinTechs",
    monthlyFeeUsdMin: 2_500,
    monthlyFeeUsdMax: 5_000,
    minMonthlyTxns: 2_000_001,
    maxMonthlyTxns: 10_000_000,
    volumeLabel: "2M–10M txns / month",
    recommended: true,
    highlights: [
      "Up to 10M transactions / month",
      "All 8 reconciliation channels",
      "AI Super Agent — root cause diagnosis",
      "CBN compliance reports · API access · dedicated CSM",
    ],
  },
  {
    id: "enterprise",
    label: "Enterprise",
    audience: "Large MFBs · Payment Processors",
    monthlyFeeUsdMin: 7_000,
    monthlyFeeUsdMax: 14_000,
    minMonthlyTxns: 10_000_001,
    maxMonthlyTxns: null,
    volumeLabel: "10M+ txns / month",
    highlights: [
      "Unlimited transaction volume",
      "All channels + custom channel build",
      "On-premise deployment · multi-entity support",
      "99.9% uptime SLA · 4-hr response · custom model training",
    ],
  },
];

/**
 * Where in the quoted band to price the deal. Defaults to the TOP of the band
 * everywhere: an ROI computed against the highest fee we would charge can only
 * be beaten in the real contract, which is the correct direction to be wrong
 * in front of a CFO.
 */
export type FeeBandPosition = "entry" | "mid" | "top";

function normalizeFeePosition(p: FeeBandPosition): FeeBandPosition {
  return p === "entry" || p === "mid" ? p : "top";
}

/** Monthly USD fee at a chosen point in the tier's band. */
export function monthlyFeeUsd(tier: PricingTier, position: FeeBandPosition = "top"): number {
  switch (normalizeFeePosition(position)) {
    case "entry":
      return tier.monthlyFeeUsdMin;
    case "mid":
      return (tier.monthlyFeeUsdMin + tier.monthlyFeeUsdMax) / 2;
    default:
      return tier.monthlyFeeUsdMax;
  }
}

/** Annual USD fee at a chosen point in the tier's band. */
export function annualFeeUsd(tier: PricingTier, position: FeeBandPosition = "top"): number {
  return monthlyFeeUsd(tier, position) * 12;
}

export function tierForVolume(monthlyTxns: number): PricingTier {
  // Garbage in must fail toward the SMALLEST tier — a NaN volume silently
  // quoting the Enterprise fee in a sales meeting is the wrong failure mode.
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
  /**
   * Which point of the tier's quoted band to price at. "top" by default so the
   * ROI shown is the worst case for us and the safest for the prospect.
   */
  feeBandPosition: FeeBandPosition;
  /** Display-currency units per USD (editable; NGN default). 1 for USD. */
  fxPerUsd: number;
}

export const DEFAULT_ASSUMPTIONS: RoiAssumptions = {
  staffEffortReduction: 0.6,
  exposureReduction: 0.8,
  exposureAnnualLossRate: 0.05,
  costOfFundsRate: 0.2,
  feeBandPosition: "top",
  fxPerUsd: 1400, // NGN per USD — matches the ₦ equivalents in the pricing model
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
  /** Monthly equivalent of `annualFee` — the tier is quoted per month. */
  monthlyFee: number;
  /** Bottom and top of the tier's quoted band (annual), for showing the range. */
  annualFeeLow: number;
  annualFeeHigh: number;

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
  const annualFee = annualFeeUsd(tier, assumptions.feeBandPosition) * fx;
  const annualFeeLow = annualFeeUsd(tier, "entry") * fx;
  const annualFeeHigh = annualFeeUsd(tier, "top") * fx;

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
    monthlyFee: annualFee / 12,
    annualFeeLow,
    annualFeeHigh,
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
  { code: "NGN", symbol: "₦", label: "Nigerian Naira", defaultFxPerUsd: 1400 },
  { code: "UGX", symbol: "USh ", label: "Ugandan Shilling", defaultFxPerUsd: 3800 },
  { code: "USD", symbol: "$", label: "US Dollar", defaultFxPerUsd: 1 },
  { code: "KES", symbol: "KSh", label: "Kenyan Shilling", defaultFxPerUsd: 130 },
  { code: "GHS", symbol: "GH₵", label: "Ghanaian Cedi", defaultFxPerUsd: 15 },
] as const;

export type CurrencyCode = (typeof CURRENCY_PRESETS)[number]["code"];
