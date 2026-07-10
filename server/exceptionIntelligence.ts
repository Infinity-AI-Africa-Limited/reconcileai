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
  agentMemory,
  exceptions as exceptionsTable,
  transactions as transactionsTable,
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
  // Opt-in: created lazily, OFF by default (both directions).
  const pseudonym = contributorPseudonymFor(organizationId, ENV.cookieSecret || "reconcileai");
  await db.insert(exceptionIntelligenceSettings).values({
    organizationId,
    contributorPseudonym: pseudonym,
    shareEnabled: false,
    consumeEnabled: false,
  });
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
  // Reciprocity: contribution and consumption are coupled — a bank benefits from
  // the pool only if it also contributes, and vice versa. Whichever toggle the
  // caller set determines a single participation value applied to BOTH.
  const participate = patch.shareEnabled ?? patch.consumeEnabled;
  if (participate === undefined) return getSettings(organizationId);
  await db
    .update(exceptionIntelligenceSettings)
    .set({ shareEnabled: participate, consumeEnabled: participate })
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

// ─── Outcome capture + retraction (write-path audit, July 2026) ──────

/**
 * Capture a terminal exception outcome into BOTH learning tiers: the
 * org-scoped agentMemory record and the anonymised local signature. Added by
 * the write-path audit for the ESCALATION surfaces, which previously fed
 * nothing — even though "escalated" is one of the three outcomes the shared
 * pool is designed to carry. Mirrors the inline capture in exceptions.resolve.
 * Best-effort: never throws into the calling mutation.
 */
export async function captureExceptionOutcome(params: {
  organizationId: number;
  exceptionId: number;
  actorUserId: number;
  outcome: Outcome;
  resolutionText: string;
}): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const [row] = await db
      .select({
        category: exceptionsTable.category,
        description: exceptionsTable.description,
        amount: transactionsTable.amount,
        counterparty: transactionsTable.counterparty,
        transactionRef: transactionsTable.transactionRef,
      })
      .from(exceptionsTable)
      .innerJoin(transactionsTable, eq(exceptionsTable.transactionId, transactionsTable.id))
      .where(eq(exceptionsTable.id, params.exceptionId))
      .limit(1);
    if (!row) return;

    const amt = parseFloat(String(row.amount)) || 0;
    const cpType = counterpartyTypeOf(row.counterparty);
    const actionClass = classifyResolutionAction(params.resolutionText);

    await db.insert(agentMemory).values({
      organizationId: params.organizationId,
      exceptionId: params.exceptionId,
      exceptionCategory: row.category,
      transactionRef: row.transactionRef ?? null,
      amountRange: amountBucketOf(amt),
      counterpartyType: cpType,
      deductionType: null,
      resolution: params.resolutionText,
      outcome: params.outcome,
      reasoning: row.description || `Exception ${params.outcome} by operations team`,
      embeddingText: `category:${row.category} amount:${amountBucketOf(amt)} counterparty:${cpType} resolution:${actionClass} outcome:${params.outcome}`,
      resolvedBy: params.actorUserId,
    });

    const sig = deriveSignature({
      exceptionCategory: row.category,
      amount: amt,
      counterparty: row.counterparty,
      resolution: params.resolutionText,
      outcome: params.outcome,
    });
    await recordLocalSignature(params.organizationId, sig);
  } catch (err) {
    console.error("[ExceptionIntelligence] outcome capture failed (non-fatal):", err);
  }
}

/**
 * Retract the learning captured for an exception — called when a resolution
 * is REOPENED (e.g. the CBS staleness check proved the anomaly was never
 * fixed). Without this, failed resolutions keep training the flywheel and
 * inflating the shared pool's observation counts. Recomputes each memory
 * row's signature from its stored coarse features (all functions involved
 * are deterministic and idempotent over their outputs), decrements the local
 * observation count (row deleted at zero), then deletes the memory rows.
 * The cloud pool reflects the decrement on its next aggregation.
 */
export async function retractResolutionLearning(
  organizationId: number,
  exceptionId: number,
): Promise<{ retracted: number }> {
  const db = await getDb();
  if (!db) return { retracted: 0 };

  const rows = await db
    .select()
    .from(agentMemory)
    .where(and(eq(agentMemory.organizationId, organizationId), eq(agentMemory.exceptionId, exceptionId)));
  if (rows.length === 0) return { retracted: 0 };

  for (const row of rows) {
    try {
      // Rebuild the exact signature this row produced at capture time.
      const sig = deriveSignature({
        exceptionCategory: row.exceptionCategory,
        amount: 0, // placeholder — bucket is overridden from the stored range below
        counterpartyType: row.counterpartyType,
        deductionType: row.deductionType ?? null,
        resolution: row.resolution,
        outcome: (row.outcome as Outcome) ?? "resolved",
      });
      sig.amountBucket = row.amountRange as AmountBucket;
      sig.signatureHash = signatureHashOf(sig);

      const [existing] = await db
        .select({ id: exceptionPatternSignatures.id, count: exceptionPatternSignatures.observationCount })
        .from(exceptionPatternSignatures)
        .where(and(
          eq(exceptionPatternSignatures.organizationId, organizationId),
          eq(exceptionPatternSignatures.signatureHash, sig.signatureHash),
        ))
        .limit(1);
      if (existing) {
        if (existing.count <= 1) {
          await db.delete(exceptionPatternSignatures).where(eq(exceptionPatternSignatures.id, existing.id));
        } else {
          await db
            .update(exceptionPatternSignatures)
            .set({ observationCount: existing.count - 1 })
            .where(eq(exceptionPatternSignatures.id, existing.id));
        }
      }
    } catch (err) {
      console.error("[ExceptionIntelligence] signature retraction failed (non-fatal):", err);
    }
  }

  await db
    .delete(agentMemory)
    .where(and(eq(agentMemory.organizationId, organizationId), eq(agentMemory.exceptionId, exceptionId)));
  return { retracted: rows.length };
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
  // Reciprocity is enforced server-side: a bank only benefits from the pool if it
  // also contributes. Both flags are kept equal, but we require BOTH defensively
  // so no configuration can free-ride on the shared pool.
  if (!settings || settings.shareEnabled !== true || settings.consumeEnabled !== true) return [];

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

  // Consumption tracking for the network KPI ("recommendations informed by
  // cross-institution patterns %"). Best-effort — never fails the lookup.
  try {
    await db
      .update(exceptionIntelligenceSettings)
      .set({
        consumeRequests: sql`${exceptionIntelligenceSettings.consumeRequests} + 1`,
        ...(rows.length > 0
          ? { consumeHits: sql`${exceptionIntelligenceSettings.consumeHits} + 1`, lastConsumedAt: new Date() }
          : {}),
      })
      .where(eq(exceptionIntelligenceSettings.organizationId, organizationId));
  } catch { /* metric is best-effort */ }

  return rows;
}

// ─── Network-level stats (internal KPI — super admin) ────────────────

/** Per-category depth of the shared pool — shows where the network is strong vs thin. */
export interface NetworkCategoryCoverage {
  category: string;
  /** Patterns in this category that clear the k-anonymity gate (servable). */
  kAnonymousPatterns: number;
  /** Highest distinct-org count across this category's patterns. */
  maxContributors: number;
  /** Total observations across this category's k-anonymous patterns. */
  observations: number;
}

export interface NetworkStats {
  /** Orgs with at least one locally-recorded pattern signature. */
  contributingOrgs: number;
  /** Orgs that opted in to reciprocal sharing/consumption. */
  participatingOrgs: number;
  /** Distinct signatures and total observations recorded across all orgs. */
  totalLocalSignatures: number;
  totalLocalObservations: number;
  /** Shared pool size and how much of it clears the k-anonymity gate. */
  poolPatterns: number;
  kAnonymousPatterns: number;
  kAnonThreshold: number;
  /** Pool lookups attempted / lookups that returned k-anonymous patterns. */
  consumeRequests: number;
  consumeHits: number;
  /** % of recommendation lookups informed by cross-institution patterns (null = no lookups yet). */
  informedRate: number | null;
  /** Gap-closure plan WS-5: the network effect needs 5–7 active institutions. */
  networkEffectThreshold: number;
  /** Per-category coverage (k-anonymous only), strongest first. */
  categoryCoverage: NetworkCategoryCoverage[];
}

/**
 * Cross-tenant view of the intelligence network for the internal KPI dashboard
 * (gap-closure plan WS-5): proves flywheel compounding in sales conversations.
 * Aggregates only — no per-org data leaves this summary.
 */
export async function getNetworkStats(): Promise<NetworkStats> {
  const empty: NetworkStats = {
    contributingOrgs: 0,
    participatingOrgs: 0,
    totalLocalSignatures: 0,
    totalLocalObservations: 0,
    poolPatterns: 0,
    kAnonymousPatterns: 0,
    kAnonThreshold: K_ANON_THRESHOLD,
    consumeRequests: 0,
    consumeHits: 0,
    informedRate: null,
    networkEffectThreshold: 5,
    categoryCoverage: [],
  };
  const db = await getDb();
  if (!db) return empty;

  const [local] = await db
    .select({
      orgs: sql<number>`count(distinct ${exceptionPatternSignatures.organizationId})`,
      sigs: sql<number>`count(*)`,
      obs: sql<number>`coalesce(sum(${exceptionPatternSignatures.observationCount}), 0)`,
    })
    .from(exceptionPatternSignatures);

  const [participation] = await db
    .select({
      participating: sql<number>`coalesce(sum(case when ${exceptionIntelligenceSettings.shareEnabled} then 1 else 0 end), 0)`,
      requests: sql<number>`coalesce(sum(${exceptionIntelligenceSettings.consumeRequests}), 0)`,
      hits: sql<number>`coalesce(sum(${exceptionIntelligenceSettings.consumeHits}), 0)`,
    })
    .from(exceptionIntelligenceSettings);

  const [pool] = await db
    .select({
      total: sql<number>`count(*)`,
      kAnon: sql<number>`coalesce(sum(case when ${sharedExceptionPatterns.contributorCount} >= ${K_ANON_THRESHOLD} then 1 else 0 end), 0)`,
    })
    .from(sharedExceptionPatterns);

  // Per-category coverage — k-anonymous patterns only, so this summary can be
  // shown without leaking below-threshold (single-institution) patterns.
  const coverageRows = await db
    .select({
      category: sharedExceptionPatterns.exceptionCategory,
      kAnonymousPatterns: sql<number>`count(*)`,
      maxContributors: sql<number>`max(${sharedExceptionPatterns.contributorCount})`,
      observations: sql<number>`coalesce(sum(${sharedExceptionPatterns.observationCount}), 0)`,
    })
    .from(sharedExceptionPatterns)
    .where(sql`${sharedExceptionPatterns.contributorCount} >= ${K_ANON_THRESHOLD}`)
    .groupBy(sharedExceptionPatterns.exceptionCategory)
    .orderBy(desc(sql`count(*)`));

  const requests = Number(participation?.requests || 0);
  const hits = Number(participation?.hits || 0);
  return {
    contributingOrgs: Number(local?.orgs || 0),
    participatingOrgs: Number(participation?.participating || 0),
    totalLocalSignatures: Number(local?.sigs || 0),
    totalLocalObservations: Number(local?.obs || 0),
    poolPatterns: Number(pool?.total || 0),
    kAnonymousPatterns: Number(pool?.kAnon || 0),
    kAnonThreshold: K_ANON_THRESHOLD,
    consumeRequests: requests,
    consumeHits: hits,
    informedRate: requests > 0 ? Math.round((hits / requests) * 10000) / 100 : null,
    networkEffectThreshold: 5,
    categoryCoverage: coverageRows.map((r) => ({
      category: r.category,
      kAnonymousPatterns: Number(r.kAnonymousPatterns || 0),
      maxContributors: Number(r.maxContributors || 0),
      observations: Number(r.observations || 0),
    })),
  };
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
