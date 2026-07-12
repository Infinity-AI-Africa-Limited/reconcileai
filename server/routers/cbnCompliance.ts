/**
 * CBN Compliance — tRPC Router (reconciliation-native scope).
 *
 * ReconcileAI is a reconciliation platform, not a GRC / regulatory-filing
 * product. This module intentionally covers ONLY the compliance surface that is
 * derived from reconciliation data and consumed by /cbn-compliance:
 *
 *  - signAttestation          — Ed25519-sign the printed compliance scorecard
 *                               attestation (tamper-evident artifact)
 *  - signingPublicKey         — public key + fingerprint so a third party can
 *                               verify an attestation signature
 *  - markDeadlineSubmitted /  — the deadline tracker's "Mark as Submitted" log
 *    listDeadlineSubmissions    (with an immutable cbn_audit_log write)
 *
 * A previous iteration also carried a full examination-report engine here
 * (framework catalogue, submission lifecycle, findings, action plans, AI gap
 * analysis, submission exports). None of it was reachable from the UI and it was
 * out of scope for ReconcileAI, so it was removed (commit history has it if a
 * dedicated GRC product ever needs it). The cbn_report_* tables remain in the
 * schema per the no-drop rule but are no longer written to.
 */

import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { signReport, publicKeyFingerprint, publicKeyPem } from "../signing";
import { cbnAuditLog, cbnDeadlineSubmissions, cbnReportSettings, cbnReportRuns } from "../../drizzle/schema";
import * as cbnReports from "../cbnReports";
import * as bouReports from "../bouReports";

// ─── CBN report builders: dispatch + shared input ─────────────────────────────
const reportTypeEnum = z.enum([
  // CBN (Nigeria)
  "daily_recon_summary", "exception_log", "counterparty_exposure", "interbank_settlement",
  "mfb_unreconciled_aging", "failed_transactions_return",
  // BoU (Uganda) — NPS framework
  "bou_trust_integrity", "bou_agent_settlement", "bou_failed_transactions",
]);
const reportParams = z.object({
  reportType: reportTypeEnum,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),     // daily_recon_summary
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),     // range reports
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

async function runReport(orgId: number, input: z.infer<typeof reportParams>) {
  const today = new Date().toISOString().slice(0, 10);
  if (input.reportType === "daily_recon_summary") {
    return cbnReports.buildDailyReconSummary(orgId, input.date ?? today);
  }
  if (input.reportType === "mfb_unreconciled_aging") {
    // As-of snapshot (MFB monthly return support) — uses `date`, not a range.
    return cbnReports.buildUnreconciledAging(orgId, input.date ?? today);
  }
  const from = new Date(`${input.from ?? today}T00:00:00.000Z`);
  const to = new Date(`${input.to ?? today}T23:59:59.999Z`);
  if (input.reportType === "failed_transactions_return") {
    // CBN April-2026 directive: monthly return of failed e-transactions with
    // reversal-window compliance and sanction exposure.
    return cbnReports.buildFailedTransactionsReturn(orgId, from, to);
  }
  // Bank of Uganda (NPS framework) returns.
  if (input.reportType === "bou_trust_integrity") return bouReports.buildTrustIntegrityReturn(orgId, from, to);
  if (input.reportType === "bou_agent_settlement") return bouReports.buildAgentRailSettlement(orgId, from, to);
  if (input.reportType === "bou_failed_transactions") return bouReports.buildBouFailedTransactions(orgId, from, to);
  if (input.reportType === "exception_log") return cbnReports.buildExceptionLog(orgId, from, to);
  if (input.reportType === "counterparty_exposure") return cbnReports.buildCounterpartyExposure(orgId, from, to);
  return cbnReports.buildInterbankSettlement(orgId, from, to);
}

function reportPeriod(input: z.infer<typeof reportParams>): { label: string; start: Date; end: Date } {
  const today = new Date().toISOString().slice(0, 10);
  if (input.reportType === "daily_recon_summary" || input.reportType === "mfb_unreconciled_aging") {
    const d = input.date ?? today;
    return { label: d, start: new Date(`${d}T00:00:00.000Z`), end: new Date(`${d}T23:59:59.999Z`) };
  }
  return {
    label: `${input.from ?? today} to ${input.to ?? today}`,
    start: new Date(`${input.from ?? today}T00:00:00.000Z`),
    end: new Date(`${input.to ?? today}T23:59:59.999Z`),
  };
}

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

// ─── Router ───────────────────────────────────────────────────────────────────

export const cbnComplianceRouter = router({
  // ── Public signing key (PEM) for third-party verification ─────────────────
  signingPublicKey: protectedProcedure.query(() => ({
    fingerprint: publicKeyFingerprint(),
    publicKeyPem: publicKeyPem(),
    algorithm: "Ed25519",
  })),

  // ── Sign a standalone compliance attestation document ─────────────────────
  // Returns a real Ed25519 signature block to embed in the printed attestation,
  // so the "timestamped, digitally signed" statement is true for that artifact.
  signAttestation: protectedProcedure
    .input(z.object({
      institution: z.string(),
      reportingPeriod: z.string(),
      overallStatus: z.string(),
      generatedAt: z.string(),
      thresholds: z.array(z.object({
        label: z.string(),
        threshold: z.union([z.number(), z.string()]),
        value: z.union([z.number(), z.string(), z.null()]),
        unit: z.string(),
        ok: z.boolean(),
      })),
    }))
    .mutation(({ ctx, input }) => {
      const payload = { ...input, organizationId: ctx.user.organizationId ?? null, signedByUserId: ctx.user.id };
      const sig = signReport(payload);
      return {
        contentHash: sig.contentHash,
        signature: sig.signature,
        signingKeyFingerprint: sig.signingKeyFingerprint,
        signedAt: sig.signedAt.toISOString(),
        algorithm: "Ed25519",
      };
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
        `${input.frameworkName} — ${input.periodLabel}`,
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

  // ═══ CBN Report Module (standalone, configurable, all customers) ═══════════

  // ── Institution profile (report header identity) ──────────────────────────
  getReportSettings: protectedProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.organizationId ?? 0;
    return cbnReports.getReportSettings(orgId);
  }),

  saveReportSettings: protectedProcedure
    .input(z.object({
      institutionName: z.string().max(255).optional(),
      institutionType: z.enum([
        "microfinance_bank", "commercial_bank", "payment_service_bank",
        "merchant_bank", "other_financial_institution", "fintech", "other",
      ]).optional(),
      rcNumber: z.string().max(50).optional(),
      cbnLicenseNumber: z.string().max(100).optional(),
      cbnInstitutionCode: z.string().max(50).optional(),
      address: z.string().max(500).optional(),
      preparedByName: z.string().max(255).optional(),
      preparedByTitle: z.string().max(150).optional(),
      attestingOfficerName: z.string().max(255).optional(),
      attestingOfficerTitle: z.string().max(150).optional(),
      complianceContactEmail: z.string().max(320).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await cbnReports.getReportSettings(orgId); // ensure row exists
      await db.update(cbnReportSettings).set({ ...input }).where(eq(cbnReportSettings.organizationId, orgId));
      await writeAuditLog(ctx.user.id, ctx.user.name, "cbn_report_settings.updated", "cbn_report_settings", orgId, input.institutionName ?? "profile", input, orgId);
      return cbnReports.getReportSettings(orgId);
    }),

  // ── Generate a report (preview data) ──────────────────────────────────────
  generateReport: protectedProcedure
    .input(reportParams)
    .query(async ({ ctx, input }) => {
      const orgId = ctx.user.organizationId ?? 0;
      return runReport(orgId, input);
    }),

  // ── One-click CBN-format CSV export (logs the run) ────────────────────────
  exportReportCsv: protectedProcedure
    .input(reportParams)
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const result = await runReport(orgId, input);
      const csv = cbnReports.toCsv(result);
      const period = reportPeriod(input);
      const db = await getDb();
      if (db) {
        await db.insert(cbnReportRuns).values({
          organizationId: orgId,
          reportType: input.reportType,
          periodLabel: period.label,
          periodStart: period.start,
          periodEnd: period.end,
          rowCount: result.rows.length,
          summary: result.summary,
          generatedByUserId: ctx.user.id,
          generatedByName: ctx.user.name ?? "Unknown",
        });
      }
      await writeAuditLog(ctx.user.id, ctx.user.name, "cbn_report.exported", "cbn_report", orgId, `${input.reportType} — ${period.label}`, { rowCount: result.rows.length }, orgId);
      const filename = `CBN_${input.reportType}_${period.label.replace(/[^0-9A-Za-z]+/g, "_")}.csv`;
      return { filename, csv, rowCount: result.rows.length };
    }),

  // ── Monthly compliance attestation (build → Ed25519 sign → persist) ───────
  generateMonthlyAttestation: protectedProcedure
    .input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }))
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const doc = await cbnReports.buildMonthlyAttestation(orgId, input.month);
      const payload = {
        ...doc,
        organizationId: orgId,
        signedByUserId: ctx.user.id,
        signedByName: ctx.user.name ?? "Unknown",
      };
      const sig = signReport(payload);
      await db.insert(cbnReportRuns).values({
        organizationId: orgId,
        reportType: "monthly_attestation",
        periodLabel: doc.monthLabel,
        periodStart: doc.periodStart,
        periodEnd: doc.periodEnd,
        rowCount: 1,
        summary: { overallStatus: doc.overallStatus, ...doc.metrics },
        contentHash: sig.contentHash,
        signature: sig.signature,
        signingKeyFingerprint: sig.signingKeyFingerprint,
        signedAt: sig.signedAt,
        attestingOfficerName: doc.attestingOfficer.name || null,
        attestingOfficerTitle: doc.attestingOfficer.title || null,
        generatedByUserId: ctx.user.id,
        generatedByName: ctx.user.name ?? "Unknown",
      });
      await writeAuditLog(ctx.user.id, ctx.user.name, "cbn_attestation.signed", "cbn_report", orgId, `Monthly attestation — ${doc.monthLabel}`, { overallStatus: doc.overallStatus }, orgId);
      return {
        document: doc,
        signature: {
          contentHash: sig.contentHash,
          signature: sig.signature,
          signingKeyFingerprint: sig.signingKeyFingerprint,
          signedAt: sig.signedAt.toISOString(),
          algorithm: "Ed25519",
        },
      };
    }),

  // ── Report / attestation generation history ───────────────────────────────
  listReportRuns: protectedProcedure
    .input(z.object({ reportType: z.string().max(48).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const db = await getDb();
      if (!db) return [];
      const conds = [eq(cbnReportRuns.organizationId, orgId)];
      if (input?.reportType) conds.push(eq(cbnReportRuns.reportType, input.reportType));
      return db.select().from(cbnReportRuns).where(and(...conds)).orderBy(desc(cbnReportRuns.createdAt)).limit(100);
    }),
});
