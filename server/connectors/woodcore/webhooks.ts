/**
 * Real-time ingestion: WoodCore webhook receiver.
 *
 * Contract (documented for the WoodCore team; header names configurable later):
 *   POST /api/webhooks/woodcore/:configId
 *   Headers:
 *     x-woodcore-signature: sha256=<hex HMAC-SHA256 of the raw body>
 *     x-woodcore-event-id:  <provider event id>          (optional)
 *     x-woodcore-event:     <event type, e.g. savings.transaction.created> (optional)
 *   Body: JSON — either the transaction object itself or { eventId, eventType, data }.
 *
 * Guarantees:
 *   - HMAC verified against the raw request body (timing-safe compare).
 *   - Idempotent: unique (configId, eventId); eventId falls back to a SHA-256
 *     of the raw body, so byte-identical replays are always deduped.
 *   - Never throws to the caller: failures are recorded on the event row and
 *     dead-lettered for retry; WoodCore always gets a fast 2xx unless the
 *     signature is invalid (401) or the connector is unknown/disabled (404).
 */
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import {
  wcConnectorFieldMappings,
  wcConnectorWebhookEvents,
} from "../../../drizzle/connector_schema";
import { getDb } from "../../db";
import { getCbsProfile } from "../cbs/registry";
import { getConfigRow } from "./config";
import { enqueueDeadLetter } from "./dlq";
import {
  ensureCbsChannel,
  createIngestBatch,
  finalizeIngestBatch,
  ingestCanonicalTransactions,
} from "./ingest";
import { applyMapping, type MappingRule } from "./mapping";
import { decryptSecretForOrg } from "./secrets";
import type { WcEntity } from "./types";

export const SIGNATURE_HEADER = "x-woodcore-signature";
export const EVENT_ID_HEADER = "x-woodcore-event-id";
export const EVENT_TYPE_HEADER = "x-woodcore-event";

export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifySignature(
  rawBody: Buffer | string,
  secret: string,
  providedHeader: string | undefined,
): boolean {
  if (!providedHeader) return false;
  const provided = providedHeader.replace(/^sha256=/i, "").trim().toLowerCase();
  const expected = computeSignature(rawBody, secret);
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Infer which entity a webhook event refers to, from event type or payload shape. */
export function inferEntity(eventType: string | null, payload: unknown): WcEntity | null {
  const t = (eventType ?? "").toLowerCase();
  if (t.includes("savings") || t.includes("deposit")) return "savings_transaction";
  if (t.includes("loan") || t.includes("arrangement")) return "loan_transaction";
  if (t.includes("journal") || t.includes("gl")) return "journal_entry";
  const p = payload as Record<string, unknown> | null;
  if (p && typeof p === "object") {
    if ("savingsAccountId" in p || "runningBalance" in p) return "savings_transaction";
    if ("loanId" in p || "principalPortion" in p || "arrangementId" in p) return "loan_transaction";
    if ("entryType" in p || "glAccountId" in p || "glAccountCode" in p || "glAccount" in p) return "journal_entry";
  }
  return null;
}

export interface WebhookHandleResult {
  httpStatus: number;
  body: { ok: boolean; status: string; eventDbId?: number; error?: string };
}

export async function handleWoodcoreWebhook(input: {
  configId: number;
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
}): Promise<WebhookHandleResult> {
  const header = (name: string): string | undefined => {
    const v = input.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };

  const cfg = await getConfigRow(input.configId);
  if (!cfg || !cfg.isEnabled || !cfg.webhookEnabled) {
    return { httpStatus: 404, body: { ok: false, status: "unknown_or_disabled" } };
  }

  // Tenant rate limit: a runaway CBS webhook firehose for one tenant must not
  // starve the others. 429 tells the sender to back off; the daily batch sync
  // guarantees nothing is lost.
  const { checkTenantRate } = await import("../../_core/rateLimit");
  const rate = await checkTenantRate(cfg.organizationId, "webhook");
  if (!rate.allowed) {
    return {
      httpStatus: 429,
      body: { ok: false, status: "rate_limited", error: `retry after ${rate.retryAfterSec}s` },
    };
  }

  const secret = await decryptSecretForOrg(cfg.webhookSecretEnc, cfg.organizationId);
  if (!secret) {
    // Misconfiguration on our side — record it, reject the event.
    return { httpStatus: 503, body: { ok: false, status: "webhook_secret_not_configured" } };
  }
  const signatureValid = verifySignature(input.rawBody, secret, header(SIGNATURE_HEADER));
  if (!signatureValid) {
    return { httpStatus: 401, body: { ok: false, status: "invalid_signature" } };
  }

  // Parse body
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody.toString());
  } catch {
    return { httpStatus: 400, body: { ok: false, status: "invalid_json" } };
  }

  const envelope = parsed as Record<string, unknown>;
  const eventType =
    header(EVENT_TYPE_HEADER) ??
    (typeof envelope.eventType === "string" ? envelope.eventType : null);
  const eventId =
    header(EVENT_ID_HEADER) ??
    (typeof envelope.eventId === "string" ? envelope.eventId : null) ??
    // Fallback: hash of the raw body — byte-identical replays dedupe.
    crypto.createHash("sha256").update(input.rawBody).digest("hex");
  const data = envelope.data !== undefined ? envelope.data : parsed;
  const entity = inferEntity(eventType, data);

  const db = await getDb();
  if (!db) return { httpStatus: 503, body: { ok: false, status: "db_unavailable" } };

  // Idempotency: unique (configId, eventId). A duplicate insert fails → mark duplicate.
  let eventDbId: number;
  try {
    const res = await db.insert(wcConnectorWebhookEvents).values({
      configId: cfg.id,
      organizationId: cfg.organizationId,
      eventId: String(eventId).slice(0, 191),
      eventType: eventType?.slice(0, 100) ?? null,
      entity,
      payload: data ?? null,
      signatureValid: true,
      status: "received",
    });
    eventDbId = Number((res as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate/i.test(msg)) {
      return { httpStatus: 200, body: { ok: true, status: "duplicate" } };
    }
    return { httpStatus: 503, body: { ok: false, status: "event_store_failed", error: msg } };
  }

  // ── LAPO multi-source realtime path ──
  // LAPO configs receive channel events, not CBS entities. Envelope:
  //   { source: "<lapoSourceKey>", events: [...] }  or a single event object
  //   carrying a "source" field. Same HMAC/idempotency/rate-limit rules as
  //   every other CBS webhook; ingestion routes through the LAPO ETL.
  if (getCbsProfile(cfg.cbsType).type === "lapo") {
    try {
      const env = data as Record<string, unknown>;
      const sourceKey = String(env.source ?? "");
      const events = Array.isArray(env.events)
        ? (env.events as Record<string, unknown>[])
        : [env as Record<string, unknown>];
      const { ingestLapoEvents } = await import("../lapo/etl");
      const result = await ingestLapoEvents(cfg.organizationId, sourceKey, events);
      await db
        .update(wcConnectorWebhookEvents)
        .set({ status: "processed", processedAt: new Date(), entity: `lapo:${sourceKey}`.slice(0, 50) })
        .where(eq(wcConnectorWebhookEvents.id, eventDbId));
      return {
        httpStatus: 200,
        body: { ok: true, status: result.failed > 0 ? "processed_with_failures" : "processed", eventDbId },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(wcConnectorWebhookEvents)
        .set({ status: "failed", error: msg.slice(0, 4000) })
        .where(eq(wcConnectorWebhookEvents.id, eventDbId));
      await enqueueDeadLetter({
        configId: cfg.id,
        organizationId: cfg.organizationId,
        source: "webhook",
        refType: "lapo_event",
        refId: String(eventId).slice(0, 191),
        payload: data,
        error: msg,
      });
      return { httpStatus: 202, body: { ok: true, status: "dead_lettered", eventDbId } };
    }
  }

  // Process inline (single event — fast path). Failures → DLQ, still 2xx.
  if (!entity) {
    await db
      .update(wcConnectorWebhookEvents)
      .set({ status: "quarantined", error: "could not infer entity from event type or payload shape" })
      .where(eq(wcConnectorWebhookEvents.id, eventDbId));
    return { httpStatus: 202, body: { ok: true, status: "quarantined", eventDbId } };
  }

  try {
    const overrides = await getActiveOverrideRules(cfg.id, entity);
    const profile = getCbsProfile(cfg.cbsType);
    const mapped = applyMapping(entity, data, overrides, profile.apiMappings[entity]);
    if (!mapped.ok || !mapped.value) {
      throw new Error(`mapping failed: ${mapped.errors.join("; ")}`);
    }
    const channelId = await ensureCbsChannel(cfg.organizationId, cfg.cbsType);
    const batchId = await createIngestBatch({
      organizationId: cfg.organizationId,
      channelId,
      label: `webhook:${eventType ?? entity}:${new Date().toISOString()}`,
    });
    const result = await ingestCanonicalTransactions([mapped.value], {
      organizationId: cfg.organizationId,
      channelId,
      batchId,
    });
    await finalizeIngestBatch(batchId, { total: 1, valid: result.inserted, invalid: 0 }, true);
    await db
      .update(wcConnectorWebhookEvents)
      .set({ status: "processed", processedAt: new Date() })
      .where(eq(wcConnectorWebhookEvents.id, eventDbId));
    return {
      httpStatus: 200,
      body: { ok: true, status: result.inserted > 0 ? "processed" : "already_ingested", eventDbId },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(wcConnectorWebhookEvents)
      .set({ status: "failed", error: msg.slice(0, 4000) })
      .where(eq(wcConnectorWebhookEvents.id, eventDbId));
    await enqueueDeadLetter({
      configId: cfg.id,
      organizationId: cfg.organizationId,
      source: "webhook",
      refType: entity,
      refId: String(eventId).slice(0, 191),
      payload: data,
      error: msg,
    });
    // 2xx: we own the retry now; WoodCore must not re-deliver forever.
    return { httpStatus: 202, body: { ok: true, status: "dead_lettered", eventDbId } };
  }
}

/** Load the active per-org mapping override rules for an entity (or null). */
export async function getActiveOverrideRules(
  configId: number,
  entity: WcEntity,
): Promise<MappingRule[] | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(wcConnectorFieldMappings)
    .where(
      and(
        eq(wcConnectorFieldMappings.configId, configId),
        eq(wcConnectorFieldMappings.entity, entity),
        eq(wcConnectorFieldMappings.isActive, true),
      ),
    )
    .orderBy(wcConnectorFieldMappings.version)
    .limit(50);
  const latest = rows[rows.length - 1];
  if (!latest) return null;
  const rules = latest.rulesJson as unknown;
  return Array.isArray(rules) ? (rules as MappingRule[]) : null;
}

/**
 * Retry handler for webhook dead letters (registered with the DLQ processor):
 * re-run mapping + ingestion from the stored payload.
 */
export async function retryWebhookDeadLetter(letter: {
  configId: number;
  organizationId: number;
  refType: string | null;
  payload: unknown;
}): Promise<void> {
  const entity = (letter.refType ?? "") as WcEntity;
  if (!["savings_transaction", "loan_transaction", "journal_entry"].includes(entity)) {
    throw new Error(`unknown entity "${letter.refType}" on dead letter`);
  }
  const cfg = await getConfigRow(letter.configId);
  const profile = getCbsProfile(cfg?.cbsType);
  const overrides = await getActiveOverrideRules(letter.configId, entity);
  const mapped = applyMapping(entity, letter.payload, overrides, profile.apiMappings[entity]);
  if (!mapped.ok || !mapped.value) {
    throw new Error(`mapping failed: ${mapped.errors.join("; ")}`);
  }
  const channelId = await ensureCbsChannel(letter.organizationId, profile.type);
  const batchId = await createIngestBatch({
    organizationId: letter.organizationId,
    channelId,
    label: `dlq-replay:${entity}:${new Date().toISOString()}`,
  });
  const result = await ingestCanonicalTransactions([mapped.value], {
    organizationId: letter.organizationId,
    channelId,
    batchId,
  });
  await finalizeIngestBatch(batchId, { total: 1, valid: result.inserted, invalid: 0 }, true);
}
