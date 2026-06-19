/**
 * Exception Age / Escalation Tracker.
 *
 * From discovery (Edozie, reconciliation ops): the value of ReconcileAI to an
 * operations buyer is the exception *workflow*, and the age tracker — escalation
 * of over-aged exceptions — was named as a top-3 feature. This module computes
 * how long each open exception has been outstanding, buckets it for the ops
 * control centre, and derives an escalation level relative to the institution's
 * SLA so over-aged items are explicit and visible.
 *
 * Pure logic (no DB/LLM) so it is unit-testable; the router/db layer feeds it.
 */

export const DEFAULT_SLA_DAYS = 7;

export type EscalationLevel = "on_track" | "watch" | "overdue" | "breach";

/** Whole days an item has been outstanding (>= 0). */
export function ageDays(createdAt: Date | string, now: Date = new Date()): number {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const ms = now.getTime() - created.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Escalation level relative to the SLA target. on_track = within SLA; beyond it
 * the item is "over-aged" and escalates as it ages: watch (≤2× SLA), overdue
 * (≤4× SLA), breach (> 4× SLA).
 */
export function escalationLevel(age: number, slaDays: number = DEFAULT_SLA_DAYS): EscalationLevel {
  const sla = slaDays > 0 ? slaDays : DEFAULT_SLA_DAYS;
  if (age <= sla) return "on_track";
  if (age <= sla * 2) return "watch";
  if (age <= sla * 4) return "overdue";
  return "breach";
}

export function isOverAged(age: number, slaDays: number = DEFAULT_SLA_DAYS): boolean {
  return age > (slaDays > 0 ? slaDays : DEFAULT_SLA_DAYS);
}

/** Fixed aging buckets for the ops control-centre summary (independent of SLA). */
export const AGE_BUCKETS = [
  { key: "0-2", label: "0–2 days", min: 0, max: 2 },
  { key: "3-7", label: "3–7 days", min: 3, max: 7 },
  { key: "8-30", label: "8–30 days", min: 8, max: 30 },
  { key: "30+", label: "30+ days", min: 31, max: Number.POSITIVE_INFINITY },
] as const;

export type BucketKey = (typeof AGE_BUCKETS)[number]["key"];

export function bucketOf(age: number): BucketKey {
  for (const b of AGE_BUCKETS) {
    if (age >= b.min && age <= b.max) return b.key;
  }
  return "30+";
}

/** Minimal shape the summary needs from each open exception. */
export interface AgingInput {
  ageDays: number;
  amount: number;
}

export interface BucketStat {
  key: BucketKey;
  label: string;
  count: number;
  exposure: number; // sum of amounts in this bucket
}

export interface AgingSummary {
  slaDays: number;
  totalOpen: number;
  totalExposure: number;
  overAgedCount: number;
  overAgedExposure: number; // ₦ at risk past SLA
  oldestAgeDays: number;
  buckets: BucketStat[];
  escalation: Record<EscalationLevel, number>;
}

export function computeSummary(items: AgingInput[], slaDays: number = DEFAULT_SLA_DAYS): AgingSummary {
  const buckets: Record<BucketKey, BucketStat> = AGE_BUCKETS.reduce((acc, b) => {
    acc[b.key] = { key: b.key, label: b.label, count: 0, exposure: 0 };
    return acc;
  }, {} as Record<BucketKey, BucketStat>);
  const escalation: Record<EscalationLevel, number> = { on_track: 0, watch: 0, overdue: 0, breach: 0 };

  let totalExposure = 0;
  let overAgedCount = 0;
  let overAgedExposure = 0;
  let oldestAgeDays = 0;

  for (const it of items) {
    const amt = Number.isFinite(it.amount) ? it.amount : 0;
    const b = bucketOf(it.ageDays);
    buckets[b].count += 1;
    buckets[b].exposure += amt;
    totalExposure += amt;
    escalation[escalationLevel(it.ageDays, slaDays)] += 1;
    if (isOverAged(it.ageDays, slaDays)) {
      overAgedCount += 1;
      overAgedExposure += amt;
    }
    if (it.ageDays > oldestAgeDays) oldestAgeDays = it.ageDays;
  }

  return {
    slaDays,
    totalOpen: items.length,
    totalExposure: round2(totalExposure),
    overAgedCount,
    overAgedExposure: round2(overAgedExposure),
    oldestAgeDays,
    buckets: AGE_BUCKETS.map((b) => ({ ...buckets[b.key], exposure: round2(buckets[b.key].exposure) })),
    escalation,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
