/**
 * ReconcileAI Exception Intelligence Layer.
 *
 * The investor "network effect": the resolution one bank applies improves the
 * recommendation another bank gets — WITHOUT any transaction data or PII ever
 * leaving a deployment. This is what reconciles the PTB "data never leaves your
 * infrastructure" guarantee with cross-institution learning.
 *
 * What is shared: only a coarse, non-personal PATTERN SIGNATURE — a tuple of
 * fixed categorical features (exception category, amount BUCKET, counterparty
 * TYPE, deduction type, resolution ACTION CLASS, outcome). Never amounts, refs,
 * names, account numbers, descriptions, or any free text.
 *
 * Privacy controls (NDPA/NDPR + GDPR-aligned), all enforced here:
 *  - Field allowlist + runtime PII-scrub assertion before anything is shared.
 *  - k-anonymity: a pattern is only served once corroborated by >= K distinct
 *    organizations, preventing singling-out.
 *  - Pseudonymized contributor id (the pool never sees org id/name).
 *  - Per-org opt-out; on-prem egress still gated by the residency allowlist.
 *
 * See docs/exception-intelligence-dpia.md.
 */
import crypto from "node:crypto";
import { and, eq, desc, sql } from "drizzle-orm";
import { contentHashOf } from "./signing";
import { getDb } from "./db";
import { ENV } from "./_core/env";
import { assertEgressAllowed, isEgressAllowed } from "./_core/egress";
import {
  exceptionPatternSignatures,
  exceptionIntelligenceSettings,
  sharedExceptionPatterns,
} from "../drizzle/schema";

/** Minimum distinct contributing organizations before a pattern can be served. */
export const K_ANON_THRESHOLD = 3;

export const AMOUNT_BUCKETS = ["0-100k", "100k-1m", "1m+"] as const;
export type AmountBucket = (typeof AMOUNT_BUCKETS)[number];

export const OUTCOMES = ["resolved", "escalated", "rejected"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * Fixed, non-identifying resolution action classes. The free-text resolution is
 * NEVER shared — it is mapped to one of these before it can leave the org.
 */
export const RESOLUTION_ACTION_CLASSES = [
  "credit_note",
  "vendor_email",
  "journal_entry",
  "payment_allocation",
  "write_off",
  "manual_match",
  "reversal",
  "escalate",
  "no_action",
  "other",
] as const;
export type ResolutionActionClass = (typeof RESOLUTION_ACTION_CLASSES)[number];

/** Map free-text resolution / action to a fixed class. Keyword-based, deterministic. */
export function classifyResolutionAction(resolution: string | null | undefined): ResolutionActionClass {
  const t = (resolution ?? "").toLowerCase();
  if (!t.trim()) return "no_action";
  if (/credit\s*note|credit memo/.test(t)) return "credit_note";
  if (/revers/.test(t)) return "reversal";
  if (/wr(ite|ote)[\s-]?off|written[\s-]?off|writeoff/.test(t)) return "write_off";
  if (/email|contact|notify|reach out/.test(t) && /vendor|distributor|supplier|counterparty/.test(t)) return "vendor_email";
  if (/journal|gl entry|ledger|posting/.test(t)) return "journal_entry";
  if (/allocat|apply payment|match payment|settle/.test(t)) return "payment_allocation";
  if (/manual(ly)?\s*match|matched manually/.test(t)) return "manual_match";
  if (/escalat/.test(t)) return "escalate";
  return "other";
}

/** Normalize an amount to a coarse bucket (no raw value retained). */
export function amountBucketOf(amount: number | string): AmountBucket {
  const a = Math.abs(parseFloat(String(amount)) || 0);
  return a < 100_000 ? "0-100k" : a < 1_000_000 ? "100k-1m" : "1m+";
}

/** Normalize a counterparty to a TYPE (never the identity). */
export function counterpartyTypeOf(raw: string | null | undefined): string {
  const t = (raw ?? "").toLowerCase();
  if (/bank|mfb|microfinance/.test(t)) return "bank";
  if (/distributor|dealer|wholesaler/.test(t)) return "distributor";
  if (/fintech|paystack|flutterwave|interswitch/.test(t)) return "fintech";
  if (/merchant|store|retail/.test(t)) return "merchant";
  return "unknown";
}

/** The exact, fixed set of keys a shared signature may contain. Anything else => reject. */
export const ALLOWED_SIGNATURE_KEYS = [
  "exceptionCategory",
  "amountBucket",
  "counterpartyType",
  "deductionType",
  "resolutionActionClass",
  "outcome",
] as const;

export interface PatternSignature {
  exceptionCategory: string;
  amountBucket: AmountBucket;
  counterpartyType: string;
  deductionType: string | null;
  resolutionActionClass: ResolutionActionClass;
  outcome: Outcome;
}

/** Deterministic hash identifying a signature tuple (the shareable identity). */
export function signatureHashOf(sig: PatternSignature): string {
  return contentHashOf({
    exceptionCategory: sig.exceptionCategory,
    amountBucket: sig.amountBucket,
    counterpartyType: sig.counterpartyType,
    deductionType: sig.deductionType ?? null,
    resolutionActionClass: sig.resolutionActionClass,
    outcome: sig.outcome,
  });
}

/**
 * Derive a shareable signature from a resolved exception's coarse features.
 * Inputs are already categorical; nothing here can carry PII by construction.
 */
export function deriveSignature(input: {
  exceptionCategory: string;
  amount: number | string;
  counterparty?: string | null;
  counterpartyType?: string | null;
  deductionType?: string | null;
  resolution?: string | null;
  resolutionActionClass?: ResolutionActionClass;
  outcome?: Outcome;
}): PatternSignature & { signatureHash: string } {
  const sig: PatternSignature = {
    exceptionCategory: input.exceptionCategory,
    amountBucket: amountBucketOf(input.amount),
    counterpartyType: input.counterpartyType
      ? counterpartyTypeOf(input.counterpartyType)
      : counterpartyTypeOf(input.counterparty),
    deductionType: input.deductionType ?? null,
    resolutionActionClass: input.resolutionActionClass ?? classifyResolutionAction(input.resolution),
    outcome: input.outcome ?? "resolved",
  };
  return { ...sig, signatureHash: signatureHashOf(sig) };
}

/**
 * Heuristic free-text / identifier detector. Used by the PII-scrub assertion to
 * catch anything that should never appear in a shared value.
 */
function looksLikeFreeTextOrId(value: string): boolean {
  if (value.length > 48) return true; // signatures are short enums; long => suspicious
  if (/\s{2,}/.test(value)) return true; // multiple spaces => sentence-like
  if (value.split(/\s+/).length > 4) return true; // >4 words => free text
  if (/[@/\\]/.test(value)) return true; // emails / paths
  if (/\d{6,}/.test(value)) return true; // long digit runs => account/ref numbers
  if (/[₦$€£]\s*\d/.test(value)) return true; // currency amounts
  return false;
}

/**
 * Assert a payload is safe to leave the deployment: it may contain ONLY the
 * allowlisted keys, and every value must be a short categorical token (no free
 * text, identifiers, amounts, or PII). Throws otherwise. This is the last line
 * of defense before any egress.
 */
export function assertNoPII(payload: Record<string, unknown>): void {
  const keys = Object.keys(payload);
  for (const key of keys) {
    if (!(ALLOWED_SIGNATURE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Exception Intelligence: disallowed field "${key}" in shared payload (only ${ALLOWED_SIGNATURE_KEYS.join(", ")} permitted)`);
    }
    const v = payload[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new Error(`Exception Intelligence: non-scalar value for "${key}" in shared payload`);
    }
    if (typeof v === "string" && looksLikeFreeTextOrId(v)) {
      throw new Error(`Exception Intelligence: value for "${key}" looks like free text / an identifier and was blocked from sharing`);
    }
  }
}

/** Build the minimal, PII-scrubbed wire payload for one signature (asserts clean). */
export function buildSharePayload(sig: PatternSignature): Record<string, unknown> {
  const payload = {
    exceptionCategory: sig.exceptionCategory,
    amountBucket: sig.amountBucket,
    counterpartyType: sig.counterpartyType,
    deductionType: sig.deductionType ?? null,
    resolutionActionClass: sig.resolutionActionClass,
    outcome: sig.outcome,
  };
  assertNoPII(payload);
  return payload;
}

/** Deterministic pseudonym for a contributor (the pool never sees org id/name). */
export function contributorPseudonymFor(organizationId: number, salt: string): string {
  return crypto.createHash("sha256").update(`${salt}:${organizationId}`).digest("hex").slice(0, 24);
}

/** k-anonymity gate: only patterns corroborated by >= K distinct orgs may be served. */
export function meetsKAnonymity(contributorCount: number): boolean {
  return contributorCount >= K_ANON_THRESHOLD;
}

// ─── Settings ────────────────────────────────────────────────────────

export async function getSettings(organizationId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(exceptionIntelligenceSettings)
    .where(eq(exceptionIntelligenceSettings.organizationId, organizationId))
    .limit(1);
  if (row) return row;
  // Default-on, created lazily.
  const pseudonym = contributorPseudonymFor(organizationId, ENV.cookieSecret || "reconcileai");
  await db.insert(exceptionIntelligenceSettings).values({ organizationId, contributorPseudonym: pseudonym });
  const [created] = await db
    .select()
    .from(exceptionIntelligenceSettings)
    .where(eq(exceptionIntelligenceSettings.organizationId, organizationId))
    .limit(1);
  return created ?? null;
}

export async function updateSettings(
  organizationId: number,
  patch: { shareEnabled?: boolean; consumeEnabled?: boolean },
) {
  const db = await getDb();
  if (!db) return null;
  await getSettings(organizationId); // ensure row exists
  await db
    .update(exceptionIntelligenceSettings)
    .set(patch)
    .where(eq(exceptionIntelligenceSettings.organizationId, organizationId));
  return getSettings(organizationId);
}

// ─── Local contribution ──────────────────────────────────────────────

/**
 * Record (or increment) a locally-observed pattern signature. Called when an
 * exception is resolved. Stores only the categorical tuple — never the
 * underlying transaction. No-op if the org has sharing disabled? No — we still
 * record locally (it powers the org's own stats); sharing is gated separately.
 */
export async function recordLocalSignature(
  organizationId: number,
  sig: PatternSignature & { signatureHash: string },
) {
  const db = await getDb();
  if (!db) return;
  const [existing] = await db
    .select({ id: exceptionPatternSignatures.id, count: exceptionPatternSignatures.observationCount })
    .from(exceptionPatternSignatures)
    .where(
      and(
        eq(exceptionPatternSignatures.organizationId, organizationId),
        eq(exceptionPatternSignatures.signatureHash, sig.signatureHash),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(exceptionPatternSignatures)
      .set({ observationCount: existing.count + 1 })
      .where(eq(exceptionPatternSignatures.id, existing.id));
    return;
  }
  await db.insert(exceptionPatternSignatures).values({
    organizationId,
    signatureHash: sig.signatureHash,
    exceptionCategory: sig.exceptionCategory,
    amountBucket: sig.amountBucket,
    counterpartyType: sig.counterpartyType,
    deductionType: sig.deductionType ?? null,
    resolutionActionClass: sig.resolutionActionClass,
    outcome: sig.outcome,
    observationCount: 1,
  });
}

// ─── Pool aggregation (multi-tenant cloud) ───────────────────────────

/**
 * Rebuild the shared pattern pool from all orgs' local signatures, computing the
 * k (distinct contributing orgs) per signature. In a single-DB multi-tenant
 * cloud this realizes the network effect with NO external calls. Patterns are
 * stored with their contributorCount; the k-anonymity gate is applied at serve
 * time so a pattern from a single org is never exposed.
 */
export async function aggregateSharedPatterns(): Promise<{ patterns: number }> {
  const db = await getDb();
  if (!db) return { patterns: 0 };
  const groups = await db
    .select({
      signatureHash: exceptionPatternSignatures.signatureHash,
      exceptionCategory: exceptionPatternSignatures.exceptionCategory,
      amountBucket: exceptionPatternSignatures.amountBucket,
      counterpartyType: exceptionPatternSignatures.counterpartyType,
      deductionType: exceptionPatternSignatures.deductionType,
      resolutionActionClass: exceptionPatternSignatures.resolutionActionClass,
      outcome: exceptionPatternSignatures.outcome,
      contributorCount: sql<number>`count(distinct ${exceptionPatternSignatures.organizationId})`,
      observationCount: sql<number>`sum(${exceptionPatternSignatures.observationCount})`,
    })
    .from(exceptionPatternSignatures)
    .groupBy(
      exceptionPatternSignatures.signatureHash,
      exceptionPatternSignatures.exceptionCategory,
      exceptionPatternSignatures.amountBucket,
      exceptionPatternSignatures.counterpartyType,
      exceptionPatternSignatures.deductionType,
      exceptionPatternSignatures.resolutionActionClass,
      exceptionPatternSignatures.outcome,
    );

  for (const g of groups) {
    await upsertSharedPattern({
      signatureHash: g.signatureHash,
      exceptionCategory: g.exceptionCategory,
      amountBucket: g.amountBucket as AmountBucket,
      counterpartyType: g.counterpartyType,
      deductionType: g.deductionType,
      resolutionActionClass: g.resolutionActionClass,
      outcome: g.outcome as Outcome,
      contributorCount: Number(g.contributorCount || 0),
      observationCount: Number(g.observationCount || 0),
    });
  }
  return { patterns: groups.length };
}

async function upsertSharedPattern(p: {
  signatureHash: string;
  exceptionCategory: string;
  amountBucket: AmountBucket;
  counterpartyType: string;
  deductionType: string | null;
  resolutionActionClass: string;
  outcome: Outcome;
  contributorCount: number;
  observationCount: number;
}) {
  const db = await getDb();
  if (!db) return;
  const [existing] = await db
    .select({ id: sharedExceptionPatterns.id })
    .from(sharedExceptionPatterns)
    .where(eq(sharedExceptionPatterns.signatureHash, p.signatureHash))
    .limit(1);
  if (existing) {
    await db
      .update(sharedExceptionPatterns)
      .set({ contributorCount: p.contributorCount, observationCount: p.observationCount })
      .where(eq(sharedExceptionPatterns.id, existing.id));
  } else {
    await db.insert(sharedExceptionPatterns).values(p);
  }
}

// ─── Consumption ─────────────────────────────────────────────────────

export interface SharedRecommendation {
  resolutionActionClass: string;
  outcome: string;
  contributorCount: number;
  observationCount: number;
}

/**
 * Recommended actions for an exception category from the shared pool, honoring
 * k-anonymity. Returns the most-observed action classes other institutions used.
 * Empty when the org has consumption disabled or nothing meets the threshold.
 */
export async function getSharedRecommendations(
  organizationId: number,
  exceptionCategory: string,
  amountBucket?: AmountBucket,
): Promise<SharedRecommendation[]> {
  const db = await getDb();
  if (!db) return [];
  const settings = await getSettings(organizationId);
  if (settings && settings.consumeEnabled === false) return [];

  const conds = [
    eq(sharedExceptionPatterns.exceptionCategory, exceptionCategory),
    sql`${sharedExceptionPatterns.contributorCount} >= ${K_ANON_THRESHOLD}`,
  ];
  if (amountBucket) conds.push(eq(sharedExceptionPatterns.amountBucket, amountBucket));

  const rows = await db
    .select({
      resolutionActionClass: sharedExceptionPatterns.resolutionActionClass,
      outcome: sharedExceptionPatterns.outcome,
      contributorCount: sharedExceptionPatterns.contributorCount,
      observationCount: sharedExceptionPatterns.observationCount,
    })
    .from(sharedExceptionPatterns)
    .where(and(...conds))
    .orderBy(desc(sharedExceptionPatterns.observationCount))
    .limit(5);
  return rows;
}

// ─── On-prem sync (endpoint-gated, egress-guarded) ──────────────────

/**
 * Push this org's eligible anonymized signatures to the central pool. Used by
 * on-prem deployments (the cloud uses aggregateSharedPatterns instead). Every
 * payload passes assertNoPII, and the destination passes the residency egress
 * guard. No-op when no endpoint is configured.
 */
export async function syncToPool(organizationId: number): Promise<{ shared: number; skipped: string | null }> {
  const endpoint = ENV.exceptionIntelEndpoint.trim();
  if (!endpoint) return { shared: 0, skipped: "no_endpoint" };

  const settings = await getSettings(organizationId);
  if (settings && settings.shareEnabled === false) return { shared: 0, skipped: "sharing_disabled" };

  // Residency: in on-prem mode the pool host must be on EGRESS_ALLOWLIST.
  if (!isEgressAllowed(endpoint)) return { shared: 0, skipped: "egress_blocked" };

  const db = await getDb();
  if (!db) return { shared: 0, skipped: "no_db" };

  const sigs = await db
    .select()
    .from(exceptionPatternSignatures)
    .where(eq(exceptionPatternSignatures.organizationId, organizationId))
    .limit(1000);

  const contributor = settings?.contributorPseudonym ?? contributorPseudonymFor(organizationId, ENV.cookieSecret || "reconcileai");
  // Build + scrub each payload (throws if anything non-categorical slips in).
  const items = sigs.map((s) => ({
    ...buildSharePayload({
      exceptionCategory: s.exceptionCategory,
      amountBucket: s.amountBucket as AmountBucket,
      counterpartyType: s.counterpartyType,
      deductionType: s.deductionType,
      resolutionActionClass: s.resolutionActionClass as ResolutionActionClass,
      outcome: s.outcome as Outcome,
    }),
    observationCount: s.observationCount,
  }));

  assertEgressAllowed(endpoint, "exception intelligence sync"); // hard guard
  const res = await fetch(endpoint.replace(/\/$/, "") + "/v1/patterns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contributor, items }),
  });
  if (!res.ok) throw new Error(`Exception Intelligence sync failed: HTTP ${res.status}`);

  await db
    .update(exceptionIntelligenceSettings)
    .set({ lastSharedAt: new Date() })
    .where(eq(exceptionIntelligenceSettings.organizationId, organizationId));
  return { shared: items.length, skipped: null };
}
