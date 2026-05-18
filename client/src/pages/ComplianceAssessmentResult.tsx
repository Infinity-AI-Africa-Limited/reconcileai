import { useParams, Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Shield, AlertTriangle, TrendingUp, CheckCircle2, ArrowRight, Download, Share2, Loader2, ExternalLink, Copy, Check } from "lucide-react";
import { useState } from "react";

const CATEGORY_LABELS: Record<string, string> = {
  reconciliation: "Reconciliation Process",
  exception: "Exception Management",
  reporting: "Regulatory Reporting",
  regulatory: "Regulatory Awareness",
  technology: "Technology & Automation",
};

const CATEGORY_ICONS: Record<string, string> = {
  reconciliation: "⚖️",
  exception: "🚨",
  reporting: "📋",
  regulatory: "🏛️",
  technology: "⚡",
};

function RiskBadge({ level }: { level: string }) {
  const config: Record<string, { label: string; bg: string; text: string; border: string }> = {
    critical: { label: "Critical Risk", bg: "bg-red-50", text: "text-red-700", border: "border-red-200" },
    high: { label: "High Risk", bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-200" },
    medium: { label: "Medium Risk", bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" },
    low: { label: "Low Risk", bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" },
  };
  const c = config[level] ?? config.medium;
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold border ${c.bg} ${c.text} ${c.border}`}>
      {level === "critical" && <AlertTriangle className="h-3.5 w-3.5" />}
      {level === "high" && <AlertTriangle className="h-3.5 w-3.5" />}
      {level === "medium" && <TrendingUp className="h-3.5 w-3.5" />}
      {level === "low" && <CheckCircle2 className="h-3.5 w-3.5" />}
      {c.label}
    </span>
  );
}

function ScoreGauge({ score }: { score: number }) {
  const color = score >= 80 ? "#10b981" : score >= 60 ? "#f59e0b" : score >= 40 ? "#f97316" : "#ef4444";
  const circumference = 2 * Math.PI * 54;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="140" height="140" className="-rotate-90">
        <circle cx="70" cy="70" r="54" fill="none" stroke="#f1f5f9" strokeWidth="10" />
        <circle
          cx="70" cy="70" r="54" fill="none" stroke={color} strokeWidth="10"
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1s ease" }}
        />
      </svg>
      <div className="absolute text-center">
        <p className="text-3xl font-bold text-[#1B365D]">{score}</p>
        <p className="text-xs text-[#8C757D]">/ 100</p>
      </div>
    </div>
  );
}

function CategoryBar({ label, score, icon }: { label: string; score: number; icon: string }) {
  const color = score >= 80 ? "bg-emerald-500" : score >= 60 ? "bg-amber-500" : score >= 40 ? "bg-orange-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-4">
      <span className="text-lg w-6 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between mb-1">
          <span className="text-sm font-medium text-[#1B365D] truncate">{label}</span>
          <span className="text-sm font-bold text-[#1B365D] ml-2 shrink-0">{score}</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${color} transition-all duration-700`}
            style={{ width: `${score}%` }}
          />
        </div>
      </div>
    </div>
  );
}

const ACTIONS: Record<string, string[]> = {
  reconciliation: [
    "Implement daily reconciliation across all payment channels — not just NIBSS and core banking.",
    "Automate transaction matching to achieve a 95%+ match rate before manual review begins.",
    "Reduce reconciliation cycle time to under 2 hours to eliminate next-day carryover risk.",
  ],
  exception: [
    "Establish a formal exception tracking system with assigned owners and resolution SLAs.",
    "Implement exception categorisation (amount mismatch, timing difference, missing counterparty) to prioritise high-risk items.",
    "Clear your backlog: any exception older than 30 days is a regulatory liability.",
  ],
  reporting: [
    "Automate CBN report generation directly from your reconciliation data — eliminate manual compilation.",
    "Implement a complete audit trail: every matching decision and exception resolution must be logged with timestamp and user.",
    "Test your ability to produce a full audit package within 2 hours — if you can't, that is your highest priority.",
  ],
  regulatory: [
    "Conduct a full review of current CBN reconciliation directives and map your gaps within 30 days.",
    "Document and board-approve a formal reconciliation policy — this is a CBN examination requirement.",
    "Add reconciliation risk to your risk register with defined controls, owners, and quarterly review dates.",
  ],
  technology: [
    "Replace spreadsheet-based reconciliation with purpose-built software — this is the single highest-leverage change.",
    "Consolidate your portal logins: every additional system is a data quality risk and a time cost.",
    "Ensure your reconciliation system can handle 3× current volume without adding headcount — volume growth is inevitable.",
  ],
};

export default function ComplianceAssessmentResult() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";

  const { data, isLoading, error } = trpc.assessment.getByToken.useQuery(
    { token },
    { enabled: !!token, retry: 1 }
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 text-[#F47458] animate-spin mx-auto mb-3" />
          <p className="text-[#8C757D] text-sm">Loading your results…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <AlertTriangle className="h-10 w-10 text-[#F47458] mx-auto mb-4" />
          <h2 className="text-xl font-bold text-[#1B365D] mb-2">Report not found</h2>
          <p className="text-[#8C757D] mb-6">This assessment link may have expired or is invalid.</p>
          <Link href="/compliance-assessment">
            <Button className="bg-[#F47458] hover:bg-[#e0644a] text-white">Take the Assessment</Button>
          </Link>
        </div>
      </div>
    );
  }

  const categoryScores = (data.categoryScores as Record<string, number>) ?? {};
  const riskLevel = data.riskLevel ?? "medium";
  const overallScore = data.overallScore ?? 0;

  // Find the two weakest categories for priority actions
  const sortedCategories = Object.entries(categoryScores).sort(([, a], [, b]) => a - b);
  const weakCategories = sortedCategories.slice(0, 2).map(([cat]) => cat);
  const strongCategories = sortedCategories.slice(-1).map(([cat]) => cat);

  const priorityActions = [
    ...(ACTIONS[weakCategories[0]] ?? []).slice(0, 2),
    ...(ACTIONS[weakCategories[1]] ?? []).slice(0, 1),
  ];

  const riskConfig: Record<string, { headline: string; sub: string; headerBg: string }> = {
    critical: {
      headline: "Immediate action required",
      sub: "Your institution has critical compliance gaps that expose you to CBN sanction or audit failure. Address these before your next regulatory cycle.",
      headerBg: "from-red-700 to-red-900",
    },
    high: {
      headline: "Significant gaps identified",
      sub: "Your institution has high-risk compliance gaps. Targeted improvements are needed before your next CBN examination.",
      headerBg: "from-orange-600 to-orange-800",
    },
    medium: {
      headline: "Partial compliance — improvements needed",
      sub: "Your institution meets some requirements but has material gaps. Focused improvements will significantly reduce your regulatory risk.",
      headerBg: "from-amber-600 to-amber-800",
    },
    low: {
      headline: "Strong compliance posture",
      sub: "Your institution demonstrates strong compliance practices. Focus on automation and scalability to maintain this standard as transaction volumes grow.",
      headerBg: "from-emerald-600 to-emerald-800",
    },
  };
  const rc = riskConfig[riskLevel] ?? riskConfig.medium;

  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback for browsers that block clipboard API
      const el = document.createElement("textarea");
      el.value = window.location.href;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] font-sans">
      {/* Header */}
      <div className={`bg-gradient-to-br ${rc.headerBg} px-6 pt-8 pb-16`}>
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <Link href="/">
              <span className="text-white font-bold text-xl cursor-pointer">ReconcileAI</span>
            </Link>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleShare}
                className={`border-white/30 text-white hover:bg-white/10 bg-transparent h-8 text-xs transition-all duration-200 ${
                  copied ? "bg-white/20 border-white/60" : ""
                }`}
              >
                {copied ? (
                  <><Check className="h-3.5 w-3.5 mr-1.5 text-emerald-300" /> Copied!</>
                ) : (
                  <><Share2 className="h-3.5 w-3.5 mr-1.5" /> Share</>
                )}
              </Button>
            </div>
          </div>
          <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
            <ScoreGauge score={overallScore} />
            <div>
              <div className="flex items-center gap-3 mb-2">
                <RiskBadge level={riskLevel} />
              </div>
              <h1 className="text-2xl md:text-3xl font-bold text-white mb-2">{rc.headline}</h1>
              <p className="text-white/70 max-w-xl leading-relaxed text-sm">{rc.sub}</p>
              {data.institutionName && (
                <p className="text-white/50 text-xs mt-2">
                  {data.institutionName} · {data.respondentRole ?? ""}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 -mt-8 pb-16">
        {/* AI Narrative */}
        {data.aiNarrative && (
          <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className="h-6 w-6 rounded-full bg-[#1B365D]/10 flex items-center justify-center">
                <Shield className="h-3.5 w-3.5 text-[#1B365D]" />
              </div>
              <span className="text-xs font-semibold text-[#1B365D] uppercase tracking-wide">AI Compliance Narrative</span>
            </div>
            <p className="text-[#1B365D] leading-relaxed">{data.aiNarrative}</p>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-6 mb-6">
          {/* Category scores */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
            <h2 className="text-base font-bold text-[#1B365D] mb-5">Score by Dimension</h2>
            <div className="space-y-4">
              {Object.entries(categoryScores)
                .sort(([, a], [, b]) => a - b)
                .map(([cat, score]) => (
                  <CategoryBar
                    key={cat}
                    label={CATEGORY_LABELS[cat] ?? cat}
                    score={score}
                    icon={CATEGORY_ICONS[cat] ?? "📊"}
                  />
                ))}
            </div>
          </div>

          {/* Priority actions */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
            <h2 className="text-base font-bold text-[#1B365D] mb-1">Your Top 3 Priority Actions</h2>
            <p className="text-xs text-[#8C757D] mb-5">
              Ranked by regulatory impact — address these first.
            </p>
            <div className="space-y-4">
              {priorityActions.map((action, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="h-6 w-6 rounded-full bg-[#F47458] text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {i + 1}
                  </div>
                  <p className="text-sm text-[#1B365D] leading-relaxed">{action}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Strengths */}
        {strongCategories.length > 0 && categoryScores[strongCategories[0]] >= 60 && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              <h2 className="text-base font-bold text-emerald-800">Strongest Area</h2>
            </div>
            <p className="text-sm text-emerald-700 leading-relaxed">
              Your <strong>{CATEGORY_LABELS[strongCategories[0]]}</strong> score of{" "}
              <strong>{categoryScores[strongCategories[0]]}/100</strong> is your strongest dimension.
              Maintain this standard as you improve in the weaker areas.
            </p>
          </div>
        )}

        {/* Full action plan */}
        <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6 shadow-sm">
          <h2 className="text-base font-bold text-[#1B365D] mb-1">Full Action Plan by Dimension</h2>
          <p className="text-xs text-[#8C757D] mb-6">
            Specific recommendations for each of the 5 compliance dimensions.
          </p>
          <div className="space-y-6">
            {Object.entries(categoryScores)
              .sort(([, a], [, b]) => a - b)
              .map(([cat, score]) => (
                <div key={cat}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-base">{CATEGORY_ICONS[cat]}</span>
                    <span className="font-semibold text-sm text-[#1B365D]">{CATEGORY_LABELS[cat]}</span>
                    <span className={`ml-auto text-xs font-bold px-2 py-0.5 rounded-full ${
                      score >= 80 ? "bg-emerald-50 text-emerald-700" :
                      score >= 60 ? "bg-amber-50 text-amber-700" :
                      score >= 40 ? "bg-orange-50 text-orange-700" :
                      "bg-red-50 text-red-700"
                    }`}>{score}/100</span>
                  </div>
                  <div className="space-y-2 pl-6">
                    {(ACTIONS[cat] ?? []).map((action, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <div className="h-1.5 w-1.5 rounded-full bg-[#F47458] mt-2 shrink-0" />
                        <p className="text-sm text-[#8C757D] leading-relaxed">{action}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* CTA */}
        <div className="bg-[#1B365D] rounded-2xl p-8 text-center">
          <h2 className="text-xl font-bold text-white mb-2">
            See how ReconcileAI addresses every gap in this report
          </h2>
          <p className="text-white/70 text-sm mb-6 max-w-lg mx-auto">
            ReconcileAI automates reconciliation, eliminates false positives, and generates CBN-ready reports — 
            directly addressing the issues identified in your assessment.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/">
              <Button className="bg-[#F47458] hover:bg-[#e0644a] text-white h-11 px-6">
                See ReconcileAI in Action <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Button
              variant="outline"
              onClick={() => window.location.href = "mailto:hello@reconcileai.ng?subject=Compliance Assessment Follow-up"}
              className="border-white/30 text-white hover:bg-white/10 bg-transparent h-11 px-6"
            >
              <ExternalLink className="mr-2 h-4 w-4" /> Talk to an Expert
            </Button>
          </div>
          <p className="text-white/40 text-xs mt-4">
            Assessment completed {data.completedAt ? new Date(data.completedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : ""}
          </p>
        </div>
      </div>
    </div>
  );
}
