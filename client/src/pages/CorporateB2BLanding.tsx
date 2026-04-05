import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ArrowRight, CheckCircle2, TrendingUp, Clock, Building2, Layers,
  AlertTriangle, ShieldCheck, Zap, Users, BarChart3, GitMerge,
  ChevronRight, Star, Send, Loader2,
} from "lucide-react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

const PAIN_POINTS = [
  {
    icon: AlertTriangle,
    title: "Payments Arrive. Books Don't Match.",
    description:
      "A single ₦10M wire from a distributor lands in your account — but it covers three separate invoices from two different business units. Your team spends 4 hours manually splitting it. Every. Single. Day.",
  },
  {
    icon: Layers,
    title: "ERP Says One Thing. Bank Says Another.",
    description:
      "SAP shows ₦2.4M outstanding. Your bank statement shows ₦2.4M received. But the reference numbers don't match, the dates are off by two days, and no one can explain the ₦18,000 difference.",
  },
  {
    icon: Clock,
    title: "Month-End Is a War Zone.",
    description:
      "Finance teams across Nigeria spend the last 5 days of every month in emergency reconciliation mode. Auditors wait. CFOs escalate. Staff work weekends. The root cause is always the same: manual matching at scale doesn't work.",
  },
  {
    icon: Building2,
    title: "Distributors Don't Follow Your Reference Format.",
    description:
      "You asked for 'INV-2024-00847' in the payment reference. They sent 'Kola Ventures payment Jan'. Your system can't match it. Your team has to.",
  },
];

const SOLUTIONS = [
  {
    icon: GitMerge,
    title: "Many-to-Many Matching",
    description:
      "ReconcileAI splits a single bank deposit across multiple invoices automatically — with confidence scores and a full reasoning trail. No more manual allocation spreadsheets.",
    highlight: "Industry-first for African FMCG",
  },
  {
    icon: Zap,
    title: "Distributor Identity Resolution",
    description:
      "Our AI recognises 'Kola Ventures', 'Kolade Ventures & Sons', and 'KV Nigeria Ltd' as the same entity — and learns every new variation permanently.",
    highlight: "95%+ auto-match rate by month 3",
  },
  {
    icon: ShieldCheck,
    title: "Human-in-the-Loop Approval",
    description:
      "Every proposed match, split, or allocation is presented to your finance team for one-click approval before it is committed. Full audit trail. Zero unauthorised postings.",
    highlight: "Regulatory-grade audit trail",
  },
  {
    icon: BarChart3,
    title: "ERP & Bank Feed Integration",
    description:
      "Connect SAP, Sage, Odoo, or any ERP alongside your bank feeds via API, SFTP, or CSV. ReconcileAI normalises the data and starts matching within 48 hours.",
    highlight: "Go live in 4 weeks",
  },
];

const METRICS = [
  { value: "95%", label: "Auto-Match Rate", sub: "By end of month 3" },
  { value: "4 hrs → 45 min", label: "Daily Reconciliation Time", sub: "Per finance officer" },
  { value: "₦600M+", label: "Annual Waste Eliminated", sub: "For a 400-distributor FMCG" },
  { value: "4,900%", label: "ROI", sub: "On ₦9M annual investment" },
];

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Connect Your Data Sources",
    description:
      "Link your ERP, bank feeds, and payment platforms. ReconcileAI ingests data via API, SFTP, or CSV upload — whichever your IT team prefers.",
  },
  {
    step: "02",
    title: "Agent Reads & Matches",
    description:
      "The Super Agent analyses every incoming payment, identifies the corresponding invoices, and proposes matches — including complex many-to-many splits — with full reasoning.",
  },
  {
    step: "03",
    title: "Your Team Reviews & Approves",
    description:
      "Finance officers see a clear, plain-language summary of each proposed match. One click to approve, one click to override. Nothing posts without human sign-off.",
  },
  {
    step: "04",
    title: "Books Close. Audit Passes.",
    description:
      "Every decision is logged to an immutable audit trail. Month-end closes in hours, not days. Auditors get a clean, timestamped record of every reconciliation decision.",
  },
];

const TESTIMONIAL = {
  quote:
    "Before ReconcileAI, our team spent Monday mornings untangling the weekend's distributor payments. Now the agent has 90% of them matched before anyone arrives at the office. The remaining 10% takes 20 minutes to review. It's changed how we operate.",
  name: "Head of Finance Operations",
  company: "Leading Nigerian FMCG Company",
  rating: 5,
};

export default function CorporateB2BLanding() {
  const [showDemoModal, setShowDemoModal] = useState(false);
  const [demoForm, setDemoForm] = useState({ companyName: "", email: "", paymentVolume: "", name: "" });
  const [submitted, setSubmitted] = useState(false);
  const requestDemo = trpc.leads.requestDemo.useMutation({
    onSuccess: () => {
      setSubmitted(true);
      toast.success("Demo request received!", { description: "Our team will contact you within 24 hours." });
    },
    onError: (err: { message: string }) => toast.error("Submission failed", { description: err.message }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!demoForm.companyName || !demoForm.email) {
      toast.error("Please fill in all required fields");
      return;
    }
    requestDemo.mutate({
      companyName: demoForm.companyName,
      contactEmail: demoForm.email,
      monthlyPaymentVolume: demoForm.paymentVolume,
      message: demoForm.name ? `Contact: ${demoForm.name}` : undefined,
      source: "corporate_b2b_landing",
    });
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <nav className="bg-[#1B365D] sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <span className="text-xl font-bold text-white cursor-pointer tracking-tight">
              ReconcileAI
            </span>
          </Link>
          <div className="hidden md:flex items-center gap-6 text-sm">
            <Link href="/banks">
              <span className="text-white/70 hover:text-white transition-colors cursor-pointer">For Banks</span>
            </Link>
            <Link href="/fintechs">
              <span className="text-white/70 hover:text-white transition-colors cursor-pointer">For FinTechs</span>
            </Link>
            <Link href="/payment-processors">
              <span className="text-white/70 hover:text-white transition-colors cursor-pointer">For Payment Processors</span>
            </Link>
            <Link href="/dashboard">
              <Button size="sm" className="bg-[#F47458] hover:bg-[#e06040] text-white border-none">
                Sign In
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="bg-gradient-to-br from-[#1B365D] via-[#1B365D] to-[#0f2240] text-white">
        <div className="max-w-7xl mx-auto px-6 py-24 grid md:grid-cols-2 gap-16 items-center">
          <div>
            <Badge className="mb-6 bg-[#F47458]/20 text-[#F47458] border-[#F47458]/30 text-sm px-3 py-1">
              Corporate B2B Payments
            </Badge>
            <h1 className="text-5xl font-bold leading-tight mb-6">
              Your Payments Are Settled.{" "}
              <span className="text-[#F47458]">Your Books Are Not.</span>
            </h1>
            <p className="text-xl text-white/80 leading-relaxed mb-8">
              ReconcileAI is the first AI reconciliation agent built for African FMCG companies and corporate B2B payment environments — where a single bank deposit can cover 12 invoices across 4 distributors.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link href="/dashboard">
                <Button size="lg" className="bg-[#F47458] hover:bg-[#e06040] text-white">
                  Request a Pilot <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </Link>
              <Link href="/super-agent">
                <Button size="lg" variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20">
                  See the Agent Live
                </Button>
              </Link>
            </div>
          </div>
          {/* Hero visual — stats card */}
          <div className="bg-white/10 backdrop-blur rounded-2xl p-8 border border-white/20">
            <div className="text-sm text-white/60 mb-4 font-medium uppercase tracking-wider">Live Reconciliation</div>
            <div className="space-y-4">
              {[
                { label: "₦10,000,000 deposit from Kola Ventures", status: "Splitting…", color: "text-[#F47458]" },
                { label: "INV-2024-00847 — ₦4,200,000", status: "Matched ✓", color: "text-green-400" },
                { label: "INV-2024-00851 — ₦3,800,000", status: "Matched ✓", color: "text-green-400" },
                { label: "INV-2024-00863 — ₦2,000,000", status: "Matched ✓", color: "text-green-400" },
              ].map((row, i) => (
                <div key={i} className="flex items-center justify-between bg-white/5 rounded-lg px-4 py-3">
                  <span className="text-white/90 text-sm">{row.label}</span>
                  <span className={`text-sm font-semibold ${row.color}`}>{row.status}</span>
                </div>
              ))}
              <div className="border-t border-white/20 pt-4 flex items-center justify-between">
                <span className="text-white/60 text-sm">Confidence Score</span>
                <span className="text-white font-bold text-lg">97.4%</span>
              </div>
              <div className="text-center text-white/50 text-xs">Awaiting your approval — 1 click to commit</div>
            </div>
          </div>
        </div>
      </section>

      {/* Metrics Bar */}
      <section className="bg-[#F47458] py-12">
        <div className="max-w-7xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-8 text-center text-white">
          {METRICS.map((m) => (
            <div key={m.label}>
              <div className="text-3xl font-bold mb-1">{m.value}</div>
              <div className="font-medium">{m.label}</div>
              <div className="text-white/70 text-sm mt-1">{m.sub}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Pain Points */}
      <section className="py-24 bg-gray-50">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <Badge className="mb-4 bg-red-100 text-red-700 border-red-200">The Problem</Badge>
            <h2 className="text-4xl font-bold text-[#1B365D] mb-4">
              Corporate B2B Payments Are Broken at Scale
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Every FMCG company with more than 50 distributors faces the same four failure modes. They are not edge cases — they are the daily reality of your finance team.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-8">
            {PAIN_POINTS.map((p) => (
              <div key={p.title} className="bg-white rounded-xl p-8 border border-gray-200">
                <div className="flex items-start gap-4">
                  <div className="bg-red-100 rounded-lg p-3 flex-shrink-0">
                    <p.icon className="h-6 w-6 text-red-600" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-[#1B365D] mb-2">{p.title}</h3>
                    <p className="text-gray-600 leading-relaxed">{p.description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Solutions */}
      <section className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <Badge className="mb-4 bg-green-100 text-green-700 border-green-200">The Solution</Badge>
            <h2 className="text-4xl font-bold text-[#1B365D] mb-4">
              ReconcileAI Solves Each One — Autonomously
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Four capabilities that work together as a single intelligent agent, not four separate tools your team has to manage.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-8">
            {SOLUTIONS.map((s) => (
              <div key={s.title} className="border border-gray-200 rounded-xl p-8 hover:border-[#1B365D]/40 transition-colors">
                <div className="flex items-start gap-4">
                  <div className="bg-[#1B365D]/10 rounded-lg p-3 flex-shrink-0">
                    <s.icon className="h-6 w-6 text-[#1B365D]" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-lg font-bold text-[#1B365D]">{s.title}</h3>
                    </div>
                    <p className="text-gray-600 leading-relaxed mb-3">{s.description}</p>
                    <Badge className="bg-[#F47458]/10 text-[#F47458] border-[#F47458]/20 text-xs">
                      {s.highlight}
                    </Badge>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Many-to-Many Explainer */}
      <section className="py-24 bg-[#1B365D] text-white">
        <div className="max-w-7xl mx-auto px-6 grid md:grid-cols-2 gap-16 items-center">
          <div>
            <Badge className="mb-6 bg-[#F47458]/20 text-[#F47458] border-[#F47458]/30">
              Industry First
            </Badge>
            <h2 className="text-4xl font-bold mb-6">
              Many-to-Many Matching: The Capability No Other Tool Has
            </h2>
            <p className="text-white/80 text-lg leading-relaxed mb-6">
              Standard reconciliation tools assume one payment matches one invoice. In the real world of Nigerian FMCG, one payment matches many invoices — and sometimes many payments match one invoice.
            </p>
            <p className="text-white/80 text-lg leading-relaxed mb-8">
              ReconcileAI's Super Agent is the only reconciliation tool in Africa that handles this natively — splitting deposits, aggregating payments, and presenting the full allocation logic for human approval before anything posts.
            </p>
            <Link href="/super-agent">
              <Button className="bg-[#F47458] hover:bg-[#e06040] text-white">
                See the Demo <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
          <div className="bg-white/10 rounded-2xl p-8 border border-white/20">
            <div className="text-sm text-white/60 mb-6 font-medium uppercase tracking-wider">
              Super Agent — Many-to-Many Split
            </div>
            <div className="mb-4 bg-white/5 rounded-lg p-4 border border-white/10">
              <div className="text-white/60 text-xs mb-1">INCOMING PAYMENT</div>
              <div className="text-white font-bold text-xl">₦10,000,000</div>
              <div className="text-white/70 text-sm">From: Kola Ventures Ltd · Ref: KV-JAN-2024</div>
            </div>
            <div className="flex items-center justify-center my-4">
              <div className="flex flex-col items-center gap-1">
                <GitMerge className="h-6 w-6 text-[#F47458]" />
                <span className="text-[#F47458] text-xs font-medium">AI Splitting</span>
              </div>
            </div>
            <div className="space-y-3">
              {[
                { inv: "INV-2024-00847", amt: "₦4,200,000", conf: "99.1%", note: "Exact ref match" },
                { inv: "INV-2024-00851", amt: "₦3,800,000", conf: "97.8%", note: "Amount + date match" },
                { inv: "INV-2024-00863", amt: "₦2,000,000", conf: "94.3%", note: "Distributor pattern" },
              ].map((row) => (
                <div key={row.inv} className="bg-white/5 rounded-lg px-4 py-3 flex items-center justify-between">
                  <div>
                    <div className="text-white text-sm font-medium">{row.inv}</div>
                    <div className="text-white/50 text-xs">{row.note}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-white font-semibold">{row.amt}</div>
                    <div className="text-green-400 text-xs">{row.conf} confidence</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-6 flex gap-3">
              <Button className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm">
                Approve All
              </Button>
              <Button variant="outline" className="flex-1 bg-white/10 text-white border-white/20 hover:bg-white/20 text-sm">
                Review Each
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-24 bg-gray-50">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <Badge className="mb-4 bg-blue-100 text-blue-700 border-blue-200">How It Works</Badge>
            <h2 className="text-4xl font-bold text-[#1B365D] mb-4">
              From Data Chaos to Clean Books in 4 Steps
            </h2>
          </div>
          <div className="grid md:grid-cols-4 gap-8">
            {HOW_IT_WORKS.map((step, i) => (
              <div key={step.step} className="relative">
                {i < HOW_IT_WORKS.length - 1 && (
                  <div className="hidden md:block absolute top-8 left-full w-full h-0.5 bg-[#1B365D]/20 z-0" />
                )}
                <div className="relative z-10">
                  <div className="w-16 h-16 rounded-full bg-[#1B365D] text-white flex items-center justify-center text-xl font-bold mb-4">
                    {step.step}
                  </div>
                  <h3 className="text-lg font-bold text-[#1B365D] mb-2">{step.title}</h3>
                  <p className="text-gray-600 text-sm leading-relaxed">{step.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonial */}
      <section className="py-24 bg-white">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <div className="flex justify-center gap-1 mb-6">
            {Array.from({ length: TESTIMONIAL.rating }).map((_, i) => (
              <Star key={i} className="h-5 w-5 fill-[#F47458] text-[#F47458]" />
            ))}
          </div>
          <blockquote className="text-2xl text-[#1B365D] font-medium leading-relaxed mb-8 italic">
            "{TESTIMONIAL.quote}"
          </blockquote>
          <div className="font-semibold text-[#1B365D]">{TESTIMONIAL.name}</div>
          <div className="text-gray-500 text-sm">{TESTIMONIAL.company}</div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 bg-[#F47458]">
        <div className="max-w-4xl mx-auto px-6 text-center text-white">
          <h2 className="text-4xl font-bold mb-4">
            Give Us 4 Weeks. We Will Show You Your Own Savings.
          </h2>
          <p className="text-xl text-white/90 mb-10 leading-relaxed">
            We run a no-risk pilot on your actual data. If ReconcileAI does not achieve a 90% auto-match rate within 4 weeks, you pay nothing and walk away with a free data quality report.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Button
              size="lg"
              className="bg-white text-[#F47458] hover:bg-gray-100 font-semibold"
              onClick={() => { setShowDemoModal(true); setSubmitted(false); }}
            >
              Request a Demo <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
            <Link href="/super-agent">
              <Button size="lg" variant="outline" className="bg-white/20 text-white border-white/40 hover:bg-white/30">
                See the Super Agent
              </Button>
            </Link>
          </div>
          <div className="mt-8 flex flex-wrap justify-center gap-8 text-white/80 text-sm">
            {["No upfront payment", "90% match rate guarantee", "4-week go-live", "Full data security"].map((item) => (
              <div key={item} className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-white" />
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Request Demo Modal */}
      <Dialog open={showDemoModal} onOpenChange={setShowDemoModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-[#1B365D]">Request a Demo</DialogTitle>
            <DialogDescription>
              Tell us about your company and we will set up a personalised demo within 24 hours.
            </DialogDescription>
          </DialogHeader>
          {submitted ? (
            <div className="py-8 flex flex-col items-center gap-4 text-center">
              <div className="h-14 w-14 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-green-600" />
              </div>
              <div>
                <p className="font-semibold text-foreground text-lg">Request Received!</p>
                <p className="text-sm text-muted-foreground mt-1">Our team will contact you at <strong>{demoForm.email}</strong> within 24 hours.</p>
              </div>
              <Button className="mt-2" onClick={() => setShowDemoModal(false)}>Close</Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Your Name</label>
                <Input
                  placeholder="e.g. Adaeze Okafor"
                  value={demoForm.name}
                  onChange={(e) => setDemoForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Company Name <span className="text-red-500">*</span></label>
                <Input
                  placeholder="e.g. BrightGoods Nigeria Ltd"
                  value={demoForm.companyName}
                  onChange={(e) => setDemoForm(f => ({ ...f, companyName: e.target.value }))}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Work Email <span className="text-red-500">*</span></label>
                <Input
                  type="email"
                  placeholder="e.g. adaeze@brightgoods.com"
                  value={demoForm.email}
                  onChange={(e) => setDemoForm(f => ({ ...f, email: e.target.value }))}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Estimated Monthly Payment Volume</label>
                <Select onValueChange={(v) => setDemoForm(f => ({ ...f, paymentVolume: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a range" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Under ₦50M/month">Under ₦50M/month</SelectItem>
                    <SelectItem value="₦50M–₦200M/month">₦50M–₦200M/month</SelectItem>
                    <SelectItem value="₦200M–₦1B/month">₦200M–₦1B/month</SelectItem>
                    <SelectItem value="Over ₦1B/month">Over ₦1B/month</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                className="w-full bg-[#F47458] hover:bg-[#e0634a] text-white font-semibold"
                disabled={requestDemo.isPending}
              >
                {requestDemo.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
                Send Request
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Footer */}
      <footer className="bg-[#1B365D] text-white/60 py-8">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4 text-sm">
          <span className="text-white font-semibold">ReconcileAI by Infinity AI</span>
          <div className="flex gap-6">
            <Link href="/banks"><span className="hover:text-white cursor-pointer">For Banks</span></Link>
            <Link href="/fintechs"><span className="hover:text-white cursor-pointer">For FinTechs</span></Link>
            <Link href="/payment-processors"><span className="hover:text-white cursor-pointer">For Payment Processors</span></Link>
            <Link href="/documentation"><span className="hover:text-white cursor-pointer">Docs</span></Link>
          </div>
          <span>© 2024 Infinity AI. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}
