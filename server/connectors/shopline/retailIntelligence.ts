/**
 * SHOPLINE Retail Exception Intelligence — the two learning layers, applied to
 * the retail_commerce vertical.
 *
 * This does NOT fork the platform's exception intelligence engine
 * (`server/exceptionIntelligence.ts`). It feeds retail exceptions through that
 * same engine using their PRECISE `retail_*` category (carried on
 * `exceptions.subCategory`), and exposes two read surfaces for a retail
 * exception category:
 *
 *   1. INTRA-organizational layer — this merchant's OWN past resolutions for
 *      the same retail category (from `agentMemory`, org-scoped). "How did I
 *      resolve this last time?" Private to the org; never leaves it.
 *
 *   2. CROSS-organizational layer — the anonymised, k-anonymous pattern pool
 *      across all consenting merchants (from `sharedExceptionPatterns`). "What
 *      action worked for other merchants with this exact exception?" Only
 *      coarse categorical tuples, gated by reciprocal opt-in + k-anonymity, PII
 *      scrubbed by construction (see exceptionIntelligence.ts).
 *
 * Both are surfaced to the retail Super Agent (by segment) and via a tRPC query
 * for the merchant's exception-detail / settlement-monitor views.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { agentMemory } from "../../../drizzle/schema";
import {
  amountBucketOf,
  classifyResolutionAction,
  getSharedRecommendations,
  type AmountBucket,
  type SharedRecommendation,
} from "../../exceptionIntelligence";
import { retailExceptionFor, RETAIL_COMMERCE_EXCEPTIONS } from "../../exceptions/retail-commerce";

/**
 * Map a precise `retail_*` category to the coarse core `exceptions.category`
 * enum used for list filters and reports. Single source of truth, shared by the
 * sync orchestrator (persist) and anything that needs the coarse bucket.
 */
export function mapRetailToCoreCategory(
  retailCategory: string,
):
  | "reversal_unmatched"
  | "duplicate_transaction"
  | "amount_mismatch"
  | "timing_difference"
  | "fx_rate_variance"
  | "unmatched" {
  const c = retailCategory.toLowerCase();
  // Order matters: more specific signals first.
  if (c.includes("duplicate")) return "duplicate_transaction";
  if (c.includes("fx") || c.includes("currency") || c.includes("conversion")) return "fx_rate_variance";
  if (c.includes("chargeback") || c.includes("refund") || c.includes("void") || c.includes("dispute") || c.includes("reversal"))
    return "reversal_unmatched";
  if (c.includes("fee") || c.includes("commission") || c.includes("interchange") || c.includes("shortfall") || c.includes("mismatch") || c.includes("variance") || c.includes("tax"))
    return "amount_mismatch";
  if (c.includes("settlement") || c.includes("payout") || c.includes("delay") || c.includes("reserve") || c.includes("batch") || c.includes("remittance"))
    return "timing_difference";
  return "unmatched";
}

/**
 * Retail exception categories whose key or label tokens appear in free text.
 * Used to attach live intelligence to a Super Agent question. Deterministic,
 * keyword-based (no LLM), scored by how many distinctive tokens overlap.
 */
export function relevantRetailCategoriesForText(text: string, max = 2): string[] {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return [];
  const scored: Array<{ key: string; score: number }> = [];
  for (const ex of RETAIL_COMMERCE_EXCEPTIONS) {
    // Distinctive tokens: the category words minus the ubiquitous "retail" prefix.
    const tokens = new Set(
      `${ex.key.replace(/^retail_/, "").replace(/_/g, " ")} ${ex.label}`
        .toLowerCase()
        .split(/[\s/]+/)
        .filter((w) => w.length > 3 && !["retail", "with", "from", "that", "this"].includes(w)),
    );
    let score = 0;
    for (const tok of Array.from(tokens)) if (t.includes(tok)) score++;
    if (score > 0) scored.push({ key: ex.key, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.key);
}

// ─── Intra-organizational layer (this merchant's own resolution history) ─────

export interface OwnResolution {
  resolution: string;
  outcome: string;
  reasoning: string;
  resolutionActionClass: string;
  amountRange: string;
  resolvedAt: Date | null;
}

/**
 * This merchant's own past resolutions for a retail exception category. Ranked
 * most-recent-first (agentMemory is append-on-resolution). Optionally weighted
 * toward the same amount bucket. Org-scoped — never crosses tenants.
 */
export async function getOwnResolutionHistory(
  organizationId: number,
  retailCategory: string,
  opts: { amountBucket?: AmountBucket; limit?: number } = {},
): Promise<OwnResolution[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      resolution: agentMemory.resolution,
      outcome: agentMemory.outcome,
      reasoning: agentMemory.reasoning,
      amountRange: agentMemory.amountRange,
      createdAt: agentMemory.createdAt,
    })
    .from(agentMemory)
    .where(
      and(
        eq(agentMemory.organizationId, organizationId),
        eq(agentMemory.exceptionCategory, retailCategory),
      ),
    )
    .orderBy(desc(agentMemory.createdAt))
    .limit(60);

  // Prefer same amount bucket, then recency; keep it deterministic.
  const ranked = rows
    .map((r) => ({
      ...r,
      bucketMatch: opts.amountBucket ? (r.amountRange === opts.amountBucket ? 1 : 0) : 0,
    }))
    .sort((a, b) => b.bucketMatch - a.bucketMatch || (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
    .slice(0, opts.limit ?? 5);

  return ranked.map((r) => ({
    resolution: r.resolution,
    outcome: r.outcome,
    reasoning: r.reasoning,
    resolutionActionClass: classifyResolutionAction(r.resolution),
    amountRange: r.amountRange,
    resolvedAt: r.createdAt ?? null,
  }));
}

// ─── Combined surface (both layers) ──────────────────────────────────────────

export interface RetailExceptionIntelligence {
  category: string;
  categoryLabel: string | null;
  amountBucket: AmountBucket;
  /** Layer 1 — this merchant's own resolution history (private). */
  ownHistory: OwnResolution[];
  /** Layer 2 — anonymised cross-merchant recommendations (k-anonymous). */
  network: SharedRecommendation[];
}

/**
 * Both intelligence layers for one retail exception, ready for the merchant
 * dashboard or the Super Agent. `network` is empty unless the org opted in to
 * reciprocal sharing AND patterns clear the k-anonymity threshold (enforced
 * inside getSharedRecommendations).
 */
export async function getRetailExceptionIntelligence(
  organizationId: number,
  retailCategory: string,
  amount: number | string = 0,
): Promise<RetailExceptionIntelligence> {
  const amountBucket = amountBucketOf(amount);
  const [ownHistory, network] = await Promise.all([
    getOwnResolutionHistory(organizationId, retailCategory, { amountBucket }),
    getSharedRecommendations(organizationId, retailCategory, amountBucket),
  ]);
  return {
    category: retailCategory,
    categoryLabel: retailExceptionFor(retailCategory)?.label ?? null,
    amountBucket,
    ownHistory,
    network,
  };
}

/**
 * Format both intelligence layers as a Super Agent prompt block for a retail
 * exception. Empty string when there is nothing to add (so it can be
 * concatenated unconditionally).
 */
export function retailIntelligencePromptBlock(intel: RetailExceptionIntelligence): string {
  if (intel.ownHistory.length === 0 && intel.network.length === 0) return "";
  const parts: string[] = [];
  const label = intel.categoryLabel ? `${intel.category} (${intel.categoryLabel})` : intel.category;

  if (intel.ownHistory.length > 0) {
    parts.push(
      `\n\nThis merchant's own past resolutions for ${label} [${intel.amountBucket}] (most relevant first):\n` +
        intel.ownHistory
          .map(
            (r) =>
              `• Action: "${r.resolution}" → ${r.outcome}. Rationale: ${(r.reasoning ?? "").substring(0, 120)}`,
          )
          .join("\n"),
    );
  }

  if (intel.network.length > 0) {
    parts.push(
      `\n\nCross-merchant network recommendations for ${label} (anonymised, k-anonymous — action classes other merchants used):\n` +
        intel.network
          .map(
            (n) =>
              `• ${n.resolutionActionClass} → ${n.outcome} (seen by ${n.contributorCount} merchants, ${n.observationCount} times)`,
          )
          .join("\n"),
    );
  }

  return parts.join("");
}
