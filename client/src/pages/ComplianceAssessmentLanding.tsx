import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Shield, Clock, BarChart3, CheckCircle2, ArrowRight, AlertTriangle, TrendingUp, FileText } from "lucide-react";

export default function ComplianceAssessmentLanding() {
  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-white/95 backdrop-blur border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/">
            <span className="text-xl font-bold text-[#1B365D] cursor-pointer">ReconcileAI</span>
          </Link>
          <Link href="/compliance-assessment/quiz">
            <Button className="bg-[#F47458] hover:bg-[#e0644a] text-white h-9 px-5 text-sm">
              Start Assessment <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-20 pb-16 px-6 bg-gradient-to-br from-[#1B365D] to-[#0f2240]">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-[#F47458]/20 text-[#F47458] text-xs font-semibold px-3 py-1.5 rounded-full mb-6 uppercase tracking-wide">
            <Shield className="h-3.5 w-3.5" />
            Free · 5 Minutes · No Account Required
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-white mb-6 leading-tight">
            CBN Compliance Readiness<br />
            <span className="text-[#F47458]">Risk Assessment</span>
          </h1>
          <p className="text-lg text-white/70 mb-10 max-w-2xl mx-auto leading-relaxed">
            25 targeted questions across 5 compliance dimensions. Get a personalised risk score, 
            AI-generated narrative, and a prioritised action plan — specific to your institution type.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/compliance-assessment/quiz">
              <Button size="lg" className="bg-[#F47458] hover:bg-[#e0644a] text-white px-8 h-12 text-base w-full sm:w-auto">
                Start Free Assessment <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
          <p className="text-white/40 text-xs mt-4">No credit card. No login. Results delivered instantly.</p>
        </div>
      </section>

      {/* What you'll get */}
      <section className="py-16 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-[#1B365D] text-center mb-3">What you'll receive</h2>
          <p className="text-[#8C757D] text-center mb-12 max-w-xl mx-auto">
            A detailed, institution-specific compliance report generated in real time — not a generic checklist.
          </p>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                icon: BarChart3,
                title: "Personalised Risk Score",
                desc: "An overall score out of 100 and five category scores — Reconciliation, Exception Management, Reporting, Regulatory, and Technology.",
                color: "text-[#1B365D]",
                bg: "bg-[#1B365D]/5",
              },
              {
                icon: FileText,
                title: "AI-Generated Narrative",
                desc: "A 2-sentence risk narrative written by an AI trained on CBN guidelines — specific to your institution type and your weakest areas.",
                color: "text-[#F47458]",
                bg: "bg-[#F47458]/10",
              },
              {
                icon: TrendingUp,
                title: "Prioritised Action Plan",
                desc: "The three highest-impact actions to take first, ranked by regulatory risk and implementation effort.",
                color: "text-emerald-600",
                bg: "bg-emerald-50",
              },
            ].map((item) => (
              <div key={item.title} className="p-6 rounded-xl border border-gray-100 bg-[#F8F9FA]">
                <div className={`h-10 w-10 rounded-lg ${item.bg} flex items-center justify-center mb-4`}>
                  <item.icon className={`h-5 w-5 ${item.color}`} />
                </div>
                <h3 className="font-semibold text-[#1B365D] mb-2">{item.title}</h3>
                <p className="text-sm text-[#8C757D] leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 5 dimensions */}
      <section className="py-16 px-6 bg-[#F8F9FA] border-y border-gray-200">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-[#1B365D] text-center mb-3">5 Compliance Dimensions</h2>
          <p className="text-[#8C757D] text-center mb-10 max-w-xl mx-auto">
            Mapped directly to CBN's reconciliation and reporting requirements for licensed institutions.
          </p>
          <div className="grid md:grid-cols-5 gap-4">
            {[
              { label: "Reconciliation Process", q: "5 questions", icon: "⚖️", desc: "How you match transactions across systems" },
              { label: "Exception Management", q: "5 questions", icon: "🚨", desc: "How you handle and resolve unmatched items" },
              { label: "Regulatory Reporting", q: "5 questions", icon: "📋", desc: "Your CBN submission accuracy and timeliness" },
              { label: "Regulatory Awareness", q: "5 questions", icon: "🏛️", desc: "Knowledge of current CBN directives" },
              { label: "Technology & Automation", q: "5 questions", icon: "⚡", desc: "Your tooling and manual process exposure" },
            ].map((dim) => (
              <div key={dim.label} className="bg-white rounded-xl p-5 border border-gray-100 text-center">
                <div className="text-2xl mb-3">{dim.icon}</div>
                <h3 className="font-semibold text-[#1B365D] text-sm mb-1">{dim.label}</h3>
                <p className="text-xs text-[#F47458] font-medium mb-2">{dim.q}</p>
                <p className="text-xs text-[#8C757D] leading-relaxed">{dim.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Who it's for */}
      <section className="py-16 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-[#1B365D] text-center mb-3">Built for Nigerian Financial Institutions</h2>
          <p className="text-[#8C757D] text-center mb-10 max-w-xl mx-auto">
            Questions are calibrated by institution type. Your score is benchmarked against CBN's minimum standards.
          </p>
          <div className="grid md:grid-cols-4 gap-4">
            {[
              { label: "Commercial Banks", icon: "🏦", risk: "License revocation risk" },
              { label: "Microfinance Banks", icon: "🏘️", risk: "Audit failure risk" },
              { label: "FinTechs", icon: "⚡", risk: "CBN sanction risk" },
              { label: "Payment Processors", icon: "💳", risk: "False positive risk" },
            ].map((type) => (
              <div key={type.label} className="p-5 rounded-xl border border-gray-100 bg-[#F8F9FA] flex flex-col items-center text-center">
                <div className="text-3xl mb-3">{type.icon}</div>
                <h3 className="font-semibold text-[#1B365D] text-sm mb-1">{type.label}</h3>
                <p className="text-xs text-[#F47458] font-medium">{type.risk}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Risk level guide */}
      <section className="py-16 px-6 bg-[#F8F9FA] border-y border-gray-200">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-[#1B365D] text-center mb-10">Understanding Your Risk Level</h2>
          <div className="grid md:grid-cols-4 gap-4">
            {[
              { level: "Critical", range: "0–39", color: "bg-red-500", text: "text-red-700", bg: "bg-red-50 border-red-200", desc: "Immediate regulatory action required. High probability of CBN sanction or audit failure." },
              { level: "High", range: "40–59", color: "bg-orange-500", text: "text-orange-700", bg: "bg-orange-50 border-orange-200", desc: "Significant gaps that must be addressed before the next regulatory cycle." },
              { level: "Medium", range: "60–79", color: "bg-amber-500", text: "text-amber-700", bg: "bg-amber-50 border-amber-200", desc: "Partial compliance. Targeted improvements will materially reduce your risk exposure." },
              { level: "Low", range: "80–100", color: "bg-emerald-500", text: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200", desc: "Strong compliance posture. Focus on automation to maintain this standard at scale." },
            ].map((r) => (
              <div key={r.level} className={`p-5 rounded-xl border ${r.bg}`}>
                <div className={`inline-flex items-center gap-2 mb-3`}>
                  <div className={`h-3 w-3 rounded-full ${r.color}`} />
                  <span className={`font-bold text-sm ${r.text}`}>{r.level}</span>
                </div>
                <p className={`text-xs font-semibold ${r.text} mb-2`}>Score: {r.range}</p>
                <p className="text-xs text-gray-600 leading-relaxed">{r.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social proof */}
      <section className="py-16 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="grid md:grid-cols-3 gap-6">
            {[
              { stat: "5 min", label: "Average completion time", icon: Clock },
              { stat: "25", label: "Questions across 5 dimensions", icon: CheckCircle2 },
              { stat: "100%", label: "Free — no account required", icon: Shield },
            ].map((s) => (
              <div key={s.label} className="text-center p-6 rounded-xl border border-gray-100">
                <s.icon className="h-6 w-6 text-[#F47458] mx-auto mb-3" />
                <p className="text-3xl font-bold text-[#1B365D] mb-1">{s.stat}</p>
                <p className="text-sm text-[#8C757D]">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-6 bg-[#1B365D]">
        <div className="max-w-3xl mx-auto text-center">
          <AlertTriangle className="h-8 w-8 text-[#F47458] mx-auto mb-4" />
          <h2 className="text-3xl font-bold text-white mb-4">
            Know your compliance risk before the CBN does.
          </h2>
          <p className="text-white/70 mb-8 max-w-xl mx-auto">
            The assessment takes 5 minutes. The results are permanent. Start now — it's free.
          </p>
          <Link href="/compliance-assessment/quiz">
            <Button size="lg" className="bg-[#F47458] hover:bg-[#e0644a] text-white px-10 h-12 text-base">
              Start Free Assessment <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 bg-[#343A40] text-center">
        <p className="text-sm text-gray-400">
          &copy; {new Date().getFullYear()} Infinity AI · ReconcileAI &mdash;{" "}
          <Link href="/"><span className="text-gray-300 hover:text-white cursor-pointer">Back to home</span></Link>
        </p>
      </footer>
    </div>
  );
}
