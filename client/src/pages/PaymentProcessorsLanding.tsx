import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Layers, CheckCircle2, Shield, Zap, Users, ArrowRight } from "lucide-react";
import { Link } from "wouter";

export default function PaymentProcessorsLanding() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-[#2A4A7C] to-[#1B365D]">
      {/* Navigation */}
      <nav className="container mx-auto px-4 py-6 flex items-center justify-between">
        <Link href="/">
          <a className="text-2xl font-bold text-white">ReconcileAI</a>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/banks">
            <a className="text-white/80 hover:text-white transition-colors">For Banks</a>
          </Link>
          <Link href="/fintechs">
            <a className="text-white/80 hover:text-white transition-colors">For FinTechs</a>
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
          <Badge className="mb-4 bg-[#F4758C] text-white border-none">For Payment Processors</Badge>
          <h1 className="text-5xl font-bold text-white mb-6">
            Eliminate 95-98% False Positives Across 20+ Reconciliation Processes
          </h1>
          <p className="text-xl text-white/90 mb-8 leading-relaxed">
            Stop wasting 30+ minutes per false alarm. Reconcile POS, transfers, bill payments, and web purchases with &lt;2% false positive rates.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/dashboard">
              <Button size="lg" className="bg-[#F4758C] hover:bg-[#e06479] text-white">
                Request Demo <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Button size="lg" variant="outline" className="bg-white/10 text-white border-white/20 hover:bg-white/20">
              Download ROI Calculator
            </Button>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="bg-white py-16">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 text-center">
            <div>
              <div className="text-4xl font-bold text-[#2A4A7C] mb-2">&lt;2%</div>
              <div className="text-gray-600">False Positive Rate</div>
              <div className="text-sm text-gray-500 mt-1">Down from 95-98%</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-[#2A4A7C] mb-2">30+</div>
              <div className="text-gray-600">Minutes Saved</div>
              <div className="text-sm text-gray-500 mt-1">Per false alarm eliminated</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-[#2A4A7C] mb-2">&lt;2%</div>
              <div className="text-gray-600">Processes Unified</div>
              <div className="text-sm text-gray-500 mt-1">POS, transfers, bills, web</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-[#2A4A7C] mb-2">9+/10</div>
              <div className="text-gray-600">Audit Confidence</div>
              <div className="text-sm text-gray-500 mt-1">For CBN compliance</div>
            </div>
          </div>
        </div>
      </section>

      {/* Pain Points Section */}
      <section className="py-20 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto text-center mb-12">
            <h2 className="text-3xl font-bold text-[#1B365D] mb-4">
              The False Positive Crisis Crippling Payment Processors
            </h2>
            <p className="text-gray-600 text-lg">
              Based on interviews with reconciliation team leads at major Nigerian payment processors
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            <Card className="border-l-4 border-l-[#2A4A7C]">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">95-98% False Positive Rates</h3>
                <p className="text-gray-600 mb-3">
                  Reconciliation teams waste <span className="font-semibold">30+ minutes per false alarm</span> investigating timing differences, 
                  rounding errors, and system lag that aren't real issues.
                </p>
                <p className="text-sm text-gray-500">— Reconciliation Team Lead, Interswitch</p>
              </CardContent>
            </Card>

            <Card className="border-l-4 border-l-[#2A4A7C]">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Settlement-Before-Reconciliation Risk</h3>
                <p className="text-gray-600 mb-3">
                  Merchants under-settled (e.g., <span className="font-semibold">₦500M instead of ₦600M</span>) due to post-settlement 
                  reconciliation, requiring 1-2 day delays for corrections.
                </p>
                <p className="text-sm text-gray-500">— Settlement Manager, Payment Processor</p>
              </CardContent>
            </Card>

            <Card className="border-l-4 border-l-[#2A4A7C]">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">20+ Reconciliation Processes</h3>
                <p className="text-gray-600 mb-3">
                  Managing reconciliation across <span className="font-semibold">POS, transfers, bill payments, web purchases, mobile money,</span> and 
                  more. Each channel requires different matching logic.
                </p>
                <p className="text-sm text-gray-500">— Operations Director, Multi-Channel Processor</p>
              </CardContent>
            </Card>

            <Card className="border-l-4 border-l-[#2A4A7C]">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">6.5-7/10 Audit Confidence</h3>
                <p className="text-gray-600 mb-3">
                  <span className="font-semibold">Fear of surprise CBN inspections.</span> Unresolved exceptions create regulatory risk that 
                  could cost operating licenses.
                </p>
                <p className="text-sm text-gray-500">— Compliance Officer, Payment Gateway</p>
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
              Three Modules for End-to-End Payment Processing Reconciliation
            </h2>
            <p className="text-gray-600 text-lg">
              From transaction integrity to settlement to account-level validation
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
            <Card className="border-t-4 border-t-[#2A4A7C]">
              <CardContent className="pt-6">
                <div className="h-12 w-12 bg-[#2A4A7C]/10 rounded-lg flex items-center justify-center mb-4">
                  <Activity className="h-6 w-6 text-[#2A4A7C]" />
                </div>
                <h3 className="font-semibold text-xl text-[#1B365D] mb-3">Transaction Integrity</h3>
                <p className="text-gray-600 mb-4">
                  Eliminate 95-98% false positive rates. Intelligent pattern recognition learns timing differences, rounding, and system lag.
                </p>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Multi-channel reconciliation (POS, transfers, bills, web)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>False positive classification & elimination</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Save 30+ minutes per false alarm</span>
                  </li>
                </ul>
              </CardContent>
            </Card>

            <Card className="border-t-4 border-t-[#F4758C]">
              <CardContent className="pt-6">
                <div className="h-12 w-12 bg-[#F4758C]/10 rounded-lg flex items-center justify-center mb-4">
                  <Layers className="h-6 w-6 text-[#F4758C]" />
                </div>
                <h3 className="font-semibold text-xl text-[#1B365D] mb-3">Settlement Reconciliation</h3>
                <p className="text-gray-600 mb-4">
                  Enable pre-settlement reconciliation. Prevent merchant under-settlement. Process 3-4 settlement windows per day automatically.
                </p>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Two-level reconciliation (Bank→Processor→Merchant)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Merchant-level grouping for instant settlement</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Prevent ₦100M+ under-settlement issues</span>
                  </li>
                </ul>
              </CardContent>
            </Card>

            <Card className="border-t-4 border-t-[#2A4A7C]">
              <CardContent className="pt-6">
                <div className="h-12 w-12 bg-[#2A4A7C]/10 rounded-lg flex items-center justify-center mb-4">
                  <Shield className="h-6 w-6 text-[#2A4A7C]" />
                </div>
                <h3 className="font-semibold text-xl text-[#1B365D] mb-3">Account-Level Reconciliation</h3>
                <p className="text-gray-600 mb-4">
                  Increase audit confidence from 6.5/10 to 9+/10. Comprehensive audit trails for CBN compliance and regulatory reporting.
                </p>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>GL integration & balance validation</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>100% audit trail completeness</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Protect operating license from CBN sanctions</span>
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Why Payment Processors Choose Us */}
      <section className="py-20 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-3xl font-bold text-[#1B365D] mb-8 text-center">
              Why Leading Payment Processors Choose ReconcileAI
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#2A4A7C]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Activity className="h-5 w-5 text-[#2A4A7C]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Intelligent Pattern Recognition</h3>
                  <p className="text-gray-600">
                    AI learns your specific timing differences, rounding patterns, and system lag characteristics to eliminate false positives.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#2A4A7C]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Layers className="h-5 w-5 text-[#2A4A7C]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Multi-Channel Orchestration</h3>
                  <p className="text-gray-600">
                    Reconcile POS, transfers, bill payments, web purchases, and mobile money from a single unified platform.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#2A4A7C]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Zap className="h-5 w-5 text-[#2A4A7C]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Pre-Settlement Reconciliation</h3>
                  <p className="text-gray-600">
                    Catch discrepancies before merchant payments. Eliminate 1-2 day delays for settlement corrections.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#2A4A7C]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Users className="h-5 w-5 text-[#2A4A7C]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Human-in-the-Loop</h3>
                  <p className="text-gray-600">
                    "If decision-making remains in human hands, that takes away the fear." AI assists, humans decide.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-gradient-to-r from-[#2A4A7C] to-[#1B365D]">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Eliminate False Positives and Protect Your Operating License
          </h2>
          <p className="text-xl text-white/90 mb-8 max-w-2xl mx-auto">
            Join leading Nigerian payment processors in reducing false positive rates from 95-98% to &lt;2%.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/dashboard">
              <Button size="lg" className="bg-[#F4758C] hover:bg-[#e06479] text-white">
                Schedule Demo <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Button size="lg" variant="outline" className="bg-white/10 text-white border-white/20 hover:bg-white/20">
              Calculate Your ROI
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
