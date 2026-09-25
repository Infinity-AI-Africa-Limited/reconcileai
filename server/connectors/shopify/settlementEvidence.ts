import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  channels,
  transactions,
  uploadBatches,
  type InsertTransaction,
} from "../../../drizzle/schema";
import { shopifyConnectorStores } from "../../../drizzle/shopify_schema";
import {
  createAuditLog,
  getDb,
  insertTransactionsWithExecutor,
  type DbExecutor,
} from "../../db";
import {
  detectColumns,
  mapSettlementRows,
  parseSettlementFile,
  type ColumnMap,
  type ParsedFile,
  type SettlementField,
} from "../shopline/settlementFileImport";
import {
  rejectAlreadyIngested,
  runReconciliationOnPersistedData,
} from "../shopline/syncOrchestrator";
import type { ShopifyEmbeddedContext } from "./embeddedAuth";
import {
  resolveAuthorizedShopifyActor,
  ShopifyActorUnavailableError,
  shopifyOrdersChannelCode,
} from "./syncOrchestrator";

const MAX_DECODED_BYTES = 10 * 1024 * 1024;
const RECONCILIATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const ORDER_REFERENCE_LOOKUP_CHUNK = 500;

export interface ShopifySettlementEvidenceInput {
  fileName: string;
  content: string;
  contentEncoding: "utf8" | "base64";
  sourceLabel: string;
  columnOverrides?: ColumnMap;
  dryRun: boolean;
}

export interface ShopifySettlementEvidenceDryRun {
  committed: false;
  headers: string[];
  mapping: ColumnMap;
  missingRequired: SettlementField[];
  totalRows: number;
  parseErrors: string[];
}

export interface ShopifySettlementEvidenceCommitted {
  committed: true;
  mapping: ColumnMap;
  totalRows: number;
  imported: number;
  duplicates: number;
  failed: number;
  matchedCount: number;
  exceptionCount: number;
}

export type ShopifySettlementEvidenceResult =
  | ShopifySettlementEvidenceDryRun
  | ShopifySettlementEvidenceCommitted;

export type ShopifySettlementEvidenceErrorCode =
  | "INVALID_REQUEST"
  | "ORDER_SYNC_REQUIRED"
  | "ACTOR_UNAVAILABLE"
  | "SERVICE_UNAVAILABLE";

export class ShopifySettlementEvidenceError extends Error {
  constructor(public readonly code: ShopifySettlementEvidenceErrorCode) {
    super(code);
    this.name = "ShopifySettlementEvidenceError";
  }
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

type ParseFile = (content: Buffer | string, fileName: string) => Promise<ParsedFile>;
type Reconcile = typeof runReconciliationOnPersistedData;
type AuditCommitted = (params: {
  actorId: number;
  organizationId: number;
  storeId: number;
  imported: number;
  duplicates: number;
  failed: number;
}) => Promise<void>;

export interface ShopifySettlementEvidenceDeps {
  parseFile?: ParseFile;
  reconcile?: Reconcile;
  auditCommitted?: AuditCommitted;
}

/** A deterministic tenant-scoped code; it never identifies a payment provider. */
export function shopifySettlementEvidenceChannelCode(storeId: number): string {
  return `shopify_settlement_evidence_${storeId}`;
}

function insertId(result: unknown): number {
  return Number((result as [{ insertId?: number }])?.[0]?.insertId ?? 0);
}

function decodeContent(input: ShopifySettlementEvidenceInput): Buffer | string {
  if (input.contentEncoding === "utf8") {
    if (Buffer.byteLength(input.content, "utf8") > MAX_DECODED_BYTES) {
      throw new ShopifySettlementEvidenceError("INVALID_REQUEST");
    }
    return input.content;
  }

  // Buffer.from is permissive and silently ignores invalid characters. Reject a
  // malformed transport before decoding so a damaged workbook is never parsed.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) {
    throw new ShopifySettlementEvidenceError("INVALID_REQUEST");
  }
  const decoded = Buffer.from(input.content, "base64");
  if (decoded.length > MAX_DECODED_BYTES) {
    throw new ShopifySettlementEvidenceError("INVALID_REQUEST");
  }
  return decoded;
}

function safeParseErrors(errors: string[]): string[] {
  return errors.slice(0, 10).map((error) => {
    const row = error.match(/\brow\s+(\d+)\b/i)?.[1];
    return row ? `row ${row}: file structure error` : "file structure error";
  });
}

async function resolveActor(
  db: DbExecutor,
  context: ShopifyEmbeddedContext,
): Promise<number> {
  const [store] = await db
    .select({
      id: shopifyConnectorStores.id,
      organizationId: shopifyConnectorStores.organizationId,
      claimedByUserId: shopifyConnectorStores.claimedByUserId,
    })
    .from(shopifyConnectorStores)
    .where(
      and(
        eq(shopifyConnectorStores.id, context.storeId),
        eq(shopifyConnectorStores.organizationId, context.organizationId),
        eq(shopifyConnectorStores.status, "active"),
      ),
    )
    .limit(1);
  if (!store) throw new ShopifySettlementEvidenceError("ACTOR_UNAVAILABLE");

  try {
    return await resolveAuthorizedShopifyActor(db, store);
  } catch (error) {
    if (error instanceof ShopifyActorUnavailableError) {
      throw new ShopifySettlementEvidenceError("ACTOR_UNAVAILABLE");
    }
    throw error;
  }
}

async function requireOrdersChannel(
  db: DbExecutor,
  context: ShopifyEmbeddedContext,
): Promise<number> {
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, context.organizationId),
        eq(channels.code, shopifyOrdersChannelCode(context.storeId)),
        eq(channels.isActive, true),
      ),
    )
    .limit(1);
  if (!channel) throw new ShopifySettlementEvidenceError("ORDER_SYNC_REQUIRED");
  return channel.id;
}

async function resolveSettlementChannel(
  db: DbExecutor,
  context: ShopifyEmbeddedContext,
): Promise<number> {
  const code = shopifySettlementEvidenceChannelCode(context.storeId);
  const find = async () => {
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.organizationId, context.organizationId), eq(channels.code, code)))
      .limit(1);
    return channel?.id ?? null;
  };

  const existing = await find();
  if (existing) return existing;

  await db
    .insert(channels)
    .values({
      organizationId: context.organizationId,
      name: `Settlement Evidence — ${context.displayName}`.slice(0, 100),
      code,
      description: "Merchant-provided settlement evidence for Shopify order reconciliation",
      channelType: "ecommerce_gateway",
      country: "GLB",
      defaultCurrency: (context.currency ?? "USD").slice(0, 3),
      matchingConfig: {
        provider: "merchant_provided",
        resource: "settlement_evidence",
        readOnlySource: true,
      },
      isActive: true,
    })
    .onDuplicateKeyUpdate({ set: { code: sql`${channels.code}` } });

  const created = await find();
  if (!created) throw new ShopifySettlementEvidenceError("SERVICE_UNAVAILABLE");
  return created;
}

async function alignShopifyOrderReferences(
  db: DbExecutor,
  params: { organizationId: number; ordersChannelId: number; rows: InsertTransaction[] },
): Promise<InsertTransaction[]> {
  const refs = [
    ...new Set(
      params.rows
        .map((row) => row.transactionRef)
        .filter((ref): ref is string => Boolean(ref)),
    ),
  ];
  const canonicalByReference = new Map<string, string>();

  for (let index = 0; index < refs.length; index += ORDER_REFERENCE_LOOKUP_CHUNK) {
    const chunk = refs.slice(index, index + ORDER_REFERENCE_LOOKUP_CHUNK);
    const orders = await db
      .select({
        transactionRef: transactions.transactionRef,
        externalRef: transactions.externalRef,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, params.organizationId),
          eq(transactions.channelId, params.ordersChannelId),
          or(
            inArray(transactions.transactionRef, chunk),
            inArray(transactions.externalRef, chunk),
          ),
        ),
      );
    for (const order of orders) {
      if (!order.transactionRef) continue;
      canonicalByReference.set(order.transactionRef, order.transactionRef);
      if (order.externalRef) canonicalByReference.set(order.externalRef, order.transactionRef);
    }
  }

  return params.rows.map((row) => {
    const original = row.transactionRef;
    const canonical = original ? canonicalByReference.get(original) : undefined;
    return canonical ? { ...row, transactionRef: canonical } : row;
  });
}

/**
 * The generic settlement parser accepts an optional free-text description for
 * other retail connectors. Scope A has no reconciliation need for that field:
 * it can contain a customer name, email, address or payment narration. Keep
 * only the bounded provenance needed to explain a match or an exception.
 */
export function minimizeShopifySettlementEvidenceRows(
  rows: InsertTransaction[],
  sourceLabel: string,
): InsertTransaction[] {
  return rows.map((row) => {
    const provenance = (row.rawData ?? {}) as Record<string, unknown>;
    return {
      ...row,
      description: `Settlement import (${sourceLabel})`,
      rawData: {
        gatewayEventType: provenance.gatewayEventType === "refund" ? "refund" : "payment",
        originalOrderRef: typeof provenance.originalOrderRef === "string"
          ? provenance.originalOrderRef
          : undefined,
        gatewayRef: typeof provenance.gatewayRef === "string" ? provenance.gatewayRef : undefined,
        feeAmount: typeof provenance.feeAmount === "number" ? provenance.feeAmount : undefined,
        importedFrom: sourceLabel,
      },
    } as InsertTransaction;
  });
}

async function defaultAuditCommitted(params: Parameters<AuditCommitted>[0]): Promise<void> {
  await createAuditLog({
    organizationId: params.organizationId,
    userId: params.actorId,
    action: "shopify_settlement_evidence_imported",
    entityType: "shopify_store",
    entityId: params.storeId,
    details: {
      source: "merchant_provided_settlement_evidence",
      imported: params.imported,
      duplicates: params.duplicates,
      failed: params.failed,
    },
  });
}

function dryRunResult(
  parsed: ParsedFile,
  mapping: ColumnMap,
  missingRequired: SettlementField[],
): ShopifySettlementEvidenceDryRun {
  return {
    committed: false,
    headers: parsed.headers,
    mapping,
    missingRequired,
    totalRows: parsed.rows.length,
    parseErrors: safeParseErrors(parsed.parseErrors),
  };
}

/**
 * Import merchant-provided settlement evidence for the store selected by the
 * authenticated App Bridge token. No browser-supplied tenant/channel value is
 * accepted, and the uploaded file is parsed in memory rather than retained.
 */
export async function importShopifySettlementEvidence(
  context: ShopifyEmbeddedContext,
  input: ShopifySettlementEvidenceInput,
  db: Db,
  deps: ShopifySettlementEvidenceDeps = {},
): Promise<ShopifySettlementEvidenceResult> {
  // Prove a same-tenant active administrator before decoding or parsing merchant
  // data. There is no user 0 and no cross-tenant fallback.
  const actorId = await resolveActor(db, context);
  const ordersChannelId = await requireOrdersChannel(db, context);

  let parsed: ParsedFile;
  try {
    parsed = await (deps.parseFile ?? parseSettlementFile)(decodeContent(input), input.fileName);
  } catch (error) {
    if (error instanceof ShopifySettlementEvidenceError) throw error;
    throw new ShopifySettlementEvidenceError("INVALID_REQUEST");
  }

  const { mapping, missingRequired } = detectColumns(parsed.headers, input.columnOverrides);
  if (input.dryRun || missingRequired.length > 0) {
    return dryRunResult(parsed, mapping, missingRequired);
  }

  const settlementChannelId = await resolveSettlementChannel(db, context);
  const batchWrite = await db.insert(uploadBatches).values({
    userId: actorId,
    organizationId: context.organizationId,
    channelId: settlementChannelId,
    fileName: input.fileName,
    fileHash: null,
    detectedFormat: "merchant_settlement_evidence",
    totalRows: parsed.rows.length,
    validRows: 0,
    invalidRows: 0,
    status: "processing",
  });
  const batchId = insertId(batchWrite);
  if (!batchId) throw new ShopifySettlementEvidenceError("SERVICE_UNAVAILABLE");

  try {
    const committed = await db.transaction(async (tx) => {
      const { rows: mappedRows, failures } = mapSettlementRows(parsed.rows, mapping, {
        organizationId: context.organizationId,
        paymentsChannelId: settlementChannelId,
        batchId,
        userId: actorId,
        defaultCurrency: context.currency ?? "USD",
        sourceLabel: input.sourceLabel,
      });
      const rows = minimizeShopifySettlementEvidenceRows(mappedRows, input.sourceLabel);
      const alignedRows = await alignShopifyOrderReferences(tx, {
        organizationId: context.organizationId,
        ordersChannelId,
        rows,
      });
      const fresh = await rejectAlreadyIngested(tx, alignedRows, [settlementChannelId]);
      const duplicates = alignedRows.length - fresh.length;
      await insertTransactionsWithExecutor(tx, fresh);

      let matchedCount = 0;
      let exceptionCount = 0;
      if (fresh.length > 0) {
        const times = fresh.map((row: InsertTransaction) => new Date(row.transactionDate).getTime());
        const from = new Date(Math.min(...times) - RECONCILIATION_WINDOW_MS);
        const to = new Date(Math.max(...times) + RECONCILIATION_WINDOW_MS);
        const result = await (deps.reconcile ?? runReconciliationOnPersistedData)(
          tx,
          context.organizationId,
          ordersChannelId,
          settlementChannelId,
          from,
          to,
          context.currency ?? "USD",
        );
        matchedCount = result.matchedCount;
        exceptionCount = result.exceptionCount;
      }

      await tx
        .update(uploadBatches)
        .set({
          status: "completed",
          validRows: fresh.length,
          invalidRows: failures.length,
          errorMessage: failures.length > 0 ? "Some rows could not be imported" : null,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(uploadBatches.id, batchId),
            eq(uploadBatches.organizationId, context.organizationId),
          ),
        );

      return {
        imported: fresh.length,
        duplicates,
        failed: failures.length,
        matchedCount,
        exceptionCount,
      };
    });

    // The ledger and reconciliation transaction is already committed. An audit
    // outage is logged loudly but never changes a successful import into a false
    // failure that invites the merchant to retry it.
    try {
      await (deps.auditCommitted ?? defaultAuditCommitted)({
        actorId,
        organizationId: context.organizationId,
        storeId: context.storeId,
        ...committed,
      });
    } catch {
      console.error("[shopify-settlement-evidence] audit write failed after committed import", {
        storeId: context.storeId,
        organizationId: context.organizationId,
      });
    }

    return {
      committed: true,
      mapping,
      totalRows: parsed.rows.length,
      ...committed,
    };
  } catch (error) {
    try {
      await db
        .update(uploadBatches)
        .set({
          status: "failed",
          errorMessage: "Settlement evidence import failed",
          completedAt: new Date(),
        })
        .where(
          and(
            eq(uploadBatches.id, batchId),
            eq(uploadBatches.organizationId, context.organizationId),
          ),
        );
    } catch {
      console.error("[shopify-settlement-evidence] failed to close upload batch", {
        storeId: context.storeId,
        organizationId: context.organizationId,
      });
    }
    throw error;
  }
}
