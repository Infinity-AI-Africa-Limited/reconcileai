import { useAuth } from "@/_core/hooks/useAuth";
import BeforeAfterROI from "@/components/BeforeAfterROI";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useEffect } from "react";
import {
  ArrowRight,
  Zap,
  Shield,
  BarChart3,
  Layers,
  Clock,
  CheckCircle2,
  AlertTriangle,
  TrendingDown,
  FileCheck,
  Building2,
  Globe,
} from "lucide-react";

function GuestLoginButton() {
  const [, navigate] = useLocation();
  const guestLogin = trpc.auth.guestLogin.useMutation({
    onSuccess: () => {
      navigate("/dashboard");
    },
  });

  return (
    <Button
      size="lg"
      variant="outline"
      onClick={() => guestLogin.mutate()}
      disabled={guestLogin.isPending}
      className="border-[#1B365D] text-[#1B365D] hover:bg-[#1B365D]/5 px-8 h-12 text-base"
    >
      {guestLogin.isPending ? "Loading..." : "Try as Guest"}
    </Button>
  );
}

export default function Home() {
  const { user, isAuthenticated, loading } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (isAuthenticated && !loading) {
      navigate("/dashboard");
    }
  }, [isAuthenticated, loading, navigate]);

  if (isAuthenticated && !loading) {
    return null;
  }

  return (
    <div className="min-h-screen bg-[#F8F9FA]">
      {/* Nav */}
      <nav className="border-b border-gray-200 bg-white/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="https://files.manuscdn.com/user_upload_by_module/session_file/310419663029108989/kAWaFedmrHMvcLRx.png" alt="Infinity AI" className="h-8" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            <span className="text-xl font-bold text-[#1B365D] tracking-tight">ReconcileAI</span>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/roi-calculator"
              className="hidden sm:inline-flex items-center gap-1.5 text-sm font-medium text-[#1B365D] hover:text-[#142847] transition-colors"
            >
              ROI Calculator
            </a>
            <a
              href="/compliance-assessment"
              className="hidden sm:inline-flex items-center gap-1.5 text-sm font-medium text-[#F47458] hover:text-[#e0644a] transition-colors"
            >
              <FileCheck className="h-4 w-4" />
              Free Assessment
            </a>
            <Button
              onClick={() => window.location.href = getLoginUrl()}
              className="bg-[#1B365D] hover:bg-[#142847] text-white"
            >
              Sign In <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-24 pb-20 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#F47458]/10 text-[#F47458] text-sm font-medium mb-6">
            <Shield className="h-4 w-4" /> CBN-Compliant | License-Safe
          </div>
          <h1 className="text-5xl md:text-6xl font-bold text-[#1B365D] leading-tight tracking-tight">
            Eliminate the risk of losing your license
            <br />
            to <span className="text-[#F47458]">Reconciliation Gaps</span>
          </h1>
          <p className="text-lg text-[#8C757D] mt-6 max-w-2xl mx-auto leading-relaxed">
            This is a regulatory survival problem, not a productivity problem. The CBN revoked licenses in 2025 —
            the question is whether you close your reconciliation gaps before or after your next examination.
            ReconcileAI resolves exposure within 24 hours and keeps a signed, CBN-ready audit trail on demand.
          </p>
          <div className="flex items-center justify-center gap-4 mt-10">
            <Button
              size="lg"
              onClick={() => window.location.href = getLoginUrl()}
              className="bg-[#1B365D] hover:bg-[#142847] text-white px-8 h-12 text-base"
            >
              Protect Your License <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <GuestLoginButton />
          </div>
        </div>
      </section>

      {/* Segment Navigation */}
      <section className="py-16 px-6 bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-[#1B365D] mb-3">Built for Your Industry</h2>
            <p className="text-lg text-gray-600">Tailored solutions for Banks, FinTechs, Payment Processors, and Corporate B2B</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <a href="/banks" className="group block">
              <div className="border-2 border-gray-200 rounded-lg p-8 hover:border-[#1B365D] hover:shadow-lg transition-all">
                <div className="h-12 w-12 bg-[#1B365D]/10 rounded-lg flex items-center justify-center mb-4 group-hover:bg-[#1B365D] transition-colors">
                  <Shield className="h-6 w-6 text-[#1B365D] group-hover:text-white" />
                </div>
                <h3 className="text-xl font-semibold text-[#1B365D] mb-2">For Banks</h3>
                <p className="text-gray-600 mb-4">Protect your banking license with 9+/10 audit confidence. Eliminate 5+ daily portal logins.</p>
                <div className="flex items-center text-[#1B365D] font-medium group-hover:translate-x-1 transition-transform">
                  Learn more <ArrowRight className="ml-2 h-4 w-4" />
                </div>
              </div>
            </a>

            <a href="/fintechs" className="group block">
              <div className="border-2 border-gray-200 rounded-lg p-8 hover:border-[#F4758C] hover:shadow-lg transition-all">
                <div className="h-12 w-12 bg-[#F4758C]/10 rounded-lg flex items-center justify-center mb-4 group-hover:bg-[#F4758C] transition-colors">
                  <Zap className="h-6 w-6 text-[#F4758C] group-hover:text-white" />
                </div>
                <h3 className="text-xl font-semibold text-[#1B365D] mb-2">For FinTechs</h3>
                <p className="text-gray-600 mb-4">Scale without scaling your recon team. Reduce 60% of manual matching time. Deploy in weeks.</p>
                <div className="flex items-center text-[#F4758C] font-medium group-hover:translate-x-1 transition-transform">
                  Learn more <ArrowRight className="ml-2 h-4 w-4" />
                </div>
              </div>
            </a>

            <a href="/payment-processors" className="group block">
              <div className="border-2 border-gray-200 rounded-lg p-8 hover:border-[#2A4A7C] hover:shadow-lg transition-all">
                <div className="h-12 w-12 bg-[#2A4A7C]/10 rounded-lg flex items-center justify-center mb-4 group-hover:bg-[#2A4A7C] transition-colors">
                  <Layers className="h-6 w-6 text-[#2A4A7C] group-hover:text-white" />
                </div>
                <h3 className="text-xl font-semibold text-[#1B365D] mb-2">For Payment Processors</h3>
                <p className="text-gray-600 mb-4">Eliminate 35-65% false positives. Save 30+ minutes per false alarm across 20+ processes.</p>
                <div className="flex items-center text-[#2A4A7C] font-medium group-hover:translate-x-1 transition-transform">
                  Learn more <ArrowRight className="ml-2 h-4 w-4" />
                </div>
              </div>
            </a>

            <a href="/corporate-b2b" className="group block">
              <div className="border-2 border-gray-200 rounded-lg p-8 hover:border-[#F47458] hover:shadow-lg transition-all relative">
                <div className="absolute top-3 right-3">
                  <span className="text-[10px] font-semibold uppercase tracking-wide bg-[#F47458]/10 text-[#F47458] px-2 py-0.5 rounded-full">Coming FY2</span>
                </div>
                <div className="h-12 w-12 bg-[#F47458]/10 rounded-lg flex items-center justify-center mb-4 group-hover:bg-[#F47458] transition-colors">
                  <Building2 className="h-6 w-6 text-[#F47458] group-hover:text-white" />
                </div>
                <h3 className="text-xl font-semibold text-[#1B365D] mb-2">For Corporate B2B</h3>
                <p className="text-gray-600 mb-4">Auto-match distributor payments to invoices. Eliminate month-end reconciliation wars across ERP and bank.</p>
                <div className="flex items-center text-[#F47458] font-medium group-hover:translate-x-1 transition-transform">
                  Learn more <ArrowRight className="ml-2 h-4 w-4" />
                </div>
              </div>
            </a>
          </div>
        </div>
      </section>

      {/* Compliance Assessment CTA */}
      <section className="py-10 px-6 bg-[#F8F9FA] border-y border-gray-100">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 bg-white rounded-2xl border border-gray-100 px-8 py-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="h-12 w-12 rounded-xl bg-[#F47458]/10 flex items-center justify-center shrink-0">
                <FileCheck className="h-6 w-6 text-[#F47458]" />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-base font-bold text-[#1B365D]">Free CBN Compliance Readiness Assessment</h3>
                  <span className="text-xs font-semibold bg-[#F47458]/10 text-[#F47458] px-2 py-0.5 rounded-full">5 min</span>
                </div>
                <p className="text-sm text-[#8C757D] max-w-xl">
                  25 questions. Personalised risk score. AI-generated narrative. Know your compliance gaps before the CBN does.
                </p>
              </div>
            </div>
            <a href="/compliance-assessment" className="shrink-0">
              <Button className="bg-[#F47458] hover:bg-[#e0644a] text-white h-10 px-6 text-sm whitespace-nowrap">
                Take Free Assessment <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="py-12 bg-white border-y border-gray-200">
        <div className="max-w-5xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-8">
          {[
            { value: "₦50M+", label: "Typical Unresolved Exposure Carried Monthly" },
            { value: "24 hrs", label: "Exposure Identified & Assigned" },
            { value: "Signed", label: "Tamper-Evident, CBN-Ready Audit Trail" },
            { value: "60%", label: "Staff Time Saved — the Secondary Benefit" },
          ].map((s) => (
            <div key={s.label} className="text-center">
              <p className="text-3xl font-bold text-[#1B365D]">{s.value}</p>
              <p className="text-sm text-[#8C757D] mt-1">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pain Points */}
      <section className="py-20 px-6 bg-[#F8F9FA]">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-[#1B365D] text-center mb-4">
            Your Reconciliation Nightmare
          </h2>
          <p className="text-center text-[#8C757D] mb-12 max-w-2xl mx-auto">
            Validated pain points from Nigerian banks, payment processors, and FinTechs
          </p>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                icon: FileCheck,
                title: "License Revocation Risk",
                desc: "Unresolved exceptions can cost you your CBN license. Audit confidence sits at only 6.5/10 for most institutions — and the examiner finds the gaps before you do.",
                severity: "critical",
              },
              {
                icon: AlertTriangle,
                title: "35-65% False Positives",
                desc: "Only 2-5% of flagged exceptions are real issues. Your team wastes 30+ minutes investigating each false alarm.",
                severity: "critical",
              },
              {
                icon: Layers,
                title: "5+ System Logins Daily",
                desc: "Logging into NIBSS, POS portals, bank statements, core banking, and ERP systems. 60% of your day spent on manual downloads.",
                severity: "high",
              },
            ].map((p) => (
              <div key={p.title} className={`p-6 rounded-xl bg-white border-2 ${p.severity === 'critical' ? 'border-red-200 bg-red-50/30' : 'border-orange-200 bg-orange-50/30'}`}>
                <div className={`h-10 w-10 rounded-lg ${p.severity === 'critical' ? 'bg-red-100' : 'bg-orange-100'} flex items-center justify-center mb-4`}>
                  <p.icon className={`h-5 w-5 ${p.severity === 'critical' ? 'text-red-600' : 'text-orange-600'}`} />
                </div>
                <h3 className="font-semibold text-[#1B365D] mb-2">{p.title}</h3>
                <p className="text-sm text-[#8C757D] leading-relaxed">{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Before / After — the decision-maker's financial comparison */}
      <BeforeAfterROI />

      {/* Features */}
      <section className="py-20 px-6 bg-white">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-[#1B365D] text-center mb-4">
            Agentic AI Automation, Human-in-the-Loop
          </h2>
          <p className="text-center text-[#8C757D] mb-12 max-w-2xl mx-auto">
            AI-assisted decision-making that keeps you in control while eliminating 95% of manual work
          </p>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: Zap,
                title: "AI-Powered Matching",
                desc: "Fuzzy matching, amount tolerance, and date windowing reconcile transactions across sources with intelligent pattern recognition.",
              },
              {
                icon: TrendingDown,
                title: "False Positive Elimination",
                desc: "AI learns your transaction patterns to reduce 35-65% of false alarms. Surface real frauds hidden in exception queues.",
              },
              {
                icon: Layers,
                title: "Multi-System Orchestration",
                desc: "One login replaces 5+ portals. Automatically fetch from NIBSS, POS, mobile wallets, bank statements, and core banking.",
              },
              {
                icon: Shield,
                title: "License Protection & CBN Compliance",
                desc: "Structured audit trails, regulatory reporting templates, and exception resolution workflows that prevent license revocation.",
              },
              {
                icon: Clock,
                title: "Exception Management",
                desc: "AI categorizes unmatched items and suggests resolutions to accelerate review while keeping you in control.",
              },
              {
                icon: CheckCircle2,
                title: "Automated Reports",
                desc: "Daily, weekly, and monthly reconciliation reports generated and exported automatically for stakeholder review.",
              },
              {
                icon: BarChart3,
                title: "Role-Based Dashboards",
                desc: "CFO, Operations, and Auditor views with KPIs, exception queues, and compliance metrics tailored to each role.",
              },
              {
                icon: Globe,
                title: "Multi-Currency & FX Reconciliation",
                desc: "Reconcile NGN, UGX, USD, GBP, EUR and 10+ African currencies. FX rate variances are detected with the implied rate cited and verified against CBN/NAFEM settlement-date rates.",
              },
            ].map((f) => (
              <div key={f.title} className="p-6 rounded-xl bg-[#F8F9FA] border border-gray-100 hover:border-[#1B365D]/20 transition-colors">
                <div className="h-10 w-10 rounded-lg bg-[#1B365D]/5 flex items-center justify-center mb-4">
                  <f.icon className="h-5 w-5 text-[#1B365D]" />
                </div>
                <h3 className="font-semibold text-[#1B365D] mb-2">{f.title}</h3>
                <p className="text-sm text-[#8C757D] leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social Proof */}
      <section className="py-16 px-6 bg-[#F8F9FA] border-y border-gray-200">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-sm text-[#8C757D] mb-6 uppercase tracking-wide font-medium">
            Validated by Nigerian Financial Services Leaders
          </p>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                quote: "If the decision making remains in the hands of a human, that can take away the fear.",
                role: "Reconciliation Lead",
                company: "A leading payment processor",
              },
              {
                quote: "Exceptions that can cost you a license. Without structured reconciliation, it's your nightmare.",
                role: "FinTech Operations",
                company: "Nigerian FinTech",
              },
              {
                quote: "35-65% false positive rate. Many exceptions are timing differences and data quality issues.",
                role: "Bank Reconciliation Lead",
                company: "Tier-1 Nigerian Bank",
              },
            ].map((t, i) => (
              <div key={i} className="p-6 rounded-xl bg-white border border-gray-100">
                <p className="text-sm text-[#1B365D] italic mb-4">"{t.quote}"</p>
                <p className="text-xs text-[#8C757D] font-medium">{t.role}</p>
                <p className="text-xs text-[#8C757D]">{t.company}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-6 bg-[#1B365D]">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Protect Your License. Eliminate False Positives.
          </h2>
          <p className="text-[#F8F9FA]/70 mb-8">
            Join Nigerian banks and FinTechs using ReconcileAI to reduce reconciliation time by 60% while maintaining CBN compliance.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Button
              size="lg"
              onClick={() => window.location.href = getLoginUrl()}
              className="bg-[#F47458] hover:bg-[#e0644a] text-white px-8 h-12 text-base"
            >
              Start Free Trial <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => window.location.href = "mailto:hello@reconcileai.ng"}
              className="border-white text-white hover:bg-white/10 px-8 h-12 text-base"
            >
              Schedule Demo
            </Button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 bg-[#343A40] text-center">
        <p className="text-sm text-gray-400">
          &copy; {new Date().getFullYear()} Infinity AI. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
