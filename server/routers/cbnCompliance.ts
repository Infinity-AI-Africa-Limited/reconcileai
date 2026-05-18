/**
 * CBN Compliance Report Module — tRPC Router
 *
 * Covers:
 *  - Regulatory framework catalogue (8 CBN reporting areas)
 *  - Report submission lifecycle (draft → submitted → acknowledged → closed)
 *  - Findings tracker (self-assessment, CBN examination, AI gap analysis)
 *  - Action plans (remediation steps linked to findings)
 *  - Immutable audit log
 *  - AI-assisted gap analysis via LLM
 *  - CSV/text export
 */

import { z } from "zod";
import { eq, and, desc, asc, isNull, sql, or, isNotNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import {
  cbnReportFrameworks,
  cbnReportSubmissions,
  cbnReportFindings,
  cbnActionPlans,
  cbnAuditLog,
  cbnDeadlineSubmissions,
} from "../../drizzle/schema";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function writeAuditLog(
  userId: number | null | undefined,
  userName: string | null | undefined,
  action: string,
  entityType: string,
  entityId: number | null | undefined,
  entityLabel: string,
  details?: Record<string, unknown>,
  organizationId?: number | null
) {
  const db = await getDb();
  if (!db) return;
  await db.insert(cbnAuditLog).values({
    organizationId: organizationId ?? null,
    userId: userId ?? null,
    userName: userName ?? "System",
    action,
    entityType,
    entityId: entityId ?? null,
    entityLabel,
    details: details ?? null,
  });
}

// Compute a compliance score (0-100) from reportData sections
function computeComplianceScore(reportData: Record<string, { value?: string; narrative?: string }> | null): number {
  if (!reportData) return 0;
  const sections = Object.values(reportData);
  if (!sections.length) return 0;
  const filled = sections.filter(s => s.value && s.value.trim() !== "").length;
  return Math.round((filled / sections.length) * 100);
}

// ─── CBN Regulatory Frameworks Seed Data ─────────────────────────────────────

const CBN_FRAMEWORKS = [
  {
    code: "AML_CFT",
    name: "AML/CFT Compliance",
    description: "Anti-Money Laundering and Counter Financing of Terrorism reporting obligations including STR, CTR, and goAML submissions to the NFIU.",
    regulatoryBasis: "MLPPA 2022 / CBN AML/CFT/CPF Regulations 2022 / NFIU Act 2018",
    frequency: "monthly" as const,
    submissionDeadlineDays: 5,
    sortOrder: 1,
  },
  {
    code: "PRUDENTIAL",
    name: "Prudential Returns",
    description: "Monthly prudential returns covering capital adequacy, asset quality, earnings, liquidity, and sensitivity (CAMELS framework). Submitted via FinA portal.",
    regulatoryBasis: "BOFIA 2020 / CBN Prudential Guidelines 2010 (as amended) / CBN FinA Returns Manual",
    frequency: "monthly" as const,
    submissionDeadlineDays: 5,
    sortOrder: 2,
  },
  {
    code: "CAPITAL_ADEQUACY",
    name: "Capital Adequacy Ratio (CAR)",
    description: "Quarterly capital adequacy computation and reporting. Minimum CAR: 10% for national banks, 15% for systemically important banks (SIBs). Includes Tier 1 and Tier 2 capital breakdown.",
    regulatoryBasis: "CBN Guidance Notes on Regulatory Capital / Basel III Framework / CBN Recapitalisation Circular 2024",
    frequency: "quarterly" as const,
    submissionDeadlineDays: 15,
    sortOrder: 3,
  },
  {
    code: "LIQUIDITY",
    name: "Liquidity Coverage Ratio (LCR)",
    description: "Monthly liquidity returns and quarterly LCR reporting. Minimum liquidity ratio: 30%. Covers HQLA, net cash outflows, contingency funding plans, and stress test results.",
    regulatoryBasis: "CBN LCR Guidelines September 2021 / CBN Prudential Guidelines / Basel III Liquidity Standards",
    frequency: "monthly" as const,
    submissionDeadlineDays: 5,
    sortOrder: 4,
  },
  {
    code: "KYC_CDD",
    name: "KYC / Customer Due Diligence",
    description: "Quarterly KYC compliance returns covering customer onboarding, CDD refresh cycles, PEP and sanctions screening, tiered KYC adherence (Tier 1/2/3), and BVN/NIN verification rates.",
    regulatoryBasis: "CBN CDD Regulations 2023 / CBN AML/CFT Regulations 2022 / BSD/DIR/PUB/LAB/019/002",
    frequency: "quarterly" as const,
    submissionDeadlineDays: 15,
    sortOrder: 5,
  },
  {
    code: "CYBERSECURITY",
    name: "Cybersecurity & IT Risk",
    description: "Semi-annual cybersecurity risk assessment and incident reporting. Covers IT controls, data protection compliance, digital banking security, and third-party risk management.",
    regulatoryBasis: "CBN Risk-Based Cybersecurity Framework 2022 / NDPA 2023 / CBN IT Standards Blueprint / NDPC Regulations",
    frequency: "semi_annual" as const,
    submissionDeadlineDays: 30,
    sortOrder: 6,
  },
  {
    code: "IFRS9",
    name: "IFRS 9 / Credit Risk Provisioning",
    description: "Quarterly IFRS 9 Expected Credit Loss (ECL) computation and reconciliation to CBN Prudential Guidelines provisioning requirements. Includes Stage 1/2/3 classification and NPL ratios.",
    regulatoryBasis: "IFRS 9 (IASB) / CBN IFRS 9 Guidance Note 2019 / CBN Prudential Guidelines / FRC Nigeria Standards",
    frequency: "quarterly" as const,
    submissionDeadlineDays: 15,
    sortOrder: 7,
  },
  {
    code: "CONSUMER_PROTECTION",
    name: "Consumer Protection",
    description: "Annual consumer protection compliance report covering complaint management, disclosure obligations, fair treatment of customers, and adherence to the CBN Consumer Protection Framework.",
    regulatoryBasis: "CBN Consumer Protection Framework 2022 / CBN Consumer Protection Regulations / BOFIA 2020 Section 55",
    frequency: "annual" as const,
    submissionDeadlineDays: 30,
    sortOrder: 8,
  },
];

// Section templates per framework — defines what fields appear in the report builder
const FRAMEWORK_SECTIONS: Record<string, Array<{ key: string; label: string; type: "text" | "number" | "boolean" | "select"; options?: string[]; required: boolean; helpText?: string }>> = {
  AML_CFT: [
    { key: "str_count", label: "Number of STRs filed this period", type: "number", required: true, helpText: "Total Suspicious Transaction Reports submitted to NFIU via goAML" },
    { key: "ctr_count", label: "Number of CTRs filed this period", type: "number", required: true, helpText: "Currency Transaction Reports for cash ≥ ₦5M (individual) / ₦10M (corporate)" },
    { key: "goaml_registered", label: "goAML platform registration status", type: "select", options: ["Registered and active", "Registered but inactive", "Not registered"], required: true },
    { key: "pep_screening", label: "PEP screening system in place", type: "boolean", required: true, helpText: "Politically Exposed Persons screening against OFAC, UN, and domestic lists" },
    { key: "sanctions_screening", label: "Sanctions screening system in place", type: "boolean", required: true },
    { key: "transaction_monitoring", label: "Automated transaction monitoring system deployed", type: "boolean", required: true },
    { key: "aml_officer", label: "Designated AML Compliance Officer name and title", type: "text", required: true },
    { key: "staff_training", label: "AML/CFT staff training completed this period", type: "boolean", required: false, helpText: "Annual training requirement for all relevant staff" },
    { key: "narrative", label: "Compliance narrative and notable observations", type: "text", required: false },
  ],
  PRUDENTIAL: [
    { key: "total_assets", label: "Total Assets (₦ millions)", type: "number", required: true },
    { key: "total_deposits", label: "Total Customer Deposits (₦ millions)", type: "number", required: true },
    { key: "total_loans", label: "Total Gross Loans and Advances (₦ millions)", type: "number", required: true },
    { key: "npl_ratio", label: "Non-Performing Loan (NPL) Ratio (%)", type: "number", required: true, helpText: "CBN maximum NPL threshold: 5%" },
    { key: "car", label: "Capital Adequacy Ratio (%)", type: "number", required: true, helpText: "Minimum: 10% (national), 15% (SIBs)" },
    { key: "liquidity_ratio", label: "Liquidity Ratio (%)", type: "number", required: true, helpText: "CBN minimum: 30%" },
    { key: "return_on_equity", label: "Return on Equity (%)", type: "number", required: false },
    { key: "cost_to_income", label: "Cost-to-Income Ratio (%)", type: "number", required: false },
    { key: "narrative", label: "Management commentary and notable changes", type: "text", required: false },
  ],
  CAPITAL_ADEQUACY: [
    { key: "tier1_capital", label: "Tier 1 Capital (₦ millions)", type: "number", required: true, helpText: "Common Equity Tier 1 + Additional Tier 1" },
    { key: "tier2_capital", label: "Tier 2 Capital (₦ millions)", type: "number", required: true },
    { key: "total_regulatory_capital", label: "Total Regulatory Capital (₦ millions)", type: "number", required: true },
    { key: "risk_weighted_assets", label: "Total Risk-Weighted Assets (₦ millions)", type: "number", required: true },
    { key: "car", label: "Capital Adequacy Ratio (%)", type: "number", required: true },
    { key: "minimum_car_met", label: "Minimum CAR requirement met", type: "boolean", required: true },
    { key: "recapitalisation_plan", label: "Recapitalisation plan status (if applicable)", type: "select", options: ["Not applicable", "Plan submitted", "Plan in progress", "Plan completed"], required: false },
    { key: "stress_test_conducted", label: "Capital stress test conducted this quarter", type: "boolean", required: false },
    { key: "narrative", label: "Capital management commentary", type: "text", required: false },
  ],
  LIQUIDITY: [
    { key: "hqla", label: "High-Quality Liquid Assets (HQLA) (₦ millions)", type: "number", required: true },
    { key: "net_cash_outflows", label: "Net Cash Outflows over 30 days (₦ millions)", type: "number", required: true },
    { key: "lcr", label: "Liquidity Coverage Ratio (%)", type: "number", required: true, helpText: "HQLA / Net Cash Outflows × 100. CBN minimum: 100%" },
    { key: "liquidity_ratio", label: "CBN Liquidity Ratio (%)", type: "number", required: true, helpText: "CBN minimum: 30%" },
    { key: "cfp_in_place", label: "Contingency Funding Plan (CFP) in place", type: "boolean", required: true },
    { key: "liquidity_stress_test", label: "Liquidity stress test conducted this period", type: "boolean", required: false },
    { key: "narrative", label: "Liquidity management commentary", type: "text", required: false },
  ],
  KYC_CDD: [
    { key: "total_customers", label: "Total Active Customer Accounts", type: "number", required: true },
    { key: "bvn_verified_pct", label: "BVN Verification Rate (%)", type: "number", required: true, helpText: "Percentage of customers with verified BVN" },
    { key: "nin_verified_pct", label: "NIN Verification Rate (%)", type: "number", required: false },
    { key: "tier1_accounts", label: "Number of Tier 1 Accounts", type: "number", required: false },
    { key: "tier2_accounts", label: "Number of Tier 2 Accounts", type: "number", required: false },
    { key: "tier3_accounts", label: "Number of Tier 3 Accounts", type: "number", required: false },
    { key: "cdd_refresh_completed", label: "CDD refresh cycle completed for high-risk customers", type: "boolean", required: true },
    { key: "edd_cases", label: "Number of Enhanced Due Diligence (EDD) cases opened", type: "number", required: false, helpText: "PEPs, NGOs, cash-intensive businesses" },
    { key: "dormant_accounts_reviewed", label: "Dormant accounts reviewed per CBN guidelines", type: "boolean", required: false },
    { key: "narrative", label: "KYC programme commentary", type: "text", required: false },
  ],
  CYBERSECURITY: [
    { key: "cyber_incidents", label: "Number of cybersecurity incidents this period", type: "number", required: true },
    { key: "critical_incidents", label: "Number of critical/high-severity incidents", type: "number", required: true },
    { key: "incidents_reported_cbn", label: "All material incidents reported to CBN within 24 hours", type: "boolean", required: true },
    { key: "penetration_test", label: "Penetration test conducted this period", type: "boolean", required: false },
    { key: "patch_management", label: "Patch management programme current", type: "boolean", required: true },
    { key: "mfa_deployed", label: "Multi-factor authentication deployed for all critical systems", type: "boolean", required: true },
    { key: "ndpa_compliant", label: "NDPA 2023 data protection compliance confirmed", type: "boolean", required: true },
    { key: "third_party_risk_reviewed", label: "Third-party/vendor risk assessments completed", type: "boolean", required: false },
    { key: "narrative", label: "Cybersecurity posture commentary", type: "text", required: false },
  ],
  IFRS9: [
    { key: "stage1_exposure", label: "Stage 1 Exposure (₦ millions) — 12-month ECL", type: "number", required: true },
    { key: "stage2_exposure", label: "Stage 2 Exposure (₦ millions) — Lifetime ECL (not credit-impaired)", type: "number", required: true },
    { key: "stage3_exposure", label: "Stage 3 Exposure (₦ millions) — Lifetime ECL (credit-impaired)", type: "number", required: true },
    { key: "total_ecl", label: "Total Expected Credit Loss Provision (₦ millions)", type: "number", required: true },
    { key: "npl_ratio", label: "NPL Ratio (%)", type: "number", required: true, helpText: "CBN maximum: 5%" },
    { key: "coverage_ratio", label: "Provision Coverage Ratio (%)", type: "number", required: false },
    { key: "cbn_prudential_reconciled", label: "ECL reconciled to CBN Prudential Guidelines provisioning", type: "boolean", required: true },
    { key: "narrative", label: "Credit risk and ECL commentary", type: "text", required: false },
  ],
  CONSUMER_PROTECTION: [
    { key: "total_complaints", label: "Total customer complaints received this period", type: "number", required: true },
    { key: "complaints_resolved", label: "Complaints resolved within CBN timeline (7 working days)", type: "number", required: true },
    { key: "complaints_escalated_cbn", label: "Complaints escalated to CBN Consumer Protection Department", type: "number", required: false },
    { key: "disclosure_compliant", label: "All product disclosures meet CBN transparency requirements", type: "boolean", required: true },
    { key: "charges_compliant", label: "All charges and fees comply with CBN Guide to Charges", type: "boolean", required: true },
    { key: "consumer_education", label: "Consumer financial education initiatives conducted", type: "boolean", required: false },
    { key: "narrative", label: "Consumer protection programme commentary", type: "text", required: false },
  ],
};

// ─── Router ───────────────────────────────────────────────────────────────────

export const cbnComplianceRouter = router({

  // ── Seed frameworks (idempotent) ──────────────────────────────────────────
  seedFrameworks: protectedProcedure.mutation(async ({ ctx }) => {
  const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const existing = await drizzle.select({ id: cbnReportFrameworks.id }).from(cbnReportFrameworks).limit(1);
      if (existing.length > 0) return { seeded: false, message: "Frameworks already seeded" };
      await drizzle.insert(cbnReportFrameworks).values(CBN_FRAMEWORKS);
    await writeAuditLog(ctx.user.id, ctx.user.name, "frameworks.seeded", "framework", null, "CBN Frameworks", { count: CBN_FRAMEWORKS.length });
    return { seeded: true, message: `${CBN_FRAMEWORKS.length} frameworks seeded` };
  }),

  // ── List frameworks ───────────────────────────────────────────────────────
  listFrameworks: protectedProcedure.query(async () => {
    const drizzle = await getDb();
    if (!drizzle) return [];
    return drizzle.select().from(cbnReportFrameworks)
      .where(eq(cbnReportFrameworks.isActive, true))
      .orderBy(asc(cbnReportFrameworks.sortOrder));
  }),

  // ── Get framework sections (for report builder) ───────────────────────────
  getFrameworkSections: protectedProcedure
    .input(z.object({ frameworkCode: z.string() }))
    .query(({ input }) => {
      const sections = FRAMEWORK_SECTIONS[input.frameworkCode] ?? [];
      return { sections };
    }),

  // ── List submissions ──────────────────────────────────────────────────────
  listSubmissions: protectedProcedure
    .input(z.object({
      frameworkId: z.number().optional(),
      status: z.enum(["draft", "in_review", "approved", "submitted", "acknowledged", "queried", "closed"]).optional(),
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) return [];
      const orgId = ctx.user.organizationId ?? null;
      const conditions = [
        orgId ? eq(cbnReportSubmissions.organizationId, orgId) : isNull(cbnReportSubmissions.organizationId),
      ];
      if (input.frameworkId) conditions.push(eq(cbnReportSubmissions.frameworkId, input.frameworkId));
      if (input.status) conditions.push(eq(cbnReportSubmissions.status, input.status));

      const rows = await drizzle
        .select({
          submission: cbnReportSubmissions,
          frameworkName: cbnReportFrameworks.name,
          frameworkCode: cbnReportFrameworks.code,
          frameworkFrequency: cbnReportFrameworks.frequency,
        })
        .from(cbnReportSubmissions)
        .leftJoin(cbnReportFrameworks, eq(cbnReportSubmissions.frameworkId, cbnReportFrameworks.id))
        .where(and(...conditions))
        .orderBy(desc(cbnReportSubmissions.updatedAt))
        .limit(input.limit)
        .offset(input.offset);

      return rows.map(r => ({ ...r.submission, frameworkName: r.frameworkName, frameworkCode: r.frameworkCode, frameworkFrequency: r.frameworkFrequency }));
    }),

  // ── Get single submission ─────────────────────────────────────────────────
  getSubmission: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const orgId = ctx.user.organizationId ?? null;
      const rows = await drizzle
        .select({
          submission: cbnReportSubmissions,
          frameworkName: cbnReportFrameworks.name,
          frameworkCode: cbnReportFrameworks.code,
          frameworkFrequency: cbnReportFrameworks.frequency,
          frameworkRegBasis: cbnReportFrameworks.regulatoryBasis,
          frameworkDeadlineDays: cbnReportFrameworks.submissionDeadlineDays,
        })
        .from(cbnReportSubmissions)
        .leftJoin(cbnReportFrameworks, eq(cbnReportSubmissions.frameworkId, cbnReportFrameworks.id))
        .where(and(
          eq(cbnReportSubmissions.id, input.id),
          orgId ? eq(cbnReportSubmissions.organizationId, orgId) : isNull(cbnReportSubmissions.organizationId)
        ))
        .limit(1);
      if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "Submission not found" });
      const r = rows[0];
      return { ...r.submission, frameworkName: r.frameworkName, frameworkCode: r.frameworkCode, frameworkFrequency: r.frameworkFrequency, frameworkRegBasis: r.frameworkRegBasis, frameworkDeadlineDays: r.frameworkDeadlineDays };
    }),

  // ── Create submission ─────────────────────────────────────────────────────
  createSubmission: protectedProcedure
    .input(z.object({
      frameworkId: z.number(),
      periodStart: z.string(), // ISO date string
      periodEnd: z.string(),
      reportingPeriodLabel: z.string().optional(),
      submissionChannel: z.enum(["goAML", "FinA", "email", "portal", "manual"]).default("portal"),
    }))
    .mutation(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const orgId = ctx.user.organizationId ?? null;
      const [result] = await drizzle.insert(cbnReportSubmissions).values({
        organizationId: orgId,
        frameworkId: input.frameworkId,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        reportingPeriodLabel: input.reportingPeriodLabel ?? null,
        submissionChannel: input.submissionChannel,
        status: "draft",
        createdByUserId: ctx.user.id,
      });
      const newId = (result as any).insertId as number;
      await writeAuditLog(ctx.user.id, ctx.user.name, "submission.created", "submission", newId, `Submission #${newId}`, { frameworkId: input.frameworkId, period: input.reportingPeriodLabel }, orgId);
      return { id: newId };
    }),

  // ── Update submission (save draft / update report data) ───────────────────
  updateSubmission: protectedProcedure
    .input(z.object({
      id: z.number(),
      reportData: z.record(z.string(), z.object({
        value: z.string().optional(),
        narrative: z.string().optional(),
      })).optional(),
      internalNotes: z.string().optional(),
      status: z.enum(["draft", "in_review", "approved", "submitted", "acknowledged", "queried", "closed"]).optional(),
      cbNReferenceNumber: z.string().optional(),
      acknowledgedAt: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const orgId = ctx.user.organizationId ?? null;
      const { id, reportData, ...rest } = input;
      const score = reportData ? computeComplianceScore(reportData as any) : undefined;
      const updatePayload: Record<string, unknown> = { ...rest };
      if (reportData !== undefined) updatePayload.reportData = reportData;
      if (score !== undefined) updatePayload.complianceScore = score;
      if (rest.status === "submitted") updatePayload.submittedAt = new Date();
      if (rest.acknowledgedAt) updatePayload.acknowledgedAt = new Date(rest.acknowledgedAt);
      if (rest.status === "submitted") updatePayload.submittedByUserId = ctx.user.id;

      await drizzle.update(cbnReportSubmissions)
        .set(updatePayload as any)
        .where(and(
          eq(cbnReportSubmissions.id, id),
          orgId ? eq(cbnReportSubmissions.organizationId, orgId) : isNull(cbnReportSubmissions.organizationId)
        ));
      await writeAuditLog(ctx.user.id, ctx.user.name, `submission.${rest.status ?? "updated"}`, "submission", id, `Submission #${id}`, { status: rest.status, score }, orgId);
      return { success: true, complianceScore: score };
    }),

  // ── AI Gap Analysis ───────────────────────────────────────────────────────
  generateGapAnalysis: protectedProcedure
    .input(z.object({ submissionId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const orgId = ctx.user.organizationId ?? null;
      const rows = await drizzle
        .select({ submission: cbnReportSubmissions, frameworkCode: cbnReportFrameworks.code, frameworkName: cbnReportFrameworks.name })
        .from(cbnReportSubmissions)
        .leftJoin(cbnReportFrameworks, eq(cbnReportSubmissions.frameworkId, cbnReportFrameworks.id))
        .where(and(
          eq(cbnReportSubmissions.id, input.submissionId),
          orgId ? eq(cbnReportSubmissions.organizationId, orgId) : isNull(cbnReportSubmissions.organizationId)
        ))
        .limit(1);
      if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "Submission not found" });
      const { submission, frameworkCode, frameworkName } = rows[0];
      const sections = FRAMEWORK_SECTIONS[frameworkCode ?? ""] ?? [];
      const reportData = (submission.reportData as Record<string, { value?: string; narrative?: string }>) ?? {};

      // Identify gaps
      const gaps = sections
        .filter(s => s.required && (!reportData[s.key]?.value || reportData[s.key]?.value?.trim() === ""))
        .map(s => s.label);
      const filled = sections.filter(s => reportData[s.key]?.value && reportData[s.key]?.value?.trim() !== "");
      const score = sections.length ? Math.round((filled.length / sections.length) * 100) : 0;

      const prompt = `You are a senior CBN regulatory compliance expert. Analyse this ${frameworkName} compliance report submission for a Nigerian financial institution.

Framework: ${frameworkName}
Regulatory Basis: ${rows[0].submission.reportData ? "as per CBN regulations" : "not yet populated"}
Reporting Period: ${submission.reportingPeriodLabel ?? "not specified"}
Completion Score: ${score}/100

Sections completed (${filled.length}/${sections.length}):
${filled.map(s => `✓ ${s.label}: ${reportData[s.key]?.value}`).join("\n")}

Missing required sections (${gaps.length}):
${gaps.length ? gaps.map(g => `✗ ${g}`).join("\n") : "None — all required sections completed"}

Write a concise, authoritative gap analysis (maximum 200 words) that:
1. Identifies the most critical compliance gaps and their regulatory risk
2. Highlights any data points that appear to breach CBN thresholds (e.g. NPL > 5%, CAR < 10%, liquidity < 30%)
3. Recommends the 3 most important actions before submission
4. Assesses overall submission readiness (Ready / Needs Work / Not Ready)

Be specific, reference the relevant CBN regulation, and write in a professional regulatory tone suitable for a board compliance committee.`;

      const response = await invokeLLM({
        messages: [
          { role: "system", content: "You are a CBN regulatory compliance expert. Be concise, specific, and authoritative." },
          { role: "user", content: prompt },
        ],
      });
      const analysis = (typeof response.choices?.[0]?.message?.content === "string" ? response.choices[0].message.content : null) ?? "Gap analysis unavailable.";

      await drizzle.update(cbnReportSubmissions)
        .set({ aiGapAnalysis: analysis, aiGapGeneratedAt: new Date(), complianceScore: score })
        .where(eq(cbnReportSubmissions.id, input.submissionId));
      await writeAuditLog(ctx.user.id, ctx.user.name, "submission.gap_analysis_generated", "submission", input.submissionId, `Submission #${input.submissionId}`, { score }, orgId);
      return { analysis, score, gaps };
    }),

  // ── Summary stats for dashboard ───────────────────────────────────────────
  getDashboardStats: protectedProcedure.query(async ({ ctx }) => {
    const drizzle = await getDb();
    if (!drizzle) return { totalSubmissions: 0, draftCount: 0, inReviewCount: 0, submittedCount: 0, acknowledgedCount: 0, queriedCount: 0, closedCount: 0, overdueCount: 0, avgComplianceScore: null, openFindings: 0, criticalFindings: 0, overdueActions: 0, recentSubmissions: [] };
    const orgId = ctx.user.organizationId ?? null;
    const orgCondition = orgId ? eq(cbnReportSubmissions.organizationId, orgId) : isNull(cbnReportSubmissions.organizationId);
    const findingOrgCondition = orgId ? eq(cbnReportFindings.organizationId, orgId) : isNull(cbnReportFindings.organizationId);

    const [submissions, findings, actionPlans] = await Promise.all([
      drizzle.select().from(cbnReportSubmissions).where(orgCondition),
      drizzle.select().from(cbnReportFindings).where(findingOrgCondition),
      drizzle.select().from(cbnActionPlans).where(
        orgId ? eq(cbnActionPlans.organizationId, orgId) : isNull(cbnActionPlans.organizationId)
      ),
    ]);

    const now = new Date();
    const overdue = submissions.filter(s => {
      if (["submitted", "acknowledged", "closed"].includes(s.status)) return false;
      // Overdue if period ended more than submissionDeadlineDays ago — simplified check
      return s.periodEnd && new Date(s.periodEnd) < now && s.status !== "closed";
    });

    const avgScore = submissions.filter(s => s.complianceScore != null).length
      ? Math.round(submissions.filter(s => s.complianceScore != null).reduce((acc, s) => acc + (s.complianceScore ?? 0), 0) / submissions.filter(s => s.complianceScore != null).length)
      : null;

    return {
      totalSubmissions: submissions.length,
      draftCount: submissions.filter(s => s.status === "draft").length,
      inReviewCount: submissions.filter(s => s.status === "in_review").length,
      submittedCount: submissions.filter(s => s.status === "submitted").length,
      acknowledgedCount: submissions.filter(s => s.status === "acknowledged").length,
      queriedCount: submissions.filter(s => s.status === "queried").length,
      closedCount: submissions.filter(s => s.status === "closed").length,
      overdueCount: overdue.length,
      avgComplianceScore: avgScore,
      openFindings: findings.filter(f => f.status === "open").length,
      criticalFindings: findings.filter(f => f.severity === "critical" && f.status !== "closed").length,
      overdueActions: actionPlans.filter(a => a.targetDate && new Date(a.targetDate) < now && !["completed", "cancelled"].includes(a.status)).length,
      recentSubmissions: submissions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5),
    };
  }),

  // ── Findings ──────────────────────────────────────────────────────────────
  listFindings: protectedProcedure
    .input(z.object({
      frameworkId: z.number().optional(),
      status: z.enum(["open", "in_progress", "resolved", "accepted_risk", "closed"]).optional(),
      severity: z.enum(["low", "medium", "high", "critical"]).optional(),
      submissionId: z.number().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) return [];
      const orgId = ctx.user.organizationId ?? null;
      const conditions = [
        orgId ? eq(cbnReportFindings.organizationId, orgId) : isNull(cbnReportFindings.organizationId),
      ];
      if (input.frameworkId) conditions.push(eq(cbnReportFindings.frameworkId, input.frameworkId));
      if (input.status) conditions.push(eq(cbnReportFindings.status, input.status));
      if (input.severity) conditions.push(eq(cbnReportFindings.severity, input.severity));
      if (input.submissionId) conditions.push(eq(cbnReportFindings.submissionId, input.submissionId));

      const rows = await drizzle
        .select({
          finding: cbnReportFindings,
          frameworkName: cbnReportFrameworks.name,
          frameworkCode: cbnReportFrameworks.code,
        })
        .from(cbnReportFindings)
        .leftJoin(cbnReportFrameworks, eq(cbnReportFindings.frameworkId, cbnReportFrameworks.id))
        .where(and(...conditions))
        .orderBy(desc(cbnReportFindings.createdAt));

      return rows.map(r => ({ ...r.finding, frameworkName: r.frameworkName, frameworkCode: r.frameworkCode }));
    }),

  createFinding: protectedProcedure
    .input(z.object({
      frameworkId: z.number(),
      submissionId: z.number().optional(),
      title: z.string().min(3).max(255),
      description: z.string().optional(),
      category: z.enum(["governance", "kyc_cdd", "aml_cft", "capital_adequacy", "liquidity", "credit_risk", "cybersecurity", "ifrs9", "consumer_protection", "reporting", "other"]).default("other"),
      severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
      source: z.enum(["self_assessment", "internal_audit", "cbn_examination", "external_audit", "ai_gap_analysis"]).default("self_assessment"),
      dueDate: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const orgId = ctx.user.organizationId ?? null;
      // Auto-generate finding reference
      const count = await drizzle.select({ id: cbnReportFindings.id }).from(cbnReportFindings)
        .where(orgId ? eq(cbnReportFindings.organizationId, orgId) : isNull(cbnReportFindings.organizationId));
      const findingRef = `F-${new Date().getFullYear()}-${String(count.length + 1).padStart(3, "0")}`;

      const [result] = await drizzle.insert(cbnReportFindings).values({
        organizationId: orgId,
        frameworkId: input.frameworkId,
        submissionId: input.submissionId ?? null,
        findingRef,
        title: input.title,
        description: input.description ?? null,
        category: input.category,
        severity: input.severity,
        source: input.source,
        status: "open",
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        createdByUserId: ctx.user.id,
      });
      const newId = (result as any).insertId as number;
      await writeAuditLog(ctx.user.id, ctx.user.name, "finding.created", "finding", newId, `${findingRef}: ${input.title}`, { severity: input.severity }, orgId);
      return { id: newId, findingRef };
    }),

  updateFinding: protectedProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().optional(),
      description: z.string().optional(),
      severity: z.enum(["low", "medium", "high", "critical"]).optional(),
      status: z.enum(["open", "in_progress", "resolved", "accepted_risk", "closed"]).optional(),
      dueDate: z.string().optional().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const orgId = ctx.user.organizationId ?? null;
      const { id, dueDate, ...rest } = input;
      const updatePayload: Record<string, unknown> = { ...rest };
      if (dueDate !== undefined) updatePayload.dueDate = dueDate ? new Date(dueDate) : null;
      if (rest.status === "resolved" || rest.status === "closed") {
        updatePayload.resolvedAt = new Date();
        updatePayload.resolvedByUserId = ctx.user.id;
      }
      await drizzle.update(cbnReportFindings).set(updatePayload as any)
        .where(and(
          eq(cbnReportFindings.id, id),
          orgId ? eq(cbnReportFindings.organizationId, orgId) : isNull(cbnReportFindings.organizationId)
        ));
      await writeAuditLog(ctx.user.id, ctx.user.name, `finding.${rest.status ?? "updated"}`, "finding", id, `Finding #${id}`, rest, orgId);
      return { success: true };
    }),

  // ── Action Plans ──────────────────────────────────────────────────────────
  listActionPlans: protectedProcedure
    .input(z.object({ findingId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) return [];
      const orgId = ctx.user.organizationId ?? null;
      const conditions = [
        orgId ? eq(cbnActionPlans.organizationId, orgId) : isNull(cbnActionPlans.organizationId),
      ];
      if (input.findingId) conditions.push(eq(cbnActionPlans.findingId, input.findingId));
      return drizzle.select().from(cbnActionPlans).where(and(...conditions)).orderBy(desc(cbnActionPlans.createdAt));
    }),

  createActionPlan: protectedProcedure
    .input(z.object({
      findingId: z.number(),
      title: z.string().min(3).max(255),
      description: z.string().optional(),
      owner: z.string().optional(),
      priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
      targetDate: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const orgId = ctx.user.organizationId ?? null;
      const [result] = await drizzle.insert(cbnActionPlans).values({
        organizationId: orgId,
        findingId: input.findingId,
        title: input.title,
        description: input.description ?? null,
        owner: input.owner ?? null,
        priority: input.priority,
        status: "not_started",
        targetDate: input.targetDate ? new Date(input.targetDate) : null,
        createdByUserId: ctx.user.id,
      });
      const newId = (result as any).insertId as number;
      await writeAuditLog(ctx.user.id, ctx.user.name, "action_plan.created", "action_plan", newId, input.title, { findingId: input.findingId }, orgId);
      return { id: newId };
    }),

  updateActionPlan: protectedProcedure
    .input(z.object({
      id: z.number(),
      status: z.enum(["not_started", "in_progress", "completed", "deferred", "cancelled"]).optional(),
      owner: z.string().optional(),
      targetDate: z.string().optional().nullable(),
      evidenceNotes: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const orgId = ctx.user.organizationId ?? null;
      const { id, targetDate, ...rest } = input;
      const updatePayload: Record<string, unknown> = { ...rest };
      if (targetDate !== undefined) updatePayload.targetDate = targetDate ? new Date(targetDate) : null;
      if (rest.status === "completed") updatePayload.completedAt = new Date();
      await drizzle.update(cbnActionPlans).set(updatePayload as any)
        .where(and(
          eq(cbnActionPlans.id, id),
          orgId ? eq(cbnActionPlans.organizationId, orgId) : isNull(cbnActionPlans.organizationId)
        ));
      await writeAuditLog(ctx.user.id, ctx.user.name, `action_plan.${rest.status ?? "updated"}`, "action_plan", id, `Action Plan #${id}`, rest, orgId);
      return { success: true };
    }),

  // ── Audit Log ─────────────────────────────────────────────────────────────
  listAuditLog: protectedProcedure
    .input(z.object({
      entityType: z.string().optional(),
      entityId: z.number().optional(),
      limit: z.number().min(1).max(200).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) return [];
      const orgId = ctx.user.organizationId ?? null;
      const conditions = [
        orgId ? eq(cbnAuditLog.organizationId, orgId) : isNull(cbnAuditLog.organizationId),
      ];
      if (input.entityType) conditions.push(eq(cbnAuditLog.entityType, input.entityType));
      if (input.entityId) conditions.push(eq(cbnAuditLog.entityId, input.entityId));
      return drizzle.select().from(cbnAuditLog)
        .where(and(...conditions))
        .orderBy(desc(cbnAuditLog.createdAt))
        .limit(input.limit)
        .offset(input.offset);
    }),

  // ── Export submission as CSV text ─────────────────────────────────────────
  exportSubmissionCsv: protectedProcedure
    .input(z.object({ submissionId: z.number() }))
    .query(async ({ ctx, input }) => {
      const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const orgId = ctx.user.organizationId ?? null;
      const rows = await drizzle
        .select({ submission: cbnReportSubmissions, frameworkName: cbnReportFrameworks.name, frameworkCode: cbnReportFrameworks.code })
        .from(cbnReportSubmissions)
        .leftJoin(cbnReportFrameworks, eq(cbnReportSubmissions.frameworkId, cbnReportFrameworks.id))
        .where(and(
          eq(cbnReportSubmissions.id, input.submissionId),
          orgId ? eq(cbnReportSubmissions.organizationId, orgId) : isNull(cbnReportSubmissions.organizationId)
        ))
        .limit(1);
      if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "Submission not found" });
      const { submission, frameworkName, frameworkCode } = rows[0];
      const sections = FRAMEWORK_SECTIONS[frameworkCode ?? ""] ?? [];
      const reportData = (submission.reportData as Record<string, { value?: string; narrative?: string }>) ?? {};

      const csvLines = [
        `"CBN Compliance Report Export"`,
        `"Framework","${frameworkName}"`,
        `"Period","${submission.reportingPeriodLabel ?? ""}"`,
        `"Status","${submission.status}"`,
        `"Compliance Score","${submission.complianceScore ?? "N/A"}/100"`,
        `"CBN Reference","${submission.cbNReferenceNumber ?? ""}"`,
        `"Submitted At","${submission.submittedAt ? new Date(submission.submittedAt).toISOString() : ""}"`,
        `""`,
        `"Section","Response","Narrative"`,
        ...sections.map(s => {
          const d = reportData[s.key] ?? {};
          const val = (d.value ?? "").replace(/"/g, '""');
          const narr = (d.narrative ?? "").replace(/"/g, '""');
          return `"${s.label}","${val}","${narr}"`;
        }),
        `""`,
        `"AI Gap Analysis"`,
        `"${(submission.aiGapAnalysis ?? "").replace(/"/g, '""')}"`,
      ];
      return { csv: csvLines.join("\n"), filename: `CBN_${frameworkCode}_${submission.reportingPeriodLabel ?? submission.id}_${new Date().toISOString().slice(0, 10)}.csv` };
    }),

  // ── Mark a regulatory deadline as submitted ───────────────────────────────
  markDeadlineSubmitted: protectedProcedure
    .input(z.object({
      frameworkCode: z.string().max(64),
      frameworkName: z.string().max(255),
      periodLabel: z.string().max(64),
      notes: z.string().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // Upsert: delete existing record for this framework+period then insert fresh
      await db.delete(cbnDeadlineSubmissions).where(
        and(
          eq(cbnDeadlineSubmissions.frameworkCode, input.frameworkCode),
          eq(cbnDeadlineSubmissions.periodLabel, input.periodLabel),
        )
      );
      await db.insert(cbnDeadlineSubmissions).values({
        organizationId: ctx.user.organizationId ?? null,
        frameworkCode: input.frameworkCode,
        frameworkName: input.frameworkName,
        periodLabel: input.periodLabel,
        submittedAt: new Date(),
        submittedByUserId: ctx.user.id,
        submittedByName: ctx.user.name ?? "Unknown",
        notes: input.notes ?? null,
      });
       await writeAuditLog(
        ctx.user.id,
        ctx.user.name,
        "deadline.submitted",
        "deadline",
        null,
        `${input.frameworkName} \u2014 ${input.periodLabel}`,
        { frameworkCode: input.frameworkCode, periodLabel: input.periodLabel },
      );
      // Notify owner — non-fatal
      try {
        const { notifyOwner } = await import("../_core/notification");
        const submittedBy = ctx.user.name ?? "Unknown";
        const notesLine = input.notes ? `\nNotes: ${input.notes}` : "";
        await notifyOwner({
          title: `CBN Submission Recorded: ${input.frameworkName}`,
          content: `Framework: ${input.frameworkName}\nPeriod: ${input.periodLabel}\nSubmitted by: ${submittedBy}\nDate: ${new Date().toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" })}${notesLine}\n\nThis submission has been logged in the ReconcileAI CBN Compliance module.`,
        });
      } catch (_) { /* non-fatal */ }
      return { success: true };
    }),
  // ── List all deadline submission records ──────────────────────────────────
  listDeadlineSubmissions: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(cbnDeadlineSubmissions)
      .orderBy(desc(cbnDeadlineSubmissions.submittedAt));
  }),
});
