import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, ArrowRight, Shield, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

// ─── Question bank ────────────────────────────────────────────────────────────
const QUESTIONS = [
  // Category 1: Reconciliation Process (q1–q5)
  {
    id: "q1", category: "reconciliation", categoryLabel: "Reconciliation Process",
    text: "How often does your institution complete a full reconciliation of all payment channels?",
    options: [
      { label: "Daily — books close every business day", score: 5 },
      { label: "2–3 times per week", score: 3 },
      { label: "Weekly", score: 2 },
      { label: "Monthly or less frequently", score: 1 },
      { label: "No formal schedule — ad hoc only", score: 0 },
    ],
  },
  {
    id: "q2", category: "reconciliation", categoryLabel: "Reconciliation Process",
    text: "How many payment channels does your reconciliation process currently cover?",
    options: [
      { label: "All channels (NIBSS, POS, ATM, mobile, card schemes, core banking)", score: 5 },
      { label: "Most channels — 1–2 gaps", score: 4 },
      { label: "Core banking and NIBSS only", score: 2 },
      { label: "Manual bank statement matching only", score: 1 },
      { label: "No structured multi-channel reconciliation", score: 0 },
    ],
  },
  {
    id: "q3", category: "reconciliation", categoryLabel: "Reconciliation Process",
    text: "What is your typical match rate on a standard reconciliation run?",
    options: [
      { label: "95%+ matched automatically", score: 5 },
      { label: "85–94% matched automatically", score: 4 },
      { label: "70–84% matched — significant manual work required", score: 2 },
      { label: "Below 70% — most matching is manual", score: 1 },
      { label: "We don't track match rates", score: 0 },
    ],
  },
  {
    id: "q4", category: "reconciliation", categoryLabel: "Reconciliation Process",
    text: "How long does it take your team to complete a full daily reconciliation?",
    options: [
      { label: "Under 30 minutes", score: 5 },
      { label: "30 minutes to 2 hours", score: 4 },
      { label: "2–6 hours", score: 2 },
      { label: "More than 6 hours / carries into the next day", score: 1 },
      { label: "We don't do daily reconciliation", score: 0 },
    ],
  },
  {
    id: "q5", category: "reconciliation", categoryLabel: "Reconciliation Process",
    text: "How many staff members are primarily dedicated to reconciliation work?",
    options: [
      { label: "1–2 (supported by automation)", score: 5 },
      { label: "3–5", score: 3 },
      { label: "6–10", score: 2 },
      { label: "More than 10", score: 1 },
      { label: "No dedicated reconciliation staff", score: 0 },
    ],
  },
  // Category 2: Exception Management (q6–q10)
  {
    id: "q6", category: "exception", categoryLabel: "Exception Management",
    text: "How are unmatched transactions (exceptions) currently tracked and managed?",
    options: [
      { label: "Dedicated exception management system with workflow and audit trail", score: 5 },
      { label: "Spreadsheet with assigned owners and resolution deadlines", score: 3 },
      { label: "Shared spreadsheet — no formal ownership", score: 2 },
      { label: "Email threads and informal notes", score: 1 },
      { label: "No formal exception tracking", score: 0 },
    ],
  },
  {
    id: "q7", category: "exception", categoryLabel: "Exception Management",
    text: "What is your current unresolved exception backlog?",
    options: [
      { label: "Zero — all exceptions resolved within 24 hours", score: 5 },
      { label: "Less than 1 week of transactions", score: 4 },
      { label: "1–4 weeks of unresolved exceptions", score: 2 },
      { label: "More than 1 month of backlog", score: 1 },
      { label: "We don't track the backlog size", score: 0 },
    ],
  },
  {
    id: "q8", category: "exception", categoryLabel: "Exception Management",
    text: "What percentage of your exceptions are false positives (timing differences, data quality issues)?",
    options: [
      { label: "Under 20% — our exceptions are mostly genuine discrepancies", score: 5 },
      { label: "20–35%", score: 4 },
      { label: "35–55%", score: 2 },
      { label: "Over 55% — most exceptions resolve themselves", score: 1 },
      { label: "We don't categorise exceptions by type", score: 0 },
    ],
  },
  {
    id: "q9", category: "exception", categoryLabel: "Exception Management",
    text: "How are exceptions categorised and prioritised for resolution?",
    options: [
      { label: "Automated categorisation by type and severity with SLA tracking", score: 5 },
      { label: "Manual categorisation with clear priority tiers", score: 3 },
      { label: "Basic categorisation — no priority framework", score: 2 },
      { label: "All exceptions treated equally — no categorisation", score: 1 },
      { label: "No categorisation process", score: 0 },
    ],
  },
  {
    id: "q10", category: "exception", categoryLabel: "Exception Management",
    text: "Do you have a formal escalation path for high-value or aged exceptions?",
    options: [
      { label: "Yes — automated escalation with defined thresholds and approvers", score: 5 },
      { label: "Yes — manual escalation process with documented rules", score: 4 },
      { label: "Informal escalation — depends on individual judgement", score: 2 },
      { label: "No escalation process", score: 0 },
    ],
  },
  // Category 3: Regulatory Reporting (q11–q15)
  {
    id: "q11", category: "reporting", categoryLabel: "Regulatory Reporting",
    text: "How do you currently generate CBN reconciliation reports?",
    options: [
      { label: "Automated generation from reconciliation system in CBN format", score: 5 },
      { label: "Semi-automated — system generates draft, team reviews and formats", score: 4 },
      { label: "Manual compilation from multiple spreadsheets", score: 2 },
      { label: "Ad hoc — compiled differently each period", score: 1 },
      { label: "We don't generate formal CBN reconciliation reports", score: 0 },
    ],
  },
  {
    id: "q12", category: "reporting", categoryLabel: "Regulatory Reporting",
    text: "Have you ever submitted a late or inaccurate reconciliation report to the CBN?",
    options: [
      { label: "Never — 100% on-time and accurate submission record", score: 5 },
      { label: "Once or twice — isolated incidents", score: 3 },
      { label: "Occasionally — 3–5 times in the past 2 years", score: 2 },
      { label: "Frequently — recurring submission issues", score: 0 },
    ],
  },
  {
    id: "q13", category: "reporting", categoryLabel: "Regulatory Reporting",
    text: "How long does it take to produce a complete regulatory reconciliation report?",
    options: [
      { label: "Under 1 hour — automated", score: 5 },
      { label: "1–4 hours", score: 4 },
      { label: "Half a day", score: 2 },
      { label: "More than a day", score: 1 },
      { label: "We don't produce formal reports", score: 0 },
    ],
  },
  {
    id: "q14", category: "reporting", categoryLabel: "Regulatory Reporting",
    text: "Do you maintain a complete audit trail for all reconciliation decisions and exception resolutions?",
    options: [
      { label: "Yes — every action logged with timestamp, user, and justification", score: 5 },
      { label: "Partial — key decisions logged but not all actions", score: 3 },
      { label: "Minimal — only final outcomes recorded", score: 1 },
      { label: "No audit trail", score: 0 },
    ],
  },
  {
    id: "q15", category: "reporting", categoryLabel: "Regulatory Reporting",
    text: "How quickly could you produce a full reconciliation audit package if the CBN requested one today?",
    options: [
      { label: "Within 2 hours — everything is structured and accessible", score: 5 },
      { label: "Within 1 business day", score: 4 },
      { label: "2–5 business days", score: 2 },
      { label: "More than a week", score: 1 },
      { label: "We could not produce a complete package", score: 0 },
    ],
  },
  // Category 4: Regulatory Awareness (q16–q20)
  {
    id: "q16", category: "regulatory", categoryLabel: "Regulatory Awareness",
    text: "Are you aware of the CBN's specific reconciliation requirements for your institution type?",
    options: [
      { label: "Yes — fully aware and compliant with all current directives", score: 5 },
      { label: "Mostly aware — some gaps in our understanding", score: 3 },
      { label: "Partially aware — we rely on our auditors to flag issues", score: 2 },
      { label: "Limited awareness", score: 1 },
      { label: "Not aware of specific CBN reconciliation requirements", score: 0 },
    ],
  },
  {
    id: "q17", category: "regulatory", categoryLabel: "Regulatory Awareness",
    text: "Has your institution received any CBN queries, sanctions, or warnings related to reconciliation in the past 3 years?",
    options: [
      { label: "No — clean record", score: 5 },
      { label: "One informal query — resolved without penalty", score: 3 },
      { label: "One formal query or warning", score: 2 },
      { label: "Multiple queries or a formal sanction", score: 0 },
    ],
  },
  {
    id: "q18", category: "regulatory", categoryLabel: "Regulatory Awareness",
    text: "How do you stay current with CBN reconciliation and reporting circulars?",
    options: [
      { label: "Dedicated compliance team monitors and implements all new directives", score: 5 },
      { label: "Regular review of CBN website + external legal counsel", score: 4 },
      { label: "Rely on industry associations and peer networks", score: 2 },
      { label: "Ad hoc — we learn about changes when auditors flag them", score: 1 },
      { label: "No formal process for tracking regulatory changes", score: 0 },
    ],
  },
  {
    id: "q19", category: "regulatory", categoryLabel: "Regulatory Awareness",
    text: "Do you have a documented reconciliation policy approved by your board or senior management?",
    options: [
      { label: "Yes — reviewed and updated within the past 12 months", score: 5 },
      { label: "Yes — but not reviewed in over a year", score: 3 },
      { label: "Draft policy exists but not formally approved", score: 1 },
      { label: "No documented reconciliation policy", score: 0 },
    ],
  },
  {
    id: "q20", category: "regulatory", categoryLabel: "Regulatory Awareness",
    text: "How are reconciliation-related risks captured in your institution's risk register?",
    options: [
      { label: "Explicitly captured with defined controls, owners, and review dates", score: 5 },
      { label: "Captured under operational risk — general category", score: 3 },
      { label: "Not explicitly captured but acknowledged informally", score: 1 },
      { label: "Not captured in the risk register", score: 0 },
    ],
  },
  // Category 5: Technology & Automation (q21–q25)
  {
    id: "q21", category: "technology", categoryLabel: "Technology & Automation",
    text: "What is your primary reconciliation tool today?",
    options: [
      { label: "Purpose-built reconciliation software (automated matching)", score: 5 },
      { label: "ERP module with reconciliation features", score: 3 },
      { label: "Excel / Google Sheets — manual process", score: 1 },
      { label: "No dedicated tool — ad hoc per channel", score: 0 },
    ],
  },
  {
    id: "q22", category: "technology", categoryLabel: "Technology & Automation",
    text: "How many separate portals or systems does your team log into to complete a reconciliation?",
    options: [
      { label: "1 — single unified system", score: 5 },
      { label: "2–3 portals", score: 4 },
      { label: "4–6 portals", score: 2 },
      { label: "7 or more portals", score: 0 },
    ],
  },
  {
    id: "q23", category: "technology", categoryLabel: "Technology & Automation",
    text: "How much of your reconciliation process is currently automated?",
    options: [
      { label: "Over 80% automated — humans review exceptions only", score: 5 },
      { label: "50–80% automated", score: 4 },
      { label: "20–50% automated", score: 2 },
      { label: "Under 20% automated — mostly manual", score: 1 },
      { label: "Fully manual", score: 0 },
    ],
  },
  {
    id: "q24", category: "technology", categoryLabel: "Technology & Automation",
    text: "Can your current system handle a 3× increase in transaction volume without adding headcount?",
    options: [
      { label: "Yes — fully scalable, no headcount change needed", score: 5 },
      { label: "Partially — would need some process changes but not more staff", score: 3 },
      { label: "No — we would need to hire more reconciliation staff", score: 1 },
      { label: "Our current system would break at 3× volume", score: 0 },
    ],
  },
  {
    id: "q25", category: "technology", categoryLabel: "Technology & Automation",
    text: "Does your reconciliation system integrate directly with your core banking system?",
    options: [
      { label: "Yes — real-time or near-real-time integration", score: 5 },
      { label: "Yes — batch/daily file integration", score: 4 },
      { label: "Partial — some channels integrated, others manual", score: 2 },
      { label: "No integration — all data entered manually", score: 0 },
    ],
  },
];

type Answer = { questionId: string; answer: string; score: number };

const TOTAL_STEPS = QUESTIONS.length + 2; // questions + contact info + submit

export default function ComplianceAssessmentQuiz() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0); // 0 = intro, 1–25 = questions, 26 = contact, 27 = submitting
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [currentSelection, setCurrentSelection] = useState<string>("");
  const [contact, setContact] = useState({
    name: "", email: "", role: "", institution: "",
    institutionType: "" as string,
    consent: false,
  });

  const submitMutation = trpc.assessment.submit.useMutation({
    onSuccess: (data) => {
      navigate(`/compliance-assessment/result/${data.token}`);
    },
    onError: (err) => {
      toast.error("Submission failed. Please try again.");
      setStep(QUESTIONS.length + 1); // back to contact step
    },
  });

  const currentQuestion = step >= 1 && step <= QUESTIONS.length ? QUESTIONS[step - 1] : null;
  const progress = step === 0 ? 0 : Math.round((step / (QUESTIONS.length + 1)) * 100);

  const handleNext = useCallback(() => {
    if (step === 0) {
      setStep(1);
      setCurrentSelection("");
      return;
    }
    if (currentQuestion) {
      if (!currentSelection) {
        toast.error("Please select an answer before continuing.");
        return;
      }
      const opt = currentQuestion.options.find(o => o.label === currentSelection)!;
      setAnswers(prev => ({
        ...prev,
        [currentQuestion.id]: { questionId: currentQuestion.id, answer: currentSelection, score: opt.score },
      }));
      setCurrentSelection(answers[QUESTIONS[step]?.id ?? ""]?.answer ?? "");
      setStep(s => s + 1);
      return;
    }
    // Contact step → submit
    if (step === QUESTIONS.length + 1) {
      const allAnswers = Object.values(answers);
      setStep(QUESTIONS.length + 2);
      submitMutation.mutate({
        answers: allAnswers,
        respondentName: contact.name || undefined,
        respondentEmail: contact.email || undefined,
        respondentRole: contact.role || undefined,
        institutionName: contact.institution || undefined,
        institutionType: contact.institutionType as any || undefined,
        consentToContact: contact.consent,
      });
    }
  }, [step, currentQuestion, currentSelection, answers, contact, submitMutation]);

  const handleBack = useCallback(() => {
    if (step <= 1) { setStep(0); return; }
    setStep(s => s - 1);
    const prevQ = QUESTIONS[step - 2];
    if (prevQ) setCurrentSelection(answers[prevQ.id]?.answer ?? "");
  }, [step, answers]);

  // ── Intro screen ──────────────────────────────────────────────────────────
  if (step === 0) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex flex-col">
        <nav className="bg-white border-b border-gray-100 px-6 h-16 flex items-center justify-between">
          <Link href="/compliance-assessment">
            <span className="text-xl font-bold text-[#1B365D] cursor-pointer">ReconcileAI</span>
          </Link>
        </nav>
        <div className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="max-w-lg w-full bg-white rounded-2xl border border-gray-100 p-8 text-center shadow-sm">
            <div className="h-14 w-14 rounded-2xl bg-[#1B365D]/5 flex items-center justify-center mx-auto mb-6">
              <Shield className="h-7 w-7 text-[#1B365D]" />
            </div>
            <h1 className="text-2xl font-bold text-[#1B365D] mb-3">CBN Compliance Readiness Assessment</h1>
            <p className="text-[#8C757D] mb-6 leading-relaxed">
              25 questions across 5 compliance dimensions. Takes approximately 5 minutes.
              Your answers are scored in real time and a personalised risk report is generated at the end.
            </p>
            <div className="grid grid-cols-5 gap-2 mb-8">
              {["Reconciliation", "Exceptions", "Reporting", "Regulatory", "Technology"].map((cat) => (
                <div key={cat} className="bg-[#F8F9FA] rounded-lg p-2 text-center">
                  <p className="text-xs font-medium text-[#1B365D] leading-tight">{cat}</p>
                  <p className="text-xs text-[#8C757D] mt-0.5">5 Qs</p>
                </div>
              ))}
            </div>
            <Button
              onClick={() => setStep(1)}
              className="w-full bg-[#F47458] hover:bg-[#e0644a] text-white h-12 text-base"
            >
              Begin Assessment <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <p className="text-xs text-[#8C757D] mt-4">Free · No account required · Results in 60 seconds</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Submitting screen ─────────────────────────────────────────────────────
  if (step === QUESTIONS.length + 2) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex flex-col items-center justify-center px-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-gray-100 p-8 text-center shadow-sm">
          <Loader2 className="h-10 w-10 text-[#F47458] animate-spin mx-auto mb-4" />
          <h2 className="text-xl font-bold text-[#1B365D] mb-2">Analysing your responses…</h2>
          <p className="text-[#8C757D] text-sm">
            Calculating your risk score and generating your personalised compliance narrative.
            This takes about 10–15 seconds.
          </p>
        </div>
      </div>
    );
  }

  // ── Contact info step ─────────────────────────────────────────────────────
  if (step === QUESTIONS.length + 1) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex flex-col">
        <nav className="bg-white border-b border-gray-100 px-6 h-16 flex items-center justify-between">
          <Link href="/compliance-assessment">
            <span className="text-xl font-bold text-[#1B365D] cursor-pointer">ReconcileAI</span>
          </Link>
          <span className="text-sm text-[#8C757D]">Almost done</span>
        </nav>
        <div className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="max-w-lg w-full">
            <div className="mb-6">
              <Progress value={96} className="h-1.5 bg-gray-100" />
              <p className="text-xs text-[#8C757D] mt-2">Step 26 of 26 — Contact details (optional)</p>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 p-8 shadow-sm">
              <h2 className="text-xl font-bold text-[#1B365D] mb-2">Get your personalised report</h2>
              <p className="text-sm text-[#8C757D] mb-6">
                All fields are optional. Providing your details allows us to personalise your report and
                follow up with tailored recommendations.
              </p>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs text-[#1B365D] font-medium mb-1.5 block">Your name</Label>
                    <Input
                      placeholder="e.g. Adaeze Okafor"
                      value={contact.name}
                      onChange={e => setContact(c => ({ ...c, name: e.target.value }))}
                      className="h-10 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-[#1B365D] font-medium mb-1.5 block">Your role</Label>
                    <Input
                      placeholder="e.g. Head of Operations"
                      value={contact.role}
                      onChange={e => setContact(c => ({ ...c, role: e.target.value }))}
                      className="h-10 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-[#1B365D] font-medium mb-1.5 block">Work email</Label>
                  <Input
                    type="email"
                    placeholder="e.g. adaeze@yourbank.com"
                    value={contact.email}
                    onChange={e => setContact(c => ({ ...c, email: e.target.value }))}
                    className="h-10 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-[#1B365D] font-medium mb-1.5 block">Institution name</Label>
                  <Input
                    placeholder="e.g. First City Bank"
                    value={contact.institution}
                    onChange={e => setContact(c => ({ ...c, institution: e.target.value }))}
                    className="h-10 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-[#1B365D] font-medium mb-1.5 block">Institution type</Label>
                  <Select
                    value={contact.institutionType}
                    onValueChange={v => setContact(c => ({ ...c, institutionType: v }))}
                  >
                    <SelectTrigger className="h-10 text-sm">
                      <SelectValue placeholder="Select institution type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="commercial_bank">Commercial Bank</SelectItem>
                      <SelectItem value="microfinance_bank">Microfinance Bank</SelectItem>
                      <SelectItem value="fintech">FinTech</SelectItem>
                      <SelectItem value="payment_processor">Payment Processor</SelectItem>
                      <SelectItem value="corporate_b2b">Corporate B2B</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-start gap-3 pt-2">
                  <Checkbox
                    id="consent"
                    checked={contact.consent}
                    onCheckedChange={v => setContact(c => ({ ...c, consent: !!v }))}
                    className="mt-0.5"
                  />
                  <Label htmlFor="consent" className="text-xs text-[#8C757D] leading-relaxed cursor-pointer">
                    I consent to ReconcileAI contacting me with personalised recommendations based on my assessment results.
                  </Label>
                </div>
              </div>
              <div className="flex gap-3 mt-8">
                <Button variant="outline" onClick={handleBack} className="flex-1 h-11">
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
                <Button
                  onClick={handleNext}
                  className="flex-2 flex-grow bg-[#F47458] hover:bg-[#e0644a] text-white h-11"
                >
                  Get My Risk Score <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Question screen ───────────────────────────────────────────────────────
  if (!currentQuestion) return null;

  const categoryColors: Record<string, string> = {
    reconciliation: "bg-[#1B365D]/10 text-[#1B365D]",
    exception: "bg-red-50 text-red-700",
    reporting: "bg-amber-50 text-amber-700",
    regulatory: "bg-purple-50 text-purple-700",
    technology: "bg-emerald-50 text-emerald-700",
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] flex flex-col">
      <nav className="bg-white border-b border-gray-100 px-6 h-16 flex items-center justify-between">
        <Link href="/compliance-assessment">
          <span className="text-xl font-bold text-[#1B365D] cursor-pointer">ReconcileAI</span>
        </Link>
        <span className="text-sm text-[#8C757D]">Question {step} of {QUESTIONS.length}</span>
      </nav>

      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="max-w-xl w-full">
          {/* Progress */}
          <div className="mb-6">
            <Progress value={progress} className="h-1.5 bg-gray-100" />
            <div className="flex justify-between mt-2">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${categoryColors[currentQuestion.category]}`}>
                {currentQuestion.categoryLabel}
              </span>
              <span className="text-xs text-[#8C757D]">{progress}% complete</span>
            </div>
          </div>

          {/* Question card */}
          <div className="bg-white rounded-2xl border border-gray-100 p-8 shadow-sm">
            <h2 className="text-lg font-semibold text-[#1B365D] mb-6 leading-snug">
              {currentQuestion.text}
            </h2>
            <RadioGroup
              value={currentSelection}
              onValueChange={setCurrentSelection}
              className="space-y-3"
            >
              {currentQuestion.options.map((opt) => (
                <div
                  key={opt.label}
                  onClick={() => setCurrentSelection(opt.label)}
                  className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
                    currentSelection === opt.label
                      ? "border-[#F47458] bg-[#F47458]/5"
                      : "border-gray-100 hover:border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  <RadioGroupItem value={opt.label} id={opt.label} className="mt-0.5 shrink-0" />
                  <Label htmlFor={opt.label} className="text-sm text-[#1B365D] cursor-pointer leading-relaxed">
                    {opt.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>

            <div className="flex gap-3 mt-8">
              <Button
                variant="outline"
                onClick={handleBack}
                className="h-11 px-5"
              >
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
              </Button>
              <Button
                onClick={handleNext}
                disabled={!currentSelection}
                className="flex-1 bg-[#F47458] hover:bg-[#e0644a] text-white h-11 disabled:opacity-40"
              >
                {step === QUESTIONS.length ? "Continue to Contact Details" : "Next Question"}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
