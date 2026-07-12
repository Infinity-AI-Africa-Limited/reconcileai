/**
 * Bank of Uganda (BoU) NPS-framework report pack (validation gap G2).
 *
 * The Ugandan counterpart to the CBN report module — same builder pattern,
 * same ReportResult/toCsv shape (regulator-aware identity block), UGX
 * currency, BoU regulatory basis. Data-driven from the Uganda channel pack
 * (UG_* channels) and taxonomy (ug_* categories); empty-safe before a Ugandan
 * tenant exists. Formats are conventions-based and refine when a licensed
 * Ugandan institution confirms BoU's exact return templates.
 *
 * Three returns, chosen for what a BoU-licensed PSP/bank actually must evidence:
 *   1. Trust Account & Suspense Integrity  — the licence-critical control
 *      (e-money 1:1 backing + the MTN-style suspense-fraud surface).
 *   2. Agent Rail & Mobile Money Settlement — the ABC shared-rail + MoMo
 *      daily settlement position (Agent Banking Regulations 2017).
 *   3. Failed Transactions & Reversals     — consumer-protection reversals on
 *      the mobile-money rails, BoU-framed.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { transactions } from "../drizzle/schema";
import { getDb } from "./db";
import {
  buildMeta,
  bucketFailedTransaction,
  channelMap,
  dayKey,
  exceptionsInRange,
  isFailedTransactionCategory,
  num,
  round2,
  type ReportResult,
} from "./cbnReports";

const UGX = "UGX";
const fmtUgx = (n: number) => n.toLocaleString("en-UG", { minimumFractionDigits: 0 });

/** Age band for an open control item — pure, unit-tested. */
export type AgeBand = "0-3d" | "4-7d" | "8-30d" | "30+d";
export function bucketByAgeDays(days: number): AgeBand {
  if (days <= 3) return "0-3d";
  if (days <= 7) return "4-7d";
  if (days <= 30) return "8-30d";
  return "30+d";
}

/** UG_* channels for this org (the Uganda channel pack). */
async function ugandaChannelIds(organizationId: number): Promise<Map<number, string>> {
  const chans = await channelMap(organizationId);
  const out = new Map<number, string>();
  for (const [id, c] of Array.from(chans.entries())) {
    if (c.code.startsWith("UG_")) out.set(id, c.name);
  }
  return out;
}

// ─── 1. Trust Account & Suspense Integrity Return ────────────────────────────
const TRUST_INTEGRITY_CATEGORIES: Record<string, string> = {
  ug_trust_account_mismatch: "E-Money Trust Account Backing",
  ug_wallet_liability_orphan: "Wallet Liability Without Rail Record",
  ug_suspense_aged_entry: "Suspense Account Integrity",
};

export async function buildTrustIntegrityReturn(
  organizationId: number,
  from: Date,
  to: Date,
): Promise<ReportResult> {
  const meta = await buildMeta(
    organizationId,
    "E-MONEY TRUST ACCOUNT & SUSPENSE INTEGRITY RETURN",
    `${dayKey(from)} to ${dayKey(to)}`,
    "Bank of Uganda National Payment Systems Act 2020 (e-money 1:1 trust backing); BoU PSP licence conditions; internal-control standards on suspense-account integrity",
    { currency: UGX, regulator: "BoU" },
  );
  const rows_ex = await exceptionsInRange(organizationId, from, to);
  const relevant = rows_ex.filter((e) => e.category != null && e.category in TRUST_INTEGRITY_CATEGORIES);

  interface Agg { open: number; total: number; value: number; resolved: number; oldestDays: number }
  const byArea = new Map<string, Agg>();
  for (const key of Object.keys(TRUST_INTEGRITY_CATEGORIES)) {
    byArea.set(key, { open: 0, total: 0, value: 0, resolved: 0, oldestDays: 0 });
  }
  for (const e of relevant) {
    const a = byArea.get(e.category as string)!;
    a.total += 1;
    a.value = round2(a.value + num(e.amount));
    if (e.resolvedAt) a.resolved += 1;
    else {
      a.open += 1;
      const days = Math.floor((to.getTime() - new Date(e.createdAt).getTime()) / 86_400_000);
      a.oldestDays = Math.max(a.oldestDays, days);
    }
  }

  const columns = [
    "S/N", "Control Area", "Total Items", "Total Value (UGX)",
    "Resolved in Period", "Unresolved at Period End", "Oldest Unresolved (days)", "Control Status",
  ];
  const rows: (string | number)[][] = Object.entries(TRUST_INTEGRITY_CATEGORIES).map(([key, label], i) => {
    const a = byArea.get(key)!;
    const status = a.open === 0 ? "SATISFACTORY" : a.oldestDays > 3 ? "BREACH — ESCALATE" : "OPEN — WITHIN SLA";
    return [i + 1, label, a.total, fmtUgx(a.value), a.resolved, a.open, a.oldestDays, status];
  });

  const totalOpen = Array.from(byArea.values()).reduce((s, a) => s + a.open, 0);
  const backing = byArea.get("ug_trust_account_mismatch")!;
  return {
    meta, columns, rows,
    summary: {
      "Trust-account backing status": backing.open === 0 ? "1:1 backing evidenced (no open mismatch)" : `${backing.open} open backing exception(s) — reportable to BoU`,
      "Suspense integrity — open items": byArea.get("ug_suspense_aged_entry")!.open,
      "Wallet-liability orphans (potential integrity incidents)": byArea.get("ug_wallet_liability_orphan")!.open,
      "Total open control items": totalOpen,
      "Overall control posture": totalOpen === 0 ? "SATISFACTORY" : "ATTENTION REQUIRED",
    },
  };
}

// ─── 2. Agent Rail & Mobile Money Settlement Summary ─────────────────────────
export async function buildAgentRailSettlement(
  organizationId: number,
  from: Date,
  to: Date,
): Promise<ReportResult> {
  const meta = await buildMeta(
    organizationId,
    "AGENT RAIL & MOBILE MONEY SETTLEMENT SUMMARY",
    `${dayKey(from)} to ${dayKey(to)}`,
    "Bank of Uganda Financial Institutions (Agent Banking) Regulations 2017 (daily agent settlement reconciliation); NPS Act 2020 (mobile-money settlement)",
    { currency: UGX, regulator: "BoU" },
  );
  const ugChannels = await ugandaChannelIds(organizationId);

  const columns = [
    "S/N", "Rail / Channel", "Volume", "Value (UGX)", "Matched Value (UGX)",
    "Unreconciled Value (UGX)", "Match Rate (%)", "Status",
  ];
  const rows: (string | number)[][] = [];
  let totVol = 0, totVal = 0, totMatched = 0;

  const db = await getDb();
  if (db && ugChannels.size > 0) {
    const txns = await db.select({
      channelId: transactions.channelId,
      amount: transactions.amount,
      status: transactions.status,
    }).from(transactions).where(and(
      eq(transactions.organizationId, organizationId),
      inArray(transactions.channelId, Array.from(ugChannels.keys())),
      gte(transactions.transactionDate, from),
      lte(transactions.transactionDate, to),
    ));

    const agg = new Map<number, { vol: number; val: number; matched: number }>();
    for (const t of txns) {
      const b = agg.get(t.channelId) ?? { vol: 0, val: 0, matched: 0 };
      const amt = num(t.amount);
      b.vol += 1;
      b.val = round2(b.val + amt);
      if (t.status === "matched" || t.status === "manually_matched") b.matched = round2(b.matched + amt);
      agg.set(t.channelId, b);
    }
    const sorted = Array.from(agg.entries()).sort((a, b) => b[1].val - a[1].val);
    sorted.forEach(([channelId, b], i) => {
      const unrec = round2(b.val - b.matched);
      const mr = b.val > 0 ? round2((b.matched / b.val) * 100) : 100;
      totVol += b.vol; totVal = round2(totVal + b.val); totMatched = round2(totMatched + b.matched);
      rows.push([
        i + 1, ugChannels.get(channelId) ?? `Channel ${channelId}`, b.vol,
        fmtUgx(b.val), fmtUgx(b.matched), fmtUgx(unrec), mr.toFixed(1) + "%",
        mr >= 99.5 ? "RECONCILED" : mr >= 95 ? "MINOR VARIANCE" : "REVIEW",
      ]);
    });
  }
  if (rows.length === 0) rows.push([1, "No Ugandan rail activity in period", 0, "0", "0", "0", "100.0%", "RECONCILED"]);

  const totUnrec = round2(totVal - totMatched);
  return {
    meta, columns, rows,
    summary: {
      "Total volume": totVol,
      "Total value (UGX)": fmtUgx(totVal),
      "Matched value (UGX)": fmtUgx(totMatched),
      "Unreconciled value (UGX)": fmtUgx(totUnrec),
      "Overall match rate": totVal > 0 ? `${round2((totMatched / totVal) * 100).toFixed(1)}%` : "100.0%",
    },
  };
}

// ─── 4. Suspense & Integrity Aging Schedule ──────────────────────────────────
// The MTN Uganda fraud was suspense-account manipulation; BoU examiners
// scrutinise how long integrity items sit open. This ages the fraud-adjacent
// classes and flags anything beyond the 3-day control window.
const INTEGRITY_CATEGORIES: Record<string, string> = {
  ug_suspense_aged_entry: "Suspense Account Entries",
  ug_orphan_reversal: "Reversals Without Original",
  ug_wallet_liability_orphan: "Wallet Liabilities Without Rail Record",
  ug_duplicate_wallet_credit: "Duplicate Wallet Credits (Excess E-Money)",
};

export async function buildSuspenseIntegrityAging(
  organizationId: number,
  from: Date,
  to: Date,
): Promise<ReportResult> {
  const meta = await buildMeta(
    organizationId,
    "SUSPENSE & INTEGRITY AGING SCHEDULE",
    `Open items as of ${dayKey(to)} (raised ${dayKey(from)}–${dayKey(to)})`,
    "Bank of Uganda internal-control and fraud-risk standards on suspense-account integrity (NPS Act 2020; the MTN suspense-manipulation precedent)",
    { currency: UGX, regulator: "BoU" },
  );
  const rows_ex = await exceptionsInRange(organizationId, from, to);
  const open = rows_ex.filter(
    (e) => e.category != null && e.category in INTEGRITY_CATEGORIES && !e.resolvedAt,
  );

  interface Agg { count: number; value: number; b0: number; b1: number; b2: number; b3: number; oldest: number }
  const byCat = new Map<string, Agg>();
  for (const key of Object.keys(INTEGRITY_CATEGORIES)) {
    byCat.set(key, { count: 0, value: 0, b0: 0, b1: 0, b2: 0, b3: 0, oldest: 0 });
  }
  for (const e of open) {
    const a = byCat.get(e.category as string)!;
    const days = Math.max(0, Math.floor((to.getTime() - new Date(e.createdAt).getTime()) / 86_400_000));
    a.count += 1;
    a.value = round2(a.value + num(e.amount));
    a.oldest = Math.max(a.oldest, days);
    const band = bucketByAgeDays(days);
    if (band === "0-3d") a.b0 += 1;
    else if (band === "4-7d") a.b1 += 1;
    else if (band === "8-30d") a.b2 += 1;
    else a.b3 += 1;
  }

  const columns = [
    "S/N", "Integrity Control Area", "Open Items", "Value (UGX)",
    "0–3 days", "4–7 days", "8–30 days", "30+ days", "Oldest (days)", "Control Status",
  ];
  const rows: (string | number)[][] = Object.entries(INTEGRITY_CATEGORIES).map(([key, label], i) => {
    const a = byCat.get(key)!;
    const beyondWindow = a.b1 + a.b2 + a.b3; // anything past the 3-day control window
    const status = a.count === 0 ? "CLEAN" : beyondWindow === 0 ? "WITHIN WINDOW" : a.b3 > 0 ? "OVERDUE — INVESTIGATE" : "ATTENTION";
    return [i + 1, label, a.count, fmtUgx(a.value), a.b0, a.b1, a.b2, a.b3, a.oldest, status];
  });

  const tot = Array.from(byCat.values()).reduce(
    (t, a) => ({ count: t.count + a.count, beyond: t.beyond + a.b1 + a.b2 + a.b3, over30: t.over30 + a.b3 }),
    { count: 0, beyond: 0, over30: 0 },
  );
  return {
    meta, columns, rows,
    summary: {
      "Total open integrity items": tot.count,
      "Beyond the 3-day control window": tot.beyond,
      "Aged over 30 days (examiner red flags)": tot.over30,
      "Overall integrity posture": tot.over30 > 0 ? "OVERDUE ITEMS PRESENT — INVESTIGATE" : tot.beyond > 0 ? "ATTENTION" : "SATISFACTORY",
    },
  };
}

// ─── 5. Digital Nano-Lending Reconciliation (MoKash / Wewole) ────────────────
export async function buildDigitalLendingRecon(
  organizationId: number,
  from: Date,
  to: Date,
): Promise<ReportResult> {
  const meta = await buildMeta(
    organizationId,
    "DIGITAL NANO-LENDING RECONCILIATION (MoKash / Wewole)",
    `${dayKey(from)} to ${dayKey(to)}`,
    "Telco↔bank nano-loan reconciliation (MoKash MTN/NCBA, Wewole Airtel/Jumo): disbursement/repayment integrity and 72h CRB update obligation",
    { currency: UGX, regulator: "BoU" },
  );
  const ugChannels = await ugandaChannelIds(organizationId);
  const lendingChannelId = Array.from(ugChannels.entries()).find(([, name]) => /Nano-Lending/i.test(name))?.[0];

  // Volume/value of disbursements (credits) and repayments (debits) on the rail.
  let disbCount = 0, disbValue = 0, repayCount = 0, repayValue = 0;
  const db = await getDb();
  if (db && lendingChannelId != null) {
    const txns = await db.select({
      amount: transactions.amount,
      debitCredit: transactions.debitCredit,
    }).from(transactions).where(and(
      eq(transactions.organizationId, organizationId),
      eq(transactions.channelId, lendingChannelId),
      gte(transactions.transactionDate, from),
      lte(transactions.transactionDate, to),
    ));
    for (const t of txns) {
      const amt = num(t.amount);
      if (t.debitCredit === "credit") { disbCount++; disbValue = round2(disbValue + amt); }
      else { repayCount++; repayValue = round2(repayValue + amt); }
    }
  }

  // Open lending-integrity exceptions.
  const rows_ex = await exceptionsInRange(organizationId, from, to);
  const cat = (e: { category: unknown }) => String(e.category ?? "");
  const disbMismatch = rows_ex.filter((e) => cat(e) === "ug_digital_loan_disbursement_mismatch" && !e.resolvedAt);
  const repayUnapplied = rows_ex.filter((e) => cat(e) === "ug_digital_loan_repayment_unapplied" && !e.resolvedAt);
  const dormant = rows_ex.filter((e) => cat(e) === "ug_dormant_wallet_balance" && !e.resolvedAt);
  const crbAtRisk = repayUnapplied.filter(
    (e) => Math.floor((to.getTime() - new Date(e.createdAt).getTime()) / 3_600_000) > 72,
  ).length;

  const columns = ["Metric", "Count", "Value (UGX)"];
  const rows: (string | number)[][] = [
    ["Disbursements to wallet", disbCount, fmtUgx(disbValue)],
    ["Repayments collected", repayCount, fmtUgx(repayValue)],
    ["Disbursements not booked in lending ledger", disbMismatch.length, fmtUgx(disbMismatch.reduce((s, e) => s + num(e.amount), 0))],
    ["Repayments collected not applied", repayUnapplied.length, fmtUgx(repayUnapplied.reduce((s, e) => s + num(e.amount), 0))],
    ["Dormant loan/savings balances flagged", dormant.length, fmtUgx(dormant.reduce((s, e) => s + num(e.amount), 0))],
  ];

  return {
    meta, columns, rows,
    summary: {
      "Net lending flow (disbursed − repaid) (UGX)": fmtUgx(round2(disbValue - repayValue)),
      "Open disbursement mismatches": disbMismatch.length,
      "Open unapplied repayments": repayUnapplied.length,
      "Unapplied repayments past the 72h CRB window": crbAtRisk,
      "Reconciliation status": disbMismatch.length + repayUnapplied.length === 0 ? "RECONCILED" : "OPEN ITEMS — REVIEW",
    },
  };
}

// ─── 3. Failed Transactions & Reversals Return (BoU) ─────────────────────────
export async function buildBouFailedTransactions(
  organizationId: number,
  from: Date,
  to: Date,
): Promise<ReportResult> {
  const meta = await buildMeta(
    organizationId,
    "FAILED TRANSACTIONS & REVERSALS RETURN",
    `${dayKey(from)} to ${dayKey(to)}`,
    "Bank of Uganda NPS Act 2020 consumer-protection expectations on failed-transaction reversals across mobile-money and agent rails",
    { currency: UGX, regulator: "BoU" },
  );
  const ugChannels = await ugandaChannelIds(organizationId);
  const all = await exceptionsInRange(organizationId, from, to);
  const failed = all.filter(
    (e) => isFailedTransactionCategory(e.category ?? "") && ugChannels.has(e.channelId),
  );

  interface Agg { count: number; value: number; w24: number; late: number; unresolved: number }
  const byChannel = new Map<string, Agg>();
  for (const e of failed) {
    const name = ugChannels.get(e.channelId) ?? `Channel ${e.channelId}`;
    const a = byChannel.get(name) ?? { count: 0, value: 0, w24: 0, late: 0, unresolved: 0 };
    a.count += 1;
    a.value = round2(a.value + num(e.amount));
    const { bucket } = bucketFailedTransaction(e, to);
    if (bucket === "reversed_within_24h" || bucket === "reversed_within_48h") a.w24 += 1;
    else if (bucket === "reversed_late") a.late += 1;
    else a.unresolved += 1;
    byChannel.set(name, a);
  }

  const columns = [
    "S/N", "Rail / Channel", "Failed Count", "Failed Value (UGX)",
    "Reversed in Time", "Reversed Late", "Unresolved at Period End", "Reversal Compliance (%)",
  ];
  const sorted = Array.from(byChannel.entries()).sort((a, b) => b[1].value - a[1].value);
  const rows: (string | number)[][] = sorted.map(([name, a], i) => {
    const compliance = a.count > 0 ? round2((a.w24 / a.count) * 100) : 100;
    return [i + 1, name, a.count, fmtUgx(a.value), a.w24, a.late, a.unresolved, compliance.toFixed(1) + "%"];
  });
  if (rows.length === 0) rows.push([1, "No failed transactions on Ugandan rails in period", 0, "0", 0, 0, 0, "100.0%"]);

  const tot = sorted.reduce(
    (t, [, a]) => ({ count: t.count + a.count, w24: t.w24 + a.w24, unresolved: t.unresolved + a.unresolved }),
    { count: 0, w24: 0, unresolved: 0 },
  );
  return {
    meta, columns, rows,
    summary: {
      "Total failed transactions": tot.count,
      "Reversed within window (compliant)": tot.w24,
      "Unresolved at period end": tot.unresolved,
      "Overall reversal compliance": tot.count > 0 ? `${round2((tot.w24 / tot.count) * 100).toFixed(1)}%` : "100.0%",
    },
  };
}
