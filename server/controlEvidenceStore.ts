import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  controlBatchManifests,
  controlSourceContracts,
  uploadBatches,
} from "../drizzle/schema";
import {
  ControlManifestConflictError,
  ControlManifestValidationError,
  validateBatchManifest,
  validateSourceContract,
} from "./controlManifest";
import {
  type ControlEvidenceActor,
  controlBatchManifestInput,
  controlSourceContractInput,
} from "./controlEvidenceSchema";
import { getDb } from "./db";
import { isDuplicateKeyError } from "./dbErrors";
import { logAuditStrict } from "./routers/shared";

type ClientInfo = { ip: string; ua: string };
type SourceContractInput = z.infer<typeof controlSourceContractInput>;
type BatchManifestInput = z.infer<typeof controlBatchManifestInput>;

export async function listControlEvidence(organizationId: number) {
  const db = await getDb();
  if (!db)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database unavailable",
    });
  const [sourceContracts, manifests] = await Promise.all([
    db
      .select()
      .from(controlSourceContracts)
      .where(eq(controlSourceContracts.organizationId, organizationId))
      .orderBy(
        desc(controlSourceContracts.effectiveAt),
        desc(controlSourceContracts.version)
      )
      .limit(100),
    db
      .select()
      .from(controlBatchManifests)
      .where(eq(controlBatchManifests.organizationId, organizationId))
      .orderBy(
        desc(controlBatchManifests.receivedAt),
        desc(controlBatchManifests.id)
      )
      .limit(200),
  ]);
  return { organizationId, sourceContracts, manifests };
}

export async function recordControlSourceContract(params: {
  actor: ControlEvidenceActor;
  organizationId: number;
  input: SourceContractInput;
  client: ClientInfo;
}) {
  const { actor, organizationId, client } = params;
  const { organizationId: _requested, ...contract } = params.input;
  try {
    validateSourceContract(contract);
    const db = await getDb();
    if (!db)
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database unavailable",
      });
    return await db.transaction(async tx => {
      const [inserted] = await tx.insert(controlSourceContracts).values({
        ...contract,
        organizationId,
        createdByUserId: actor.id,
      });
      const id = Number(inserted.insertId);
      await logAuditStrict({
        userId: actor.id,
        organizationId,
        action: "control_source_contract_recorded",
        entityType: "control_source_contract",
        entityId: id,
        details: {
          sourceKey: contract.sourceKey,
          version: contract.version,
          role: contract.role,
          status: contract.status,
          controlTotalRequired: contract.controlTotalRequired,
        },
        ipAddress: client.ip,
        userAgent: client.ua,
        executor: tx,
      });
      return { id };
    });
  } catch (error) {
    return asControlEvidenceError(error);
  }
}

export async function recordControlBatchManifest(params: {
  actor: ControlEvidenceActor;
  organizationId: number;
  input: BatchManifestInput;
  client: ClientInfo;
}) {
  const { actor, organizationId, client } = params;
  const { organizationId: _requested, ...manifest } = params.input;
  try {
    const db = await getDb();
    if (!db)
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database unavailable",
      });
    return await db.transaction(async tx => {
      const [contract] = await tx
        .select({
          id: controlSourceContracts.id,
          organizationId: controlSourceContracts.organizationId,
          sourceKey: controlSourceContracts.sourceKey,
          version: controlSourceContracts.version,
          status: controlSourceContracts.status,
          controlTotalRequired: controlSourceContracts.controlTotalRequired,
          expectedCurrency: controlSourceContracts.expectedCurrency,
        })
        .from(controlSourceContracts)
        .where(
          and(
            eq(controlSourceContracts.id, manifest.sourceContractId),
            eq(controlSourceContracts.organizationId, organizationId)
          )
        )
        .limit(1);
      if (!contract)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Source contract not found",
        });
      validateBatchManifest(manifest, contract);
      if (manifest.uploadBatchId !== null) {
        const [batch] = await tx
          .select({ id: uploadBatches.id, status: uploadBatches.status })
          .from(uploadBatches)
          .where(
            and(
              eq(uploadBatches.id, manifest.uploadBatchId),
              eq(uploadBatches.organizationId, organizationId)
            )
          )
          .limit(1);
        if (!batch)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Upload batch not found",
          });
        if (batch.status !== "completed") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "A batch manifest can reference only a completed upload batch.",
          });
        }
      }
      const [inserted] = await tx.insert(controlBatchManifests).values({
        ...manifest,
        organizationId,
        sourceContractVersion: contract.version,
        recordedByUserId: actor.id,
      });
      const id = Number(inserted.insertId);
      await logAuditStrict({
        userId: actor.id,
        organizationId,
        action: "control_batch_manifest_recorded",
        entityType: "control_batch_manifest",
        entityId: id,
        details: {
          sourceContractId: manifest.sourceContractId,
          sourceKey: contract.sourceKey,
          sourceContractVersion: contract.version,
          controlPeriod: manifest.controlPeriod,
          deliveryIdentity: manifest.deliveryIdentity,
          schemaState: manifest.schemaState,
          duplicateDelivery: manifest.duplicateDelivery,
        },
        ipAddress: client.ip,
        userAgent: client.ua,
        executor: tx,
      });
      return { id };
    });
  } catch (error) {
    return asControlEvidenceError(error);
  }
}

function asControlEvidenceError(error: unknown): never {
  if (error instanceof ControlManifestValidationError) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "invalid_control_evidence",
      cause: error,
    });
  }
  if (
    error instanceof ControlManifestConflictError ||
    isDuplicateKeyError(error)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This source-contract version or delivered batch identity has already been recorded.",
      cause: error,
    });
  }
  throw error;
}
