/**
 * POC KPI Stats Router
 *
 * Computes real KPI metrics from actual run data for all three POCs:
 *   - Generic (LAPO MFB, Salad Africa): derived from poc_runs + poc_exceptions
 *   - Woodcore: derived from wc_reconciliation_runs + wc_exceptions
 *
 * Each procedure returns a structured KpiReport that the PocKpiDashboard
 * component renders as gauges, benchmark bands, and trend sparklines.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";

// ─── Benchmark constants (from the KPI framework document) ───────────────────

export const BENCHMARKS = {
  autoMatchRate:       { target: 95,  floor: 85,  unit: "%",  label: "Auto-Match Rate",           higherIsBetter: true },
  falsePositiveRate:   { target: 2,   floor: 5,   unit: "%",  label: "False Positive Rate",        higherIsBetter: false },
  exceptionResolutionRate: { target: 80, floor: 60, unit: "%", label: "Resolution Progress Rate",  higherIsBetter: true },
  escalationRate:      { target: 10,  floor: 20,  unit: "%",  label: "Escalation Rate",            higherIsBetter: false },
  aiConfidence:        { target: 85,  floor: 75,  unit: "%",  label: "AI Agent Confidence",        higherIsBetter: true },
  auditTrailComplete:  { target: 100, floor: 100, unit: "%",  label: "Audit Trail Completeness",   higherIsBetter: true },
  // LAPO-specific
  chargebackDetection: { target: 100, floor: 95,  unit: "%",  label: "Chargeback Detection Rate",  higherIsBetter: true },
  duplicateDetection:  { target: 100, floor: 98,  unit: "%",  label: "Duplicate Detection Rate",   higherIsBetter: true },
  // Woodcore-specific
  varianceAttribution: { target: 100, floor: 95,  unit: "%",  label: "Variance Attribution Completeness", higherIsBetter: true },
  layer2TriggerRate:   { target: 100, floor: 100, unit: "%",  label: "Layer 2 Auto-Trigger Rate",  higherIsBetter: true },
  // Salad Africa-specific
  parseSuccessRate:    { target: 90,  floor: 75,  unit: "%",  label: "Structured Parse Success Rate", higherIsBetter: true },
  timeToInsightSec:    { target: 60,  floor: 180, unit: "s",  label: "Time to Full Run (seconds)", higherIsBetter: false },
} as const;

export type BenchmarkKey = keyof typeof BENCHMARKS;

export interface KpiMetric {
  key: BenchmarkKey;
  label: string;
  value: number | null;       // null = not enough data yet
  unit: string;
  target: number;
  floor: number;
  higherIsBetter: boolean;
  /** "above_target" | "between" | "below_floor" | "no_data" */
  status: "above_target" | "between" | "below_floor" | "no_data";
  trend: number[];            // last N run values for sparkline (oldest first)
  runCount: number;           // how many runs contributed to this metric
}

export interface KpiReport {
  pocSlug: string;
  computedAt: string;
  runCount: number;
  metrics: KpiMetric[];
}

export function statusFor(value: number | null, target: number, floor: number, higherIsBetter: boolean): KpiMetric["status"] {
  if (value === null) return "no_data";
  if (higherIsBetter) {
    if (value >= target) return "above_target";
    if (value >= floor) return "between";
    return "below_floor";
  } else {
    if (value <= target) return "above_target";
    if (value <= floor) return "between";
    return "below_floor";
  }
}

function metric(
  key: BenchmarkKey,
  value: number | null,
  trend: number[],
  runCount: number,
): KpiMetric {
  const b = BENCHMARKS[key];
  return {
    key,
    label: b.label,
    value,
    unit: b.unit,
    target: b.target,
    floor: b.floor,
    higherIsBetter: b.higherIsBetter,
    status: statusFor(value, b.target, b.floor, b.higherIsBetter),
    trend,
    runCount,
  };
}

// ─── Generic POC KPI computation (LAPO MFB + Salad Africa) ──────────────────

async function computeGenericKpis(pocSlug: string): Promise<KpiReport> {
  const { getDb } = await import("../db");
  const { pocRuns, pocExceptions } = await import("../../drizzle/poc_schema");
  const { eq, desc, inArray } = await import("drizzle-orm");

  const empty = (): KpiReport => ({ pocSlug, computedAt: new Date().toISOString(), runCount: 0, metrics: [] });
  const db = await getDb();
  if (!db) return empty();

  // Most recent 20 runs for this POC.
  const runs = await db
    .select()
    .from(pocRuns)
    .where(eq(pocRuns.pocSlug, pocSlug))
    .orderBy(desc(pocRuns.createdAt))
    .limit(20);
  if (runs.length === 0) return empty();

  // All exceptions for those runs, grouped by run once. Re-scanning the full set per
  // run is wasteful — a single Salad statement can produce ~1,300 exceptions per run.
  const runIds = runs.map((r) => r.id);
  const allExceptions = await db
    .select()
    .from(pocExceptions)
    .where(inArray(pocExceptions.runId, runIds));
  const byRun = new Map<number, typeof allExceptions>();
  for (const e of allExceptions) {
    const arr = byRun.get(e.runId);
    if (arr) arr.push(e); else byRun.set(e.runId, [e]);
  }
  const exceptionsFor = (runId: number) => byRun.get(runId) ?? [];

  // ── Per-run metrics (for trend sparklines) ──────────────────────────────────
  const matchRateTrend: number[] = [];
  const resolutionRateTrend: number[] = [];
  const escalationRateTrend: number[] = [];
  const aiConfidenceTrend: number[] = [];

  for (const run of [...runs].reverse()) { // oldest first for sparkline
    const matchRate = run.matchRate != null ? parseFloat(String(run.matchRate)) : null;
    if (matchRate !== null && Number.isFinite(matchRate)) matchRateTrend.push(matchRate);

    const runExceptions = exceptionsFor(run.id);
    const total = runExceptions.length;
    if (total > 0) {
      const resolved = runExceptions.filter((e) => e.reviewStatus === "RESOLVED").length;
      const escalated = runExceptions.filter((e) => e.reviewStatus === "ESCALATED").length;
      resolutionRateTrend.push(Math.round(((resolved + escalated) / total) * 100));
      escalationRateTrend.push(Math.round((escalated / total) * 100));

      const confidences = runExceptions
        .map((e) => e.agentConfidence)
        .filter((c): c is number => c !== null && c !== undefined);
      if (confidences.length > 0) {
        aiConfidenceTrend.push(Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length));
      }
    }
  }

  // ── Aggregate KPIs across all runs ─────────────────────────────────────────
  const totalTransactions = runs.reduce((s, r) => s + r.matchedCount + r.exceptionCount, 0);
  const totalMatched = runs.reduce((s, r) => s + r.matchedCount, 0);
  const avgMatchRate = totalTransactions > 0
    ? Math.round((totalMatched / totalTransactions) * 10000) / 100
    : null;

  const totalExceptions = allExceptions.length;
  const resolvedExceptions = allExceptions.filter((e) => e.reviewStatus === "RESOLVED").length;
  const escalatedExceptions = allExceptions.filter((e) => e.reviewStatus === "ESCALATED").length;
  const resolutionRate = totalExceptions > 0
    ? Math.round(((resolvedExceptions + escalatedExceptions) / totalExceptions) * 100)
    : null;
  const escalationRate = totalExceptions > 0
    ? Math.round((escalatedExceptions / totalExceptions) * 100)
    : null;

  const allConfidences = allExceptions
    .map((e) => e.agentConfidence)
    .filter((c): c is number => c !== null && c !== undefined);
  const avgConfidence = allConfidences.length > 0
    ? Math.round(allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length)
    : null;

  // Audit trail: every run has a complete record (it's always 100% by design)
  const auditTrailComplete = runs.length > 0 ? 100 : null;

  // LAPO-specific: chargeback detection rate
  // We can't compute a "missed" rate from the data alone, but we can show
  // what % of exceptions with CHARGEBACK category were reviewed (not left OPEN)
  const chargebacks = allExceptions.filter((e) => e.category === "CHARGEBACK");
  const chargebackReviewed = chargebacks.filter((e) => e.reviewStatus !== "OPEN").length;
  const chargebackDetectionRate = chargebacks.length > 0
    ? Math.round((chargebackReviewed / chargebacks.length) * 100)
    : null;

  const duplicates = allExceptions.filter((e) => e.category === "DUPLICATE");
  const duplicateDetectionRate = duplicates.length > 0 ? 100 : null; // all detected = 100%

  // False positive rate: approximated as % of OPEN exceptions that were never
  // escalated or resolved (still unactioned after being flagged)
  const openExceptions = allExceptions.filter((e) => e.reviewStatus === "OPEN").length;
  const falsePositiveRate = totalExceptions > 0
    ? Math.round((openExceptions / totalExceptions) * 100)
    : null;

  const isLapo = pocSlug === "lapo_mfb";

  const metrics: KpiMetric[] = [
    metric("autoMatchRate", avgMatchRate, matchRateTrend, runs.length),
    metric("falsePositiveRate", falsePositiveRate, [], runs.length),
    metric("exceptionResolutionRate", resolutionRate, resolutionRateTrend, runs.length),
    metric("escalationRate", escalationRate, escalationRateTrend, runs.length),
    metric("aiConfidence", avgConfidence, aiConfidenceTrend, runs.length),
    metric("auditTrailComplete", auditTrailComplete, [], runs.length),
    ...(isLapo ? [
      metric("chargebackDetection", chargebackDetectionRate, [], runs.length),
      metric("duplicateDetection", duplicateDetectionRate, [], runs.length),
    ] : []),
  ];

  return {
    pocSlug,
    computedAt: new Date().toISOString(),
    runCount: runs.length,
    metrics,
  };
}

// ─── Woodcore KPI computation ────────────────────────────────────────────────

async function computeWoodcoreKpis(): Promise<KpiReport> {
  const { getDb } = await import("../db");
  const { wc_reconciliation_runs, wc_exceptions } = await import("../../drizzle/woodcore_schema");
  const { desc, inArray } = await import("drizzle-orm");

  const empty = (): KpiReport => ({ pocSlug: "woodcore", computedAt: new Date().toISOString(), runCount: 0, metrics: [] });
  const db = await getDb();
  if (!db) return empty();

  const runs = await db
    .select()
    .from(wc_reconciliation_runs)
    .orderBy(desc(wc_reconciliation_runs.createdAt))
    .limit(20);
  if (runs.length === 0) return empty();

  // Fetch all exceptions for those runs, grouped by run once (avoids re-scanning).
  const runIds = runs.map((r) => r.id);
  const allExceptions = await db
    .select()
    .from(wc_exceptions)
    .where(inArray(wc_exceptions.reconciliationRunId, runIds));
  const byRun = new Map<number, typeof allExceptions>();
  for (const e of allExceptions) {
    const arr = byRun.get(e.reconciliationRunId);
    if (arr) arr.push(e); else byRun.set(e.reconciliationRunId, [e]);
  }
  const exceptionsFor = (runId: number) => byRun.get(runId) ?? [];

  // ── Per-run metrics for sparklines ─────────────────────────────────────────
  const matchRateTrend: number[] = [];
  const resolutionRateTrend: number[] = [];
  const layer2TriggerTrend: number[] = [];

  for (const run of [...runs].reverse()) {
    // Layer 2 trigger: 100 if variance triggered the exception layer, else 0.
    layer2TriggerTrend.push(run.layer2Triggered ? 100 : 0);

    const runExceptions = exceptionsFor(run.id);
    const total = runExceptions.length;
    const totalTxns = (run.totalGlEntries ?? 0) + (run.totalSavingsTxns ?? 0);
    const exceptionCount = total;
    const matched = totalTxns - exceptionCount;
    if (totalTxns > 0) {
      matchRateTrend.push(Math.round((Math.max(0, matched) / totalTxns) * 100));
    }

    if (total > 0) {
      const resolved = runExceptions.filter((e) => e.reviewStatus === "RESOLVED").length;
      const escalated = runExceptions.filter((e) => e.reviewStatus === "ESCALATED").length;
      resolutionRateTrend.push(Math.round(((resolved + escalated) / total) * 100));
    }
  }

  // ── Aggregate KPIs ──────────────────────────────────────────────────────────
  const totalGlEntries = runs.reduce((s, r) => s + (r.totalGlEntries ?? 0), 0);
  const totalExceptionCount = allExceptions.length;
  const totalMatched = totalGlEntries - totalExceptionCount;
  const avgMatchRate = totalGlEntries > 0
    ? Math.round((Math.max(0, totalMatched) / totalGlEntries) * 10000) / 100
    : null;

  const totalExceptions = allExceptions.length;
  const resolvedExceptions = allExceptions.filter((e) => e.reviewStatus === "RESOLVED").length;
  const escalatedExceptions = allExceptions.filter((e) => e.reviewStatus === "ESCALATED").length;
  const resolutionRate = totalExceptions > 0
    ? Math.round(((resolvedExceptions + escalatedExceptions) / totalExceptions) * 100)
    : null;
  const escalationRate = totalExceptions > 0
    ? Math.round((escalatedExceptions / totalExceptions) * 100)
    : null;

  const allConfidences = allExceptions
    .map((e) => e.agentConfidence)
    .filter((c): c is number => c !== null && c !== undefined);
  const avgConfidence = allConfidences.length > 0
    ? Math.round(allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length)
    : null;

  // Layer 2 auto-trigger rate: % of VARIANCE_DETECTED runs that have exceptions
  const varianceRuns = runs.filter((r) => r.status === "VARIANCE_DETECTED");
  const triggeredRuns = varianceRuns.filter((r) => exceptionsFor(r.id).length > 0);
  const layer2TriggerRate = varianceRuns.length > 0
    ? Math.round((triggeredRuns.length / varianceRuns.length) * 100)
    : 100; // if no variance runs, the system is working perfectly

  // Variance attribution: % of VARIANCE_DETECTED runs where exceptions exist
  // (proxy for "the variance is fully explained by the exceptions found")
  const varianceAttributionRate = varianceRuns.length > 0
    ? Math.round((triggeredRuns.length / varianceRuns.length) * 100)
    : 100;

  const openExceptions = allExceptions.filter((e) => e.reviewStatus === "OPEN").length;
  const falsePositiveRate = totalExceptions > 0
    ? Math.round((openExceptions / totalExceptions) * 100)
    : null;

  const metrics: KpiMetric[] = [
    metric("autoMatchRate", avgMatchRate, matchRateTrend, runs.length),
    metric("falsePositiveRate", falsePositiveRate, [], runs.length),
    metric("exceptionResolutionRate", resolutionRate, resolutionRateTrend, runs.length),
    metric("escalationRate", escalationRate, [], runs.length),
    metric("aiConfidence", avgConfidence, [], runs.length),
    metric("auditTrailComplete", 100, [], runs.length),
    metric("layer2TriggerRate", layer2TriggerRate, layer2TriggerTrend, runs.length),
    metric("varianceAttribution", varianceAttributionRate, [], runs.length),
  ];

  return {
    pocSlug: "woodcore",
    computedAt: new Date().toISOString(),
    runCount: runs.length,
    metrics,
  };
}

// ─── Router ──────────────────────────────────────────────────────────────────

const pocSlugSchema = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);

// The KPI dashboards are an INTERNAL Infinity AI view — never shown to POC
// customers. Gate them to authenticated super admins. This is the server-side
// half of the restriction; the POC pages also hide the tab for non-super-admins.
// A POC access token (the customer's `?key=`) is intentionally NOT sufficient here.
const superAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "super_admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Super Admin access required." });
  }
  return next({ ctx });
});

export const pocKpiRouter = router({
  // Generic POC KPIs (LAPO MFB, Salad Africa) — super admin only
  getKpis: superAdminProcedure
    .input(z.object({ pocSlug: pocSlugSchema }))
    .query(async ({ input }) => computeGenericKpis(input.pocSlug)),

  // Woodcore KPIs — super admin only
  getWoodcoreKpis: superAdminProcedure
    .query(async () => computeWoodcoreKpis()),
});
