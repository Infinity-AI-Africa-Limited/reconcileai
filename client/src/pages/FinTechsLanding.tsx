import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Zap, Rocket, CheckCircle2, TrendingUp, Clock, Target, ArrowRight } from "lucide-react";
import { Link } from "wouter";

export default function FinTechsLanding() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-[#F4758C] to-[#e06479]">
      {/* Navigation */}
      <nav className="container mx-auto px-4 py-6 flex items-center justify-between">
        <Link href="/">
          <a className="text-2xl font-bold text-white">ReconcileAI</a>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/banks">
            <a className="text-white/80 hover:text-white transition-colors">For Banks</a>
          </Link>
          <Link href="/payment-processors">
            <a className="text-white/80 hover:text-white transition-colors">For Payment Processors</a>
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
          <Badge className="mb-4 bg-white/20 text-white border-none">For FinTechs</Badge>
          <h1 className="text-5xl font-bold text-white mb-6">
            Scale Your FinTech Without Scaling Your Reconciliation Team
          </h1>
          <p className="text-xl text-white/90 mb-8 leading-relaxed">
            Reduce 60% of manual matching time. Free your team to focus on growth, not reconciliation. 
            Deploy in weeks, not months.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/dashboard">
              <Button size="lg" className="bg-white text-[#F4758C] hover:bg-gray-100">
                Start Free Trial <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Button size="lg" variant="outline" className="bg-white/10 text-white border-white/20 hover:bg-white/20">
              See How It Works
            </Button>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="bg-white py-16">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 text-center">
            <div>
              <div className="text-4xl font-bold text-[#F4758C] mb-2">60%</div>
              <div className="text-gray-600">Time Savings</div>
              <div className="text-sm text-gray-500 mt-1">On manual matching</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-[#F4758C] mb-2">&lt;2%</div>
              <div className="text-gray-600">False Positive Rate</div>
              <div className="text-sm text-gray-500 mt-1">Down from 35-65%</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-[#F4758C] mb-2">Weeks</div>
              <div className="text-gray-600">Time to Deploy</div>
              <div className="text-sm text-gray-500 mt-1">vs. 12-18 months internal build</div>
            </div>
            <div>
              <div className="text-4xl font-bold text-[#F4758C] mb-2">10+</div>
              <div className="text-gray-600">Payment Channels</div>
              <div className="text-sm text-gray-500 mt-1">Unified reconciliation</div>
            </div>
          </div>
        </div>
      </section>

      {/* Pain Points Section */}
      <section className="py-20 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto text-center mb-12">
            <h2 className="text-3xl font-bold text-[#1B365D] mb-4">
              The Reconciliation Bottleneck Holding Back Your Growth
            </h2>
            <p className="text-gray-600 text-lg">
              Based on interviews with operations leads at fast-growing Nigerian FinTechs
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            <Card className="border-l-4 border-l-[#F4758C]">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">60% Time on Manual Matching</h3>
                <p className="text-gray-600 mb-3">
                  Even with some automation, <span className="font-semibold">majority of time consumed by manual transaction matching.</span> Your 
                  team should be building features, not matching transactions.
                </p>
                <p className="text-sm text-gray-500">— Operations Lead, Payment FinTech</p>
              </CardContent>
            </Card>

            <Card className="border-l-4 border-l-[#F4758C]">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Reconciliation = Last Line of Defense</h3>
                <p className="text-gray-600 mb-3">
                  <span className="font-semibold">Failures always have massive financial impact.</span> When reconciliation misses control 
                  failures, exploitable gaps lead to significant losses.
                </p>
                <p className="text-sm text-gray-500">— CFO, Digital Lending Platform</p>
              </CardContent>
            </Card>

            <Card className="border-l-4 border-l-[#F4758C]">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Volume Drives Complexity</h3>
                <p className="text-gray-600 mb-3">
                  As transaction volume grows, <span className="font-semibold">reconciliation complexity increases exponentially.</span> Manual 
                  processes don't scale with your business.
                </p>
                <p className="text-sm text-gray-500">— Head of Finance, Mobile Money Provider</p>
              </CardContent>
            </Card>

            <Card className="border-l-4 border-l-[#F4758C]">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Hybrid Team Required</h3>
                <p className="text-gray-600 mb-3">
                  Need both accountants and data analysts. <span className="font-semibold">Hard to hire, expensive to retain,</span> and 
                  difficult to scale as transaction volume increases.
                </p>
                <p className="text-sm text-gray-500">— Operations Manager, Payment Gateway</p>
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
              Modular Architecture That Grows With Your FinTech
            </h2>
            <p className="text-gray-600 text-lg">
              Start with one module, add more as you scale. No need to buy everything upfront.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
            <Card className="border-t-4 border-t-[#F4758C]">
              <CardContent className="pt-6">
                <div className="h-12 w-12 bg-[#F4758C]/10 rounded-lg flex items-center justify-center mb-4">
                  <Zap className="h-6 w-6 text-[#F4758C]" />
                </div>
                <h3 className="font-semibold text-xl text-[#1B365D] mb-3">Transaction Integrity</h3>
                <p className="text-gray-600 mb-4">
                  Ensure every transaction is accounted for across your systems. Eliminate 35-65% false positive rates that waste your team's time.
                </p>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Intelligent matching across 5-6 systems</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Duplicate detection & data normalization</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>60% reduction in manual matching time</span>
                  </li>
                </ul>
              </CardContent>
            </Card>

            <Card className="border-t-4 border-t-[#1B365D]">
              <CardContent className="pt-6">
                <div className="h-12 w-12 bg-[#1B365D]/10 rounded-lg flex items-center justify-center mb-4">
                  <Rocket className="h-6 w-6 text-[#1B365D]" />
                </div>
                <h3 className="font-semibold text-xl text-[#1B365D] mb-3">Settlement Reconciliation</h3>
                <p className="text-gray-600 mb-4">
                  Reconcile across 10+ payment channels automatically. Process 3-4 settlement windows per day without manual intervention.
                </p>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Multi-processor orchestration</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Pre-settlement reconciliation</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Prevent merchant under-settlement</span>
                  </li>
                </ul>
              </CardContent>
            </Card>

            <Card className="border-t-4 border-t-[#F4758C]">
              <CardContent className="pt-6">
                <div className="h-12 w-12 bg-[#F4758C]/10 rounded-lg flex items-center justify-center mb-4">
                  <TrendingUp className="h-6 w-6 text-[#F4758C]" />
                </div>
                <h3 className="font-semibold text-xl text-[#1B365D] mb-3">Account-Level Reconciliation</h3>
                <p className="text-gray-600 mb-4">
                  Match bank account balances to transaction reports. Increase audit confidence from 6.5/10 to 9+/10 for CBN compliance.
                </p>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>GL integration & balance validation</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Comprehensive audit trails</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <span>Reduce month-end close to 1-2 days</span>
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Why FinTechs Choose Us */}
      <section className="py-20 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-3xl font-bold text-[#1B365D] mb-8 text-center">
              Why Fast-Growing FinTechs Choose ReconcileAI
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#F4758C]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Clock className="h-5 w-5 text-[#F4758C]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Deploy in Weeks, Not Months</h3>
                  <p className="text-gray-600">
                    Start reconciling in weeks vs. 12-18 months for internal builds. Get to market faster with lower upfront investment.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#F4758C]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Target className="h-5 w-5 text-[#F4758C]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Pay As You Grow</h3>
                  <p className="text-gray-600">
                    Start with one module, add more as transaction volume increases. No need to commit to full platform upfront.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#F4758C]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Zap className="h-5 w-5 text-[#F4758C]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">AI That Learns & Improves</h3>
                  <p className="text-gray-600">
                    Continuous learning through reinforcement learning. Matching accuracy improves over time as AI learns your patterns.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="h-10 w-10 bg-[#F4758C]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Rocket className="h-5 w-5 text-[#F4758C]" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg text-[#1B365D] mb-2">Focus on Growth, Not Ops</h3>
                  <p className="text-gray-600">
                    Free your team from manual reconciliation. Redirect resources to product development and customer acquisition.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-gradient-to-r from-[#F4758C] to-[#e06479]">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Ready to Scale Without Reconciliation Bottlenecks?
          </h2>
          <p className="text-xl text-white/90 mb-8 max-w-2xl mx-auto">
            Join fast-growing FinTechs using ReconcileAI to eliminate 60% of manual matching work and focus on growth.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/dashboard">
              <Button size="lg" className="bg-white text-[#F4758C] hover:bg-gray-100">
                Start Free Trial <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Button size="lg" variant="outline" className="bg-white/10 text-white border-white/20 hover:bg-white/20">
              Talk to Sales
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
