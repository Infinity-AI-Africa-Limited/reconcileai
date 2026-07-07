import { getDb } from "./db";
import { apiIngestionLogs, uploadBatches, transactions, apiKeys } from "../drizzle/schema";
import { eq, and, desc } from "drizzle-orm";
import crypto from "crypto";
import Papa from "papaparse";

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

export function calculateFileHash(content: string): string {
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

export function parseAndValidateCsv(
  csvContent: string,
  channelId: number
): {
  valid: ParsedTransaction[];
  invalid: Array<{ row: number; errors: string[] }>;
  totalRows: number;
} {
  const parsed = Papa.parse<any>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header: string) => header.trim(),
  });

  const valid: ParsedTransaction[] = [];
  const invalid: Array<{ row: number; errors: string[] }> = [];

  parsed.data.forEach((row: any, index: number) => {
    const errors: string[] = [];
    const rowNum = index + 2; // +2 because index is 0-based and we skip header

    // Required fields validation
    if (!row.transactionDate && !row.date && !row.Date) {
      errors.push("Missing transaction date");
    }
    if (!row.amount && !row.Amount) {
      errors.push("Missing amount");
    }

    // Amount validation
    const amountStr = row.amount || row.Amount;
    if (amountStr) {
      const amount = parseFloat(String(amountStr).replace(/[^0-9.-]/g, ""));
      if (isNaN(amount)) {
        errors.push("Invalid amount format");
      }
    }

    // Date validation
    const dateStr = row.transactionDate || row.date || row.Date;
    if (dateStr) {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        errors.push("Invalid date format");
      }
    }

    if (errors.length > 0) {
      invalid.push({ row: rowNum, errors });
    } else {
      valid.push({
        transactionDate: dateStr,
        amount: amountStr,
        currency: row.currency || row.Currency || "NGN",
        reference: row.reference || row.Reference || row.ref || "",
        description: row.description || row.Description || "",
        counterparty: row.counterparty || row.Counterparty || row.beneficiary || "",
        ...row,
      });
    }
  });

  return {
    valid,
    invalid,
    totalRows: parsed.data.length,
  };
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

  const txnRecords = validRows.map((row) => ({
    userId: 0, // System user for API uploads
    batchId: uploadBatchId,
    uploadBatchId,
    channelId,
    organizationId: organizationId ?? null,
    transactionDate: new Date(row.transactionDate),
    amount: String(parseFloat(String(row.amount).replace(/[^0-9.-]/g, ""))),
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
