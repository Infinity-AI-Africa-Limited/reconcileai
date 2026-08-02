import SftpClient from "ssh2-sftp-client";
import crypto from "crypto";
import { getDb } from "./db";
import { sftpCredentials, sftpIngestionLogs, uploadBatches, transactions } from "../drizzle/schema";
import { eq, and, lte } from "drizzle-orm";
import { validateParsedRows, storeTransactions, calculateFileHash } from "./apiIngestionService";
import { parseTabularFile } from "./ingest/fileParser";

// ─── Constants ──────────────────────────────────────────────────────

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY = process.env.SFTP_ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex");
const POLLING_CHECK_INTERVAL = 60000; // Check every 60 seconds for due polls

// ─── Credential Encryption ──────────────────────────────────────────

export function encryptCredential(text: string): string {
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  
  const authTag = cipher.getAuthTag();
  
  // Return: iv:authTag:encrypted
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptCredential(encryptedText: string): string {
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
  const parts = encryptedText.split(":");
  
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted credential format");
  }
  
  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];
  
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  
  return decrypted;
}

// ─── SFTP Connection Testing ───────────────────────────────────────

export async function testSftpConnection(config: {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}): Promise<{ success: boolean; error?: string }> {
  const sftp = new SftpClient();
  
  try {
    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      privateKey: config.privateKey,
      readyTimeout: 10000,
    });
    
    // Test list directory
    await sftp.list("/");
    
    await sftp.end();
    
    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Connection failed",
    };
  }
}

// ─── SFTP File Operations ──────────────────────────────────────────

export async function listSftpFiles(
  credentialId: number
): Promise<{ success: boolean; files?: Array<{ name: string; size: number; modifyTime: number }>; error?: string }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const [cred] = await db
    .select()
    .from(sftpCredentials)
    .where(eq(sftpCredentials.id, credentialId))
    .limit(1);
  
  if (!cred) {
    return { success: false, error: "Credential not found" };
  }
  
  const sftp = new SftpClient();
  
  try {
    const password = cred.passwordEncrypted ? decryptCredential(cred.passwordEncrypted) : undefined;
    const privateKey = cred.privateKeyEncrypted ? decryptCredential(cred.privateKeyEncrypted) : undefined;
    
    await sftp.connect({
      host: cred.host,
      port: cred.port,
      username: cred.username,
      password,
      privateKey,
      readyTimeout: 10000,
    });
    
    const fileList = await sftp.list(cred.remotePath);
    
    // Filter by file pattern (glob)
    const pattern = cred.filePattern.replace(/\*/g, ".*");
    const regex = new RegExp(`^${pattern}$`);
    
    const matchedFiles = fileList
      .filter((file) => file.type === "-" && regex.test(file.name))
      .map((file) => ({
        name: file.name,
        size: file.size,
        modifyTime: file.modifyTime,
      }));
    
    await sftp.end();
    
    return { success: true, files: matchedFiles };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Failed to list files",
    };
  }
}

export async function downloadAndProcessSftpFile(
  credentialId: number,
  fileName: string
): Promise<{ success: boolean; uploadBatchId?: number; error?: string }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const [cred] = await db
    .select()
    .from(sftpCredentials)
    .where(eq(sftpCredentials.id, credentialId))
    .limit(1);
  
  if (!cred) {
    return { success: false, error: "Credential not found" };
  }
  
  const sftp = new SftpClient();
  const startTime = Date.now();
  
  try {
    const password = cred.passwordEncrypted ? decryptCredential(cred.passwordEncrypted) : undefined;
    const privateKey = cred.privateKeyEncrypted ? decryptCredential(cred.privateKeyEncrypted) : undefined;
    
    await sftp.connect({
      host: cred.host,
      port: cred.port,
      username: cred.username,
      password,
      privateKey,
      readyTimeout: 10000,
    });
    
    const remotePath = `${cred.remotePath}/${fileName}`;
    const raw = await sftp.get(remotePath);
    // Keep the bytes. This used to be `.toString("utf8")` unconditionally, so a
    // workbook dropped on SFTP — the norm for couriers and enterprise PSPs — was
    // mangled into replacement characters and then parsed as delimited text,
    // yielding garbage rows. Hashing that lossy string could also collide two
    // different spreadsheets and silently discard the second as a duplicate.
    const fileBuffer: Buffer = Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw as unknown as string, "utf8");
    const fileSize = fileBuffer.byteLength;
    const fileHash = calculateFileHash(fileBuffer);
    
    // Check for duplicate
    const [existingLog] = await db
      .select()
      .from(sftpIngestionLogs)
      .where(
        and(
          eq(sftpIngestionLogs.sftpCredentialId, credentialId),
          eq(sftpIngestionLogs.fileHash, fileHash)
        )
      )
      .limit(1);
    
    if (existingLog) {
      await sftp.end();
      return {
        success: true,
        uploadBatchId: existingLog.uploadBatchId ?? undefined,
        error: "File already processed (duplicate hash)",
      };
    }
    
    // Parse via the shared ingestion core: CSV/TSV or Excel, same validation.
    let valid: Awaited<ReturnType<typeof validateParsedRows>>["valid"] = [];
    let invalid: Array<{ row: number; errors: string[] }> = [];
    let totalRows = 0;
    let parseFailure: string | null = null;
    try {
      const parsed = await parseTabularFile(fileBuffer, fileName);
      ({ valid, invalid, totalRows } = validateParsedRows(parsed.rows));
    } catch (parseErr) {
      // A corrupt or password-protected workbook must fail loudly with a usable
      // reason, not fall through as "no valid rows".
      parseFailure = parseErr instanceof Error ? parseErr.message : String(parseErr);
    }

    if (parseFailure || valid.length === 0) {
      // Log failed ingestion
      await db.insert(sftpIngestionLogs).values({
        sftpCredentialId: credentialId,
        organizationId: cred.organizationId,
        channelId: cred.channelId,
        fileName,
        filePath: remotePath,
        fileSize,
        fileHash,
        totalRows,
        validRows: 0,
        invalidRows: invalid.length,
        status: "failed",
        errorMessage: parseFailure ?? "No valid rows found in file",
        processingTimeMs: Date.now() - startTime,
      });
      
      await sftp.end();
      return { success: false, error: parseFailure ?? "No valid rows found in file" };
    }
    
    // Create upload batch
    const [batchResult] = await db.insert(uploadBatches).values({
      userId: 0, // System user for SFTP uploads
      channelId: cred.channelId,
      organizationId: cred.organizationId,
      fileName,
      fileHash,
      totalRows,
      validRows: valid.length,
      invalidRows: invalid.length,
      status: "processing",
    });
    
    const uploadBatchId = batchResult.insertId;
    
    // Store transactions
    await storeTransactions(valid, uploadBatchId, cred.channelId, cred.organizationId ?? undefined);
    
    // Update batch status
    await db
      .update(uploadBatches)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(uploadBatches.id, uploadBatchId));
    
    // Archive file if configured
    let archivedPath: string | null = null;
    if (cred.archivePath) {
      const archiveRemotePath = `${cred.archivePath}/${fileName}`;
      await sftp.rename(remotePath, archiveRemotePath);
      archivedPath = archiveRemotePath;
    } else {
      // Delete file if no archive path
      await sftp.delete(remotePath);
    }
    
    // Log successful ingestion
    await db.insert(sftpIngestionLogs).values({
      sftpCredentialId: credentialId,
      organizationId: cred.organizationId,
      channelId: cred.channelId,
      fileName,
      filePath: remotePath,
      fileSize,
      fileHash,
      totalRows,
      validRows: valid.length,
      invalidRows: invalid.length,
      status: invalid.length > 0 ? "partial" : "success",
      processingTimeMs: Date.now() - startTime,
      uploadBatchId,
      archivedPath,
    });
    
    // Update credential stats
    await db
      .update(sftpCredentials)
      .set({
        lastPolledAt: new Date(),
        lastSuccessAt: new Date(),
        totalFilesProcessed: cred.totalFilesProcessed + 1,
      })
      .where(eq(sftpCredentials.id, credentialId));
    
    await sftp.end();
    
    return { success: true, uploadBatchId };
  } catch (error: any) {
    // Log failed ingestion
    await db.insert(sftpIngestionLogs).values({
      sftpCredentialId: credentialId,
      organizationId: cred.organizationId,
      channelId: cred.channelId,
      fileName,
      filePath: `${cred.remotePath}/${fileName}`,
      status: "failed",
      errorMessage: error.message,
      processingTimeMs: Date.now() - startTime,
    });
    
    // Update credential error stats
    await db
      .update(sftpCredentials)
      .set({
        lastPolledAt: new Date(),
        lastErrorAt: new Date(),
        lastErrorMessage: error.message,
        totalFilesFailed: cred.totalFilesFailed + 1,
      })
      .where(eq(sftpCredentials.id, credentialId));
    
    return {
      success: false,
      error: error.message || "Failed to process file",
    };
  }
}

// ─── SFTP Polling Service ──────────────────────────────────────────

let pollingInterval: NodeJS.Timeout | null = null;

export async function pollSftpCredentials() {
  const db = await getDb();
  if (!db) return;
  
  try {
    // Get all active credentials that are due for polling
    const now = new Date();
    const credentials = await db
      .select()
      .from(sftpCredentials)
      .where(
        and(
          eq(sftpCredentials.isActive, true),
          eq(sftpCredentials.pollingEnabled, true)
        )
      );
    
    for (const cred of credentials) {
      // Check if polling is due
      const lastPolled = cred.lastPolledAt ? new Date(cred.lastPolledAt).getTime() : 0;
      const intervalMs = cred.pollingIntervalMinutes * 60 * 1000;
      const nextPollDue = lastPolled + intervalMs;
      
      if (now.getTime() < nextPollDue) {
        continue; // Not due yet
      }
      
      console.log(`[SFTP Polling] Checking credential ${cred.id} (${cred.name})`);
      
      // List files
      const { success, files, error } = await listSftpFiles(cred.id);
      
      if (!success) {
        console.error(`[SFTP Polling] Failed to list files for credential ${cred.id}:`, error);
        await db
          .update(sftpCredentials)
          .set({
            lastPolledAt: now,
            lastErrorAt: now,
            lastErrorMessage: error,
          })
          .where(eq(sftpCredentials.id, cred.id));
        continue;
      }
      
      if (!files || files.length === 0) {
        console.log(`[SFTP Polling] No new files for credential ${cred.id}`);
        await db
          .update(sftpCredentials)
          .set({ lastPolledAt: now })
          .where(eq(sftpCredentials.id, cred.id));
        continue;
      }
      
      console.log(`[SFTP Polling] Found ${files.length} file(s) for credential ${cred.id}`);
      
      // Process each file
      for (const file of files) {
        console.log(`[SFTP Polling] Processing file: ${file.name}`);
        const result = await downloadAndProcessSftpFile(cred.id, file.name);
        
        if (result.success) {
          console.log(`[SFTP Polling] Successfully processed ${file.name}, batch ID: ${result.uploadBatchId}`);
        } else {
          console.error(`[SFTP Polling] Failed to process ${file.name}:`, result.error);
        }
      }
    }
  } catch (error) {
    console.error("[SFTP Polling] Polling failed:", error);
  }
}

export function startSftpPolling() {
  if (pollingInterval) {
    console.log("[SFTP Polling] Already running");
    return;
  }
  
  console.log(`[SFTP Polling] Starting with ${POLLING_CHECK_INTERVAL}ms interval`);
  
  // Initial poll
  pollSftpCredentials();
  
  // Set up recurring poll
  pollingInterval = setInterval(pollSftpCredentials, POLLING_CHECK_INTERVAL);
}

export function stopSftpPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log("[SFTP Polling] Stopped");
  }
}
