/**
 * Public ROI Calculator — /roi-calculator (no login).
 *
 * The sales-process "before and after": inputs are the four numbers every
 * operations head knows (volume, staff, salary, unresolved exposure); outputs
 * are annual current-state cost vs annual cost with ReconcileAI, net savings,
 * ROI multiple and payback period. All computation is local (shared/roiModel)
 * — nothing is sent to a server, which is exactly what a bank prospect wants
 * to hear. Inputs round-trip through URL query params so a salesperson can
 * send a prefilled link, and the page prints cleanly for meeting handouts.
 */
import { useEffect, useMemo, useState } from "react";
import {
  computeRoi,
  DEFAULT_ASSUMPTIONS,
  CURRENCY_PRESETS,
  type CurrencyCode,
  type FeeBandPosition,
  type RoiAssumptions,
  type RoiInputs,
} from "@shared/roiModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowRight, Calculator, Check, Link2, Printer, TrendingDown, TrendingUp } from "lucide-react";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtMoney(n: number, symbol: string): string {
  const abs = Math.abs(n);
  const compact =
    abs >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(2)}bn`
    : abs >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}m`
    : n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return `${symbol}${compact}`;
}

/** "$1K–$2K" — the band exactly as the pricing model quotes it. */
function fmtUsdBand(min: number, max: number): string {
  const k = (n: number) => (n % 1000 === 0 ? `$${n / 1000}K` : `$${(n / 1000).toFixed(1)}K`);
  return `${k(min)}–${k(max)}`;
}

function numFromQuery(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function RoiCalculator() {
  // Defaults describe a typical mid-tier MFB / FinTech — the Growth tier the
  // pricing model leads with — so the page never opens empty in a meeting.
  const [currency, setCurrency] = useState<CurrencyCode>("NGN");
  const [volume, setVolume] = useState(3_000_000);
  const [staffCount, setStaffCount] = useState(10);
  const [salary, setSalary] = useState(400_000);
  const [exposure, setExposure] = useState(1_200_000_000);
  const [assumptions, setAssumptions] = useState<RoiAssumptions>(DEFAULT_ASSUMPTIONS);
  const [showAssumptions, setShowAssumptions] = useState(false);

  // Prefill from a shared link once on mount.
  useEffect(() => {
    if (!window.location.search) return;
    const q = new URLSearchParams(window.location.search);
    const ccy = q.get("ccy");
    const preset = CURRENCY_PRESETS.find((c) => c.code === ccy);
    if (preset) {
      setCurrency(preset.code);
      setAssumptions((a) => ({ ...a, fxPerUsd: numFromQuery(q, "fx", preset.defaultFxPerUsd) }));
    }
    const band = q.get("band");
    if (band === "entry" || band === "mid" || band === "top") {
      setAssumptions((a) => ({ ...a, feeBandPosition: band }));
    }
    setVolume(numFromQuery(q, "vol", 3_000_000));
    setStaffCount(numFromQuery(q, "staff", 10));
    setSalary(numFromQuery(q, "sal", 400_000));
    setExposure(numFromQuery(q, "exp", 1_200_000_000));
  }, []);

  const symbol = CURRENCY_PRESETS.find((c) => c.code === currency)?.symbol ?? "₦";

  const result = useMemo(() => {
    const inputs: RoiInputs = {
      monthlyTransactionVolume: volume,
      reconciliationStaffCount: staffCount,
      averageMonthlyStaffSalary: salary,
      monthlyUnresolvedExposure: exposure,
    };
    return computeRoi(inputs, assumptions);
  }, [volume, staffCount, salary, exposure, assumptions]);

  const shareLink = () => {
    const q = new URLSearchParams({
      ccy: currency,
      fx: String(assumptions.fxPerUsd),
      band: assumptions.feeBandPosition,
      vol: String(volume),
      staff: String(staffCount),
      sal: String(salary),
      exp: String(exposure),
    });
    const url = `${window.location.origin}/roi-calculator?${q.toString()}`;
    navigator.clipboard.writeText(url);
    toast.success("Prefilled link copied — send it to your prospect");
  };

  const numInput = (
    label: string,
    value: number,
    onChange: (n: number) => void,
    hint: string,
    prefix?: string,
  ) => (
    <div>
      <label className="text-sm font-medium text-gray-700 mb-1 block">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">{prefix}</span>
        )}
        <Input
          type="number"
          min={0}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) && n >= 0 ? n : 0);
          }}
          className={prefix ? "pl-8" : ""}
        />
      </div>
      <p className="text-xs text-gray-400 mt-1">{hint}</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1B365D] to-[#0f2240]">
      {/* Header */}
      <header className="max-w-6xl mx-auto px-4 pt-8 pb-4 flex items-center justify-between print:hidden">
        <a href="/" className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center">
            <span className="text-white font-bold text-lg">R</span>
          </div>
          <span className="text-white font-bold text-lg">ReconcileAI</span>
        </a>
        <a href="/compliance-assessment">
          <Button variant="outline" className="bg-transparent text-white border-white/40 hover:bg-white/10 hover:text-white">
            Free compliance assessment
          </Button>
        </a>
      </header>

      <main className="max-w-6xl mx-auto px-4 pb-16">
        <div className="text-center text-white mb-8 print:text-gray-900">
          <h1 className="text-3xl md:text-4xl font-bold flex items-center justify-center gap-3">
            <Calculator className="h-8 w-8 print:hidden" />
            Reconciliation ROI Calculator
          </h1>
          <p className="mt-2 text-white/70 max-w-2xl mx-auto print:text-gray-600">
            Four numbers from your operation — your annual cost today versus with ReconcileAI,
            your net savings, and how fast the platform pays for itself. Calculated entirely in
            your browser; nothing is uploaded.
          </p>
        </div>

        <div className="grid lg:grid-cols-5 gap-6">
          {/* ── Inputs ── */}
          <Card className="lg:col-span-2 print:hidden">
            <CardHeader>
              <CardTitle className="text-lg">Your institution</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Currency</label>
                <Select
                  value={currency}
                  onValueChange={(v) => {
                    const preset = CURRENCY_PRESETS.find((c) => c.code === v);
                    if (!preset) return;
                    setCurrency(preset.code);
                    setAssumptions((a) => ({ ...a, fxPerUsd: preset.defaultFxPerUsd }));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCY_PRESETS.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.symbol} {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {numInput(
                "Monthly transaction volume",
                volume,
                setVolume,
                "Across all reconciled channels (NIP, cards, USSD, agent…). Sets your pricing tier.",
              )}
              {numInput(
                "Reconciliation staff",
                staffCount,
                setStaffCount,
                "People whose main job is matching, investigating and resolving breaks.",
              )}
              {numInput(
                "Average monthly salary per staff",
                salary,
                setSalary,
                "Fully-loaded monthly cost per reconciliation staff member.",
                symbol,
              )}
              {numInput(
                "Average unresolved exposure",
                exposure,
                setExposure,
                "Typical outstanding value of unreconciled items at any point in time.",
                symbol,
              )}

              {/* Assumptions — visible and editable, because a CFO will ask. */}
              <button
                className="text-sm text-[#1B365D] font-medium underline underline-offset-2"
                onClick={() => setShowAssumptions((v) => !v)}
              >
                {showAssumptions ? "Hide" : "Review"} the assumptions
              </button>
              {showAssumptions && (
                <div className="space-y-3 rounded-lg border p-3 bg-gray-50">
                  {(
                    [
                      ["staffEffortReduction", "Staff effort automated", 100, "% of recon effort removed (platform auto-matches 95%+; 60% is the conservative planning figure)"],
                      ["exposureReduction", "Exposure reduction", 100, "% shrink in the unresolved balance when breaks resolve in hours, not weeks"],
                      ["exposureAnnualLossRate", "Annual write-off rate", 100, "% of the unresolved balance written off each year (aged items)"],
                      ["costOfFundsRate", "Cost of funds", 100, "annual carrying cost of cash trapped in unreconciled positions"],
                    ] as const
                  ).map(([key, label, scale, hint]) => (
                    <div key={key}>
                      <label className="text-xs font-medium text-gray-600 block">
                        {label}: {(assumptions[key] * scale).toFixed(0)}%
                      </label>
                      <input
                        type="range"
                        min={0}
                        max={key === "exposureAnnualLossRate" ? 20 : key === "costOfFundsRate" ? 40 : 95}
                        value={assumptions[key] * 100}
                        onChange={(e) =>
                          setAssumptions((a) => ({ ...a, [key]: Number(e.target.value) / 100 }))
                        }
                        className="w-full"
                      />
                      <p className="text-[11px] text-gray-400">{hint}</p>
                    </div>
                  ))}
                  {/* Each tier is quoted as a band; where in it we price is a
                      real commercial variable, so let the prospect see it. */}
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">
                      Fee point in the {result.tier.label} band (
                      {fmtUsdBand(result.tier.monthlyFeeUsdMin, result.tier.monthlyFeeUsdMax)}/mo)
                    </label>
                    <Select
                      value={assumptions.feeBandPosition}
                      onValueChange={(v) =>
                        setAssumptions((a) => ({ ...a, feeBandPosition: v as FeeBandPosition }))
                      }
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="top">Top of band (conservative default)</SelectItem>
                        <SelectItem value="mid">Midpoint</SelectItem>
                        <SelectItem value="entry">Entry price</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {currency !== "USD" && (
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">
                        Exchange rate ({currency} per USD) — pricing is contracted in USD
                      </label>
                      <Input
                        type="number"
                        min={1}
                        value={assumptions.fxPerUsd}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setAssumptions((a) => ({ ...a, fxPerUsd: n > 0 ? n : a.fxPerUsd }));
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Results ── */}
          <div className="lg:col-span-3 space-y-4">
            {/* Before / After */}
            <div className="grid md:grid-cols-2 gap-4">
              <Card className="border-red-200">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2 text-red-700">
                    <TrendingDown className="h-4 w-4" /> Today (annual)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Reconciliation staff</span>
                    <span className="font-medium">{fmtMoney(result.currentStaffCost, symbol)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Write-offs + trapped cash</span>
                    <span className="font-medium">{fmtMoney(result.currentExposureCost, symbol)}</span>
                  </div>
                  <div className="flex justify-between border-t pt-2 text-base">
                    <span className="font-semibold">Total</span>
                    <span className="font-bold text-red-700">{fmtMoney(result.currentTotal, symbol)}</span>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-green-300">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2 text-green-700">
                    <TrendingUp className="h-4 w-4" /> With ReconcileAI (annual)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Remaining staff effort</span>
                    <span className="font-medium">{fmtMoney(result.remainingStaffCost, symbol)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Remaining exposure cost</span>
                    <span className="font-medium">{fmtMoney(result.remainingExposureCost, symbol)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">
                      ReconcileAI ({result.tier.label})
                      <span className="block text-xs text-gray-400">
                        {fmtMoney(result.monthlyFee, symbol)} / month
                      </span>
                    </span>
                    <span className="font-medium">{fmtMoney(result.annualFee, symbol)}</span>
                  </div>
                  <div className="flex justify-between border-t pt-2 text-base">
                    <span className="font-semibold">Total</span>
                    <span className="font-bold text-green-700">{fmtMoney(result.newTotal, symbol)}</span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Headline */}
            <Card className="bg-white">
              <CardContent className="pt-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-sm text-gray-500">Net annual savings</p>
                    <p className={`text-3xl font-bold ${result.netAnnualSavings >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {fmtMoney(result.netAnnualSavings, symbol)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Return on the fee</p>
                    <p className="text-3xl font-bold text-[#1B365D]">
                      {result.roiMultiple !== null ? `${result.roiMultiple.toFixed(1)}×` : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Payback period</p>
                    <p className="text-3xl font-bold text-[#1B365D]">
                      {result.paybackMonths !== null
                        ? result.paybackMonths < 1
                          ? "< 1 month"
                          : `${result.paybackMonths.toFixed(1)} months`
                        : "—"}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-gray-400 text-center mt-4">
                  Priced at the {result.tier.label} tier ({volume.toLocaleString()} transactions/month),
                  {assumptions.feeBandPosition === "top"
                    ? " at the top of the quoted band"
                    : assumptions.feeBandPosition === "mid"
                      ? " at the midpoint of the quoted band"
                      : " at the entry price of the quoted band"}
                  . Conservative defaults — adjust every assumption. Indicative, not a quotation.
                </p>
              </CardContent>
            </Card>

            {/* ── The matched tier, straight from the pricing model ── */}
            <Card className="bg-white">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex flex-wrap items-center gap-2">
                  Your tier: {result.tier.label}
                  {result.tier.recommended && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide rounded bg-amber-100 text-amber-700 px-1.5 py-0.5">
                      Recommended
                    </span>
                  )}
                  <span className="text-xs font-normal text-gray-500">
                    {result.tier.audience} · {result.tier.volumeLabel}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-2xl font-bold text-[#1B365D]">
                    {fmtMoney(result.annualFeeLow / 12, symbol)}–{fmtMoney(result.annualFeeHigh / 12, symbol)}
                    <span className="text-sm font-normal text-gray-500"> / month</span>
                  </span>
                  <span className="text-sm text-gray-500">
                    {fmtUsdBand(result.tier.monthlyFeeUsdMin, result.tier.monthlyFeeUsdMax)} / month
                    {currency !== "USD" && ` at ${assumptions.fxPerUsd.toLocaleString()} ${currency}/USD`}
                  </span>
                </div>
                <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm text-gray-600">
                  {result.tier.highlights.map((h) => (
                    <li key={h} className="flex items-start gap-2">
                      <Check className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-gray-400">
                  Contracted in USD. Bands are anchored to confirmed institutional
                  reconciliation budgets, not list price.
                </p>
              </CardContent>
            </Card>

            {/* Actions */}
            <div className="flex flex-wrap gap-3 print:hidden">
              <Button onClick={shareLink} variant="outline" className="bg-white">
                <Link2 className="h-4 w-4 mr-2" /> Copy prefilled link
              </Button>
              <Button onClick={() => window.print()} variant="outline" className="bg-white">
                <Printer className="h-4 w-4 mr-2" /> Print / save PDF
              </Button>
              <a href="/compliance-assessment">
                <Button className="bg-amber-500 hover:bg-amber-600 text-[#1B365D] font-semibold">
                  See your compliance exposure next <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
