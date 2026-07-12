/**
 * CBN Compliance Report Engine.
 *
 * Builds the five reports CBN's MFB / commercial-bank supervision departments
 * expect, entirely from existing reconciliation data (jobs, matches, exceptions,
 * transactions, channels, audit log). Each builder returns a structured
 * { meta, columns, rows, summary } object; the router turns that into an on-screen
 * preview and a one-click CBN-format CSV via `toCsv`.
 *
 *  1. dailyReconSummary       — per-channel daily reconciliation position
 *  2. exceptionLog            — every exception + resolution status + audit trail
 *  3. counterpartyExposure    — open unreconciled exposure aggregated by counterparty
 *  4. interbankSettlement     — NIBSS/RTGS interbank settlement reconciliation
 *  5. monthlyAttestation      — signed monthly compliance attestation payload
 *
 * All queries are org-scoped. Reconciliation data is joined to `transactions`
 * (which carries organizationId) or `reconciliation_jobs.organizationId`.
 */
import { and, eq, gte, lte, inArray, desc, asc, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  transactions, exceptions, reconciliationJobs, matches, channels,
  auditLogs, users, cbnReportSettings,
} from "../drizzle/schema";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReportMeta {
  title: string;
  institutionName: string;
  institutionType: string;
  rcNumber: string;
  cbnLicenseNumber: string;
  cbnInstitutionCode: string;
  periodLabel: string;
  preparedBy: string;
  generatedAt: string;
  currency: string;
  regulatoryBasis: string;
  /** Which regulator this return is for — drives the CSV identity-block labels. */
  regulator: "CBN" | "BoU";
}

export interface ReportResult {
  meta: ReportMeta;
  columns: string[];
  rows: (string | number)[][];
  summary: Record<string, string | number>;
}

// ─── Institution profile ──────────────────────────────────────────────────────

const INSTITUTION_TYPE_LABEL: Record<string, string> = {
  microfinance_bank: "Microfinance Bank (MFB)",
  commercial_bank: "Commercial Bank",
  payment_service_bank: "Payment Service Bank (PSB)",
  merchant_bank: "Merchant Bank",
  other_financial_institution: "Other Financial Institution (OFI)",
  fintech: "Fintech / Payment Solution Provider",
  other: "Other",
};

/** Fetch (lazily creating) the org's CBN report profile. */
export async function getReportSettings(organizationId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select().from(cbnReportSettings).where(eq(cbnReportSettings.organizationId, organizationId)).limit(1);
  if (row) return row;
  await db.insert(cbnReportSettings).values({ organizationId }).onDuplicateKeyUpdate({ set: { organizationId } });
  const [created] = await db.select().from(cbnReportSettings).where(eq(cbnReportSettings.organizationId, organizationId)).limit(1);
  return created ?? null;
}

export async function buildMeta(
  organizationId: number,
  title: string,
  periodLabel: string,
  regulatoryBasis: string,
  opts: { currency?: string; regulator?: "CBN" | "BoU" } = {},
): Promise<ReportMeta> {
  const s = await getReportSettings(organizationId);
  return {
    title,
    institutionName: s?.institutionName || "[Institution name not set — configure in Report settings]",
    institutionType: INSTITUTION_TYPE_LABEL[s?.institutionType ?? "microfinance_bank"] ?? s?.institutionType ?? "",
    rcNumber: s?.rcNumber || "—",
    cbnLicenseNumber: s?.cbnLicenseNumber || "—",
    cbnInstitutionCode: s?.cbnInstitutionCode || "—",
    periodLabel,
    preparedBy: s?.preparedByName ? `${s.preparedByName}${s.preparedByTitle ? `, ${s.preparedByTitle}` : ""}` : "—",
    generatedAt: new Date().toISOString(),
    currency: opts.currency ?? "NGN",
    regulatoryBasis,
    regulator: opts.regulator ?? "CBN",
  };
}

// Shared report primitives, exported for the BoU pack (server/bouReports.ts).
export { num, round2, dayKey };
export { exceptionsInRange, channelMap };

// ─── Helpers ──────────────────────────────────────────────────────────────────

const num = (v: unknown) => Number(v ?? 0) || 0;
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** Serialize a report to CBN-style CSV: an identity header block, then the table. */
export function toCsv(r: ReportResult): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Regulator-neutral labels so the same builder serves CBN (Nigeria) and BoU (Uganda).
  const regLabel = r.meta.regulator === "BoU" ? "BoU Licence" : "CBN Licence";
  const regNumLabel = r.meta.regulator === "BoU" ? "Registration No." : "RC Number";
  const header = [
    `"${r.meta.title}"`,
    `"Institution:","${r.meta.institutionName}"`,
    `"Type:","${r.meta.institutionType}"`,
    `"${regNumLabel}:","${r.meta.rcNumber}","${regLabel}:","${r.meta.cbnLicenseNumber}","Institution Code:","${r.meta.cbnInstitutionCode}"`,
    `"Reporting Period:","${r.meta.periodLabel}","Currency:","${r.meta.currency}"`,
    `"Prepared By:","${r.meta.preparedBy}"`,
    `"Regulatory Basis:","${r.meta.regulatoryBasis}"`,
    `"Generated:","${r.meta.generatedAt}"`,
    "",
  ];
  const body = [
    r.columns.map(esc).join(","),
    ...r.rows.map((row) => row.map(esc).join(",")),
  ];
  const summaryBlock = [
    "",
    '"Summary"',
    ...Object.entries(r.summary).map(([k, v]) => `${esc(k)},${esc(v)}`),
  ];
  return "﻿" + [...header, ...body, ...summaryBlock].join("\n");
}

// ─── Data access (org-scoped) ─────────────────────────────────────────────────

/** Completed reconciliation jobs for an org whose reconciled date falls in range. */
async function jobsInRange(organizationId: number, from: Date, to: Date) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(reconciliationJobs).where(and(
    eq(reconciliationJobs.organizationId, organizationId),
    eq(reconciliationJobs.status, "completed"),
    gte(reconciliationJobs.dateTo, from),
    lte(reconciliationJobs.dateFrom, to),
  )).orderBy(asc(reconciliationJobs.dateFrom));
}

/** Exceptions raised in range for an org, joined to their transaction + assignee. */
async function exceptionsInRange(organizationId: number, from: Date, to: Date, openOnly = false) {
  const db = await getDb();
  if (!db) return [];
  const conds = [
    eq(transactions.organizationId, organizationId),
    gte(exceptions.createdAt, from),
    lte(exceptions.createdAt, to),
  ];
  if (openOnly) conds.push(inArray(exceptions.status, ["open", "in_review", "escalated"]));
  return db.select({
    id: exceptions.id,
    jobId: exceptions.jobId,
    createdAt: exceptions.createdAt,
    category: exceptions.category,
    severity: exceptions.severity,
    status: exceptions.status,
    description: exceptions.description,
    resolvedBy: exceptions.resolvedBy,
    resolvedAt: exceptions.resolvedAt,
    resolutionNotes: exceptions.resolutionNotes,
    assignedTo: exceptions.assignedTo,
    cbsStillAnomalous: exceptions.cbsStillAnomalous,
    amount: transactions.amount,
    counterparty: transactions.counterparty,
    transactionRef: transactions.transactionRef,
    transactionDate: transactions.transactionDate,
    channelId: transactions.channelId,
    assigneeName: users.name,
  })
    .from(exceptions)
    .innerJoin(transactions, eq(exceptions.transactionId, transactions.id))
    .leftJoin(users, eq(exceptions.assignedTo, users.id))
    .where(and(...conds))
    .orderBy(asc(exceptions.createdAt));
}

async function channelMap(organizationId: number): Promise<Map<number, { name: string; code: string; type: string }>> {
  const db = await getDb();
  const m = new Map<number, { name: string; code: string; type: string }>();
  if (!db) return m;
  const rows = await db.select().from(channels);
  for (const c of rows) m.set(c.id, { name: c.name, code: c.code, type: c.channelType });
  return m;
}

// ─── 0a. Failed Transactions Monthly Return (CBN, April 2026 directive) ──────
// CBN now requires monthly reporting of failed electronic transactions and
// their reversal timelines. The sanction frame: ₦10,000 per failed NIP item
// not reversed within 24h of complaint; ATM refunds within 24h (on-us) / 48h
// (not-on-us). This return gives per-channel failed volume/value, reversal
// buckets against those windows, a compliance rate, and the indicative
// sanction exposure — one click instead of a month-end spreadsheet hunt.

/**
 * Which exception categories represent a FAILED CUSTOMER TRANSACTION
 * (debited-without-value / credit-not-applied / reversal-owed), as opposed to
 * fee variances, aging analyses or settlement breaks. Curated across the
 * Nigerian channel, mobile-money, LAPO and core taxonomies by suffix pattern —
 * new taxonomy keys following the same naming automatically participate.
 */
export const FAILED_TXN_CATEGORY_PATTERN =
  /(timeout_debit|debit_no_credit|debit_no_value|debit_unsettled|not_credited|credit_not_applied|inward_credit|dispense_error|short_dispense|declined_but_debited|debited_biller|dry_posting|reversal_missing|reversal_not_credited|reversal_unmatched|expired_session_debit|expired_code_debit|transaction_not_posted|fallback_debit|wallet_to_bank_failed|bank_to_wallet_failed|wallet_credit_failed|failed_ussd_debit)/;

export function isFailedTransactionCategory(category: string): boolean {
  return FAILED_TXN_CATEGORY_PATTERN.test(category);
}

export type FailedTxnBucket =
  | "reversed_within_24h"
  | "reversed_within_48h"
  | "reversed_late"
  | "unresolved";

/**
 * Bucket one failed-transaction exception against the CBN reversal windows.
 * Pure — unit-tested; `asOf` bounds the "unresolved" clock for month-end runs.
 */
export function bucketFailedTransaction(
  e: { createdAt: Date | string; resolvedAt: Date | string | null },
  asOf: Date,
): { bucket: FailedTxnBucket; resolutionHours: number | null } {
  const created = new Date(e.createdAt).getTime();
  if (e.resolvedAt) {
    const resolved = new Date(e.resolvedAt).getTime();
    const hours = Math.max(0, (resolved - created) / 3_600_000);
    if (hours <= 24) return { bucket: "reversed_within_24h", resolutionHours: hours };
    if (hours <= 48) return { bucket: "reversed_within_48h", resolutionHours: hours };
    return { bucket: "reversed_late", resolutionHours: hours };
  }
  const openHours = Math.max(0, (asOf.getTime() - created) / 3_600_000);
  return { bucket: "unresolved", resolutionHours: openHours };
}

/** ₦10,000 per item beyond the 24h window (CBN Instant EFT regulations). */
export const CBN_FAILED_TXN_SANCTION_NGN = 10_000;

export async function buildFailedTransactionsReturn(
  organizationId: number,
  from: Date,
  to: Date,
): Promise<ReportResult> {
  const meta = await buildMeta(
    organizationId,
    "FAILED TRANSACTIONS MONTHLY RETURN",
    `${dayKey(from)} to ${dayKey(to)}`,
    "CBN Directive on Monthly Reporting of Failed Transactions (April 2026); CBN Regulations on Instant EFT (₦10,000 per item unreversed >24h); CBN ATM Refund Guidelines (Oct 2025: 24h on-us / 48h not-on-us)",
  );
  const chans = await channelMap(organizationId);
  const all = await exceptionsInRange(organizationId, from, to);
  const failed = all.filter((e) => isFailedTransactionCategory(e.category ?? ""));

  interface ChannelAgg {
    count: number; value: number;
    w24: number; w48: number; late: number; unresolved: number;
    resolutionHoursSum: number; resolvedCount: number;
  }
  const byChannel = new Map<string, ChannelAgg>();
  let oldestUnresolvedDays = 0;

  for (const e of failed) {
    const channelName = chans.get(e.channelId)?.name ?? `Channel ${e.channelId}`;
    const agg = byChannel.get(channelName) ?? {
      count: 0, value: 0, w24: 0, w48: 0, late: 0, unresolved: 0,
      resolutionHoursSum: 0, resolvedCount: 0,
    };
    const amt = num(e.amount);
    agg.count += 1;
    agg.value = round2(agg.value + amt);
    const { bucket, resolutionHours } = bucketFailedTransaction(e, to);
    if (bucket === "reversed_within_24h") agg.w24 += 1;
    else if (bucket === "reversed_within_48h") agg.w48 += 1;
    else if (bucket === "reversed_late") agg.late += 1;
    else {
      agg.unresolved += 1;
      oldestUnresolvedDays = Math.max(oldestUnresolvedDays, Math.floor((resolutionHours ?? 0) / 24));
    }
    if (bucket !== "unresolved" && resolutionHours !== null) {
      agg.resolutionHoursSum += resolutionHours;
      agg.resolvedCount += 1;
    }
    byChannel.set(channelName, agg);
  }

  const columns = [
    "S/N", "Channel", "Failed Count", "Failed Value (NGN)",
    "Reversed ≤24h", "Reversed 24–48h", "Reversed >48h", "Unresolved at Period End",
    "24h Compliance Rate (%)", "Avg Resolution (hours)",
  ];
  const sorted = Array.from(byChannel.entries()).sort((a, b) => b[1].value - a[1].value);
  const rows: (string | number)[][] = sorted.map(([name, a], i) => {
    const compliance = a.count > 0 ? round2((a.w24 / a.count) * 100) : 100;
    const avgHours = a.resolvedCount > 0 ? round2(a.resolutionHoursSum / a.resolvedCount) : 0;
    return [
      i + 1, name, a.count, a.value.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      a.w24, a.w48, a.late, a.unresolved, compliance.toFixed(1) + "%", avgHours,
    ];
  });
  if (rows.length === 0) {
    rows.push([1, "No failed transactions recorded in period", 0, "0.00", 0, 0, 0, 0, "100.0%", 0]);
  }

  const totals = sorted.reduce(
    (t, [, a]) => ({
      count: t.count + a.count, value: round2(t.value + a.value),
      w24: t.w24 + a.w24, beyond: t.beyond + a.w48 + a.late + a.unresolved,
      unresolved: t.unresolved + a.unresolved,
    }),
    { count: 0, value: 0, w24: 0, beyond: 0, unresolved: 0 },
  );
  const sanctionExposure = totals.beyond * CBN_FAILED_TXN_SANCTION_NGN;

  return {
    meta, columns, rows,
    summary: {
      "Total failed transactions": totals.count,
      "Total failed value (NGN)": totals.value.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      "Reversed within 24h (compliant)": totals.w24,
      "Beyond the 24h window (48h/late/unresolved)": totals.beyond,
      "Overall 24h compliance rate": totals.count > 0 ? `${round2((totals.w24 / totals.count) * 100).toFixed(1)}%` : "100.0%",
      "Unresolved at period end": totals.unresolved,
      "Oldest unresolved item (days)": oldestUnresolvedDays,
      "Indicative sanction exposure @ ₦10,000/item (NGN)": sanctionExposure.toLocaleString("en-NG"),
    },
  };
}

// ─── 0. Unreconciled Items Aging Schedule (MFB-specific) ─────────────────────
// The MFB examination staple the original five reports lacked: unreconciled
// items aged 0–30 / 31–60 / 61–90 / 90+ days per channel, as of a date.
// Supports the OFISD monthly return pack and the Prudential Guidelines
// provisioning conversation (long-aged unreconciled debits attract provisions).

export async function buildUnreconciledAging(organizationId: number, asOf: string): Promise<ReportResult> {
  const meta = await buildMeta(
    organizationId,
    "UNRECONCILED ITEMS AGING SCHEDULE",
    `As of ${asOf}`,
    "CBN Prudential Guidelines (provisioning for aged unreconciled items); OFISD MFB monthly return support; CBN bank-reconciliation circulars",
  );
  const db = await getDb();
  const chans = await channelMap(organizationId);
  const asOfDate = new Date(`${asOf}T23:59:59.999Z`);

  type Bucket = { c0_30: number; v0_30: number; c31_60: number; v31_60: number; c61_90: number; v61_90: number; c90p: number; v90p: number; oldest: number };
  const mk = (): Bucket => ({ c0_30: 0, v0_30: 0, c31_60: 0, v31_60: 0, c61_90: 0, v61_90: 0, c90p: 0, v90p: 0, oldest: 0 });
  const byChannel = new Map<number, Bucket>();
  let totalValue = 0;
  let totalCount = 0;

  if (db) {
    const open = await db
      .select({
        channelId: transactions.channelId,
        amount: transactions.amount,
        transactionDate: transactions.transactionDate,
      })
      .from(transactions)
      .where(and(
        eq(transactions.organizationId, organizationId),
        inArray(transactions.status, ["unmatched", "exception"]),
        lte(transactions.transactionDate, asOfDate),
      ));

    for (const t of open) {
      const age = Math.max(0, Math.floor((asOfDate.getTime() - new Date(t.transactionDate).getTime()) / 86_400_000));
      const amt = num(t.amount);
      const b = byChannel.get(t.channelId) ?? mk();
      if (age <= 30) { b.c0_30++; b.v0_30 = round2(b.v0_30 + amt); }
      else if (age <= 60) { b.c31_60++; b.v31_60 = round2(b.v31_60 + amt); }
      else if (age <= 90) { b.c61_90++; b.v61_90 = round2(b.v61_90 + amt); }
      else { b.c90p++; b.v90p = round2(b.v90p + amt); }
      b.oldest = Math.max(b.oldest, age);
      byChannel.set(t.channelId, b);
      totalValue = round2(totalValue + amt);
      totalCount++;
    }
  }

  const fmt = (n: number) => n.toLocaleString("en-NG", { minimumFractionDigits: 2 });
  const columns = [
    "S/N", "Channel", "0–30 days (Count)", "0–30 days (NGN)", "31–60 days (Count)", "31–60 days (NGN)",
    "61–90 days (Count)", "61–90 days (NGN)", "Over 90 days (Count)", "Over 90 days (NGN)",
    "Oldest Item (days)", "Provisioning Flag",
  ];
  const sorted = Array.from(byChannel.entries()).sort(
    (a, b) => (b[1].v0_30 + b[1].v31_60 + b[1].v61_90 + b[1].v90p) - (a[1].v0_30 + a[1].v31_60 + a[1].v61_90 + a[1].v90p),
  );
  const rows: (string | number)[][] = sorted.map(([channelId, b], i) => [
    i + 1,
    chans.get(channelId)?.name ?? `Channel ${channelId}`,
    b.c0_30, fmt(b.v0_30), b.c31_60, fmt(b.v31_60), b.c61_90, fmt(b.v61_90), b.c90p, fmt(b.v90p),
    b.oldest,
    b.v90p > 0 ? "PROVISION (>90d)" : b.v61_90 > 0 ? "WATCH (61–90d)" : "NONE",
  ]);
  if (rows.length === 0) rows.push([1, "No unreconciled items as of this date", 0, "0.00", 0, "0.00", 0, "0.00", 0, "0.00", 0, "NONE"]);

  const over90 = sorted.reduce((s, [, b]) => round2(s + b.v90p), 0);
  return {
    meta, columns, rows,
    summary: {
      "Total unreconciled items": totalCount,
      "Total unreconciled value (NGN)": fmt(totalValue),
      "Value aged over 90 days (NGN)": fmt(over90),
      "Channels with provisioning-flag items": sorted.filter(([, b]) => b.v90p > 0).length,
      "Attestation note": "Items aged >90 days are candidates for provisioning per the Prudential Guidelines; dispositions must be evidenced in the exception log.",
    },
  };
}

// ─── 1. Daily Reconciliation Summary (CBN format) ─────────────────────────────

export async function buildDailyReconSummary(organizationId: number, date: string): Promise<ReportResult> {
  const from = new Date(`${date}T00:00:00.000Z`);
  const to = new Date(`${date}T23:59:59.999Z`);
  const meta = await buildMeta(
    organizationId,
    "DAILY RECONCILIATION SUMMARY",
    new Date(date).toLocaleDateString("en-NG", { day: "2-digit", month: "long", year: "numeric" }),
    "CBN Guidelines for the Regulation of Reconciliation & Settlement; NIBSS Operating Rules",
  );

  const jobs = await jobsInRange(organizationId, from, to);
  const chans = await channelMap(organizationId);

  // Unreconciled exposure = value of still-open exceptions raised that day,
  // attributed to the run (job) that raised them.
  const openExc = await exceptionsInRange(organizationId, from, to, true);
  const exposureByJob = new Map<number, number>();
  for (const e of openExc) {
    exposureByJob.set(e.jobId, round2((exposureByJob.get(e.jobId) ?? 0) + num(e.amount)));
  }
  const totExposure = round2(openExc.reduce((s, e) => s + num(e.amount), 0));

  const columns = [
    "S/N", "Reconciliation Account / Channel", "Total Transactions", "Matched",
    "Unmatched / Exceptions", "Match Rate (%)", "Unreconciled Exposure (NGN)",
    "CBN Threshold (95%)", "Status",
  ];
  const rows: (string | number)[][] = [];
  let totTxn = 0, totMatched = 0, totExc = 0;

  jobs.forEach((j, i) => {
    const src = chans.get(j.sourceChannelId)?.name ?? `Channel ${j.sourceChannelId}`;
    const tgt = chans.get(j.targetChannelId)?.name ?? `Channel ${j.targetChannelId}`;
    const totalTxn = j.totalSourceTxns + j.totalTargetTxns;
    const matched = j.matchedCount;
    const exc = j.exceptionCount;
    const mr = num(j.matchRate);
    const exposure = exposureByJob.get(j.id) ?? 0;
    totTxn += totalTxn; totMatched += matched; totExc += exc;
    rows.push([
      i + 1, `${src} vs ${tgt}`, totalTxn, matched, exc, mr.toFixed(2),
      exposure.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      "≥ 95.00", mr >= 95 ? "COMPLIANT" : "BREACH",
    ]);
  });

  const overallMr = totTxn > 0 ? round2((totMatched * 2 / totTxn) * 100) : 0;
  if (jobs.length === 0) {
    rows.push([1, "No completed reconciliation runs for this date", 0, 0, 0, "0.00", "0.00", "≥ 95.00", "NO ACTIVITY"]);
  }

  return {
    meta, columns, rows,
    summary: {
      "Reconciliation runs": jobs.length,
      "Total transactions reconciled": totTxn,
      "Total matched": totMatched,
      "Total exceptions": totExc,
      "Overall match rate (%)": overallMr.toFixed(2),
      "Unreconciled exposure (NGN)": totExposure.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      "Daily reconciliation performed": jobs.length > 0 ? "YES" : "NO",
    },
  };
}

// ─── 2. Exception Log with resolution status + audit trail ────────────────────

export async function buildExceptionLog(organizationId: number, from: Date, to: Date): Promise<ReportResult> {
  const meta = await buildMeta(
    organizationId,
    "RECONCILIATION EXCEPTION LOG & RESOLUTION REGISTER",
    `${dayKey(from)} to ${dayKey(to)}`,
    "CBN Prudential Guidelines — reconciliation exception tracking & aged-item resolution",
  );
  const exc = await exceptionsInRange(organizationId, from, to);
  const chans = await channelMap(organizationId);

  // Full audit trail: pull audit-log events for these exceptions and index by id.
  const db = await getDb();
  const trailById = new Map<number, number>();
  if (db && exc.length > 0) {
    const ids = exc.map((e) => e.id);
    const trail = await db.select({ entityId: auditLogs.entityId, n: sql<number>`count(*)` })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, "exception"), inArray(auditLogs.entityId, ids)))
      .groupBy(auditLogs.entityId);
    for (const t of trail) if (t.entityId != null) trailById.set(t.entityId, num(t.n));
  }

  const now = new Date();
  const columns = [
    "Exception ID", "Date Raised", "Channel", "Category", "Severity", "Amount (NGN)",
    "Counterparty", "Reference", "Status", "Assigned To", "Resolved By (user id)",
    "Resolved At", "Days Outstanding", "CBS Reflected", "Audit Events", "Resolution Notes",
  ];
  const rows: (string | number)[][] = exc.map((e) => {
    const endRef = e.resolvedAt ? new Date(e.resolvedAt) : now;
    const daysOut = Math.max(0, Math.floor((endRef.getTime() - new Date(e.createdAt).getTime()) / 86_400_000));
    const cbsReflected = e.status === "resolved"
      ? (e.cbsStillAnomalous ? "NO — still anomalous in CBS" : "Yes")
      : "n/a";
    return [
      e.id, dayKey(e.createdAt), chans.get(e.channelId)?.name ?? "—",
      String(e.category).replace(/_/g, " "), e.severity,
      num(e.amount).toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      e.counterparty ?? "—", e.transactionRef ?? "—", String(e.status).toUpperCase(),
      e.assigneeName ?? "Unassigned", e.resolvedBy ?? "—",
      e.resolvedAt ? dayKey(e.resolvedAt) : "—", daysOut, cbsReflected,
      trailById.get(e.id) ?? 0, (e.resolutionNotes ?? "").replace(/\s+/g, " ").slice(0, 300),
    ];
  });

  const open = exc.filter((e) => ["open", "in_review", "escalated"].includes(String(e.status)));
  const resolved = exc.filter((e) => ["resolved", "dismissed"].includes(String(e.status)));
  return {
    meta, columns, rows,
    summary: {
      "Total exceptions in period": exc.length,
      "Open / unresolved": open.length,
      "Resolved / dismissed": resolved.length,
      "Resolution rate (%)": exc.length ? round2((resolved.length / exc.length) * 100).toFixed(2) : "0.00",
      "Open exposure (NGN)": round2(open.reduce((s, e) => s + num(e.amount), 0)).toLocaleString("en-NG", { minimumFractionDigits: 2 }),
    },
  };
}

// ─── 3. Counterparty Exposure Report ──────────────────────────────────────────

export async function buildCounterpartyExposure(organizationId: number, from: Date, to: Date): Promise<ReportResult> {
  const meta = await buildMeta(
    organizationId,
    "COUNTERPARTY EXPOSURE REPORT (UNRECONCILED ITEMS)",
    `${dayKey(from)} to ${dayKey(to)}`,
    "CBN Prudential Guidelines — counterparty concentration & unreconciled exposure",
  );
  const open = await exceptionsInRange(organizationId, from, to, true);
  const now = new Date();

  const byCp = new Map<string, { count: number; exposure: number; oldest: number; max: number }>();
  for (const e of open) {
    const cp = (e.counterparty && e.counterparty.trim()) ? e.counterparty.trim() : "Unidentified counterparty";
    const age = Math.max(0, Math.floor((now.getTime() - new Date(e.createdAt).getTime()) / 86_400_000));
    const amt = num(e.amount);
    const b = byCp.get(cp) ?? { count: 0, exposure: 0, oldest: 0, max: 0 };
    b.count += 1; b.exposure = round2(b.exposure + amt); b.oldest = Math.max(b.oldest, age); b.max = Math.max(b.max, amt);
    byCp.set(cp, b);
  }
  const totalExposure = round2(Array.from(byCp.values()).reduce((s, b) => s + b.exposure, 0));
  const sorted = Array.from(byCp.entries()).sort((a, b) => b[1].exposure - a[1].exposure);

  const columns = [
    "S/N", "Counterparty", "Open Items", "Total Exposure (NGN)", "% of Total Exposure",
    "Largest Single Item (NGN)", "Oldest Item (days)", "Concentration Risk",
  ];
  const rows: (string | number)[][] = sorted.map(([cp, b], i) => {
    const pct = totalExposure > 0 ? round2((b.exposure / totalExposure) * 100) : 0;
    const risk = pct >= 20 || b.oldest > 30 ? "HIGH" : pct >= 10 || b.oldest > 14 ? "MEDIUM" : "LOW";
    return [
      i + 1, cp, b.count, b.exposure.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      pct.toFixed(2) + "%", b.max.toLocaleString("en-NG", { minimumFractionDigits: 2 }), b.oldest, risk,
    ];
  });
  if (rows.length === 0) rows.push([1, "No unreconciled counterparty exposure in period", 0, "0.00", "0.00%", "0.00", 0, "NONE"]);

  return {
    meta, columns, rows,
    summary: {
      "Distinct counterparties with open exposure": byCp.size,
      "Total unreconciled exposure (NGN)": totalExposure.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      "Largest counterparty exposure (NGN)": (sorted[0]?.[1].exposure ?? 0).toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      "High-concentration counterparties": rows.filter((r) => r[7] === "HIGH").length,
    },
  };
}

// ─── 4. Interbank Settlement Reconciliation (NIBSS format) ────────────────────

export async function buildInterbankSettlement(organizationId: number, from: Date, to: Date): Promise<ReportResult> {
  const meta = await buildMeta(
    organizationId,
    "INTERBANK SETTLEMENT RECONCILIATION (NIBSS)",
    `${dayKey(from)} to ${dayKey(to)}`,
    "NIBSS Instant Payment (NIP) Operating Rules; CBN RTGS Guidelines",
  );
  const db = await getDb();
  const chans = await channelMap(organizationId);
  // Interbank/settlement channels: NIBSS, RTGS, SWIFT.
  const interbankChannelIds = new Set(
    Array.from(chans.entries()).filter(([, c]) => ["nibss", "rtgs", "swift"].includes(c.type)).map(([id]) => id),
  );

  const columns = [
    "Settlement Date", "Instrument / Channel", "Volume (Count)", "Value (NGN)",
    "Matched Value (NGN)", "Unreconciled Value (NGN)", "Match Rate (%)", "Status",
  ];
  const rows: (string | number)[][] = [];
  let totVol = 0, totVal = 0, totMatchedVal = 0, totUnrec = 0;

  if (db && interbankChannelIds.size > 0) {
    // Aggregate transactions on interbank channels by day + channel.
    const txns = await db.select({
      channelId: transactions.channelId,
      amount: transactions.amount,
      status: transactions.status,
      transactionDate: transactions.transactionDate,
    }).from(transactions).where(and(
      eq(transactions.organizationId, organizationId),
      inArray(transactions.channelId, Array.from(interbankChannelIds)),
      gte(transactions.transactionDate, from),
      lte(transactions.transactionDate, to),
    ));

    const agg = new Map<string, { channelId: number; vol: number; val: number; matchedVal: number }>();
    for (const t of txns) {
      const key = `${dayKey(t.transactionDate)}|${t.channelId}`;
      const b = agg.get(key) ?? { channelId: t.channelId, vol: 0, val: 0, matchedVal: 0 };
      const amt = num(t.amount);
      b.vol += 1; b.val = round2(b.val + amt);
      if (t.status === "matched" || t.status === "manually_matched") b.matchedVal = round2(b.matchedVal + amt);
      agg.set(key, b);
    }
    const keys = Array.from(agg.keys()).sort();
    for (const key of keys) {
      const [d] = key.split("|");
      const b = agg.get(key)!;
      const unrec = round2(b.val - b.matchedVal);
      const mr = b.val > 0 ? round2((b.matchedVal / b.val) * 100) : 0;
      totVol += b.vol; totVal = round2(totVal + b.val); totMatchedVal = round2(totMatchedVal + b.matchedVal); totUnrec = round2(totUnrec + unrec);
      rows.push([
        d, chans.get(b.channelId)?.name ?? `Channel ${b.channelId}`, b.vol,
        b.val.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
        b.matchedVal.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
        unrec.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
        mr.toFixed(2), mr >= 99.5 ? "SETTLED" : unrec > 0 ? "VARIANCE" : "SETTLED",
      ]);
    }
  }
  if (rows.length === 0) {
    rows.push(["—", "No interbank (NIBSS/RTGS/SWIFT) settlement channels configured or no activity in period", 0, "0.00", "0.00", "0.00", "0.00", "NO ACTIVITY"]);
  }
  const overallMr = totVal > 0 ? round2((totMatchedVal / totVal) * 100) : 0;

  return {
    meta, columns, rows,
    summary: {
      "Interbank channels": interbankChannelIds.size,
      "Total settlement volume": totVol,
      "Total settlement value (NGN)": totVal.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      "Reconciled value (NGN)": totMatchedVal.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      "Unreconciled value (NGN)": totUnrec.toLocaleString("en-NG", { minimumFractionDigits: 2 }),
      "Settlement match rate (%)": overallMr.toFixed(2),
    },
  };
}

// ─── 5. Monthly Compliance Attestation ────────────────────────────────────────

/** Build the attestation payload (to be signed by the router). `month` is YYYY-MM. */
export async function buildMonthlyAttestation(organizationId: number, month: string) {
  const from = new Date(`${month}-01T00:00:00.000Z`);
  const to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1); to.setUTCMilliseconds(-1);
  const monthLabel = from.toLocaleDateString("en-NG", { month: "long", year: "numeric" });
  const settings = await getReportSettings(organizationId);

  const jobs = await jobsInRange(organizationId, from, to);
  const exc = await exceptionsInRange(organizationId, from, to);
  const open = exc.filter((e) => ["open", "in_review", "escalated"].includes(String(e.status)));
  const resolved = exc.filter((e) => ["resolved", "dismissed"].includes(String(e.status)));

  const totTxn = jobs.reduce((s, j) => s + j.totalSourceTxns + j.totalTargetTxns, 0);
  const totMatched = jobs.reduce((s, j) => s + j.matchedCount, 0);
  const matchRate = totTxn > 0 ? round2((totMatched * 2 / totTxn) * 100) : 0;
  const exceptionRatio = totTxn > 0 ? round2((exc.length / totTxn) * 100) : 0;
  const openExposure = round2(open.reduce((s, e) => s + num(e.amount), 0));

  const thresholds = [
    { label: "Settlement match rate", value: matchRate, threshold: 95, unit: "%", ok: matchRate >= 95 },
    { label: "Exception-to-transaction ratio", value: exceptionRatio, threshold: 5, unit: "%", ok: exceptionRatio <= 5 },
    { label: "Open exceptions at month end", value: open.length, threshold: 50, unit: "", ok: open.length <= 50 },
  ];
  const overallStatus = thresholds.every((t) => t.ok) ? "COMPLIANT" : "REMEDIATION REQUIRED";

  return {
    monthLabel,
    periodStart: from,
    periodEnd: to,
    institution: {
      name: settings?.institutionName || "[Institution name not set]",
      type: INSTITUTION_TYPE_LABEL[settings?.institutionType ?? "microfinance_bank"],
      rcNumber: settings?.rcNumber || "—",
      cbnLicenseNumber: settings?.cbnLicenseNumber || "—",
    },
    metrics: {
      reconciliationRuns: jobs.length,
      transactionsReconciled: totTxn,
      matchRate,
      exceptionRatio,
      exceptionsRaised: exc.length,
      exceptionsResolved: resolved.length,
      openExceptions: open.length,
      openExposureNGN: openExposure,
    },
    thresholds,
    overallStatus,
    attestation:
      `I attest that ${settings?.institutionName || "the institution"} performed reconciliation across all ` +
      `settlement channels for ${monthLabel}, that the figures above are derived from the institution's ` +
      `reconciliation records, and that outstanding exceptions are being managed in line with CBN requirements.`,
    attestingOfficer: {
      name: settings?.attestingOfficerName || "",
      title: settings?.attestingOfficerTitle || "",
    },
  };
}
