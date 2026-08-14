/**
 * Job Progress Service
 * Tracks reconciliation job progress in real-time via database events.
 * Provides polling-based progress updates for the monitoring dashboard.
 */
import * as db from "./db";
import { emitJobProgress } from "./jobEvents";

// ─── Types ──────────────────────────────────────────────────────────

export type JobPhase =
  | "queued"
  | "loading_data"
  | "pass1_exact_match"
  | "pass2_fuzzy_match"
  | "pass3_tolerance_match"
  | "duplicate_detection"
  | "reversal_detection"
  | "exception_categorization"
  | "ai_analysis"
  | "finalizing"
  | "completed"
  | "failed";

const PHASE_WEIGHTS: Record<JobPhase, number> = {
  queued: 0,
  loading_data: 5,
  pass1_exact_match: 25,
  pass2_fuzzy_match: 45,
  pass3_tolerance_match: 60,
  duplicate_detection: 70,
  reversal_detection: 75,
  exception_categorization: 85,
  ai_analysis: 92,
  finalizing: 97,
  completed: 100,
  failed: 100,
};

const PHASE_LABELS: Record<JobPhase, string> = {
  queued: "Queued",
  loading_data: "Loading transaction data",
  pass1_exact_match: "Pass 1: Exact reference matching",
  pass2_fuzzy_match: "Pass 2: Fuzzy matching",
  pass3_tolerance_match: "Pass 3: Tolerance-based matching",
  duplicate_detection: "Detecting duplicates",
  reversal_detection: "Detecting reversals",
  exception_categorization: "Categorizing exceptions",
  ai_analysis: "AI analysis of high-severity exceptions",
  finalizing: "Finalizing results",
  completed: "Completed",
  failed: "Failed",
};

// ─── Progress Tracking ──────────────────────────────────────────────

export async function trackProgress(
  jobId: number,
  phase: JobPhase,
  options: {
    processedCount?: number;
    totalCount?: number;
    message?: string;
  } = {}
): Promise<void> {
  const baseProgress = PHASE_WEIGHTS[phase];
  let progress = baseProgress;

  // Calculate sub-phase progress if counts are provided
  if (options.totalCount && options.totalCount > 0 && options.processedCount !== undefined) {
    const nextPhaseProgress = getNextPhaseProgress(phase);
    const phaseRange = nextPhaseProgress - baseProgress;
    const subProgress = (options.processedCount / options.totalCount) * phaseRange;
    progress = Math.min(Math.round(baseProgress + subProgress), nextPhaseProgress);
  }

  const message = options.message || PHASE_LABELS[phase];

  await db.insertJobProgressEvent({
    jobId,
    phase,
    progress,
    message,
    processedCount: options.processedCount || 0,
    totalCount: options.totalCount || 0,
  });

  // Push to the live SSE stream for real-time dashboard updates — but only when
  // the owning tenant is KNOWN. An unresolved owner is not broadcast at all; see
  // organizationForJob.
  const owner = await organizationForJob(jobId);
  if (owner.known) {
    emitJobProgress({
      jobId,
      organizationId: owner.organizationId,
      phase,
      progress,
      message,
      processedCount: options.processedCount || 0,
      totalCount: options.totalCount || 0,
    });
  }
}

/**
 * Who owns a job — and whether we actually know.
 *
 * `known: false` is NOT the same as `organizationId: null`, and collapsing the
 * two is the defect this type exists to prevent. An earlier revision returned a
 * bare `number | null` and called it fail-closed on the reasoning that "an
 * unresolvable job yields null, which only an org-less viewer matches". That is
 * wrong: `null` is not an empty set, it is a real tenancy bucket — 22 accounts
 * currently have no organisation — so an unresolved job was broadcast to every
 * one of them. It failed OPEN toward exactly the viewers least entitled to it.
 *
 * The same mistake, in a different pair, as "no organisation is not an unknown
 * segment" (shared/verticalFeatures): absence of an answer is not an answer.
 */
type JobOwner =
  | { known: true; organizationId: number | null }
  | { known: false; organizationId: null };

const UNKNOWN_OWNER: JobOwner = { known: false, organizationId: null };

/**
 * The tenant that owns a job, memoised for the life of the process.
 *
 * Resolved HERE rather than threaded through `trackProgress`'s signature, which
 * is the whole point: there are progress calls scattered across the
 * reconciliation runner, and any one of them that forgot to pass the tenant
 * would silently restore the broadcast. Looking it up from the jobId means no
 * call site can get it wrong.
 *
 * A job's owner never changes, so caching a RESOLVED owner is safe and one
 * lookup per job replaces one per progress event — a run emits a dozen or more.
 * An unresolved lookup is never cached: a single transient database error would
 * otherwise pin the wrong answer to that job for the life of the process.
 */
const jobOrgCache = new Map<number, number | null>();

async function organizationForJob(jobId: number): Promise<JobOwner> {
  const cached = jobOrgCache.get(jobId);
  if (cached !== undefined) return { known: true, organizationId: cached };

  let job: Awaited<ReturnType<typeof db.getReconciliationJob>>;
  try {
    job = await db.getReconciliationJob(jobId);
  } catch {
    return UNKNOWN_OWNER; // transient DB failure — not cached, retried next event
  }
  // No row means deleted or never existed. Either way the owner is unknown, and
  // an unknown owner must reach nobody rather than defaulting into a bucket.
  if (!job) return UNKNOWN_OWNER;

  const org = job.organizationId ?? null;
  jobOrgCache.set(jobId, org);
  // Bound the map so a long-lived process cannot accumulate every job id.
  // Insertion-ordered, so Array.from(...).slice takes the OLDEST half.
  if (jobOrgCache.size > 5000) {
    for (const k of Array.from(jobOrgCache.keys()).slice(0, 2500)) jobOrgCache.delete(k);
  }
  return { known: true, organizationId: org };
}

function getNextPhaseProgress(currentPhase: JobPhase): number {
  const phases = Object.keys(PHASE_WEIGHTS) as JobPhase[];
  const currentIndex = phases.indexOf(currentPhase);
  if (currentIndex < phases.length - 1) {
    return PHASE_WEIGHTS[phases[currentIndex + 1]];
  }
  return 100;
}

// ─── Progress Query ─────────────────────────────────────────────────

export interface JobProgressSummary {
  jobId: number;
  jobName: string;
  status: string;
  phase: string;
  phaseLabel: string;
  progress: number;
  processedCount: number;
  totalCount: number;
  message: string;
  startedAt: Date | null;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
  sourceChannel: string;
  targetChannel: string;
  matchedCount: number;
  exceptionCount: number;
}

export async function getJobProgress(jobId: number): Promise<JobProgressSummary | null> {
  const job = await db.getReconciliationJob(jobId);
  if (!job) return null;

  const latestProgress = await db.getLatestJobProgress(jobId);
  const sourceChannel = await db.getChannelById(job.sourceChannelId);
  const targetChannel = await db.getChannelById(job.targetChannelId);

  const phase = latestProgress?.phase || (job.status === "completed" ? "completed" : "queued");
  const progress = latestProgress?.progress || (job.status === "completed" ? 100 : 0);

  const startedAt = job.startedAt ? new Date(job.startedAt) : null;
  const elapsedMs = startedAt ? Date.now() - startedAt.getTime() : 0;

  // Estimate remaining time based on progress
  let estimatedRemainingMs: number | null = null;
  if (progress > 0 && progress < 100 && elapsedMs > 0) {
    estimatedRemainingMs = Math.round((elapsedMs / progress) * (100 - progress));
  }

  return {
    jobId: job.id,
    jobName: job.name,
    status: job.status,
    phase,
    phaseLabel: PHASE_LABELS[phase as JobPhase] || phase,
    progress,
    processedCount: latestProgress?.processedCount || 0,
    totalCount: latestProgress?.totalCount || 0,
    message: latestProgress?.message || PHASE_LABELS[phase as JobPhase] || "Waiting...",
    startedAt,
    elapsedMs,
    estimatedRemainingMs,
    sourceChannel: sourceChannel?.name || `Channel #${job.sourceChannelId}`,
    targetChannel: targetChannel?.name || `Channel #${job.targetChannelId}`,
    matchedCount: job.matchedCount,
    exceptionCount: job.exceptionCount,
  };
}

export async function getAllActiveJobsProgress(): Promise<JobProgressSummary[]> {
  const activeJobs = await db.getActiveJobsProgress();
  const summaries: JobProgressSummary[] = [];

  for (const job of activeJobs) {
    const sourceChannel = await db.getChannelById(job.sourceChannelId);
    const targetChannel = await db.getChannelById(job.targetChannelId);
    const phase = job.latestProgress?.phase || "queued";
    const progress = job.latestProgress?.progress || 0;
    const startedAt = job.startedAt ? new Date(job.startedAt) : null;
    const elapsedMs = startedAt ? Date.now() - startedAt.getTime() : 0;

    let estimatedRemainingMs: number | null = null;
    if (progress > 0 && progress < 100 && elapsedMs > 0) {
      estimatedRemainingMs = Math.round((elapsedMs / progress) * (100 - progress));
    }

    summaries.push({
      jobId: job.id,
      jobName: job.name,
      status: job.status,
      phase,
      phaseLabel: PHASE_LABELS[phase as JobPhase] || phase,
      progress,
      processedCount: job.latestProgress?.processedCount || 0,
      totalCount: job.latestProgress?.totalCount || 0,
      message: job.latestProgress?.message || "Waiting...",
      startedAt,
      elapsedMs,
      estimatedRemainingMs,
      sourceChannel: sourceChannel?.name || `Channel #${job.sourceChannelId}`,
      targetChannel: targetChannel?.name || `Channel #${job.targetChannelId}`,
      matchedCount: job.matchedCount,
      exceptionCount: job.exceptionCount,
    });
  }

  return summaries;
}
