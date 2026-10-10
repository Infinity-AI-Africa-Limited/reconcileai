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
    .query(({ ctx, input }) =>
      assessPersistedControlRun({
        organizationId: resolveControlEvidenceScope(
          ctx.user,
          input.organizationId
        ),
        controlPeriod: input.controlPeriod,
      })
    ),

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
