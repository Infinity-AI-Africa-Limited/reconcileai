/**
 * Email-forward ingestion (Tier A) — inbound handler.
 *
 * The merchant sets ONE forwarding rule; every provider that emails a payout
 * report then works with no API, no credentials and no per-provider work.
 *
 * ── Trust model ──────────────────────────────────────────────────────────────
 * This is the only surface where an unauthenticated stranger can hand us a
 * file, so nothing here trusts the message. In order:
 *   1. Svix signature + timestamp window — proves Resend sent it.
 *   2. Address token — resolves which org, and is unguessable.
 *   3. Sender allow-list — knowing the address is NOT enough (addresses leak).
 *   4. Attachment name/extension — checked on METADATA, before any download.
 *   5. Size cap — also from metadata, so an oversized file costs us nothing.
 *   6. Content hash — the same file never counts twice.
 * Accepted files are never executed or interpreted; they go to the same tabular
 * parser as a manual upload.
 *
 * ── HTTP semantics ───────────────────────────────────────────────────────────
 * Only a signature failure returns non-2xx. Every business rejection (unknown
 * address, disallowed sender, unusable attachment) is recorded and answered
 * 200: Resend retries non-2xx for hours, and retrying a message we will always
 * refuse is pure noise. A 200 also refuses to confirm whether an address
 * exists, so the endpoint cannot be used to probe for live addresses.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import {
  emailIngestionSources,
  emailIngestionLogs,
  uploadBatches,
} from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { verifySvixSignature, type SvixHeaders } from "./svixSignature";
import { isSenderAllowed, isIngestibleAttachment, normaliseSender } from "./senderAllowlist";
import { parseTabularFile } from "./fileParser";
import { validateParsedRows, storeTransactions, calculateFileHash } from "../apiIngestionService";

const RESEND_API = "https://api.resend.com";

/** Local-part shape: settle-<token>@<inbound domain>. */
const ADDRESS_RE = /^settle-([a-z0-9]{8,64})@/i;

export type InboundOutcome =
  | { status: 401; reason: string }
  | { status: 200; handled: boolean; reason?: string; imported?: number };

/** Pull the address token out of any recipient we recognise. */
export function extractAddressToken(recipients: string[]): string | null {
  for (const raw of recipients) {
    const addr = normaliseSender(raw);
    if (!addr) continue;
    const m = addr.match(ADDRESS_RE);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

interface ResendAttachmentMeta {
  id: string;
  filename?: string;
  size?: number;
  content_type?: string;
  download_url?: string;
}

/** List an inbound message's attachments (metadata + a 1-hour download URL). */
async function listAttachments(emailId: string): Promise<ResendAttachmentMeta[]> {
  const res = await fetch(`${RESEND_API}/emails/receiving/${encodeURIComponent(emailId)}/attachments`, {
    headers: { authorization: `Bearer ${ENV.resendApiKey}` },
  });
  if (!res.ok) throw new Error(`Resend attachments list failed: ${res.status}`);
  const body = (await res.json()) as { data?: ResendAttachmentMeta[] } | ResendAttachmentMeta[];
  return Array.isArray(body) ? body : (body.data ?? []);
}

/**
 * Download an attachment, refusing to buffer more than `maxBytes`.
 *
 * The metadata size is checked first, but it is supplied by the provider and
 * describes the stored object — so the actual read is capped too rather than
 * trusted. A lie about size must not become unbounded memory use.
 */
async function downloadCapped(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`attachment download failed: ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
  return buf;
}

/**
 * Handle one `email.received` delivery. Never throws — the webhook path must
 * always answer, and every outcome is written to email_ingestion_logs.
 */
export async function handleInboundEmail(
  rawBody: Buffer | string,
  headers: SvixHeaders,
): Promise<InboundOutcome> {
  // 1 — authenticity. Fails closed when the secret is unset.
  const sig = verifySvixSignature(rawBody, headers, ENV.resendWebhookSecret);
  if (!sig.ok) return { status: 401, reason: sig.reason };

  // 1b — shape checks are pure and cheap, so they come BEFORE any I/O. Junk and
  // irrelevant event types are then rejected without a database round-trip, and
  // stay diagnosable even while the database is down.
  let payload: {
    type?: string;
    data?: { email_id?: string; from?: string; to?: string[]; subject?: string; attachments?: { id: string; filename?: string }[] };
  };
  try {
    payload = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  } catch {
    return { status: 200, handled: false, reason: "unparseable_payload" };
  }
  if (payload.type !== "email.received") {
    return { status: 200, handled: false, reason: "ignored_event_type" };
  }

  const db = await getDb();
  if (!db) return { status: 200, handled: false, reason: "database_unavailable" };

  const log = (fields: Partial<typeof emailIngestionLogs.$inferInsert>) =>
    db.insert(emailIngestionLogs).values({ status: "rejected", ...fields } as typeof emailIngestionLogs.$inferInsert)
      .catch((e) => console.error("[emailIngestion] could not write log:", e));

  const d = payload.data ?? {};
  const emailId = d.email_id ?? null;
  const from = d.from ?? null;
  const recipients = Array.isArray(d.to) ? d.to : [];
  const subject = (d.subject ?? "").slice(0, 500);

  // 2 — which source is this for?
  const token = extractAddressToken(recipients);
  if (!token) {
    await log({ providerMessageId: emailId, fromAddress: from?.slice(0, 320), toAddress: recipients[0]?.slice(0, 320), subject, rejectionReason: "unknown_address" });
    return { status: 200, handled: false, reason: "unknown_address" };
  }

  const [source] = await db
    .select()
    .from(emailIngestionSources)
    .where(and(eq(emailIngestionSources.addressToken, token), eq(emailIngestionSources.isActive, true)))
    .limit(1);
  if (!source) {
    await log({ providerMessageId: emailId, fromAddress: from?.slice(0, 320), toAddress: recipients[0]?.slice(0, 320), subject, rejectionReason: "unknown_address" });
    return { status: 200, handled: false, reason: "unknown_address" };
  }

  const base = {
    emailSourceId: source.id,
    organizationId: source.organizationId,
    channelId: source.channelId,
    providerMessageId: emailId,
    fromAddress: from?.slice(0, 320) ?? null,
    toAddress: recipients[0]?.slice(0, 320) ?? null,
    subject,
  };

  // 3 — the control that makes a leaked address survivable.
  if (!isSenderAllowed(from, source.allowedSenders)) {
    await log({ ...base, rejectionReason: "sender_not_allowed" });
    return { status: 200, handled: false, reason: "sender_not_allowed" };
  }

  // Idempotency against webhook retries and manual replays.
  if (emailId) {
    const [seen] = await db
      .select({ id: emailIngestionLogs.id })
      .from(emailIngestionLogs)
      .where(and(
        eq(emailIngestionLogs.emailSourceId, source.id),
        eq(emailIngestionLogs.providerMessageId, emailId),
        eq(emailIngestionLogs.status, "success"),
      ))
      .limit(1);
    if (seen) return { status: 200, handled: false, reason: "already_processed" };
  }

  // 4 — filter on metadata BEFORE fetching anything.
  const candidates = (d.attachments ?? []).filter((a) => isIngestibleAttachment(a.filename));
  if (candidates.length === 0) {
    await log({ ...base, status: "skipped", rejectionReason: "no_ingestible_attachment" });
    return { status: 200, handled: false, reason: "no_ingestible_attachment" };
  }

  let imported = 0;
  try {
    const meta = emailId ? await listAttachments(emailId) : [];
    const byId = new Map(meta.map((m) => [m.id, m]));

    for (const att of candidates) {
      const m = byId.get(att.id);
      const filename = att.filename ?? m?.filename ?? "attachment";
      if (!m?.download_url) {
        await log({ ...base, status: "failed", attachmentName: filename, errorMessage: "no download_url returned" });
        continue;
      }
      // 5 — size cap from metadata, before the download.
      if (typeof m.size === "number" && m.size > source.maxAttachmentBytes) {
        await log({ ...base, status: "skipped", attachmentName: filename, fileSize: m.size, rejectionReason: "attachment_too_large" });
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await downloadCapped(m.download_url, source.maxAttachmentBytes);
      } catch (err) {
        await log({ ...base, status: "failed", attachmentName: filename, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 2000) });
        continue;
      }

      // 6 — the same file never counts twice, even re-sent under a new name.
      const fileHash = calculateFileHash(bytes);
      const [dupe] = await db
        .select({ id: emailIngestionLogs.id })
        .from(emailIngestionLogs)
        .where(and(eq(emailIngestionLogs.emailSourceId, source.id), eq(emailIngestionLogs.fileHash, fileHash)))
        .limit(1);
      if (dupe) {
        await log({ ...base, status: "skipped", attachmentName: filename, fileHash, rejectionReason: "duplicate_content" });
        continue;
      }

      let parsed;
      try {
        parsed = await parseTabularFile(bytes, filename);
      } catch (err) {
        await log({ ...base, status: "failed", attachmentName: filename, fileHash, fileSize: bytes.byteLength, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 2000) });
        continue;
      }

      const { valid, invalid, totalRows } = validateParsedRows(parsed.rows);
      if (valid.length === 0) {
        await log({ ...base, status: "failed", attachmentName: filename, fileHash, fileSize: bytes.byteLength, totalRows, validRows: 0, invalidRows: invalid.length, errorMessage: "No valid rows found in attachment" });
        continue;
      }

      const [batch] = await db.insert(uploadBatches).values({
        userId: 0, // system
        channelId: source.channelId,
        organizationId: source.organizationId,
        fileName: filename,
        fileHash,
        detectedFormat: "email_forward",
        totalRows,
        validRows: valid.length,
        invalidRows: invalid.length,
        status: "processing",
      });
      const uploadBatchId = batch.insertId;

      await storeTransactions(valid, uploadBatchId, source.channelId, source.organizationId);
      await db.update(uploadBatches)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(uploadBatches.id, uploadBatchId));

      await log({
        ...base,
        status: invalid.length > 0 ? "partial" : "success",
        attachmentName: filename, fileHash, fileSize: bytes.byteLength,
        totalRows, validRows: valid.length, invalidRows: invalid.length,
        uploadBatchId, rejectionReason: null,
      });
      imported += valid.length;
    }

    await db.update(emailIngestionSources).set({
      lastReceivedAt: new Date(),
      lastErrorAt: null,
      lastErrorMessage: null,
      totalFilesProcessed: source.totalFilesProcessed + candidates.length,
    }).where(eq(emailIngestionSources.id, source.id));

    return { status: 200, handled: true, imported };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log({ ...base, status: "failed", errorMessage: message.slice(0, 2000) });
    await db.update(emailIngestionSources)
      .set({ lastErrorAt: new Date(), lastErrorMessage: message.slice(0, 2000) })
      .where(eq(emailIngestionSources.id, source.id))
      .catch(() => {});
    return { status: 200, handled: false, reason: "processing_error" };
  }
}
