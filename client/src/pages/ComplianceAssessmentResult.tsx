import { useParams, Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Shield, AlertTriangle, TrendingUp, CheckCircle2, ArrowRight, Download, Share2, Loader2, ExternalLink, Copy, Check, Linkedin } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import jsPDF from "jspdf";

// ── Calendly / booking link — swap this when the real link is available ────
const DEMO_BOOKING_URL = "https://calendly.com/reconcileai/demo";

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

const RISK_LABEL: Record<string, string> = {
  critical: "Critical Risk",
  high: "High Risk",
  medium: "Medium Risk",
  low: "Low Risk",
};

function ShareBadge({
  score,
  riskLevel,
  institutionName,
  token,
}: {
  score: number;
  riskLevel: string;
  institutionName?: string;
  token: string;
}) {
  const [embedCopied, setEmbedCopied] = useState(false);
  const resultUrl = `https://reconcileai.vip/compliance-assessment/result/${token}`;
  const riskLabel = RISK_LABEL[riskLevel] ?? "Medium Risk";
  const scoreColor = score >= 80 ? "#10b981" : score >= 60 ? "#f59e0b" : score >= 40 ? "#f97316" : "#ef4444";
  const badgeBg = score >= 80 ? "#f0fdf4" : score >= 60 ? "#fffbeb" : score >= 40 ? "#fff7ed" : "#fef2f2";
  const badgeBorder = score >= 80 ? "#bbf7d0" : score >= 60 ? "#fde68a" : score >= 40 ? "#fed7aa" : "#fecaca";

  const linkedInText = encodeURIComponent(
    `I just completed the ReconcileAI CBN Compliance Readiness Assessment.\n\nMy score: ${score}/100 (${riskLabel})\n\nIf you're in banking or fintech in Nigeria, this 5-minute assessment is worth doing — it maps your reconciliation and compliance gaps against CBN requirements.\n\nTake the free assessment: ${resultUrl}`
  );
  const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(resultUrl)}&summary=${linkedInText}`;

  const embedSnippet = `<a href="${resultUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:10px;padding:10px 16px;background:${badgeBg};border:1.5px solid ${badgeBorder};border-radius:10px;text-decoration:none;font-family:Inter,Arial,sans-serif;">
  <span style="font-size:22px;font-weight:800;color:${scoreColor};">${score}</span>
  <span style="font-size:11px;color:#6b7280;">/ 100</span>
  <span style="width:1px;height:28px;background:#e5e7eb;margin:0 4px;"></span>
  <span style="font-size:12px;font-weight:600;color:#1B365D;">${riskLabel}</span>
  <span style="font-size:11px;color:#9ca3af;">· CBN Compliance · ReconcileAI</span>
</a>`;

  const handleCopyEmbed = async () => {
    try {
      await navigator.clipboard.writeText(embedSnippet);
    } catch {
      const el = document.createElement("textarea");
      el.value = embedSnippet;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setEmbedCopied(true);
    toast.success("Embed snippet copied!", { description: "Paste it into your website, email signature, or LinkedIn post." });
    setTimeout(() => setEmbedCopied(false), 3000);
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6 shadow-sm">
      <h2 className="text-base font-bold text-[#1B365D] mb-1">Share Your Score</h2>
      <p className="text-xs text-[#8C757D] mb-5">
        Share your compliance score on LinkedIn or embed the badge on your website.
      </p>

      {/* Badge preview */}
      <div
        className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl border mb-5"
        style={{ background: badgeBg, borderColor: badgeBorder }}
      >
        <span className="text-2xl font-extrabold" style={{ color: scoreColor }}>{score}</span>
        <span className="text-xs text-gray-400">/ 100</span>
        <span className="w-px h-7 bg-gray-200 mx-1" />
        <span className="text-sm font-semibold text-[#1B365D]">{riskLabel}</span>
        <span className="text-xs text-gray-400 hidden sm:inline">· CBN Compliance · ReconcileAI</span>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        {/* LinkedIn share */}
        <a
          href={linkedInUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#0A66C2] text-white text-sm font-semibold hover:bg-[#0958a8] transition-colors"
        >
          <Linkedin className="h-4 w-4" />
          Share on LinkedIn
        </a>

        {/* Copy embed snippet */}
        <button
          onClick={handleCopyEmbed}
          className={`inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-semibold transition-all duration-150 ${
            embedCopied
              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
              : "border-gray-200 bg-white text-[#1B365D] hover:border-[#1B365D]/30 hover:bg-[#1B365D]/5"
          }`}
        >
          {embedCopied ? (
            <><Check className="h-4 w-4" /> Copied!</>
          ) : (
            <><Copy className="h-4 w-4" /> Copy embed snippet</>
          )}
        </button>

        {/* Copy report link */}
        <button
          onClick={async () => {
            try { await navigator.clipboard.writeText(resultUrl); }
            catch { /* silent */ }
            toast.success("Link copied!", { description: "Anyone with this link can view your full report." });
          }}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-gray-200 bg-white text-[#1B365D] text-sm font-semibold hover:border-[#1B365D]/30 hover:bg-[#1B365D]/5 transition-colors"
        >
          <Share2 className="h-4 w-4" /> Copy report link
        </button>
      </div>

      {institutionName && (
        <p className="text-xs text-[#8C757D] mt-4">
          Scored for <strong>{institutionName}</strong> · <a href={resultUrl} className="text-[#F47458] hover:underline">View full report</a>
        </p>
      )}
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
  const [pdfDownloading, setPdfDownloading] = useState(false);

  const handleDownloadPdf = () => {
    setPdfDownloading(true);
    try {
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageW = 210;
      const margin = 18;
      const contentW = pageW - margin * 2;
      let y = 0;

      // ── Helpers ──────────────────────────────────────────────────────────
      const addPage = () => { doc.addPage(); y = margin; };
      const checkY = (needed: number) => { if (y + needed > 270) addPage(); };

      const riskLabelMap: Record<string, string> = {
        critical: "Critical Risk", high: "High Risk",
        medium: "Medium Risk", low: "Low Risk",
      };
      const riskColMap: Record<string, [number, number, number]> = {
        critical: [220, 38, 38], high: [234, 88, 12],
        medium: [217, 119, 6], low: [5, 150, 105],
      };
      const catLabelMap: Record<string, string> = {
        reconciliation: "Reconciliation Process",
        exception: "Exception Management",
        reporting: "Regulatory Reporting",
        regulatory: "Regulatory Awareness",
        technology: "Technology & Automation",
      };

      const rl = riskLevel as string;
      const riskLabel = riskLabelMap[rl] ?? "Medium Risk";
      const riskCol = riskColMap[rl] ?? [217, 119, 6];
      const instName = (data.institutionName as string | null) ?? "";
      const completedDate = data.completedAt
        ? new Date(data.completedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
        : "";

      // ── Cover header ─────────────────────────────────────────────────────
      doc.setFillColor(27, 54, 93); // #1B365D
      doc.rect(0, 0, pageW, 52, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(20);
      doc.setFont("helvetica", "bold");
      doc.text("CBN Compliance Readiness Report", margin, 22);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text("ReconcileAI · Infinity AI Africa Limited", margin, 31);
      if (instName) doc.text(instName, margin, 39);
      if (completedDate) doc.text(`Assessment date: ${completedDate}`, margin, 47);
      y = 62;

      // ── Score + Risk Level ───────────────────────────────────────────────
      doc.setFillColor(248, 249, 250);
      doc.roundedRect(margin, y, contentW, 30, 3, 3, "F");
      doc.setFontSize(36);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(riskCol[0], riskCol[1], riskCol[2]);
      doc.text(`${overallScore}`, margin + 8, y + 21);
      doc.setFontSize(12);
      doc.setTextColor(100, 100, 100);
      doc.text("/ 100", margin + 28, y + 21);
      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(riskCol[0], riskCol[1], riskCol[2]);
      doc.text(riskLabel, margin + 55, y + 21);
      y += 38;

      // ── AI Narrative ─────────────────────────────────────────────────────
      if (data.aiNarrative) {
        checkY(30);
        doc.setFontSize(11);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(27, 54, 93);
        doc.text("AI Compliance Narrative", margin, y);
        y += 6;
        doc.setFontSize(9.5);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(60, 60, 60);
        const narrativeLines = doc.splitTextToSize(data.aiNarrative as string, contentW);
        checkY(narrativeLines.length * 5 + 4);
        doc.text(narrativeLines, margin, y);
        y += narrativeLines.length * 5 + 8;
      }

      // ── Score by Dimension ───────────────────────────────────────────────
      checkY(20);
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(27, 54, 93);
      doc.text("Score by Dimension", margin, y);
      y += 6;
      const sortedCats = Object.entries(categoryScores).sort(([, a], [, b]) => (a as number) - (b as number));
      for (const [cat, score] of sortedCats) {
        const s = score as number;
        checkY(10);
        const barColor: [number, number, number] = s >= 80 ? [16, 185, 129] : s >= 60 ? [245, 158, 11] : s >= 40 ? [249, 115, 22] : [239, 68, 68];
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(60, 60, 60);
        doc.text(catLabelMap[cat] ?? cat, margin, y + 4);
        doc.setTextColor(barColor[0], barColor[1], barColor[2]);
        doc.setFont("helvetica", "bold");
        doc.text(`${s}/100`, pageW - margin - 16, y + 4);
        doc.setFillColor(230, 230, 230);
        doc.roundedRect(margin + 60, y, contentW - 76, 4, 1, 1, "F");
        doc.setFillColor(barColor[0], barColor[1], barColor[2]);
        doc.roundedRect(margin + 60, y, (contentW - 76) * (s / 100), 4, 1, 1, "F");
        y += 9;
      }
      y += 4;

      // ── Top 3 Priority Actions ───────────────────────────────────────────
      checkY(20);
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(27, 54, 93);
      doc.text("Top 3 Priority Actions", margin, y);
      y += 6;
      priorityActions.forEach((action, i) => {
        const lines = doc.splitTextToSize(`${i + 1}. ${action}`, contentW);
        checkY(lines.length * 5 + 4);
        doc.setFontSize(9.5);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(60, 60, 60);
        doc.text(lines, margin, y);
        y += lines.length * 5 + 3;
      });
      y += 4;

      // ── Full Action Plan ─────────────────────────────────────────────────
      checkY(20);
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(27, 54, 93);
      doc.text("Full Action Plan by Dimension", margin, y);
      y += 7;
      for (const [cat, score] of sortedCats) {
        const s = score as number;
        checkY(16);
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(27, 54, 93);
        doc.text(`${catLabelMap[cat] ?? cat} — ${s}/100`, margin, y);
        y += 5;
        const actions = ACTIONS[cat] ?? [];
        for (const action of actions) {
          const lines = doc.splitTextToSize(`• ${action}`, contentW - 4);
          checkY(lines.length * 5 + 2);
          doc.setFontSize(9);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(80, 80, 80);
          doc.text(lines, margin + 3, y);
          y += lines.length * 5 + 2;
        }
        y += 4;
      }

      // ── Book a Demo final page ────────────────────────────────────────────
      doc.addPage();
      // Navy header bar
      doc.setFillColor(27, 54, 93);
      doc.rect(0, 0, pageW, 52, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("Ready to close your compliance gaps?", margin, 22);
      doc.setFontSize(11);
      doc.setFont("helvetica", "normal");
      doc.text("Book a personalised 30-minute demo with the ReconcileAI team.", margin, 34);
      doc.setFontSize(9);
      doc.text("We will walk through your specific scores and show you exactly how ReconcileAI resolves each gap.", margin, 43);

      // Coral CTA box
      const ctaY = 70;
      doc.setFillColor(244, 116, 88); // #F47458 coral
      doc.roundedRect(margin, ctaY, contentW, 28, 3, 3, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(13);
      doc.setFont("helvetica", "bold");
      doc.text("Book Your Free Demo", pageW / 2, ctaY + 11, { align: "center" });
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text(DEMO_BOOKING_URL, pageW / 2, ctaY + 21, { align: "center" });

      // What to expect section
      const expectY = ctaY + 42;
      doc.setTextColor(27, 54, 93);
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text("What to expect in the demo", margin, expectY);
      doc.setDrawColor(244, 116, 88);
      doc.setLineWidth(0.5);
      doc.line(margin, expectY + 2, margin + 60, expectY + 2);

      const bullets = [
        "Live walkthrough of the ReconcileAI reconciliation engine on your transaction types",
        "Side-by-side comparison: your current process vs. automated reconciliation",
        "Specific resolution path for each gap identified in your compliance score",
        "Pricing and implementation timeline for your institution size",
        "Q&A with the product team — no sales pressure, just answers",
      ];
      let bY = expectY + 10;
      for (const bullet of bullets) {
        doc.setFillColor(244, 116, 88);
        doc.circle(margin + 2, bY - 1.5, 1.2, "F");
        const bLines = doc.splitTextToSize(bullet, contentW - 8);
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(60, 60, 60);
        doc.text(bLines, margin + 6, bY);
        bY += bLines.length * 5 + 3;
      }

      // Score summary reminder box
      const summaryY = bY + 8;
      doc.setFillColor(248, 249, 250);
      doc.roundedRect(margin, summaryY, contentW, 22, 2, 2, "F");
      doc.setDrawColor(220, 220, 220);
      doc.setLineWidth(0.3);
      doc.roundedRect(margin, summaryY, contentW, 22, 2, 2, "S");
      doc.setTextColor(27, 54, 93);
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.text(`Your score: ${overallScore}/100 — ${riskLabel}`, margin + 6, summaryY + 8);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      const summaryLine = instName
        ? `${instName} · Assessment completed ${completedDate}`
        : `Assessment completed ${completedDate}`;
      doc.text(summaryLine, margin + 6, summaryY + 16);

      // Footer note on demo page
      doc.setFontSize(8);
      doc.setTextColor(160, 160, 160);
      doc.text("ReconcileAI by Infinity AI Africa Limited · reconcileai.vip · contact@reconcileai.vip", pageW / 2, 282, { align: "center" });

      // ── Footer on every page ─────────────────────────────────────────────
      const pageCount = doc.getNumberOfPages();
      for (let p = 1; p <= pageCount; p++) {
        doc.setPage(p);
        doc.setFontSize(8);
        doc.setTextColor(160, 160, 160);
        doc.text(
          `ReconcileAI CBN Compliance Report · ${instName || "Assessment"} · Page ${p} of ${pageCount}`,
          margin, 290
        );
        doc.text("reconcileai.vip", pageW - margin - 22, 290);
      }

      const filename = instName
        ? `ReconcileAI_Compliance_Report_${instName.replace(/\s+/g, "_")}.pdf`
        : `ReconcileAI_Compliance_Report_${overallScore}.pdf`;
      doc.save(filename);
      toast.success("PDF downloaded!", { description: filename });
    } catch (err) {
      console.error("PDF generation failed:", err);
      toast.error("PDF generation failed", { description: "Please try again or use your browser's print function." });
    } finally {
      setPdfDownloading(false);
    }
  };

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
                onClick={handleDownloadPdf}
                disabled={pdfDownloading}
                className="border-white/30 text-white hover:bg-white/10 bg-transparent h-8 text-xs transition-all duration-200 disabled:opacity-60"
              >
                {pdfDownloading ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Generating…</>
                ) : (
                  <><Download className="h-3.5 w-3.5 mr-1.5" /> Download PDF</>
                )}
              </Button>
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

        {/* Share Badge */}
        <ShareBadge
          score={overallScore}
          riskLevel={riskLevel}
          institutionName={data.institutionName ?? undefined}
          token={token}
        />

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
