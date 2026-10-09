import { TRPCError } from "@trpc/server";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
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
  CONTROL_EVIDENCE_PAGE_DEFAULT,
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

/**
 * What a read of control evidence returns, named column by column.
 *
 * `select()` with no projection returns whatever the table holds at the time,
 * so a column added later — an internal note, a reviewer's identity — would
 * start reaching callers with no change here to notice in review. Both lists
 * are enumerated instead, and `createdByUserId` / `recordedByUserId` are
 * included deliberately: who filed a piece of evidence is part of the evidence.
 */
const CONTROL_SOURCE_CONTRACT_FIELDS = {
  id: controlSourceContracts.id,
  organizationId: controlSourceContracts.organizationId,
  sourceKey: controlSourceContracts.sourceKey,
  version: controlSourceContracts.version,
  role: controlSourceContracts.role,
  displayName: controlSourceContracts.displayName,
  systemName: controlSourceContracts.systemName,
  controlPurpose: controlSourceContracts.controlPurpose,
  accountableOwner: controlSourceContracts.accountableOwner,
  escalationOwner: controlSourceContracts.escalationOwner,
  deliveryRoute: controlSourceContracts.deliveryRoute,
  timeZone: controlSourceContracts.timeZone,
  cutoffMinutes: controlSourceContracts.cutoffMinutes,
  schemaVersion: controlSourceContracts.schemaVersion,
  controlTotalRequired: controlSourceContracts.controlTotalRequired,
  expectedCurrency: controlSourceContracts.expectedCurrency,
  status: controlSourceContracts.status,
  approvalReference: controlSourceContracts.approvalReference,
  effectiveAt: controlSourceContracts.effectiveAt,
  createdByUserId: controlSourceContracts.createdByUserId,
  createdAt: controlSourceContracts.createdAt,
  updatedAt: controlSourceContracts.updatedAt,
} as const;

const CONTROL_BATCH_MANIFEST_FIELDS = {
  id: controlBatchManifests.id,
  organizationId: controlBatchManifests.organizationId,
  sourceContractId: controlBatchManifests.sourceContractId,
  sourceContractVersion: controlBatchManifests.sourceContractVersion,
  controlPeriod: controlBatchManifests.controlPeriod,
  deliveryIdentity: controlBatchManifests.deliveryIdentity,
  uploadBatchId: controlBatchManifests.uploadBatchId,
  receivedAt: controlBatchManifests.receivedAt,
  mappingVersion: controlBatchManifests.mappingVersion,
  reconciliationPolicyVersion: controlBatchManifests.reconciliationPolicyVersion,
  schemaState: controlBatchManifests.schemaState,
  duplicateDelivery: controlBatchManifests.duplicateDelivery,
  invalidRowCount: controlBatchManifests.invalidRowCount,
  expectedRecordCount: controlBatchManifests.expectedRecordCount,
  expectedMonetaryTotal: controlBatchManifests.expectedMonetaryTotal,
  expectedCurrency: controlBatchManifests.expectedCurrency,
  receivedRecordCount: controlBatchManifests.receivedRecordCount,
  receivedMonetaryTotal: controlBatchManifests.receivedMonetaryTotal,
  receivedCurrency: controlBatchManifests.receivedCurrency,
  recordedByUserId: controlBatchManifests.recordedByUserId,
  createdAt: controlBatchManifests.createdAt,
} as const;

/**
 * Rows strictly after a keyset cursor, in `<sort> DESC, id DESC` order.
 *
 * The ORDER BY must be exactly these two columns. A third sort key the cursor
 * does not carry would let two rows tie on the cursor's terms, and the page
 * boundary would then repeat or skip whichever the engine happened to order
 * differently between calls.
 */
function afterCursor(
  sortColumn: MySqlColumn,
  idColumn: MySqlColumn,
  position: { sort: Date; id: number }
) {
  return or(
    lt(sortColumn, position.sort),
    and(eq(sortColumn, position.sort), lt(idColumn, position.id))
  );
}

/** A bounded page, and the cursor that reaches what it did not return. */
function page<Row extends { id: number }>(
  rows: Row[],
  limit: number,
  positionOf: (row: Row) => Date
): { rows: Row[]; hasMore: boolean; nextCursor: { id: number; at: Date } | null } {
  // One row beyond the limit was fetched purely to answer "is there more?".
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const last = visible[visible.length - 1];
  return {
    rows: visible,
    hasMore,
    nextCursor: hasMore && last ? { id: last.id, at: positionOf(last) } : null,
  };
}

/**
 * One page of a tenant's control evidence.
 *
 * Both collections are bounded AND say whether more exists. Returning a silent
 * truncation would be worse than returning less: evidence for a daily control is
 * read to answer "is this complete?", and a caller cannot tell a short list from
 * a complete one. Older evidence stays reachable through `controlPeriod` (which
 * `idx_control_batch_manifest_org_period` serves directly) or by following the
 * cursor.
 */
export async function listControlEvidence(
  organizationId: number,
  options: {
    controlPeriod?: string;
    sourceContractId?: number;
    sourceKey?: string;
    limit?: number;
    contractCursor?: { effectiveAt: Date; id: number };
    manifestCursor?: { receivedAt: Date; id: number };
  } = {}
) {
  const db = await getDb();
  if (!db)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database unavailable",
    });
  const limit = options.limit ?? CONTROL_EVIDENCE_PAGE_DEFAULT;

  const contractWhere = [
    eq(controlSourceContracts.organizationId, organizationId),
    options.sourceKey
      ? eq(controlSourceContracts.sourceKey, options.sourceKey)
      : undefined,
    options.sourceContractId
      ? eq(controlSourceContracts.id, options.sourceContractId)
      : undefined,
    options.contractCursor
      ? afterCursor(controlSourceContracts.effectiveAt, controlSourceContracts.id, {
          sort: options.contractCursor.effectiveAt,
          id: options.contractCursor.id,
        })
      : undefined,
  ].filter(part => part !== undefined);

  const manifestWhere = [
    eq(controlBatchManifests.organizationId, organizationId),
    options.controlPeriod
      ? eq(controlBatchManifests.controlPeriod, options.controlPeriod)
      : undefined,
    options.sourceContractId
      ? eq(controlBatchManifests.sourceContractId, options.sourceContractId)
      : undefined,
    options.manifestCursor
      ? afterCursor(controlBatchManifests.receivedAt, controlBatchManifests.id, {
          sort: options.manifestCursor.receivedAt,
          id: options.manifestCursor.id,
        })
      : undefined,
  ].filter(part => part !== undefined);

  const [contractRows, manifestRows] = await Promise.all([
    db
      .select(CONTROL_SOURCE_CONTRACT_FIELDS)
      .from(controlSourceContracts)
      .where(and(...contractWhere))
      .orderBy(
        desc(controlSourceContracts.effectiveAt),
        desc(controlSourceContracts.id)
      )
      .limit(limit + 1),
    db
      .select(CONTROL_BATCH_MANIFEST_FIELDS)
      .from(controlBatchManifests)
      .where(and(...manifestWhere))
      .orderBy(
        desc(controlBatchManifests.receivedAt),
        desc(controlBatchManifests.id)
      )
      .limit(limit + 1),
  ]);

  const contracts = page(contractRows, limit, row => row.effectiveAt);
  const manifests = page(manifestRows, limit, row => row.receivedAt);
  return {
    organizationId,
    limit,
    sourceContracts: {
      rows: contracts.rows,
      hasMore: contracts.hasMore,
      nextCursor: contracts.nextCursor
        ? { effectiveAt: contracts.nextCursor.at, id: contracts.nextCursor.id }
        : null,
    },
    manifests: {
      rows: manifests.rows,
      hasMore: manifests.hasMore,
      nextCursor: manifests.nextCursor
        ? { receivedAt: manifests.nextCursor.at, id: manifests.nextCursor.id }
        : null,
    },
  };
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
      const id = insertedId(inserted);
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
      const id = insertedId(inserted);
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

/**
 * The row id an insert produced, or a refusal.
 *
 * The audit entry for a piece of control evidence carries this as its
 * entityId, so an unreadable id must not pass as 0 or NaN: the caller would be
 * told the evidence was recorded while the audit trail pointed at nothing. The
 * transaction has not committed yet here, so throwing discards the insert too.
 */
function insertedId(inserted: { insertId?: number | string }): number {
  const id = Number(inserted?.insertId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database unavailable",
    });
  }
  return id;
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
