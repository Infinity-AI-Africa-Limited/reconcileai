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
    const s = stats.get(item.category);
    if (!s || s.actioned === 0) return item;
    learningApplied += 1;
    const approach = s.topActionClass && s.topActionClass !== "other"
      ? ` Most common resolution approach: ${s.topActionClass.replace(/_/g, " ")}.`
      : "";
    return {
      ...item,
      agentExplanation:
        item.agentExplanation +
        `\n\nInstitutional memory: this institution has previously actioned ${s.actioned} similar ` +
        `exception${s.actioned === 1 ? "" : "s"} in this category (${s.resolved} resolved, ${s.escalated} escalated).${approach}`,
      agentConfidence: Math.min(98, item.agentConfidence + Math.min(6, s.actioned)),
    };
  });

  return { items: enriched, learningApplied };
}
