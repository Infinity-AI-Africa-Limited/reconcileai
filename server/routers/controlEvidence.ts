import { protectedProcedure, router } from "../_core/trpc";
import {
  assertControlEvidenceWriter,
  controlBatchManifestInput,
  controlEvidenceScopeInput,
  controlRunReadinessInput,
  controlSourceContractInput,
  resolveControlEvidenceScope,
} from "../controlEvidenceSchema";
import {
  listControlEvidence,
  recordControlBatchManifest,
  recordControlSourceContract,
} from "../controlEvidenceStore";
import { evaluateGovernedAdmission } from "../controlRunAdmission";
import { assessPersistedControlRun } from "../controlRunReadiness";
import { getClientInfo } from "./shared";

/**
 * Tenant-scoped evidence for a daily control: immutable approved source
 * contracts and the delivery manifests. `assessReadiness` may evaluate their
 * completeness but cannot start a run; run orchestration remains a later,
 * separately reviewed increment.
 */
export const controlEvidenceRouter = router({
  /**
   * Read-only daily-control preflight. It translates persisted source contracts
   * and batch manifests into the fail-closed completeness policy; it cannot
   * start matching, create a job, or publish a control conclusion.
   */
  assessReadiness: protectedProcedure
    .input(controlRunReadinessInput)
    .query(async ({ ctx, input }) => {
      const assessment = await assessPersistedControlRun({
        organizationId: resolveControlEvidenceScope(
          ctx.user,
          input.organizationId
        ),
        controlPeriod: input.controlPeriod,
      });
      // The same verdict admission enforces, so the page offers Start exactly
      // when reconciliation.createGovernedDailyControl would accept it — and
      // says why not otherwise. A ready preflight alone is not enough: one
      // settlement source with no internal register is "ready" and inadmissible.
      const verdict = await evaluateGovernedAdmission(assessment);
      return {
        ...assessment,
        governedAdmission: { admissible: verdict.admissible, reasons: verdict.reasons },
      };
    }),

  /**
   * One bounded page per collection, with `hasMore` and a cursor. Older
   * evidence is reached by `controlPeriod` or by following `nextCursor`;
   * neither list is ever silently truncated.
   */
  get: protectedProcedure
    .input(controlEvidenceScopeInput)
    .query(({ ctx, input }) => {
      const { organizationId: _requested, ...options } = input;
      return listControlEvidence(
        resolveControlEvidenceScope(ctx.user, input.organizationId),
        options
      );
    }),

  createSourceContract: protectedProcedure
    .input(controlSourceContractInput)
    .mutation(({ ctx, input }) => {
      assertControlEvidenceWriter(ctx.user);
      return recordControlSourceContract({
        actor: ctx.user,
        organizationId: resolveControlEvidenceScope(
          ctx.user,
          input.organizationId
        ),
        input,
        client: getClientInfo(ctx),
      });
    }),

  recordBatchManifest: protectedProcedure
    .input(controlBatchManifestInput)
    .mutation(({ ctx, input }) => {
      assertControlEvidenceWriter(ctx.user);
      return recordControlBatchManifest({
        actor: ctx.user,
        organizationId: resolveControlEvidenceScope(
          ctx.user,
          input.organizationId
        ),
        input,
        client: getClientInfo(ctx),
      });
    }),
});
