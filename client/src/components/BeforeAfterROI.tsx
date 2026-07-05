import { useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck, ArrowRight } from "lucide-react";

/**
 * Before/After financial comparison — the decision-maker's view of the problem.
 *
 * Strategy: banks don't buy a reconciliation tool, they buy protection from CBN
 * enforcement, audit failure, and personal career risk. Abstract statistics are
 * less persuasive than a concrete transformation, so this renders the buyer's
 * own numbers: what the current state costs them today vs. the ReconcileAI
 * state. Used on the public Home and Banks landing pages.
 */

const fmtNGN = (n: number) =>
  `₦${Math.round(n).toLocaleString("en-NG")}`;

const fmtNGNCompact = (n: number) => {
  if (n >= 1_000_000_000) return `₦${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `₦${(n / 1_000).toFixed(0)}K`;
  return `₦${n.toFixed(0)}`;
};

function NumberInput({
  label, value, onChange, prefix, suffix, step = 1, min = 0,
}: {
  label: string; value: number; onChange: (v: number) => void;
  prefix?: string; suffix?: string; step?: number; min?: number;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-[#8C757D]">{label}</span>
      <div className="mt-1 flex items-center rounded-lg border border-gray-200 bg-white px-3 h-10 focus-within:border-[#1B365D]">
        {prefix && <span className="text-sm text-[#8C757D] mr-1">{prefix}</span>}
        <input
          type="number"
          className="w-full text-sm font-semibold text-[#1B365D] outline-none bg-transparent"
          value={value}
          min={min}
          step={step}
          onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))}
        />
        {suffix && <span className="text-xs text-[#8C757D] ml-1 whitespace-nowrap">{suffix}</span>}
      </div>
    </label>
  );
}

export default function BeforeAfterROI() {
  // Sensible Nigerian MFB/bank defaults — every input is editable so the
  // prospect sees THEIR numbers, not ours.
  const [staff, setStaff] = useState(4);
  const [monthlySalary, setMonthlySalary] = useState(250_000);
  const [reconTimePct, setReconTimePct] = useState(60);
  const [exposure, setExposure] = useState(50_000_000);

  const model = useMemo(() => {
    const annualStaffCost = staff * monthlySalary * 12;
    const reconCostBefore = annualStaffCost * (reconTimePct / 100);
    // 80% of manual reconciliation effort automated (matching, triage, audit prep).
    const reconCostAfter = reconCostBefore * 0.2;
    const annualSaving = reconCostBefore - reconCostAfter;
    return { reconCostBefore, reconCostAfter, annualSaving };
  }, [staff, monthlySalary, reconTimePct]);

  return (
    <section className="py-16 px-6 bg-[#1B365D]">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-white mb-3">What the Current State Actually Costs You</h2>
          <p className="text-white/70 max-w-2xl mx-auto">
            Put in your institution's numbers. This is the comparison your MD, CFO and board will ask for.
          </p>
        </div>

        {/* Inputs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8 bg-white/5 rounded-xl p-5 border border-white/10">
          <NumberInput label="Reconciliation staff" value={staff} onChange={setStaff} min={1} />
          <NumberInput label="Avg monthly salary" value={monthlySalary} onChange={setMonthlySalary} prefix="₦" step={50_000} />
          <NumberInput label="Time spent on manual recon" value={reconTimePct} onChange={(v) => setReconTimePct(Math.min(100, v))} suffix="%" />
          <NumberInput label="Unresolved exposure carried" value={exposure} onChange={setExposure} prefix="₦" step={5_000_000} />
        </div>

        {/* Before / After */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Before */}
          <div className="rounded-2xl bg-white/5 border border-red-400/30 p-6">
            <div className="flex items-center gap-2 mb-5">
              <ShieldAlert className="h-5 w-5 text-red-400" />
              <h3 className="text-lg font-bold text-white">Before ReconcileAI</h3>
            </div>
            <ul className="space-y-4">
              <li className="flex items-start justify-between gap-4">
                <span className="text-sm text-white/70">Staff time spent on manual reconciliation</span>
                <span className="text-base font-bold text-red-300 whitespace-nowrap">{fmtNGN(model.reconCostBefore)}/yr</span>
              </li>
              <li className="flex items-start justify-between gap-4">
                <span className="text-sm text-white/70">Unresolved exposure carried on the books</span>
                <span className="text-base font-bold text-red-300 whitespace-nowrap">{fmtNGNCompact(exposure)}<span className="text-white/50 font-normal text-xs">/month</span></span>
              </li>
              <li className="flex items-start justify-between gap-4">
                <span className="text-sm text-white/70">Exception resolution time</span>
                <span className="text-base font-bold text-red-300 whitespace-nowrap">Days–weeks</span>
              </li>
              <li className="flex items-start justify-between gap-4">
                <span className="text-sm text-white/70">CBN examination posture</span>
                <span className="text-base font-bold text-red-300 text-right">Enforcement risk — gaps found by the examiner</span>
              </li>
            </ul>
          </div>

          {/* After */}
          <div className="rounded-2xl bg-white/5 border border-emerald-400/40 p-6">
            <div className="flex items-center gap-2 mb-5">
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
              <h3 className="text-lg font-bold text-white">After ReconcileAI</h3>
            </div>
            <ul className="space-y-4">
              <li className="flex items-start justify-between gap-4">
                <span className="text-sm text-white/70">Staff time on reconciliation <span className="text-emerald-300">(−80%)</span></span>
                <span className="text-base font-bold text-emerald-300 whitespace-nowrap">{fmtNGN(model.reconCostAfter)}/yr</span>
              </li>
              <li className="flex items-start justify-between gap-4">
                <span className="text-sm text-white/70">Exposure identified, classified &amp; assigned</span>
                <span className="text-base font-bold text-emerald-300 whitespace-nowrap">Within 24 hours</span>
              </li>
              <li className="flex items-start justify-between gap-4">
                <span className="text-sm text-white/70">Exception resolution with AI-recommended actions</span>
                <span className="text-base font-bold text-emerald-300 whitespace-nowrap">Same day</span>
              </li>
              <li className="flex items-start justify-between gap-4">
                <span className="text-sm text-white/70">CBN examination posture</span>
                <span className="text-base font-bold text-emerald-300 text-right">Signed, tamper-evident audit trail — ready on demand</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Net line */}
        <div className="mt-8 rounded-xl bg-[#F47458] px-6 py-5 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-white font-semibold text-lg">
            Direct saving: {fmtNGNCompact(model.annualSaving)}/year in staff time alone — before counting a single avoided penalty.
          </p>
          <a href="/compliance-assessment" className="shrink-0">
            <span className="inline-flex items-center gap-2 bg-white text-[#F47458] font-semibold rounded-lg px-5 h-11 leading-[44px] hover:bg-gray-50 transition-colors">
              See your compliance gaps <ArrowRight className="h-4 w-4" />
            </span>
          </a>
        </div>
      </div>
    </section>
  );
}
