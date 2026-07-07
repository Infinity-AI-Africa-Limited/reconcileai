/**
 * Mobile Money Reconciliation tRPC router
 *
 * Public-but-gated: uses the same per-POC access token system as poc.ts.
 * All procedures are scoped by `pocSlug` so each institution's data is isolated.
 *
 * Operators supported:
 *   Nigeria transfers/USSD — NIBSS NIP, OPay, Palmpay
 *   Nigeria wallets (WS-8) — OPay Wallet, Palmpay Wallet, Moniepoint Wallet
 *   Uganda — MTN MoMo, Airtel Money
 */
import { z } from "zod";
import { router, publicProcedure } from "../_core/trpc";
import { assertPocAccess, tokenFromCtx } from "../pocAccess";
import {
  runFullMmReconciliation,
  getMmRuns,
  getMmExceptions,
  updateMmExceptionStatus,
} from "../mobileMoney-engine";
import { MM_OPERATORS, type MmOperator } from "../../drizzle/mobile_money_schema";

const MAX_BASE64_LEN = 20 * 1024 * 1024;
const pocSlug = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);
// Derived from the schema constant so new operators (e.g. WS-8 wallets) can't drift.
const mmOperator = z.enum(MM_OPERATORS);

// Public-but-gated: requires a valid per-POC access token
const mmProcedure = publicProcedure.use(async (opts) => {
  const raw = (await opts.getRawInput()) as { pocSlug?: string } | undefined;
  await assertPocAccess(raw?.pocSlug ?? "", tokenFromCtx(opts.ctx));
  return opts.next();
});

export const mobileMoneyRouter = router({
  /**
   * Run a full mobile money reconciliation.
   * Accepts base64-encoded settlement and ledger files.
   */
  run: mmProcedure
    .input(
      z.object({
        pocSlug,
        operator: mmOperator,
        settlementFileName: z.string().max(500).optional(),
        settlementFileType: z.enum(["csv", "excel"]),
        settlementContentBase64: z.string().min(1).max(MAX_BASE64_LEN),
        ledgerFileName: z.string().max(500).optional(),
        ledgerFileType: z.enum(["csv", "excel"]),
        ledgerContentBase64: z.string().min(1).max(MAX_BASE64_LEN),
      })
    )
    .mutation(async ({ input }) => {
      const result = await runFullMmReconciliation({
        pocKey: input.pocSlug,
        operator: input.operator as MmOperator,
        settlementFileBase64: input.settlementContentBase64,
        settlementFileType: input.settlementFileType,
        settlementFileName: input.settlementFileName,
        ledgerFileBase64: input.ledgerContentBase64,
        ledgerFileType: input.ledgerFileType,
        ledgerFileName: input.ledgerFileName,
      });
      return {
        runId: result.runId,
        operator: result.operator,
        currency: result.currency,
        layer1: result.layer1,
        matchedCount: result.matchedCount,
        exceptionCount: result.exceptionCount,
        exceptions: result.layer3,
        aiSummary: result.aiSummary,
        learningApplied: result.learningApplied,
      };
    }),

  /**
   * Get all reconciliation runs for a POC, optionally filtered by operator.
   */
  getRuns: mmProcedure
    .input(
      z.object({
        pocSlug,
        operator: mmOperator.optional(),
      })
    )
    .query(async ({ input }) => {
      return getMmRuns(input.pocSlug, input.operator as MmOperator | undefined);
    }),

  /**
   * Get all exceptions for a specific run.
   */
  getExceptions: mmProcedure
    .input(
      z.object({
        pocSlug,
        runId: z.number().int().positive(),
      })
    )
    .query(async ({ input }) => {
      return getMmExceptions(input.runId);
    }),

  /**
   * Update the review status of a mobile money exception.
   * Non-OPEN statuses become the institution's resolution history, which
   * applyInstitutionalLearning feeds back into future run diagnoses — this
   * is the per-institution learning write-path for POC-scoped runs.
   */
  updateExceptionStatus: mmProcedure
    .input(
      z.object({
        pocSlug,
        exceptionId: z.number().int().positive(),
        reviewStatus: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "ESCALATED", "REJECTED"]),
        reviewedBy: z.string().max(200).default("POC User"),
        reviewNote: z.string().max(2000).default(""),
      })
    )
    .mutation(async ({ input }) => {
      await updateMmExceptionStatus({
        exceptionId: input.exceptionId,
        reviewStatus: input.reviewStatus,
        reviewedBy: input.reviewedBy,
        reviewNote: input.reviewNote,
      });
      return { success: true };
    }),
});
