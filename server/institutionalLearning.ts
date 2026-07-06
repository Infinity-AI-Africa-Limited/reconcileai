/**
 * Per-Institution Learning — shared enrichment layer.
 *
 * Turns an institution's own exception-resolution history into better AI
 * diagnoses: each new exception cites how many similar exceptions the
 * institution has previously actioned, the dominant resolution approach, and
 * gains confidence with corroborating history. Used by both the mobile money
 * engine (mm_exceptions history) and the generic POC engine (poc_exceptions
 * history). This is the POC-scoped half of the learning flywheel; the
 * cross-institution half (exceptionIntelligence.ts pattern pool) activates
 * when a POC converts to a full tenant with an organizationId.
 *
 * Pure functions only — callers fetch the history rows; enrichment never
 * touches the database, so it is unit-testable and can never fail a run.
 */

export interface CategoryResolutionStats {
  category: string;
  actioned: number;              // reviews with any terminal status
  resolved: number;
  escalated: number;
  topActionClass: string | null; // most common resolution action class
}

export interface ResolutionHistoryRow {
  category: string;
  reviewStatus: string;
  reviewNote: string | null;
}

/**
 * Aggregate an institution's past exception reviews, grouped by category.
 * `classifyAction` is injected (exceptionIntelligence.classifyResolutionAction)
 * so this module stays dependency-free.
 */
export function summarizeResolutionHistory(
  rows: ResolutionHistoryRow[],
  classifyAction: (note: string | null | undefined) => string,
): Map<string, CategoryResolutionStats> {
  const stats = new Map<string, CategoryResolutionStats>();
  const actionCounts = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (row.reviewStatus === "OPEN") continue;
    let s = stats.get(row.category);
    if (!s) {
      s = { category: row.category, actioned: 0, resolved: 0, escalated: 0, topActionClass: null };
      stats.set(row.category, s);
    }
    s.actioned += 1;
    if (row.reviewStatus === "RESOLVED") s.resolved += 1;
    if (row.reviewStatus === "ESCALATED") s.escalated += 1;

    const cls = classifyAction(row.reviewNote);
    let counts = actionCounts.get(row.category);
    if (!counts) {
      counts = new Map();
      actionCounts.set(row.category, counts);
    }
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }

  for (const [category, counts] of Array.from(actionCounts.entries())) {
    let top: string | null = null;
    let topCount = 0;
    for (const [cls, count] of Array.from(counts.entries())) {
      if (count > topCount) { top = cls; topCount = count; }
    }
    const s = stats.get(category);
    if (s) s.topActionClass = top;
  }

  return stats;
}

/** The institutional-memory citation for one category (empty when no history). */
export function institutionalMemoryNote(stats: CategoryResolutionStats | undefined): string {
  if (!stats || stats.actioned === 0) return "";
  const approach = stats.topActionClass && stats.topActionClass !== "other"
    ? ` Most common resolution approach: ${stats.topActionClass.replace(/_/g, " ")}.`
    : "";
  return (
    `Institutional memory: this institution has previously actioned ${stats.actioned} similar ` +
    `exception${stats.actioned === 1 ? "" : "s"} in this category ` +
    `(${stats.resolved} resolved, ${stats.escalated} escalated).${approach}`
  );
}

/**
 * Enrich a single AI-diagnosis item with the institution's own resolution
 * history: append the memory citation and raise confidence by up to 6 points
 * (capped at 98) with corroborating resolutions. Returns the item unchanged
 * (and applied=false) when there is no matching history.
 */
export function enrichItemWithInstitutionalMemory<
  T extends { category: string; agentExplanation: string; agentConfidence: number },
>(item: T, stats: Map<string, CategoryResolutionStats>): { item: T; applied: boolean } {
  const s = stats.get(item.category);
  const note = institutionalMemoryNote(s);
  if (!note) return { item, applied: false };
  return {
    item: {
      ...item,
      agentExplanation: `${item.agentExplanation}\n\n${note}`,
      agentConfidence: Math.min(98, item.agentConfidence + Math.min(6, s!.actioned)),
    },
    applied: true,
  };
}

/**
 * Enrich AI diagnoses with the institutional memory: append the history
 * citation to each item's explanation and raise confidence by up to 6 points
 * (capped at 98) with corroborating resolutions. Generic over any Layer-3
 * item shape that carries category/agentExplanation/agentConfidence.
 */
export function enrichWithInstitutionalMemory<
  T extends { category: string; agentExplanation: string; agentConfidence: number },
>(
  items: T[],
  stats: Map<string, CategoryResolutionStats>,
): { items: T[]; learningApplied: number } {
  if (items.length === 0 || stats.size === 0) return { items, learningApplied: 0 };

  let learningApplied = 0;
  const enriched = items.map((item) => {
    const { item: next, applied } = enrichItemWithInstitutionalMemory(item, stats);
    if (applied) learningApplied += 1;
    return next;
  });

  return { items: enriched, learningApplied };
}

/** One anonymised cross-institution pattern from the shared pool. */
export interface NetworkRecommendation {
  resolutionActionClass: string;
  outcome: string;
  contributorCount: number;
  observationCount: number;
}

/**
 * Format k-anonymous cross-institution patterns as prompt-injectable guidance
 * for the AI diagnosis. Purely categorical — the pool never carries an org id,
 * name, or any transaction detail, so this string is safe to feed an LLM.
 * Returns "" when there is nothing that clears the k-anonymity gate.
 */
export function formatNetworkGuidance(recs: NetworkRecommendation[]): string {
  if (recs.length === 0) return "";
  const lines = recs
    .slice(0, 3)
    .map((r) => {
      const action = r.resolutionActionClass.replace(/_/g, " ");
      return `- ${action} → ${r.outcome} (seen across ${r.contributorCount} institutions, ${r.observationCount} cases)`;
    })
    .join("\n");
  return (
    `Cross-institution intelligence (anonymised, k-anonymous ReconcileAI network): ` +
    `peer institutions most often resolved similar exceptions as follows:\n${lines}`
  );
}
