import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CheckCircle2, AlertTriangle, TrendingUp, Zap, Building2, Landmark,
  FlaskConical, RefreshCw, Loader2, BarChart3, Clock, Shield,
  DollarSign, Users, Activity, ArrowUpRight, ArrowDownRight, Printer,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface MetricCardProps {
  title: string;
  value: string;
  subtitle: string;
  icon: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  trendLabel?: string;
  accent?: string;
}

function MetricCard({ title, value, subtitle, icon, trend, trendLabel, accent = "blue" }: MetricCardProps) {
  const accentMap: Record<string, string> = {
    blue: "text-blue-600 bg-blue-50",
    green: "text-green-600 bg-green-50",
    amber: "text-amber-600 bg-amber-50",
    purple: "text-purple-600 bg-purple-50",
    red: "text-red-600 bg-red-50",
  };
  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{title}</p>
            <p className="text-2xl font-bold text-foreground leading-none mb-1">{value}</p>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
            {trend && trendLabel && (
              <div className={`flex items-center gap-1 mt-2 text-xs font-medium ${trend === "up" ? "text-green-600" : trend === "down" ? "text-red-600" : "text-muted-foreground"}`}>
                {trend === "up" ? <ArrowUpRight className="h-3 w-3" /> : trend === "down" ? <ArrowDownRight className="h-3 w-3" /> : null}
                {trendLabel}
              </div>
            )}
          </div>
          <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ml-3 ${accentMap[accent] ?? accentMap.blue}`}>
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Exception Card ────────────────────────────────────────────────────────────

interface ExceptionCardProps {
  type: string;
  category: string;
  description: string;
  plainLanguage: string;
  recommendation: string;
  severity: "low" | "medium" | "high";
  status: "resolved";
}

function ExceptionCard({ type, category, description, plainLanguage, recommendation, severity }: ExceptionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const severityMap = {
    low: "bg-green-100 text-green-700",
    medium: "bg-amber-100 text-amber-700",
    high: "bg-red-100 text-red-700",
  };
  return (
    <div className="border rounded-xl p-4 bg-card hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-mono text-muted-foreground">{type}</span>
            <Badge variant="outline" className="text-xs">{category}</Badge>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${severityMap[severity]}`}>{severity}</span>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-700">resolved</span>
          </div>
          <p className="text-sm font-medium text-foreground">{description}</p>
        </div>
        <button onClick={() => setExpanded(e => !e)} className="text-xs text-muted-foreground hover:text-foreground shrink-0">
          {expanded ? "Less" : "More"}
        </button>
      </div>
      {expanded && (
        <div className="mt-3 space-y-3 border-t pt-3">
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Plain Language Explanation</p>
            <p className="text-sm text-foreground leading-relaxed">{plainLanguage}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Recommended Action</p>
            <p className="text-sm text-foreground leading-relaxed">{recommendation}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── FMCG Demo Panel ───────────────────────────────────────────────────────────

const FMCG_EXCEPTIONS: ExceptionCardProps[] = [
  {
    type: "partial_payment",
    category: "Amount Mismatch",
    description: "Kola Ventures paid ₦1,800,000 against invoice of ₦2,400,000 — shortfall ₦600,000",
    plainLanguage: "Kola Ventures sent ₦1.8M but their invoice was ₦2.4M. They're ₦600,000 short. This is consistent with a promotional discount they claimed on Order #ORD-2847, but the discount hasn't been formally approved in the system yet.",
    recommendation: "Check if a promotional deduction of ₦600,000 was agreed with the Kola Ventures account manager. If yes, raise a credit note and close the exception. If no, send a payment reminder for the shortfall.",
    severity: "medium",
    status: "resolved",
  },
  {
    type: "fx_bank_fee",
    category: "FX / Bank Fee",
    description: "Remi Foods paid ₦2,398,500 against invoice of ₦2,400,000 — ₦1,500 bank fee deducted",
    plainLanguage: "Remi Foods paid almost the full amount — they're just ₦1,500 short. This is almost certainly a bank transfer fee that their bank deducted before sending the money. This is not a real shortfall.",
    recommendation: "Accept ₦2,398,500 as full payment. Write off ₦1,500 to the Bank Charges cost centre. No further action needed.",
    severity: "low",
    status: "resolved",
  },
  {
    type: "split_payment",
    category: "Many-to-Many Match",
    description: "Single ₦10,000,000 deposit from Ade Distributors matched to 3 invoices: ₦3,300,000 + ₦3,300,000 + ₦3,400,000",
    plainLanguage: "Ade Distributors sent one large payment of ₦10M to cover three separate invoices. The system has split the payment across all three invoices — the numbers add up perfectly. This is a valid payment, just structured differently from the usual one-payment-per-invoice pattern.",
    recommendation: "Approve the three-way split. All three invoices can be marked as paid. No further action needed.",
    severity: "low",
    status: "resolved",
  },
  {
    type: "timing_difference",
    category: "Timing Difference",
    description: "Payment from Sunrise Stores received at 11:47 PM — order not yet entered in ERP",
    plainLanguage: "Sunrise Stores paid late at night, but the sales team hadn't entered their order into the system yet. The money arrived before the paperwork. This happens regularly with distributors who pay after business hours.",
    recommendation: "Wait for the order to be entered in the ERP (expected by 9 AM). The system will auto-match once the order is visible. No manual action needed.",
    severity: "low",
    status: "resolved",
  },
  {
    type: "promotional_deduction",
    category: "Promotional Deduction",
    description: "Metro Traders deducted ₦450,000 — referenced 'Q4 promo less 5%' in payment narration",
    plainLanguage: "Metro Traders took a 5% discount off their payment, referencing a Q4 promotional offer. The AI found the text 'Q4 promo less 5%' in their payment reference. This looks like a legitimate promotional deduction, but it needs to be verified against the approved promotions list.",
    recommendation: "Check the approved Q4 promotions list for Metro Traders. If the 5% discount was authorised, raise a credit note for ₦450,000 and close the exception. If not authorised, contact the account manager.",
    severity: "medium",
    status: "resolved",
  },
];

function FmcgDemoPanel() {
  const demoStatus = trpc.demo.status.useQuery();
  const activateDemo = trpc.demo.activate.useMutation({
    onSuccess: () => demoStatus.refetch(),
  });
  const deactivateDemo = trpc.demo.deactivate.useMutation({
    onSuccess: () => demoStatus.refetch(),
  });
  const isActive = demoStatus.data?.active ?? false;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-foreground">BrightGoods FMCG Demo</h2>
          <p className="text-sm text-muted-foreground">Simulated reconciliation for a mid-size Nigerian FMCG distributor network</p>
        </div>
        <div className="flex items-center gap-2">
          {isActive ? (
            <Button size="sm" variant="outline" onClick={() => deactivateDemo.mutate()} disabled={deactivateDemo.isPending} className="text-xs gap-1.5">
              {deactivateDemo.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
              Clear Demo Data
            </Button>
          ) : (
            <Button size="sm" onClick={() => activateDemo.mutate({ segment: "fmcg" })} disabled={activateDemo.isPending} className="text-xs gap-1.5 bg-amber-500 hover:bg-amber-600 text-white">
              {activateDemo.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
              {activateDemo.isPending ? "Loading 1,000 transactions..." : "Load FMCG Demo Data"}
            </Button>
          )}
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard title="Total Transactions" value="1,000" subtitle="30-day period" icon={<Activity className="h-5 w-5" />} accent="blue" />
        <MetricCard title="Auto-Match Rate" value="95.0%" subtitle="950 matched automatically" icon={<CheckCircle2 className="h-5 w-5" />} accent="green" trend="up" trendLabel="vs 62% manual baseline" />
        <MetricCard title="Exceptions" value="50" subtitle="5% requiring review" icon={<AlertTriangle className="h-5 w-5" />} accent="amber" />
        <MetricCard title="Time Saved" value="18.5 hrs" subtitle="vs manual reconciliation" icon={<Clock className="h-5 w-5" />} accent="purple" trend="up" trendLabel="per reconciliation cycle" />
      </div>

      {/* Match Rate Breakdown */}
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Match Rate Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { label: "Exact reference match", count: 720, pct: 72, color: "bg-green-500" },
              { label: "Fuzzy name match (AI)", count: 145, pct: 14.5, color: "bg-blue-500" },
              { label: "Amount tolerance match (±0.5%)", count: 55, pct: 5.5, color: "bg-purple-500" },
              { label: "Many-to-many split match", count: 30, pct: 3, color: "bg-indigo-500" },
              { label: "Exceptions (human review)", count: 50, pct: 5, color: "bg-amber-500" },
            ].map(row => (
              <div key={row.label} className="flex items-center gap-3">
                <div className="w-44 text-xs text-muted-foreground shrink-0">{row.label}</div>
                <div className="flex-1 bg-muted rounded-full h-2">
                  <div className={`h-2 rounded-full ${row.color}`} style={{ width: `${row.pct}%` }} />
                </div>
                <div className="w-16 text-right text-xs font-medium">{row.count.toLocaleString()} ({row.pct}%)</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Exception Scenarios */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">Exception Scenarios — With Plain Language Explanations</h3>
          <Badge variant="outline" className="text-xs">5 of 50 shown</Badge>
        </div>
        <div className="space-y-3">
          {FMCG_EXCEPTIONS.map((ex, i) => (
            <ExceptionCard key={i} {...ex} />
          ))}
        </div>
      </div>

      {/* ROI Summary */}
      <Card className="border-0 shadow-sm bg-gradient-to-br from-green-50 to-emerald-50">
        <CardContent className="p-5">
          <div className="flex items-start gap-4">
            <div className="h-10 w-10 rounded-xl bg-green-500 flex items-center justify-center shrink-0">
              <TrendingUp className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-sm font-bold text-green-900 mb-1">BrightGoods ROI Summary</p>
              <p className="text-xs text-green-800 leading-relaxed">
                At ₦600M annual revenue with 400 distributors, ReconcileAI reduces reconciliation time from 4 hours to 45 minutes per cycle.
                At 22 cycles per month, that is <strong>73.3 hours saved monthly</strong> — equivalent to one full-time finance officer.
                The 95% auto-match rate eliminates manual investigation for 950 of every 1,000 transactions.
              </p>
              <div className="grid grid-cols-3 gap-4 mt-3">
                <div><p className="text-lg font-bold text-green-900">₦9M</p><p className="text-xs text-green-700">Annual investment</p></div>
                <div><p className="text-lg font-bold text-green-900">₦441M</p><p className="text-xs text-green-700">Recoverable leakage</p></div>
                <div><p className="text-lg font-bold text-green-900">4,900%</p><p className="text-xs text-green-700">ROI</p></div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── FinServ Demo Panel ────────────────────────────────────────────────────────

const FINSERV_EXCEPTIONS: ExceptionCardProps[] = [
  {
    type: "failed_direct_debit",
    category: "Unmatched",
    description: "NIBSS Direct Debit mandate returned — insufficient funds in borrower account",
    plainLanguage: "The borrower's bank rejected the automatic loan repayment because there wasn't enough money in their account. The system tried to collect ₦45,000 on the due date but the bank sent it back. We need to try again in 3 days or call the borrower.",
    recommendation: "Retry direct debit in 3 business days. If second attempt fails, escalate to collections team and send SMS notification to borrower.",
    severity: "high",
    status: "resolved",
  },
  {
    type: "ussd_timeout",
    category: "Timing Difference",
    description: "USSD session timed out — payment credited but not reflected in loan ledger",
    plainLanguage: "The borrower paid via USSD but their phone lost connection before the app confirmed it. The money arrived in our account but the loan system didn't know about it. We can see the payment — it just needs to be matched to the right loan account.",
    recommendation: "Match the USSD credit to the open loan repayment schedule. Update loan ledger manually and mark as resolved. Escalate USSD callback failure to IT for investigation.",
    severity: "medium",
    status: "resolved",
  },
  {
    type: "duplicate_nip_credit",
    category: "Duplicate Transaction",
    description: "Duplicate NIP credit — same session ID credited twice by sending bank",
    plainLanguage: "The borrower's bank accidentally sent the same payment twice. We received ₦30,000 twice from the same transaction. We should keep one as the loan repayment and send the other one back to the borrower immediately.",
    recommendation: "Retain the first credit as the valid loan repayment. Flag the second credit as a duplicate and initiate a refund to the borrower's account via NIP within 24 hours. Document the session ID for NIBSS dispute resolution.",
    severity: "high",
    status: "resolved",
  },
  {
    type: "partial_loan_repayment",
    category: "Amount Mismatch",
    description: "Borrower paid ₦18,500 against scheduled instalment of ₦25,000 — shortfall ₦6,500",
    plainLanguage: "The borrower paid ₦18,500 but their monthly repayment is ₦25,000. They're ₦6,500 short. We should apply what they paid and send them a reminder for the remaining amount before charging any late fees.",
    recommendation: "Apply ₦18,500 to the loan account as a partial payment. Record ₦6,500 as outstanding arrears. Generate a payment reminder for the shortfall with a 7-day grace period before penalty interest accrues.",
    severity: "medium",
    status: "resolved",
  },
  {
    type: "agent_banking_float_shortfall",
    category: "Amount Mismatch",
    description: "Agent banking collection short by ₦150 — agent float fee deducted before remittance",
    plainLanguage: "The agent who collected the borrower's payment kept ₦150 as their fee before sending us the rest. This is normal for agent banking. We should treat the ₦14,850 as the full repayment and record the ₦150 as an agent fee.",
    recommendation: "Accept ₦14,850 as full repayment. Write off ₦150 to Agent Banking Charges cost centre. Update the agent fee schedule to reflect this deduction pattern.",
    severity: "low",
    status: "resolved",
  },
];

const PAYMENT_RAILS = [
  { name: "NIBSS NIP (Interbank)", code: "NIBSS_NIP", txns: "1,200,000", pct: 40 },
  { name: "Direct Debit (NIBSS)", code: "DIRECT_DEBIT", txns: "750,000", pct: 25 },
  { name: "USSD Collections", code: "USSD", txns: "450,000", pct: 15 },
  { name: "POS Terminal", code: "POS", txns: "300,000", pct: 10 },
  { name: "Mobile Banking App", code: "MOBILE_APP", txns: "150,000", pct: 5 },
  { name: "Agent Banking", code: "AGENT_BANKING", txns: "90,000", pct: 3 },
  { name: "Card Payments", code: "CARD", txns: "60,000", pct: 2 },
];

function FinServDemoPanel() {
  const [entity, setEntity] = useState<"both" | "lapo" | "renmoney">("both");
  const demoStatus = trpc.demo.status.useQuery();
  const activateDemo = trpc.demo.activate.useMutation({
    onSuccess: () => demoStatus.refetch(),
  });
  const deactivateDemo = trpc.demo.deactivate.useMutation({
    onSuccess: () => demoStatus.refetch(),
  });
  const isActive = demoStatus.data?.active ?? false;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-foreground">Financial Services Demo</h2>
          <p className="text-sm text-muted-foreground">Simulated reconciliation for LapoMFB and Renmoney MFB — 3,000,000 transactions across 7 payment rails</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Entity selector */}
          <div className="flex rounded-lg border overflow-hidden text-xs">
            {(["both", "lapo", "renmoney"] as const).map(e => (
              <button
                key={e}
                onClick={() => setEntity(e)}
                className={`px-3 py-1.5 font-medium transition-colors ${entity === e ? "bg-blue-600 text-white" : "bg-background text-muted-foreground hover:bg-muted"}`}
              >
                {e === "both" ? "Both" : e === "lapo" ? "LapoMFB" : "Renmoney"}
              </button>
            ))}
          </div>
          {isActive ? (
            <Button size="sm" variant="outline" onClick={() => deactivateDemo.mutate()} disabled={deactivateDemo.isPending} className="text-xs gap-1.5">
              {deactivateDemo.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
              Clear Demo Data
            </Button>
          ) : (
            <Button size="sm" onClick={() => activateDemo.mutate({ segment: "finserv" })} disabled={activateDemo.isPending} className="text-xs gap-1.5 bg-blue-600 hover:bg-blue-700 text-white">
              {activateDemo.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
              {activateDemo.isPending ? "Loading 3M transactions..." : "Load FinServ Demo Data"}
            </Button>
          )}
        </div>
      </div>

      {/* Entity Profiles */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(entity === "both" || entity === "lapo") && (
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="h-9 w-9 rounded-lg bg-green-100 flex items-center justify-center">
                  <Landmark className="h-5 w-5 text-green-700" />
                </div>
                <div>
                  <p className="text-sm font-bold">LapoMFB</p>
                  <p className="text-xs text-muted-foreground">Microfinance Bank — 1.8M active loan accounts</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><p className="text-muted-foreground">Monthly collections</p><p className="font-semibold">₦18.4B</p></div>
                <div><p className="text-muted-foreground">Match rate</p><p className="font-semibold text-green-600">95.2%</p></div>
                <div><p className="text-muted-foreground">Transactions/month</p><p className="font-semibold">1,800,000</p></div>
                <div><p className="text-muted-foreground">Exceptions</p><p className="font-semibold text-amber-600">88,200</p></div>
              </div>
            </CardContent>
          </Card>
        )}
        {(entity === "both" || entity === "renmoney") && (
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="h-9 w-9 rounded-lg bg-blue-100 flex items-center justify-center">
                  <Landmark className="h-5 w-5 text-blue-700" />
                </div>
                <div>
                  <p className="text-sm font-bold">Renmoney MFB</p>
                  <p className="text-xs text-muted-foreground">Digital Microfinance Bank — 620K active borrowers</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><p className="text-muted-foreground">Monthly collections</p><p className="font-semibold">₦6.2B</p></div>
                <div><p className="text-muted-foreground">Match rate</p><p className="font-semibold text-green-600">94.8%</p></div>
                <div><p className="text-muted-foreground">Transactions/month</p><p className="font-semibold">1,200,000</p></div>
                <div><p className="text-muted-foreground">Exceptions</p><p className="font-semibold text-amber-600">62,400</p></div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Combined Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard title="Total Transactions" value="3,000,000" subtitle="Combined monthly volume" icon={<Activity className="h-5 w-5" />} accent="blue" />
        <MetricCard title="Auto-Match Rate" value="95.0%" subtitle="2,850,000 matched automatically" icon={<CheckCircle2 className="h-5 w-5" />} accent="green" trend="up" trendLabel="vs 55% manual baseline" />
        <MetricCard title="Total Exceptions" value="150,000" subtitle="5% requiring human review" icon={<AlertTriangle className="h-5 w-5" />} accent="amber" />
        <MetricCard title="Collections Processed" value="₦24.6B" subtitle="Monthly combined portfolio" icon={<DollarSign className="h-5 w-5" />} accent="purple" />
      </div>

      {/* Payment Rails Breakdown */}
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Payment Rails Coverage — All 7 Rails Active</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {PAYMENT_RAILS.map(rail => (
              <div key={rail.code} className="flex items-center gap-3">
                <div className="w-48 text-xs text-muted-foreground shrink-0">{rail.name}</div>
                <div className="flex-1 bg-muted rounded-full h-2">
                  <div className="h-2 rounded-full bg-blue-500" style={{ width: `${rail.pct}%` }} />
                </div>
                <div className="w-28 text-right text-xs font-medium">{rail.txns} txns ({rail.pct}%)</div>
                <Badge variant="outline" className="text-xs text-green-600 border-green-200">95%+ match</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Exception Scenarios */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">FinServ Exception Scenarios — With Plain Language Explanations</h3>
          <Badge variant="outline" className="text-xs">5 of 150,000 shown</Badge>
        </div>
        <div className="space-y-3">
          {FINSERV_EXCEPTIONS.map((ex, i) => (
            <ExceptionCard key={i} {...ex} />
          ))}
        </div>
      </div>

      {/* ROI Summary */}
      <Card className="border-0 shadow-sm bg-gradient-to-br from-blue-50 to-indigo-50">
        <CardContent className="p-5">
          <div className="flex items-start gap-4">
            <div className="h-10 w-10 rounded-xl bg-blue-600 flex items-center justify-center shrink-0">
              <Shield className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-sm font-bold text-blue-900 mb-1">Financial Services ROI Summary</p>
              <p className="text-xs text-blue-800 leading-relaxed">
                At 3,000,000 transactions per month across 7 payment rails, manual reconciliation requires a team of 12 finance officers working full-time.
                ReconcileAI reduces this to 2 officers handling the 5% exception queue.
                The 95% auto-match rate prevents ₦2.4B in unreconciled collections from ageing beyond 48 hours — a critical regulatory requirement under CBN guidelines.
              </p>
              <div className="grid grid-cols-3 gap-4 mt-3">
                <div><p className="text-lg font-bold text-blue-900">10 FTEs</p><p className="text-xs text-blue-700">Staff reduction</p></div>
                <div><p className="text-lg font-bold text-blue-900">₦2.4B</p><p className="text-xs text-blue-700">Collections reconciled daily</p></div>
                <div><p className="text-lg font-bold text-blue-900">CBN</p><p className="text-xs text-blue-700">Compliance-ready audit trail</p></div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Main Demo Dashboard ───────────────────────────────────────────────────────

function printDemoReport(segment: "fmcg" | "finserv") {
  const title = segment === "fmcg" ? "BrightGoods FMCG — ReconcileAI Demo Report" : "Financial Services (LapoMFB + Renmoney) — ReconcileAI Demo Report";
  const date = new Date().toLocaleDateString("en-NG", { year: "numeric", month: "long", day: "numeric" });
  const fmcgContent = `
    <h2>FMCG Reconciliation Summary</h2>
    <table><tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Total Transactions</td><td>1,000</td></tr>
      <tr><td>Auto-Match Rate</td><td>95.0%</td></tr>
      <tr><td>Automatically Matched</td><td>950</td></tr>
      <tr><td>Exceptions for Review</td><td>50</td></tr>
      <tr><td>Time Saved per Cycle</td><td>18.5 hours</td></tr>
      <tr><td>Finance Officers Required</td><td>1 (vs 4 manual)</td></tr>
    </table>
    <h2>Match Type Breakdown</h2>
    <table><tr><th>Match Type</th><th>Count</th><th>%</th></tr>
      <tr><td>Exact reference match</td><td>720</td><td>72%</td></tr>
      <tr><td>Fuzzy name match (AI)</td><td>145</td><td>14.5%</td></tr>
      <tr><td>FX variance tolerance</td><td>55</td><td>5.5%</td></tr>
      <tr><td>Many-to-many split</td><td>30</td><td>3%</td></tr>
    </table>
    <h2>Exception Narratives (Sample)</h2>
    <p><strong>Partial Payment — Kola Ventures:</strong> Paid ₦1.8M against ₦2.4M invoice. Shortfall of ₦600K consistent with promotional deduction on Order #ORD-2847. Recommendation: verify with account manager and raise credit note if approved.</p>
    <p><strong>FX Bank Fee — Remi Foods:</strong> Paid ₦2,398,500 against ₦2,400,000 invoice. ₦1,500 bank fee deducted by sending bank. Recommendation: accept as full payment, write off ₦1,500 to Bank Charges.</p>
    <p><strong>Split Payment — Ade Distributors:</strong> Single ₦10M deposit matched to 3 invoices (₦3.3M + ₦3.3M + ₦3.4M). Numbers add up perfectly. Recommendation: approve three-way split, mark all three invoices as paid.</p>
    <h2>ROI Summary</h2>
    <p>At 1,000 transactions per reconciliation cycle, ReconcileAI reduces manual reconciliation from 4 finance officers to 1, saving 18.5 hours per cycle. The 95% auto-match rate eliminates ₦600M in annual unreconciled payment risk.</p>
  `;
  const finservContent = `
    <h2>Financial Services Reconciliation Summary</h2>
    <table><tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Total Transactions</td><td>3,000,000/month</td></tr>
      <tr><td>Auto-Match Rate</td><td>95.0%</td></tr>
      <tr><td>Payment Rails Covered</td><td>7 (NIP, Direct Debit, USSD, POS, Mobile, Agent Banking, Card)</td></tr>
      <tr><td>Exceptions for Review</td><td>150,000 (5%)</td></tr>
      <tr><td>Staff Reduction</td><td>10 FTEs (12 → 2)</td></tr>
      <tr><td>Daily Collections Reconciled</td><td>₦2.4B</td></tr>
    </table>
    <h2>Payment Rail Breakdown</h2>
    <table><tr><th>Rail</th><th>Transactions</th><th>Match Rate</th></tr>
      <tr><td>NIP / NIBSS</td><td>1,200,000</td><td>97%</td></tr>
      <tr><td>Direct Debit</td><td>600,000</td><td>94%</td></tr>
      <tr><td>USSD</td><td>480,000</td><td>93%</td></tr>
      <tr><td>POS</td><td>360,000</td><td>96%</td></tr>
      <tr><td>Mobile Banking</td><td>240,000</td><td>95%</td></tr>
      <tr><td>Agent Banking</td><td>72,000</td><td>92%</td></tr>
      <tr><td>Card Payments</td><td>48,000</td><td>96%</td></tr>
    </table>
    <h2>Exception Narratives (Sample)</h2>
    <p><strong>Failed Direct Debit — Chukwuemeka Obi:</strong> Mandate #DD-2847 failed with code R01 (insufficient funds). Loan repayment of ₦45,000 not collected. Recommendation: retry in 3 days, flag account for collections review.</p>
    <p><strong>USSD Timeout — Amina Yusuf:</strong> Customer initiated ₦12,500 transfer via USSD but session timed out. Debit posted but credit not confirmed. Recommendation: check interbank settlement report, reverse debit if credit not confirmed within 24 hours.</p>
    <h2>ROI Summary</h2>
    <p>At 3,000,000 transactions per month across 7 payment rails, ReconcileAI reduces reconciliation staff from 12 to 2 officers. The 95% auto-match rate prevents ₦2.4B in unreconciled collections from ageing beyond 48 hours — a critical CBN regulatory requirement.</p>
  `;
  const content = segment === "fmcg" ? fmcgContent : finservContent;
  const html = `<!DOCTYPE html><html><head><title>${title}</title><style>
    body { font-family: Arial, sans-serif; font-size: 12px; color: #111; margin: 40px; }
    h1 { font-size: 18px; color: #1B365D; border-bottom: 2px solid #1B365D; padding-bottom: 8px; margin-bottom: 4px; }
    h2 { font-size: 14px; color: #1B365D; margin-top: 20px; margin-bottom: 8px; }
    .meta { font-size: 11px; color: #666; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { background: #1B365D; color: white; padding: 6px 10px; text-align: left; font-size: 11px; }
    td { padding: 5px 10px; border-bottom: 1px solid #e5e7eb; font-size: 11px; }
    tr:nth-child(even) td { background: #f9fafb; }
    p { line-height: 1.6; margin-bottom: 10px; }
    .footer { margin-top: 40px; font-size: 10px; color: #999; border-top: 1px solid #e5e7eb; padding-top: 10px; }
    @media print { body { margin: 20px; } }
  </style></head><body>
    <h1>ReconcileAI — Demo Report</h1>
    <p class="meta">Prepared by: Infinity AI &nbsp;|&nbsp; Date: ${date} &nbsp;|&nbsp; Segment: ${segment === "fmcg" ? "FMCG (BrightGoods)" : "Financial Services (LapoMFB + Renmoney MFB)"}</p>
    ${content}
    <div class="footer">This report was generated by ReconcileAI, a product of Infinity AI. The data shown is for demonstration purposes only. Contact: hello@infinityai.ng</div>
  </body></html>`;
  const win = window.open("", "_blank");
  if (win) {
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 500);
  }
}

export default function DemoDashboard() {
  const [activeSegment, setActiveSegment] = useState<"fmcg" | "finserv">("fmcg");
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-amber-500 flex items-center justify-center">
          <FlaskConical className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Demo Dashboard</h1>
          <p className="text-sm text-muted-foreground">Isolated demo environment — data shown here is for demonstration purposes only and does not affect your live reconciliation data</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge className="bg-amber-500 text-white text-xs">DEMO ONLY</Badge>
          <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => printDemoReport(activeSegment)}>
            <Printer className="h-3.5 w-3.5" />
            Print Report
          </Button>
        </div>
      </div>

      {/* Segment Tabs */}
      <Tabs defaultValue="fmcg" onValueChange={(v) => setActiveSegment(v as "fmcg" | "finserv")}>
        <TabsList className="grid w-full max-w-sm grid-cols-2">
          <TabsTrigger value="fmcg" className="gap-1.5 text-xs">
            <Building2 className="h-3.5 w-3.5" />
            FMCG (BrightGoods)
          </TabsTrigger>
          <TabsTrigger value="finserv" className="gap-1.5 text-xs">
            <Landmark className="h-3.5 w-3.5" />
            Financial Services
          </TabsTrigger>
        </TabsList>

        <TabsContent value="fmcg" className="mt-6">
          <FmcgDemoPanel />
        </TabsContent>

        <TabsContent value="finserv" className="mt-6">
          <FinServDemoPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
