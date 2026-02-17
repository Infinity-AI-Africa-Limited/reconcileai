import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
import { useLocation } from "wouter";
import { useEffect } from "react";
import {
  ArrowRight,
  Zap,
  Shield,
  BarChart3,
  Layers,
  Clock,
  CheckCircle2,
} from "lucide-react";

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
          <Button
            onClick={() => window.location.href = getLoginUrl()}
            className="bg-[#1B365D] hover:bg-[#142847] text-white"
          >
            Sign In <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-24 pb-20 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#F47458]/10 text-[#F47458] text-sm font-medium mb-6">
            <Zap className="h-4 w-4" /> Powered by Agentic AI
          </div>
          <h1 className="text-5xl md:text-6xl font-bold text-[#1B365D] leading-tight tracking-tight">
            Autonomous Financial
            <br />
            <span className="text-[#F47458]">Reconciliation</span>
          </h1>
          <p className="text-lg text-[#8C757D] mt-6 max-w-2xl mx-auto leading-relaxed">
            Transform reconciliation from a manual, resource-intensive bottleneck into an intelligent, autonomous process. Built for African financial institutions.
          </p>
          <div className="flex items-center justify-center gap-4 mt-10">
            <Button
              size="lg"
              onClick={() => window.location.href = getLoginUrl()}
              className="bg-[#1B365D] hover:bg-[#142847] text-white px-8 h-12 text-base"
            >
              Get Started <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="py-12 bg-white border-y border-gray-200">
        <div className="max-w-5xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-8">
          {[
            { value: "95%+", label: "Auto-Match Rate" },
            { value: "< 3min", label: "Avg Resolution Time" },
            { value: "80%", label: "Exception Reduction" },
            { value: "6+", label: "Payment Channels" },
          ].map((s) => (
            <div key={s.label} className="text-center">
              <p className="text-3xl font-bold text-[#1B365D]">{s.value}</p>
              <p className="text-sm text-[#8C757D] mt-1">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="py-20 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-[#1B365D] text-center mb-12">
            Built for African Finance
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: Zap,
                title: "AI-Powered Matching",
                desc: "Fuzzy matching, amount tolerance, and date windowing reconcile transactions across sources autonomously.",
              },
              {
                icon: Layers,
                title: "Multi-Channel Support",
                desc: "NIBSS, POS, ATM, mobile wallets, and bank statements — all reconciled in a single view.",
              },
              {
                icon: Shield,
                title: "CBN Compliance",
                desc: "Comprehensive audit trails and automated reporting for regulatory compliance.",
              },
              {
                icon: BarChart3,
                title: "Real-Time Dashboard",
                desc: "Match rates, exception summaries, and trend analytics at a glance.",
              },
              {
                icon: Clock,
                title: "Exception Management",
                desc: "AI categorizes unmatched items and suggests resolutions to accelerate review.",
              },
              {
                icon: CheckCircle2,
                title: "Automated Reports",
                desc: "Daily, weekly, and monthly reconciliation reports generated and exported automatically.",
              },
            ].map((f) => (
              <div key={f.title} className="p-6 rounded-xl bg-white border border-gray-100 hover:border-[#1B365D]/20 transition-colors">
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

      {/* CTA */}
      <section className="py-20 px-6 bg-[#1B365D]">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Ready to Automate Reconciliation?
          </h2>
          <p className="text-[#F8F9FA]/70 mb-8">
            Join leading Nigerian financial institutions using ReconcileAI to eliminate manual reconciliation.
          </p>
          <Button
            size="lg"
            onClick={() => window.location.href = getLoginUrl()}
            className="bg-[#F47458] hover:bg-[#e0644a] text-white px-8 h-12 text-base"
          >
            Start Free Trial <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
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
