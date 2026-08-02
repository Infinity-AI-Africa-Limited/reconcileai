import { getDb, getChannelByIdForOrg } from "./db";
import { apiIngestionLogs, uploadBatches, transactions, apiKeys } from "../drizzle/schema";
import { eq, and, desc } from "drizzle-orm";
import crypto from "crypto";
import Papa from "papaparse";
import { parseAmount, parseDate, normalizeHeader } from "./ingest/fileParser";

// ─── Types ──────────────────────────────────────────────────────────

export interface ApiUploadRequest {
  apiKey: string;
  channelId: number;
  fileName: string;
  fileContent: string; // Base64 or raw CSV
  encoding?: "base64" | "utf8";
  autoReconcile?: boolean;
  reconcileTargetChannelId?: number;
}

export interface ApiUploadResponse {
  success: boolean;
  uploadBatchId?: number;
  reconciliationJobId?: number;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  errors?: string[];
  message: string;
}

// ─── API Key Validation ─────────────────────────────────────────────

export async function validateApiKey(apiKey: string): Promise<{
  valid: boolean;
  organizationId?: number;
  apiKeyId?: number;
  /** The key owner — REST gateway requests act as this user (WS-4). */
  userId?: number;
  error?: string;
}> {
  if (!apiKey || apiKey.length < 32) {
    return { valid: false, error: "Invalid API key format" };
  }

  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .limit(1);

  if (!key) {
    return { valid: false, error: "API key not found or inactive" };
  }

  if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
    return { valid: false, error: "API key expired" };
  }

  // Update last used timestamp
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id));

  return {
    valid: true,
    organizationId: key.organizationId ?? undefined,
    apiKeyId: key.id,
    userId: key.userId,
  };
}

// ─── File Hash Calculation ──────────────────────────────────────────

/**
 * Content hash used for duplicate-file detection.
 *
 * Accepts a Buffer so binary formats (.xlsx) are hashed over their real bytes.
 * Hashing a `.toString("utf8")` of a workbook is lossy — invalid byte sequences
 * collapse to U+FFFD — so two different spreadsheets could hash identically and
 * the second would be silently discarded as a duplicate.
 */
export function calculateFileHash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ─── CSV Parsing & Validation ───────────────────────────────────────

interface ParsedTransaction {
  transactionDate: string;
  amount: string;
  currency?: string;
  reference?: string;
  description?: string;
  counterparty?: string;
  [key: string]: any;
}

/**
 * Header vocabularies for bank/PSP exports. Deliberately broad: "any bank"
 * means we cannot dictate column names, and the previous code accepted exactly
 * `transactionDate|date|Date` and `amount|Amount`, so a file headed
 * "Posting Date"/"Value" was rejected wholesale as malformed.
 */
const DATE_HEADERS = [
  "transactiondate", "transaction_date", "date", "posting_date", "posted_at",
  "value_date", "valuedate", "settlement_date", "created_at", "created",
  "datetime", "timestamp", "txn_date", "trans_date",
];
const AMOUNT_HEADERS = [
  "amount", "transaction_amount", "txn_amount", "value", "net_amount", "net",
  "credit", "debit", "total", "total_amount", "settlement_amount", "gross_amount",
];

/** Case/spacing-insensitive lookup of the first matching header in a row. */
function pickField(row: Record<string, unknown>, aliases: string[]): string | undefined {
  const byNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    const n = normalizeHeader(k);
    if (n && !byNorm.has(n)) byNorm.set(n, v);
  }
  for (const a of aliases) {
    const v = byNorm.get(a);
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return undefined;
}

export interface RowValidationResult {
  valid: ParsedTransaction[];
  invalid: Array<{ row: number; errors: string[] }>;
  totalRows: number;
}

/**
 * Validate already-parsed rows.
 *
 * Split out from `parseAndValidateCsv` so callers that obtained their rows from
 * a workbook (SFTP/bucket drops, which are frequently .xlsx) share exactly the
 * same validation as CSV callers, rather than needing the data to be delimited
 * text first.
 */
export function validateParsedRows(rows: Record<string, unknown>[]): RowValidationResult {
  const valid: ParsedTransaction[] = [];
  const invalid: Array<{ row: number; errors: string[] }> = [];

  rows.forEach((row: any, index: number) => {
    const errors: string[] = [];
    const rowNum = index + 2; // +2 because index is 0-based and we skip header

    // Header resolution and coercion both come from the shared ingestion core,
    // so the validator and storeTransactions can never disagree about whether a
    // value is readable. Previously each had its own parser and its own short
    // list of accepted spellings.
    const amountStr = pickField(row, AMOUNT_HEADERS);
    const dateStr = pickField(row, DATE_HEADERS);

    if (!dateStr) errors.push("Missing transaction date");
    if (!amountStr) errors.push("Missing amount");
    if (amountStr && parseAmount(amountStr) === null) errors.push("Invalid amount format");
    if (dateStr && parseDate(dateStr) === null) errors.push("Invalid date format");

    if (errors.length > 0) {
      invalid.push({ row: rowNum, errors });
    } else {
      valid.push({
        // Raw row first so the original columns are preserved for rawData…
        ...row,
        // …but the RESOLVED values win. Spreading last would let a present-but-
        // empty `amount` column clobber a value correctly resolved from `Value`.
        transactionDate: dateStr,
        amount: amountStr,
        currency: row.currency || row.Currency || "NGN",
        reference: row.reference || row.Reference || row.ref || "",
        description: row.description || row.Description || "",
        counterparty: row.counterparty || row.Counterparty || row.beneficiary || "",
      });
    }
  });

  return { valid, invalid, totalRows: rows.length };
}

/** Parse delimited text and validate it. Retained for existing CSV callers. */
export function parseAndValidateCsv(
  csvContent: string,
  channelId: number,
): RowValidationResult {
  const parsed = Papa.parse<any>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header: string) => header.trim(),
  });
  return validateParsedRows((parsed.data ?? []) as Record<string, unknown>[]);
}

// ─── Store Transactions ─────────────────────────────────────────────

export async function storeTransactions(
  validRows: ParsedTransaction[],
  uploadBatchId: number,
  channelId: number,
  organizationId: number | undefined
): Promise<number> {
  if (validRows.length === 0) return 0;

  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Coercion goes through the shared ingestion core. The previous inline
  // `parseFloat(String(x).replace(/[^0-9.-]/g, ""))` corrupted money silently:
  // the accounting negative "(12.30)" became +12.30 (a refund posted as a
  // credit) and the European "1.234,56" became 1.23456. Both produced numbers
  // that still looked plausible, which is the dangerous kind of wrong.
  const coerced = validRows.map((row) => ({
    row,
    amount: parseAmount(row.amount as string),
    date: parseDate(row.transactionDate as string),
  }));

  // Defensive: parseAndValidateCsv already rejects these using the SAME parser,
  // so anything landing here is an upstream inconsistency, not user input.
  const unusable = coerced.filter((c) => c.amount === null || c.date === null);
  if (unusable.length > 0) {
    console.warn(
      `[apiIngestion] Skipped ${unusable.length} row(s) with unparseable amount/date after validation — batch ${uploadBatchId}`,
    );
  }

  const txnRecords = coerced
    .filter((c): c is typeof c & { amount: number; date: Date } => c.amount !== null && c.date !== null)
    .map(({ row, amount, date }) => ({
    userId: 0, // System user for API uploads
    batchId: uploadBatchId,
    uploadBatchId,
    channelId,
    organizationId: organizationId ?? null,
    transactionDate: date,
    amount: String(amount),
    currency: row.currency || "NGN",
    reference: row.reference || null,
    description: row.description || null,
    counterparty: row.counterparty || null,
    debitCredit: row.debitCredit || row.type || "debit",
    rawData: JSON.stringify(row),
    status: "unmatched" as const,
  }));

  // Batch insert (max 1000 at a time to avoid query size limits)
  let inserted = 0;
  for (let i = 0; i < txnRecords.length; i += 1000) {
    const batch = txnRecords.slice(i, i + 1000);
    await db.insert(transactions).values(batch);
    inserted += batch.length;
  }

  return inserted;
}

// ─── Log API Ingestion ──────────────────────────────────────────────

export async function logApiIngestion(data: {
  organizationId?: number;
  apiKeyId?: number;
  endpoint: string;
  method: string;
  channelId?: number;
  fileName?: string;
  fileHash?: string;
  payloadSize?: number;
  totalRows?: number;
  validRows?: number;
  invalidRows?: number;
  status: "success" | "failed" | "partial";
  statusCode: number;
  errorMessage?: string;
  processingTimeMs?: number;
  uploadBatchId?: number;
  reconciliationJobId?: number;
  ipAddress?: string;
  userAgent?: string;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [result] = await db.insert(apiIngestionLogs).values({
    organizationId: data.organizationId ?? null,
    apiKeyId: data.apiKeyId ?? null,
    endpoint: data.endpoint,
    method: data.method,
    channelId: data.channelId ?? null,
    fileName: data.fileName ?? null,
    fileHash: data.fileHash ?? null,
    payloadSize: data.payloadSize ?? null,
    totalRows: data.totalRows ?? null,
    validRows: data.validRows ?? null,
    invalidRows: data.invalidRows ?? null,
    status: data.status,
    statusCode: data.statusCode,
    errorMessage: data.errorMessage ?? null,
    processingTimeMs: data.processingTimeMs ?? null,
    uploadBatchId: data.uploadBatchId ?? null,
    reconciliationJobId: data.reconciliationJobId ?? null,
    ipAddress: data.ipAddress ?? null,
    userAgent: data.userAgent ?? null,
  });

  return result.insertId;
}

// ─── Process API Upload ─────────────────────────────────────────────

export async function processApiUpload(
  request: ApiUploadRequest,
  ipAddress?: string,
  userAgent?: string
): Promise<ApiUploadResponse> {
  const startTime = Date.now();

  try {
    // 1. Validate API key
    const keyValidation = await validateApiKey(request.apiKey);
    if (!keyValidation.valid) {
      await logApiIngestion({
        endpoint: "/api/v1/transactions/upload",
        method: "POST",
        status: "failed",
        statusCode: 401,
        errorMessage: keyValidation.error,
        ipAddress,
        userAgent,
      });
      return {
        success: false,
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        errors: [keyValidation.error || "Unauthorized"],
        message: "API key validation failed",
      };
    }

    // 2. Decode file content
    let csvContent: string;
    if (request.encoding === "base64") {
      csvContent = Buffer.from(request.fileContent, "base64").toString("utf8");
    } else {
      csvContent = request.fileContent;
    }

    // 3. Calculate file hash for idempotency
    const fileHash = calculateFileHash(csvContent);

    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // TENANCY GATE — must come before any read or write keyed on channelId.
    //
    // `channelId` is supplied by the CALLER over the public, internet-facing
    // API. An API key belongs to exactly one organization, so without this an
    // integration key issued to one bank could push transactions straight into
    // another bank's channel — a cross-tenant write on the most exposed surface
    // we have. Shared platform rails (organizationId NULL) remain reachable.
    const targetChannel = await getChannelByIdForOrg(
      request.channelId,
      keyValidation.organizationId ?? null,
    );
    if (!targetChannel) {
      await logApiIngestion({
        organizationId: keyValidation.organizationId,
        apiKeyId: keyValidation.apiKeyId,
        endpoint: "/api/v1/transactions/upload",
        method: "POST",
        channelId: request.channelId,
        fileName: request.fileName,
        status: "failed",
        statusCode: 403,
        errorMessage: "Channel does not belong to this API key's organization",
        ipAddress,
        userAgent,
      });
      return {
        success: false,
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        // Deliberately does not distinguish "not yours" from "does not exist";
        // that difference is an enumeration oracle for other tenants' channels.
        errors: ["Channel not found"],
        message: "Channel not found",
      };
    }

    // Check for duplicate upload
    const [existingBatch] = await db
      .select()
      .from(uploadBatches)
      .where(
        and(
          eq(uploadBatches.fileHash, fileHash),
          eq(uploadBatches.channelId, request.channelId)
        )
      )
      .orderBy(desc(uploadBatches.createdAt))
      .limit(1);

    if (existingBatch) {
      await logApiIngestion({
        organizationId: keyValidation.organizationId,
        apiKeyId: keyValidation.apiKeyId,
        endpoint: "/api/v1/transactions/upload",
        method: "POST",
        channelId: request.channelId,
        fileName: request.fileName,
        fileHash,
        payloadSize: csvContent.length,
        status: "success",
        statusCode: 200,
        uploadBatchId: existingBatch.id,
        processingTimeMs: Date.now() - startTime,
        ipAddress,
        userAgent,
      });

      return {
        success: true,
        uploadBatchId: existingBatch.id,
        totalRows: existingBatch.totalRows,
        validRows: existingBatch.validRows,
        invalidRows: existingBatch.invalidRows,
        message: "Duplicate upload detected, returning existing batch",
      };
    }

    // 4. Parse and validate CSV
    const { valid, invalid, totalRows } = parseAndValidateCsv(
      csvContent,
      request.channelId
    );

    if (valid.length === 0) {
      await logApiIngestion({
        organizationId: keyValidation.organizationId,
        apiKeyId: keyValidation.apiKeyId,
        endpoint: "/api/v1/transactions/upload",
        method: "POST",
        channelId: request.channelId,
        fileName: request.fileName,
        fileHash,
        payloadSize: csvContent.length,
        totalRows,
        validRows: 0,
        invalidRows: invalid.length,
        status: "failed",
        statusCode: 400,
        errorMessage: "No valid rows found in CSV",
        processingTimeMs: Date.now() - startTime,
        ipAddress,
        userAgent,
      });

      return {
        success: false,
        totalRows,
        validRows: 0,
        invalidRows: invalid.length,
        errors: invalid.map((inv) => `Row ${inv.row}: ${inv.errors.join(", ")}`),
        message: "CSV validation failed",
      };
    }

    // 5. Create upload batch
    const [batchResult] = await db.insert(uploadBatches).values({
      userId: 0, // System user for API uploads
      channelId: request.channelId,
      organizationId: keyValidation.organizationId ?? null,
      fileName: request.fileName,
      fileHash,
      totalRows,
      validRows: valid.length,
      invalidRows: invalid.length,
      status: "processing",
    });

    const uploadBatchId = batchResult.insertId;

    // 6. Store transactions
    await storeTransactions(
      valid,
      uploadBatchId,
      request.channelId,
      keyValidation.organizationId
    );

    // 7. Update batch status
    await db
      .update(uploadBatches)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(uploadBatches.id, uploadBatchId));

    // 8. Log success
    await logApiIngestion({
      organizationId: keyValidation.organizationId,
      apiKeyId: keyValidation.apiKeyId,
      endpoint: "/api/v1/transactions/upload",
      method: "POST",
      channelId: request.channelId,
      fileName: request.fileName,
      fileHash,
      payloadSize: csvContent.length,
      totalRows,
      validRows: valid.length,
      invalidRows: invalid.length,
      status: invalid.length > 0 ? "partial" : "success",
      statusCode: 200,
      uploadBatchId,
      processingTimeMs: Date.now() - startTime,
      ipAddress,
      userAgent,
    });

    return {
      success: true,
      uploadBatchId,
      totalRows,
      validRows: valid.length,
      invalidRows: invalid.length,
      errors: invalid.length > 0 ? invalid.map((inv) => `Row ${inv.row}: ${inv.errors.join(", ")}`) : undefined,
      message: `Successfully uploaded ${valid.length} transactions`,
    };
  } catch (error: any) {
    await logApiIngestion({
      endpoint: "/api/v1/transactions/upload",
      method: "POST",
      channelId: request.channelId,
      fileName: request.fileName,
      status: "failed",
      statusCode: 500,
      errorMessage: error.message,
      processingTimeMs: Date.now() - startTime,
      ipAddress,
      userAgent,
    });

    return {
      success: false,
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      errors: [error.message],
      message: "Internal server error during upload processing",
    };
  }
}

// ─── Get API Ingestion Logs ─────────────────────────────────────────

export async function getApiIngestionLogs(filters: {
  organizationId?: number;
  apiKeyId?: number;
  status?: "success" | "failed" | "partial";
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  let query = db.select().from(apiIngestionLogs).$dynamic();

  if (filters.organizationId) {
    query = query.where(eq(apiIngestionLogs.organizationId, filters.organizationId));
  }
  if (filters.apiKeyId) {
    query = query.where(eq(apiIngestionLogs.apiKeyId, filters.apiKeyId));
  }
  if (filters.status) {
    query = query.where(eq(apiIngestionLogs.status, filters.status));
  }

  const logs = await query
    .orderBy(desc(apiIngestionLogs.createdAt))
    .limit(filters.limit || 50)
    .offset(filters.offset || 0);

  return logs;
}
