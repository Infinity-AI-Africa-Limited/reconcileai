import BeforeAfterROI from "@/components/BeforeAfterROI";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shield, Building2, CheckCircle2, TrendingUp, Clock, Users, ArrowRight } from "lucide-react";
import { Link } from "wouter";

export default function BanksLanding() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-[#1B365D] to-[#2A4A7C]">
      {/* Navigation */}
      <nav className="container mx-auto px-4 py-6 flex items-center justify-between">
        <Link href="/">
          <span className="text-2xl font-bold text-white cursor-pointer">ReconcileAI</span>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/fintechs">
            <span className="text-white/80 hover:text-white transition-colors cursor-pointer">For FinTechs</span>
          </Link>
          <Link href="/payment-processors">
            <span className="text-white/80 hover:text-white transition-colors cursor-pointer">For Payment Processors</span>
          </Link>
          <Link href="/dashboard">
            <Button variant="outline" className="bg-white/10 text-white border-white/20 hover:bg-white/20">
              Sign In
            </Button>
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-4xl mx-auto text-center">
          <Badge className="mb-4 bg-[#F4758C] text-white border-none">For Banks</Badge>
          <h1 className="text-5xl font-bold text-white mb-6">
            Protect Your Banking License with AI-Assisted Reconciliation
          </h1>
          <p className="text-xl text-white/90 mb-8 leading-relaxed">
            Increase audit confidence from 6.5/10 to 9+/10 for CBN compliance. Eliminate the multi-system complexity that consumes your settlement officers' entire workday.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/dashboard">
              <Button size="lg" className="bg-[#F4758C] hover:bg-[#e06479] text-white">
                Request Demo <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Button size="lg" variant="outline" className="bg-white/10 text-white border-white/20 hover:bg-white/20">
              View Case Studies
            </Button>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="bg-white py-16">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 text-center">
            <div>
              <div className="text-4xl font-bold text-[#1B365D] mb-2">9+/10</div>
              <div className="text-gray-600">Audit Confidence Score</div>
              <div className="text-sm text-gray-500 mt-1">Up from 6.5/10</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-[#1B365D] mb-2">60%</div>
              <div className="text-gray-600">Workload Reduction</div>
              <div className="text-sm text-gray-500 mt-1">For settlement officers</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-[#1B365D] mb-2">5+</div>
              <div className="text-gray-600">Portals Eliminated</div>
              <div className="text-sm text-gray-500 mt-1">Unified reconciliation view</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-[#1B365D] mb-2">Zero</div>
              <div className="text-gray-600">License Revocations</div>
              <div className="text-sm text-gray-500 mt-1">Due to reconciliation failures</div>
            </div>
          </div>
        </div>
      </section>

      {/* Pain Points Section */}
      <section className="py-20 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto text-center mb-12">
            <h2 className="text-3xl font-bold text-[#1B365D] mb-4">
              The Reconciliation Crisis Facing Nigerian Banks
            </h2>
            <p className="text-gray-600 text-lg">
              Based on interviews with settlement officers and compliance teams at Tier-1 banks
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            <Card className="border-l-4 border-l-red-500">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Multi-System Login Nightmare</h3>
                <p className="text-gray-600 mb-3">
                  Settlement officers log into 7+ portals daily (3-4 on Interswitch alone, plus NIBSS, UPSL, eTranzact). 
                  <span className="font-semibold"> Majority of 8-hour workday spent on manual downloads.</span>
                </p>
                <p className="text-sm text-gray-500">— Settlement Officer, Tier-1 Bank</p>
              </CardContent>
            </Card>

            <Card className="border-l-4 border-l-red-500">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">License Revocation Risk</h3>
                <p className="text-gray-600 mb-3">
                  Banks report <span className="font-semibold">6.5-7/10 confidence for surprise CBN audits.</span> Unresolved 
                  reconciliation exceptions create regulatory risk that threatens operating licenses.
                </p>
                <p className="text-sm text-gray-500">— Compliance Officer, Commercial Bank</p>
              </CardContent>
            </Card>

            <Card className="border-l-4 border-l-red-500">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">3-4 Settlement Windows Daily</h3>
                <p className="text-gray-600 mb-3">
                  Modern banking requires reconciliation 3-4 times per day, not just daily. Manual processes can't keep pace 
                  with <span className="font-semibold">real-time settlement demands.</span>
                </p>
                <p className="text-sm text-gray-500">— Operations Manager, Digital Bank</p>
              </CardContent>
            </Card>

            <Card className="border-l-4 border-l-red-500">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Month-End Close Delays</h3>
                <p className="text-gray-600 mb-3">
                  Account-level reconciliation takes <span className="font-semibold">5-7 days for month-end close,</span> delaying 
                  financial reporting and creating audit trail gaps for regulatory compliance.
                </p>
                <p className="text-sm text-gray-500">— Finance Manager, Regional Bank</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Solution Section */}
      <section className="py-20 bg-white">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto text-center mb-12">
            <h2 className="text-3xl font-bold text-[#1B365D] mb-4">
              Three Modules Purpose-Built for Banking Operations
            </h2>
            <p className="text-gray-600 text-lg">
              Deploy independently or together based on your institution's needs
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
            <Card className="border-t-4 border-t-[#1B365D]">
              <CardContent className="pt-6">
                <div className="h-12 w-12 bg-[#1B365D]/10 rounded-lg flex items-center justify-center mb-4">
                  <Shield className="h-6 w-6 text-[#1B365D]" />
                </div>
                <h3 className="font-semibold text-xl text-[#1B365D] mb-3">Transaction Integrity</h3>
                <p className="text-gray-600 mb-4">
                  Ensure all transactions are accounted for across your internal systems. Eliminate 35-65% false positive rates.
                </p>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Multi-source transaction ingestion</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Intelligent matching across 5-6 systems</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Duplicate detection & timestamp normalization</span>
                  </li>
                </ul>
              </CardContent>
            </Card>

            <Card className="border-t-4 border-t-[#F4758C]">
              <CardContent className="pt-6">
                <div className="h-12 w-12 bg-[#F4758C]/10 rounded-lg flex items-center justify-center mb-4">
                  <Building2 className="h-6 w-6 text-[#F4758C]" />
                </div>
                <h3 className="font-semibold text-xl text-[#1B365D] mb-3">Settlement Reconciliation</h3>
                <p className="text-gray-600 mb-4">
                  Unified view across all processors. Eliminate 5+ daily portal logins. Process 3-4 settlement windows automatically.
                </p>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Multi-processor orchestration (NIBSS, Interswitch, UPSL)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Automated settlement window scheduling</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>60% reduction in settlement officer workload</span>
                  </li>
                </ul>
              </CardContent>
            </Card>

            <Card className="border-t-4 border-t-[#1B365D]">
              <CardContent className="pt-6">
                <div className="h-12 w-12 bg-[#1B365D]/10 rounded-lg flex items-center justify-center mb-4">
                  <TrendingUp className="h-6 w-6 text-[#1B365D]" />
                </div>
                <h3 className="font-semibold text-xl text-[#1B365D] mb-3">Account-Level Reconciliation</h3>
                <p className="text-gray-600 mb-4">
                  Match bank account balances to transaction reports. Reduce month-end close from 5-7 days to 1-2 days.
                </p>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>GL integration & balance validation</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Audit trail for CBN compliance</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Increase audit confidence to 9+/10</span>
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Trust Section */}
      <section className="py-20 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-3xl font-bold text-[#1B365D] mb-8 text-center">
              Built for Nigerian Banking Regulations
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#1B365D]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Shield className="h-5 w-5 text-[#1B365D]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">CBN Compliance</h3>
                  <p className="text-gray-600">
                    Purpose-built for Nigerian regulatory requirements with comprehensive audit trails and reporting standards.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#1B365D]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Building2 className="h-5 w-5 text-[#1B365D]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">On-Premise Deployment</h3>
                  <p className="text-gray-600">
                    Deploy on your infrastructure to address data sovereignty concerns. Cloud option also available.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#1B365D]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Users className="h-5 w-5 text-[#1B365D]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Human-in-the-Loop</h3>
                  <p className="text-gray-600">
                    AI assists with recommendations, but humans retain final decision-making authority for exceptions.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#1B365D]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Clock className="h-5 w-5 text-[#1B365D]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Weeks to Deploy</h3>
                  <p className="text-gray-600">
                    Deploy in weeks vs. 12-18 months for internal builds. Start with one module and expand as needed.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Before / After — the decision-maker's financial comparison */}
      <BeforeAfterROI />

      {/* CTA Section */}
      <section className="py-20 bg-gradient-to-r from-[#1B365D] to-[#2A4A7C]">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Protect Your Banking License with ReconcileAI
          </h2>
          <p className="text-xl text-white/90 mb-8 max-w-2xl mx-auto">
            Join leading Nigerian banks in eliminating reconciliation risk and achieving 9+/10 audit confidence.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/dashboard">
              <Button size="lg" className="bg-[#F4758C] hover:bg-[#e06479] text-white">
                Schedule Demo <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Button size="lg" variant="outline" className="bg-white/10 text-white border-white/20 hover:bg-white/20">
              Download Case Study
            </Button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#1B365D] text-white/80 py-8">
        <div className="container mx-auto px-4 text-center">
          <p>&copy; 2026 ReconcileAI. Purpose-built for African financial institutions.</p>
        </div>
      </footer>
    </div>
  );
}
