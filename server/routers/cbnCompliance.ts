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
import { cbnAuditLog, cbnDeadlineSubmissions } from "../../drizzle/schema";

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
});
