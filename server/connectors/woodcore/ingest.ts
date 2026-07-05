/**
 * Canonical ingestion: write mapped WoodCore transactions into the main
 * reconciliation tables (channels → upload_batches → transactions), with
 * dedupe on externalRef so webhook and batch delivery of the same transaction
 * never double-ingests.
 */
import { and, eq, inArray } from "drizzle-orm";
import { channels, transactions, uploadBatches } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { CanonicalTransaction } from "./types";

export const WOODCORE_CHANNEL_CODE_PREFIX = "WOODCORE_CBS";

/** System user id used for connector-originated rows (matches API ingestion). */
const SYSTEM_USER_ID = 0;

/** Find or create the per-org WoodCore CBS channel. */
export async function ensureWoodcoreChannel(organizationId: number): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const code = `${WOODCORE_CHANNEL_CODE_PREFIX}_${organizationId}`;
  const existing = await db.select().from(channels).where(eq(channels.code, code)).limit(1);
  if (existing[0]) return existing[0].id;

  await db.insert(channels).values({
    organizationId,
    name: "WoodCore Core Banking",
    code,
    description: "Live WoodCore CBS connector (API sync + webhooks)",
    channelType: "bank_core",
    country: "NGA",
    defaultCurrency: "NGN",
    isActive: true,
  });
  const created = await db.select().from(channels).where(eq(channels.code, code)).limit(1);
  if (!created[0]) throw new Error("Failed to create WoodCore channel");
  return created[0].id;
}

/** One upload_batches row per sync run / webhook burst, for lineage + reporting. */
export async function createIngestBatch(input: {
  organizationId: number;
  channelId: number;
  label: string;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const result = await db.insert(uploadBatches).values({
    userId: SYSTEM_USER_ID,
    channelId: input.channelId,
    organizationId: input.organizationId,
    fileName: input.label.slice(0, 500),
    detectedFormat: "woodcore_connector",
    status: "processing",
  });
  const insertId = Number((result as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
  if (!insertId) throw new Error("Failed to create ingest batch");
  return insertId;
}

export async function finalizeIngestBatch(
  batchId: number,
  counts: { total: number; valid: number; invalid: number },
  ok: boolean,
  errorMessage?: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(uploadBatches)
    .set({
      totalRows: counts.total,
      validRows: counts.valid,
      invalidRows: counts.invalid,
      status: ok ? "completed" : "failed",
      errorMessage: errorMessage?.slice(0, 4000) ?? null,
      completedAt: new Date(),
    })
    .where(eq(uploadBatches.id, batchId));
}

export interface IngestResult {
  inserted: number;
  duplicates: number;
}

/**
 * Insert canonical transactions, skipping any externalRef already present on
 * this channel. Chunked to stay under MySQL packet limits; safe for the
 * 500K+/month target (≈17K/day) with room to spare.
 */
export async function ingestCanonicalTransactions(
  items: CanonicalTransaction[],
  target: { organizationId: number; channelId: number; batchId: number },
): Promise<IngestResult> {
  if (items.length === 0) return { inserted: 0, duplicates: 0 };
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  // De-dupe within the incoming set first (a webhook replay inside one burst).
  const seen = new Set<string>();
  const unique = items.filter((t) => {
    if (seen.has(t.externalRef)) return false;
    seen.add(t.externalRef);
    return true;
  });

  let inserted = 0;
  let duplicates = items.length - unique.length;

  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const refs = chunk.map((t) => t.externalRef);
    const existing = await db
      .select({ externalRef: transactions.externalRef })
      .from(transactions)
      .where(and(eq(transactions.channelId, target.channelId), inArray(transactions.externalRef, refs)));
    const existingSet = new Set(existing.map((r) => r.externalRef));

    const fresh = chunk.filter((t) => !existingSet.has(t.externalRef));
    duplicates += chunk.length - fresh.length;
    if (fresh.length === 0) continue;

    await db.insert(transactions).values(
      fresh.map((t) => ({
        batchId: target.batchId,
        channelId: target.channelId,
        userId: SYSTEM_USER_ID,
        organizationId: target.organizationId,
        transactionRef: t.transactionRef,
        externalRef: t.externalRef,
        description: t.description,
        amount: t.amount,
        currency: t.currency,
        transactionDate: t.transactionDate,
        valueDate: t.valueDate,
        debitCredit: t.debitCredit,
        counterparty: t.counterparty,
        isReversal: t.isReversal,
        status: "unmatched" as const,
        rawData: t.raw ?? null,
      })),
    );
    inserted += fresh.length;
  }

  return { inserted, duplicates };
}
