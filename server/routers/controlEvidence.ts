import { protectedProcedure, router } from "../_core/trpc";
import {
  assertControlEvidenceWriter,
  controlBatchManifestInput,
  controlEvidenceScopeInput,
  controlSourceContractInput,
  resolveControlEvidenceScope,
} from "../controlEvidenceSchema";
import {
  listControlEvidence,
  recordControlBatchManifest,
  recordControlSourceContract,
} from "../controlEvidenceStore";
import { getClientInfo } from "./shared";

/**
 * Tenant-scoped evidence for a daily control: immutable approved source
 * contracts and the delivery manifests that can later be evaluated by the
 * completeness policy. This router intentionally does not start a run or
 * declare a control ready; run orchestration is a later reviewed increment.
 */
export const controlEvidenceRouter = router({
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
