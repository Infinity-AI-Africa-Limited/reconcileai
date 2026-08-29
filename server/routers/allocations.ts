/**
 * Allocation proposals — the Corporate B2B pilot's headline capability, wired.
 *
 * The go-live plan cites `runM2MMatching` as evidence that the platform does
 * "complex allocation reasoning … one-to-many, many-to-one and many-to-many
 * allocation suggestions", and the Control Fit Brief's default corporate_b2b
 * workflow is literally "Distributor receipt to invoice allocation". The
 * function had zero call sites: the promise was delivered by code nothing ran.
 *
 * ── Read-only, and structurally so ────────────────────────────────────────
 *
 * Pilot gate B4: "every non-exact or many-to-many candidate stays proposed
 * until a named human approves it." So this is a tRPC `query`, not a mutation.
 * It writes nothing — no matches, no action drafts, no status changes. The
 * proposals are returned for a person to read, and any posting happens in the
 * customer's own system, outside ReconcileAI. That is the no-write boundary the
 * closure register requires, enforced by the shape of the endpoint rather than
 * by remembering not to write.
 *
 * It also makes no model call. `runM2MMatching` is deterministic arithmetic over
 * references and amounts, so this surface keeps working for a tenant with AI
 * disabled — which is the DEFAULT for a controlled pilot (gate B5).
 *
 * ── What it refuses to do ─────────────────────────────────────────────────
 *
 * The engine distinguishes `unique`, `ambiguous`, `indeterminate` and `none`,
 * and proposes nothing for the middle two. Those refusals are returned as
 * `unresolvedAmbiguities` rather than dropped, because "several splits fit
 * equally well" and "nothing fits" need different work from a controller, and a
 * silent refusal is indistinguishable from finding nothing.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { runM2MMatching, type SATransaction } from "../superAgentEngine";

/**
 * Cap on each side of the comparison.
 *
 * `findSubsetSum` is bounded per receipt, but the strategies loop over every
 * source against every target, so an uncapped job would turn one page load into
 * a very long synchronous scan. 500 is the platform's existing query ceiling
 * and is far above a pilot's daily volume (the go-live design is 10–30
 * distributors), so the cap is reported rather than hidden — a truncated pool
 * would otherwise silently change which allocations are found.
 */
const SIDE_LIMIT = 500;

function toSA(row: {
  id: number; transactionRef: string | null; description: string | null; counterparty: string | null;
  amount: string; currency: string; transactionDate: Date; channelId: number; debitCredit: string;
  isReversal?: boolean | null; originalTransactionRef?: string | null;
}): SATransaction {
  return {
    id: row.id,
    transactionRef: row.transactionRef,
    description: row.description,
    counterparty: row.counterparty,
    amount: row.amount,
    currency: row.currency,
    transactionDate: row.transactionDate,
    channelId: row.channelId,
    debitCredit: row.debitCredit,
    isReversal: row.isReversal,
    originalTransactionRef: row.originalTransactionRef,
  };
}

/** The fields a person needs to judge a proposal, keyed by transaction id. */
function legend(rows: SATransaction[]) {
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      {
        reference: r.transactionRef,
        counterparty: r.counterparty,
        amount: String(r.amount),
        currency: r.currency,
        date: new Date(r.transactionDate).toISOString().slice(0, 10),
      },
    ]),
  );
}

export const allocationsRouter = router({
  /**
   * Proposed allocations for one reconciliation job's unmatched items.
   *
   * A QUERY: it computes and returns, and writes nothing. See the module note.
   */
  proposals: protectedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      // The caller's own organisation, always. A job id from the client decides
      // nothing about tenancy — it is checked against the session's org below,
      // which is the guard the cross-tenant defects in CLAUDE.md §19.3 lacked.
      const organizationId = ctx.user.organizationId ?? null;
      if (organizationId === null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Your account is not linked to an organisation.",
        });
      }

      const job = await db.getReconciliationJob(input.jobId);
      if (!job || job.organizationId !== organizationId) {
        // Not found rather than forbidden: another tenant's job id must not be
        // distinguishable from one that does not exist.
        throw new TRPCError({ code: "NOT_FOUND", message: "Reconciliation job not found." });
      }

      const openStatuses = ["unmatched", "exception"] as const;
      const [sourceRows, targetRows] = await Promise.all([
        db.getOpenTransactionsForChannel({
          organizationId,
          channelId: job.sourceChannelId,
          statuses: openStatuses,
          limit: SIDE_LIMIT,
        }),
        db.getOpenTransactionsForChannel({
          organizationId,
          channelId: job.targetChannelId,
          statuses: openStatuses,
          limit: SIDE_LIMIT,
        }),
      ]);

      const sources = sourceRows.map(toSA);
      const targets = targetRows.map(toSA);
      const result = runM2MMatching(sources, targets, Number(job.amountTolerance ?? 0.015));

      return {
        jobId: job.id,
        jobName: job.name,
        /**
         * Stated, not implied: these are proposals for a named human to approve
         * and to post in the customer's own system. Nothing here has been
         * written, and this endpoint cannot write.
         */
        readOnly: true as const,
        pool: {
          sources: sources.length,
          targets: targets.length,
          truncated: sourceRows.length >= SIDE_LIMIT || targetRows.length >= SIDE_LIMIT,
          limit: SIDE_LIMIT,
        },
        proposals: result.m2mMatches,
        /** Candidates the engine refused to guess at — see the module note. */
        unresolvedAmbiguities: result.unresolvedAmbiguities,
        remaining: {
          sourceIds: result.remainingSourceIds,
          targetIds: result.remainingTargetIds,
        },
        legend: { ...legend(sources), ...legend(targets) },
      };
    }),
});
