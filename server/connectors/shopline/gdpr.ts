/**
 * SHOPLINE GDPR / Mandatory Compliance Handlers
 *
 * SHOPLINE requires every public app to handle mandatory data-protection
 * webhooks; an app that does not respond correctly is refused activation
 * (spec §A7 + the GDPR webhook doc). The three subjects are:
 *
 *   customers/data_request  — a customer asks what data we hold (access).
 *   customers/redact        — delete a customer's personal data.
 *   shop/redact (a.k.a.     — delete a shop's data (fires 48h after uninstall).
 *   merchants/redact)
 *
 * Contract: verify the HMAC signature, respond 200 within 5 seconds, and
 * complete the underlying action within 30 days (ours are immediate). Every
 * request is recorded in `sl_connector_gdpr_requests` for an auditable trail.
 *
 * Where customer PII actually lives in our system: normalized `transactions`
 * store only amounts/refs/dates (no PII). The raw SHOPLINE order payloads —
 * which DO contain customer name/email/address — are retained in
 * `sl_connector_webhook_events.payloadJson`. So customer redaction scrubs the
 * customer object out of those stored payloads for the affected store.
 */
import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  slConnectorStores,
  slConnectorWebhookEvents,
  slConnectorGdprRequests,
} from "../../../drizzle/connector_schema";
import { ENV } from "../../_core/env";
import { verifyWebhookHmac } from "./signature";
import { handleShoplineUninstall } from "./onboarding";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Canonical GDPR topics, tolerant of SHOPLINE's naming variants. */
export type GdprKind = "customer_data_request" | "customer_redact" | "shop_redact";

export function classifyGdprTopic(topic: string | undefined): GdprKind | null {
  const t = (topic ?? "").toLowerCase();
  if (t.includes("data_request") || t.includes("data-request")) return "customer_data_request";
  if (t.includes("customer") && t.includes("redact")) return "customer_redact";
  if ((t.includes("shop") || t.includes("merchant")) && t.includes("redact")) return "shop_redact";
  return null;
}

export interface GdprRequestInput {
  /** Raw request body (for HMAC verification). */
  rawBody: Buffer;
  /** X-Shopline-Hmac-Sha256 header. */
  hmacHeader: string;
  /** X-Shopline-Topic header (may be absent; falls back to `kind` param). */
  topic?: string;
  /** Parsed JSON body. */
  payload: GdprPayload;
  /**
   * The canonical kind implied by the endpoint that received it (the portal
   * registers a distinct URL per subject). Used when the topic header is
   * missing; the header wins when present and classifiable.
   */
  endpointKind: GdprKind;
}

interface GdprPayload {
  shop_domain?: string;
  shop_id?: string | number;
  customer?: { id?: string | number; email?: string };
  data_request?: { id?: string | number };
  orders_to_redact?: Array<string | number>;
}

export type GdprResult =
  | { status: "completed"; kind: GdprKind; recordsAffected: number }
  | { status: "unresolved_store"; kind: GdprKind }
  | { status: "invalid_signature" };

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Verify the SHOPLINE signature on a GDPR request. Verification is MANDATORY —
 * unlike an earlier revision that skipped it when the header was absent, which
 * let an unsigned POST trigger a shop uninstall. No header ⇒ rejected.
 */
export function verifyGdprSignature(rawBody: Buffer, hmacHeader: string): boolean {
  if (!hmacHeader) return false;
  return verifyWebhookHmac(rawBody, hmacHeader, ENV.shoplineAppSecret);
}

/** Resolve the store (and its org) for a GDPR request from the shop domain. */
async function resolveStore(db: Db, shopDomain: string | undefined) {
  if (!shopDomain) return null;
  const handle = shopDomain.replace(/\.myshopline\.com$/i, "");
  const [store] = await db
    .select({ id: slConnectorStores.id, organizationId: slConnectorStores.organizationId })
    .from(slConnectorStores)
    .where(eq(slConnectorStores.storeHandle, handle))
    .limit(1);
  return store ?? null;
}

/**
 * Scrub the `customer` object (and any customer PII) out of the stored raw
 * webhook payloads for a store, optionally narrowed to one customer id.
 * Returns the number of stored events scrubbed.
 */
async function scrubCustomerFromWebhookPayloads(
  db: Db,
  slStoreId: number,
  customerId?: string,
): Promise<number> {
  const events = await db
    .select({ id: slConnectorWebhookEvents.id, payloadJson: slConnectorWebhookEvents.payloadJson })
    .from(slConnectorWebhookEvents)
    .where(eq(slConnectorWebhookEvents.slStoreId, slStoreId));

  let scrubbed = 0;
  for (const ev of events) {
    const payload = ev.payloadJson as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") continue;
    const cust = payload["customer"] as { id?: unknown } | undefined;
    if (!cust) continue;
    // If a specific customer was named, only scrub matching rows.
    if (customerId && String(cust.id ?? "") !== customerId) continue;

    const redacted = {
      ...payload,
      customer: { id: cust.id ?? null, redacted: true },
    };
    // Also drop common PII-bearing top-level fields if present.
    for (const k of ["email", "billing_address", "shipping_address", "customer_locale", "phone"]) {
      if (k in redacted) (redacted as Record<string, unknown>)[k] = null;
    }
    await db
      .update(slConnectorWebhookEvents)
      .set({ payloadJson: redacted })
      .where(eq(slConnectorWebhookEvents.id, ev.id));
    scrubbed++;
  }
  return scrubbed;
}

async function recordRequest(
  db: Db,
  fields: {
    organizationId: number | null;
    slStoreId: number | null;
    topic: string;
    shopDomain: string | null;
    subjectHash: string | null;
    status: "completed" | "unresolved_store" | "failed";
    recordsAffected: number;
    note: string;
  },
): Promise<void> {
  try {
    await db.insert(slConnectorGdprRequests).values({
      organizationId: fields.organizationId,
      slStoreId: fields.slStoreId,
      topic: fields.topic,
      shopDomain: fields.shopDomain,
      subjectHash: fields.subjectHash,
      status: fields.status,
      recordsAffected: fields.recordsAffected,
      note: fields.note,
      completedAt: fields.status === "completed" ? new Date() : null,
    });
  } catch (err) {
    // Audit insert must never break the 200 ack.
    console.error("[shopline-gdpr] audit record failed (non-fatal):", err);
  }
}

/**
 * Process a verified GDPR request. The caller has ALREADY verified the
 * signature and must return 200 regardless of the outcome here (SHOPLINE only
 * cares that we acked and will complete within 30 days).
 */
export async function processGdprRequest(input: GdprRequestInput): Promise<GdprResult> {
  const db = await getDb();
  if (!db) return { status: "unresolved_store", kind: input.endpointKind };

  const kind = classifyGdprTopic(input.topic) ?? input.endpointKind;
  const shopDomain = input.payload.shop_domain ?? null;
  const store = await resolveStore(db, shopDomain ?? undefined);
  const orgId = store?.organizationId ?? null;
  const slStoreId = store?.id ?? null;
  const topicStr = input.topic || kind;

  // Shop deletion — uninstall + retention countdown (same as merchants/redact).
  if (kind === "shop_redact") {
    const subjectHash = shopDomain ? sha256(shopDomain) : null;
    if (shopDomain) await handleShoplineUninstall(shopDomain.replace(/\.myshopline\.com$/i, ""));
    await recordRequest(db, {
      organizationId: orgId,
      slStoreId,
      topic: topicStr,
      shopDomain,
      subjectHash,
      status: store ? "completed" : "unresolved_store",
      recordsAffected: 0,
      note: store
        ? "Store marked uninstalled; data scheduled for purge within retention window."
        : "Shop not found (already offboarded).",
    });
    return store
      ? { status: "completed", kind, recordsAffected: 0 }
      : { status: "unresolved_store", kind };
  }

  // Customer requests — resolve customer id (if any), hash it for the audit row.
  const customerId = input.payload.customer?.id != null ? String(input.payload.customer.id) : undefined;
  const subjectHash = customerId ? sha256(customerId) : shopDomain ? sha256(shopDomain) : null;

  if (!store) {
    await recordRequest(db, {
      organizationId: null,
      slStoreId: null,
      topic: topicStr,
      shopDomain,
      subjectHash,
      status: "unresolved_store",
      recordsAffected: 0,
      note: "No matching installed store for this shop domain.",
    });
    return { status: "unresolved_store", kind };
  }

  if (kind === "customer_redact") {
    const scrubbed = await scrubCustomerFromWebhookPayloads(db, store.id, customerId);
    await recordRequest(db, {
      organizationId: orgId,
      slStoreId,
      topic: topicStr,
      shopDomain,
      subjectHash,
      status: "completed",
      recordsAffected: scrubbed,
      note: `Redacted customer PII from ${scrubbed} stored webhook payload(s).`,
    });
    return { status: "completed", kind, recordsAffected: scrubbed };
  }

  // customer_data_request (access): ReconcileAI holds no standalone customer
  // profile — only order-linked webhook payloads. Record the request and the
  // fact that no separate profile store exists; the merchant fulfils the access
  // request from SHOPLINE's own order record.
  await recordRequest(db, {
    organizationId: orgId,
    slStoreId,
    topic: topicStr,
    shopDomain,
    subjectHash,
    status: "completed",
    recordsAffected: 0,
    note: "Access request acknowledged. No standalone customer profile is stored; only order-linked settlement records exist, keyed by SHOPLINE order id.",
  });
  return { status: "completed", kind, recordsAffected: 0 };
}

/** Open (received but not completed) GDPR requests for an org — compliance view. */
export async function getOpenGdprRequests(organizationId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(slConnectorGdprRequests)
    .where(
      and(
        eq(slConnectorGdprRequests.organizationId, organizationId),
        sql`${slConnectorGdprRequests.status} = 'received'`,
      ),
    );
}
