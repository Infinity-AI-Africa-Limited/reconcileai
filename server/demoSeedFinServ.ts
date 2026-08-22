/**
 * Financial-services operational demo seed.
 *
 * This is deliberately a compact, internally consistent control dataset—not a
 * synthetic claim about millions of rows. It creates 320 settlement items and
 * 320 corresponding core-banking postings across eight rails. 304 pairs match;
 * 16 realistic reconciliation cases drive the Transactions, Exceptions, Review
 * Queue, Age Tracker, Dashboard, Multi-Channel, Super Agent and Audit views.
 */

import { and, eq, inArray, like, or } from "drizzle-orm";
import {
  agentMemory,
  channels,
  exceptions,
  matches,
  reconciliationJobs,
  transactions,
  uploadBatches,
} from "../drizzle/schema";
import { getDb, invalidateDashboardStatsCache, orgFilter } from "./db";

type FinServRailCode =
  | "NIBSS_NIP"
  | "DIRECT_DEBIT"
  | "USSD_BANKING"
  | "MOBILE_APP"
  | "CORE_BANKING"
  | "POS_TERMINAL"
  | "CARD_PAYMENT"
  | "AGENT_BANKING";

type ExceptionStatus = "open" | "in_review" | "resolved" | "escalated";
type ExceptionCategory =
  | "missing_counterparty"
  | "amount_mismatch"
  | "timing_difference"
  | "duplicate_transaction"
  | "unmatched"
  | "reversal_unmatched"
  | "currency_mismatch"
  | "fx_rate_variance"
  | "format_error";

const DEMO_MARKER = "finserv-operational-demo-v1";

/**
 * The organisation id earlier seeders used when the caller had none.
 *
 * Zero is not a tenant and never was — no `organizations` row has it. Rows
 * written under it are invisible to every org-scoped read and shared by every
 * org-less caller, which is the same defect as the 14 unreachable distributor
 * rows in CLAUDE.md §19.2. Nothing writes it any more; this constant exists so
 * cleanup can still find what was written before.
 */
const LEGACY_PSEUDO_TENANT_ID = 0;
const MATCHED_PAIRS = 304;
const EXCEPTION_CASES = 16;
const SETTLEMENT_ITEMS = MATCHED_PAIRS + EXCEPTION_CASES;

const PAYMENT_RAILS: Array<{
  code: FinServRailCode;
  name: string;
  channelType: string;
  description: string;
}> = [
  {
    code: "NIBSS_NIP",
    name: "NIBSS NIP Settlement",
    channelType: "nibss",
    description: "Inbound and outbound NIP settlement control feed",
  },
  {
    code: "DIRECT_DEBIT",
    name: "NIBSS Direct Debit",
    channelType: "bank_transfer",
    description: "Mandate collection and return reconciliation feed",
  },
  {
    code: "USSD_BANKING",
    name: "USSD Banking",
    channelType: "mobile_money",
    description: "USSD payment and loan-repayment control feed",
  },
  {
    code: "MOBILE_APP",
    name: "Mobile Banking App",
    channelType: "mobile_money",
    description: "Mobile-app transfer and disbursement control feed",
  },
  {
    code: "CORE_BANKING",
    name: "Core Banking Ledger",
    channelType: "bank_core",
    description: "Core-banking ledger postings used as the reconciliation target",
  },
  {
    code: "POS_TERMINAL",
    name: "POS Acquirer Settlement",
    channelType: "pos",
    description: "POS acquiring, reversal and merchant-settlement control feed",
  },
  {
    code: "CARD_PAYMENT",
    name: "Card Scheme Settlement",
    channelType: "card_payments",
    description: "Card-scheme clearing, settlement and FX-variance control feed",
  },
  {
    code: "AGENT_BANKING",
    name: "Agent Banking Collection",
    channelType: "mobile_money",
    description: "Agent collection and float-settlement control feed",
  },
];

export type FinServOperationalCase = {
  id: string;
  railCode: FinServRailCode;
  category: ExceptionCategory;
  severity: "low" | "medium" | "high" | "critical";
  status: ExceptionStatus;
  ageDays: number;
  sourceAmount: string;
  targetAmount: string;
  sourceRef: string;
  targetRef: string;
  sourceDescription: string;
  targetDescription: string;
  counterparty: string;
  rootCause: string;
  recommendedAction: string;
  plainLanguage: string;
  confidence: number;
  resolutionNotes?: string;
  isReversal?: boolean;
  cbsStillAnomalous?: boolean;
};

/**
 * These are fictional, representative operational cases. Account references are
 * deliberately non-live identifiers so a bank demo cannot be mistaken for real
 * customer or settlement data.
 */
export const FINSERV_OPERATIONAL_CASES: FinServOperationalCase[] = [
  {
    id: "FS-DEMO-001",
    railCode: "NIBSS_NIP",
    category: "duplicate_transaction",
    severity: "high",
    status: "open",
    ageDays: 0,
    sourceAmount: "125000.00",
    targetAmount: "125000.00",
    sourceRef: "NIP-DEMO-20260814-0001-R",
    targetRef: "CBS-DEMO-LN-0001",
    sourceDescription: "NIP repayment retry after gateway timeout",
    targetDescription: "Loan repayment posting expected once",
    counterparty: "Demo Customer A",
    rootCause: "A NIP timeout retry produced two settlement messages for one loan-repayment instruction.",
    recommendedAction: "Confirm the original posting, reverse the duplicate credit and notify operations.",
    plainLanguage: "The same repayment arrived twice after a retry. Keep one and reverse the duplicate.",
    confidence: 0.98,
  },
  {
    id: "FS-DEMO-002",
    railCode: "DIRECT_DEBIT",
    category: "unmatched",
    severity: "critical",
    status: "open",
    ageDays: 3,
    sourceAmount: "0.00",
    targetAmount: "75000.00",
    sourceRef: "DD-DEMO-RETURN-0002",
    targetRef: "CBS-DEMO-LN-0002",
    sourceDescription: "Direct-debit mandate return — insufficient funds",
    targetDescription: "Scheduled loan repayment due",
    counterparty: "Demo Customer B",
    rootCause: "The direct-debit mandate returned unpaid while the core ledger still carries the scheduled repayment.",
    recommendedAction: "Create a collections work item and route the account for credit-policy review.",
    plainLanguage: "The scheduled repayment did not clear. Collections needs to contact the customer.",
    confidence: 0.97,
  },
  {
    id: "FS-DEMO-003",
    railCode: "USSD_BANKING",
    category: "timing_difference",
    severity: "medium",
    status: "open",
    ageDays: 0,
    sourceAmount: "18500.00",
    targetAmount: "18500.00",
    sourceRef: "USSD-DEMO-0003",
    targetRef: "CBS-DEMO-LN-0003",
    sourceDescription: "USSD repayment settled after customer session ended",
    targetDescription: "Loan ledger posting awaiting settlement reference",
    counterparty: "Demo Customer C",
    rootCause: "The USSD session ended before the payment confirmation reached the application, although the rail settled the payment.",
    recommendedAction: "Confirm the settlement reference and apply the repayment to the loan ledger.",
    plainLanguage: "The payment succeeded after the phone session ended. Match it to the loan account.",
    confidence: 0.94,
  },
  {
    id: "FS-DEMO-004",
    railCode: "POS_TERMINAL",
    category: "reversal_unmatched",
    severity: "high",
    status: "in_review",
    ageDays: 1,
    sourceAmount: "25000.00",
    targetAmount: "25000.00",
    sourceRef: "POS-DEMO-REV-0004",
    targetRef: "CBS-DEMO-POS-0004",
    sourceDescription: "POS reversal received from acquirer",
    targetDescription: "Customer debit still present in core banking",
    counterparty: "Demo Merchant 004",
    rootCause: "The acquirer reversal has settled but the compensating core-banking credit has not posted.",
    recommendedAction: "Validate the acquirer file and post the customer reversal under dual control.",
    plainLanguage: "The card payment was reversed externally but the customer has not yet been credited internally.",
    confidence: 0.96,
    isReversal: true,
  },
  {
    id: "FS-DEMO-005",
    railCode: "CORE_BANKING",
    category: "duplicate_transaction",
    severity: "critical",
    status: "escalated",
    ageDays: 7,
    sourceAmount: "300000.00",
    targetAmount: "300000.00",
    sourceRef: "CBS-DEMO-DUP-0005",
    targetRef: "CBS-DEMO-SAV-0005",
    sourceDescription: "Core-banking batch duplicate debit detected",
    targetDescription: "Single authorised savings withdrawal",
    counterparty: "Demo Customer E",
    rootCause: "A recovery batch reposted a completed core-banking debit during a controlled restart window.",
    recommendedAction: "Reverse the duplicate posting, preserve the incident evidence and complete the customer-redress control.",
    plainLanguage: "The core system posted one withdrawal twice. One debit must be reversed with evidence retained.",
    confidence: 0.99,
    cbsStillAnomalous: true,
  },
  {
    id: "FS-DEMO-006",
    railCode: "AGENT_BANKING",
    category: "amount_mismatch",
    severity: "medium",
    status: "open",
    ageDays: 0,
    sourceAmount: "14850.00",
    targetAmount: "15000.00",
    sourceRef: "AGENT-DEMO-0006",
    targetRef: "CBS-DEMO-LN-0006",
    sourceDescription: "Agent collection net of documented float fee",
    targetDescription: "Loan instalment expected at gross amount",
    counterparty: "Demo Agent 006",
    rootCause: "The settlement file is net of a contracted agent float fee while the loan schedule carries the gross instalment.",
    recommendedAction: "Validate the fee against the approved tariff and post the variance to agent-banking charges.",
    plainLanguage: "The agent sent the payment after an approved fee. Confirm the tariff and book the small difference.",
    confidence: 0.95,
  },
  {
    id: "FS-DEMO-007",
    railCode: "MOBILE_APP",
    category: "amount_mismatch",
    severity: "low",
    status: "resolved",
    ageDays: 2,
    sourceAmount: "48750.00",
    targetAmount: "50000.00",
    sourceRef: "MOB-DEMO-0007",
    targetRef: "CBS-DEMO-LN-0007",
    sourceDescription: "Mobile-app loan disbursement net of processing fee",
    targetDescription: "Approved gross loan disbursement",
    counterparty: "Demo Customer G",
    rootCause: "The signed loan arrangement permits a 2.5% processing fee to be deducted at disbursement.",
    recommendedAction: "Confirm the fee against the loan agreement and post it to the approved fee income GL.",
    plainLanguage: "The customer received the net loan amount because the documented processing fee was deducted.",
    confidence: 0.99,
    resolutionNotes: "Fee validated against the demo loan agreement; ₦1,250 posted to Loan Processing Fees.",
  },
  {
    id: "FS-DEMO-008",
    railCode: "NIBSS_NIP",
    category: "missing_counterparty",
    severity: "medium",
    status: "open",
    ageDays: 0,
    sourceAmount: "500000.00",
    targetAmount: "500000.00",
    sourceRef: "NIP-DEMO-0008",
    targetRef: "CBS-DEMO-SAV-0008",
    sourceDescription: "NIP inward credit with truncated originator narrative",
    targetDescription: "Savings deposit awaiting account-owner confirmation",
    counterparty: "NIP INWARD DEMO 008",
    rootCause: "The NIP narrative is truncated; the amount and registered receiving account align but require human confirmation.",
    recommendedAction: "Confirm the account mapping under maker-checker control and save an approved alias.",
    plainLanguage: "The money arrived but the sender name is shortened. Confirm the account before posting it.",
    confidence: 0.91,
  },
  {
    id: "FS-DEMO-009",
    railCode: "NIBSS_NIP",
    category: "timing_difference",
    severity: "low",
    status: "open",
    ageDays: 0,
    sourceAmount: "200000.00",
    targetAmount: "200000.00",
    sourceRef: "RTGS-DEMO-0009",
    targetRef: "CBS-DEMO-CORP-0009",
    sourceDescription: "Large-value settlement received after end-of-day cut-off",
    targetDescription: "Corporate account posting on next value date",
    counterparty: "Demo Corporate Counterparty 009",
    rootCause: "The settlement message arrived after the core-banking posting cut-off and should clear on the next business day.",
    recommendedAction: "Confirm the next-day posting and retain the timing note; no customer remediation is required.",
    plainLanguage: "The payment arrived after cut-off and is expected to post the next day.",
    confidence: 0.93,
  },
  {
    id: "FS-DEMO-010",
    railCode: "CARD_PAYMENT",
    category: "fx_rate_variance",
    severity: "medium",
    status: "in_review",
    ageDays: 1,
    sourceAmount: "154200.00",
    targetAmount: "152950.00",
    sourceRef: "CARD-DEMO-00010",
    targetRef: "CBS-DEMO-CARD-0010",
    sourceDescription: "Card-scheme settlement translated at scheme rate",
    targetDescription: "Core-banking merchant settlement at booked rate",
    counterparty: "Demo Merchant 010",
    rootCause: "The card scheme and core ledger used different settlement-date FX rates for the same cleared item.",
    recommendedAction: "Validate the scheme advice, document the approved rate source and post the permitted FX variance.",
    plainLanguage: "The card settlement used a slightly different approved exchange rate. Validate the rate and book the difference.",
    confidence: 0.9,
  },
  {
    id: "FS-DEMO-011",
    railCode: "CORE_BANKING",
    category: "unmatched",
    severity: "high",
    status: "open",
    ageDays: 0,
    sourceAmount: "87500.00",
    targetAmount: "87500.00",
    sourceRef: "CHEQUE-DEMO-RETURN-0011",
    targetRef: "CBS-DEMO-CHQ-0011",
    sourceDescription: "Cheque clearing return awaiting suspense release",
    targetDescription: "Cheque lodgement held in clearing suspense",
    counterparty: "Demo Drawer 011",
    rootCause: "The returned clearing item requires a controlled suspense reversal before the customer balance is finalised.",
    recommendedAction: "Validate the return reason and complete the suspense release with checker approval.",
    plainLanguage: "A cheque was returned and the temporary suspense entry must be cleared correctly.",
    confidence: 0.95,
  },
  {
    id: "FS-DEMO-012",
    railCode: "POS_TERMINAL",
    category: "reversal_unmatched",
    severity: "high",
    status: "open",
    ageDays: 4,
    sourceAmount: "40000.00",
    targetAmount: "40000.00",
    sourceRef: "ATM-DEMO-REV-0012",
    targetRef: "CBS-DEMO-ATM-0012",
    sourceDescription: "Cash withdrawal reversal from switch pending ledger release",
    targetDescription: "ATM customer debit remains unreversed",
    counterparty: "Demo Customer L",
    rootCause: "The switch reversal was received but the core-banking compensating entry is still absent beyond the operational SLA.",
    recommendedAction: "Escalate to the card operations queue and complete the reversal with an incident reference.",
    plainLanguage: "The cash withdrawal was reversed by the switch but the customer has not been credited yet.",
    confidence: 0.97,
    isReversal: true,
  },
  {
    id: "FS-DEMO-013",
    railCode: "MOBILE_APP",
    category: "duplicate_transaction",
    severity: "medium",
    status: "open",
    ageDays: 0,
    sourceAmount: "62000.00",
    targetAmount: "62000.00",
    sourceRef: "MOB-DEMO-DUP-0013",
    targetRef: "CBS-DEMO-MOB-0013",
    sourceDescription: "Mobile-wallet aggregator replay detected",
    targetDescription: "Single wallet top-up expected",
    counterparty: "Demo Wallet 013",
    rootCause: "The aggregator retried a successful callback and produced a replayed settlement event.",
    recommendedAction: "Retain the original top-up, reverse the replay and mark the provider event as consumed.",
    plainLanguage: "A provider retried a successful callback. Only one wallet top-up should remain.",
    confidence: 0.96,
  },
  {
    id: "FS-DEMO-014",
    railCode: "AGENT_BANKING",
    category: "amount_mismatch",
    severity: "low",
    status: "resolved",
    ageDays: 1,
    sourceAmount: "99500.00",
    targetAmount: "100000.00",
    sourceRef: "AGENT-DEMO-0014",
    targetRef: "CBS-DEMO-AGENT-0014",
    sourceDescription: "Agent collection after authorised commission",
    targetDescription: "Gross agent collection expected",
    counterparty: "Demo Agent 014",
    rootCause: "The settlement is net of a documented ₦500 collection commission.",
    recommendedAction: "Confirm the commission against the agent contract and post it to the approved expense GL.",
    plainLanguage: "The agent deducted an approved commission. The difference has been validated and recorded.",
    confidence: 0.99,
    resolutionNotes: "Commission verified against the demo agent tariff; ₦500 posted to Agent Collection Charges.",
  },
  {
    id: "FS-DEMO-015",
    railCode: "NIBSS_NIP",
    category: "reversal_unmatched",
    severity: "high",
    status: "in_review",
    ageDays: 2,
    sourceAmount: "180000.00",
    targetAmount: "180000.00",
    sourceRef: "NIP-DEMO-OUT-REV-0015",
    targetRef: "CBS-DEMO-NIP-0015",
    sourceDescription: "Failed outward NIP transfer reversal received",
    targetDescription: "Original customer debit remains in core banking",
    counterparty: "Demo Customer O",
    rootCause: "The outward transfer failed at the beneficiary bank and the incoming reversal has not yet cleared the originating debit.",
    recommendedAction: "Match the NIP reversal to the original debit and restore the customer balance under dual control.",
    plainLanguage: "The transfer failed and the reversal arrived. The original debit still needs to be cleared.",
    confidence: 0.98,
    isReversal: true,
  },
  {
    id: "FS-DEMO-016",
    railCode: "CORE_BANKING",
    category: "unmatched",
    severity: "high",
    status: "open",
    ageDays: 1,
    sourceAmount: "410000.00",
    targetAmount: "410000.00",
    sourceRef: "CBS-DEMO-SUSP-0016",
    targetRef: "GL-DEMO-SUSP-0016",
    sourceDescription: "Unallocated core-banking suspense credit",
    targetDescription: "Settlement suspense balance awaiting allocation",
    counterparty: "Demo Suspense Control",
    rootCause: "A valid credit posted to suspense without a usable remittance reference for allocation.",
    recommendedAction: "Obtain the supporting remittance, allocate the credit to the correct account and retain the approval evidence.",
    plainLanguage: "A genuine credit is sitting in suspense because its destination account is not yet confirmed.",
    confidence: 0.88,
  },
];

export interface FinServDemoPlan {
  settlementItems: number;
  transactionLegs: number;
  matchedPairs: number;
  exceptionCases: number;
  matchRate: string;
  reviewQueueOpenToday: number;
  exceptionStatusCounts: Record<ExceptionStatus, number>;
  rails: typeof PAYMENT_RAILS;
  cases: FinServOperationalCase[];
}

/** Pure plan builder: testable without a database and intentionally deterministic. */
export function buildFinServDemoPlan(): FinServDemoPlan {
  const exceptionStatusCounts: Record<ExceptionStatus, number> = {
    open: 0,
    in_review: 0,
    resolved: 0,
    escalated: 0,
  };
  for (const item of FINSERV_OPERATIONAL_CASES) exceptionStatusCounts[item.status] += 1;
  return {
    settlementItems: SETTLEMENT_ITEMS,
    transactionLegs: SETTLEMENT_ITEMS * 2,
    matchedPairs: MATCHED_PAIRS,
    exceptionCases: EXCEPTION_CASES,
    matchRate: ((MATCHED_PAIRS / SETTLEMENT_ITEMS) * 100).toFixed(2),
    reviewQueueOpenToday: FINSERV_OPERATIONAL_CASES.filter((item) => item.status === "open" && item.ageDays === 0).length,
    exceptionStatusCounts,
    rails: PAYMENT_RAILS,
    cases: FINSERV_OPERATIONAL_CASES,
  };
}

const demoTag = (extra: Record<string, unknown>) => ({
  isDemoData: true,
  segment: "finserv",
  dataset: DEMO_MARKER,
  ...extra,
});

function dateDaysAgo(reference: Date, days: number): Date {
  const value = new Date(reference);
  value.setDate(value.getDate() - days);
  return value;
}

function scopedRailCode(code: FinServRailCode, organizationId: number | null) {
  return organizationId === null ? `FINSERV_${code}` : `FINSERV_${code}_ORG${organizationId}`;
}

async function ensureFinServChannel(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  rail: (typeof PAYMENT_RAILS)[number],
  organizationId: number | null,
): Promise<number> {
  const code = scopedRailCode(rail.code, organizationId);
  const [existing] = await db.select({ id: channels.id }).from(channels).where(eq(channels.code, code)).limit(1);
  if (existing) return existing.id;

  await db.insert(channels).values({
    name: `${rail.name} (Demo)`,
    code,
    organizationId,
    channelType: rail.channelType as "bank_core",
    description: `${rail.description}. Fictional operational-control demo data only.`,
    isActive: true,
  });
  const [created] = await db.select({ id: channels.id }).from(channels).where(eq(channels.code, code)).limit(1);
  if (!created) throw new Error(`Unable to create financial-services channel ${code}`);
  return created.id;
}

async function createBatch(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  organizationId: number | null,
  channelId: number,
  fileName: string,
  count: number,
) {
  const result = await db.insert(uploadBatches).values({
    userId,
    organizationId,
    channelId,
    fileName,
    fileHash: `${DEMO_MARKER}:${fileName}`,
    totalRows: count,
    validRows: count,
    invalidRows: 0,
    status: "completed",
  });
  const id = Number((result as unknown as { insertId?: number }[])[0]?.insertId ?? 0);
  if (!id) throw new Error(`Unable to create demo batch ${fileName}`);
  return id;
}

export interface FinServSeedResult {
  segment: "finserv";
  jobId: number;
  totalTransactions: number;
  matchedCount: number;
  exceptionCount: number;
  matchRate: string;
  paymentRails: string[];
  reviewQueueOpenToday: number;
  message: string;
}

export async function seedFinServDemoData(
  userId: number,
  organizationId: number | null,
  _entity: "lapo" | "renmoney" | "both" = "both",
): Promise<FinServSeedResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (organizationId == null) {
    throw new Error("Financial Services demo seed requires an owning organizationId");
  }

  /**
   * Agent memory is written ONLY when the caller has a real organisation.
   *
   * `agentMemory.organizationId` is NOT NULL, which is why the original code
   * reached for `?? 0`. But organisation 0 is not a tenant: every read of that
   * table is org-scoped, so those rows can never be retrieved by anyone, and
   * each org-less caller is pooled into the same pseudo-tenant. That is exactly
   * how 14 unreachable distributor rows came to sit under organizationId 0
   * (CLAUDE.md §9C, §19.2). "No organisation" is not "organisation zero".
   *
   * Skipping rather than throwing, deliberately. The prewarm demo user and the
   * guest-login fallback user are both created WITHOUT an organisation, so a
   * hard refusal would break the guest demo — and the rows being skipped had no
   * value to lose: written under org 0 they were already unreadable. Everything
   * else in this seed (transactions, exceptions, matches) targets tables whose
   * organizationId is nullable and is unaffected.
   */
  const plan = buildFinServDemoPlan();
  const now = new Date();

  // Make activation idempotent for an organisation: re-activation produces a
  // fresh, consistent state instead of appending competing demonstration cases.
  await wipeFinServDemoData(userId, organizationId);

  const channelIds = new Map<FinServRailCode, number>();
  for (const rail of PAYMENT_RAILS) {
    channelIds.set(rail.code, await ensureFinServChannel(db, rail, organizationId));
  }
  const coreChannelId = channelIds.get("CORE_BANKING");
  const nipChannelId = channelIds.get("NIBSS_NIP");
  if (!coreChannelId || !nipChannelId) throw new Error("Financial-services demo rails were not created");

  const sourceBatchIds = new Map<FinServRailCode, number>();
  for (const rail of PAYMENT_RAILS) {
    if (rail.code === "CORE_BANKING") continue;
    const count = Math.ceil(plan.settlementItems / (PAYMENT_RAILS.length - 1));
    sourceBatchIds.set(
      rail.code,
      await createBatch(db, userId, organizationId, channelIds.get(rail.code)!, `FinServ_Demo_${rail.code}_Settlement.csv`, count),
    );
  }
  const coreBatchId = await createBatch(
    db,
    userId,
    organizationId,
    coreChannelId,
    "FinServ_Demo_Core_Banking_Ledger.csv",
    plan.settlementItems,
  );

  const jobInsert = await db.insert(reconciliationJobs).values({
    userId,
    organizationId,
    moduleType: "transaction_integrity",
    name: "FinServ — Multi-Rail Operations Control Run (Demo)",
    sourceChannelId: nipChannelId,
    targetChannelId: coreChannelId,
    dateFrom: dateDaysAgo(now, 30),
    dateTo: now,
    currency: "NGN",
    amountTolerance: "0.0050",
    dateWindowDays: 1,
    engineConfig: demoTag({ paymentRails: PAYMENT_RAILS.map((rail) => rail.code), scenarioCount: plan.exceptionCases }),
    status: "completed",
    totalSourceTxns: plan.settlementItems,
    totalTargetTxns: plan.settlementItems,
    matchedCount: plan.matchedPairs,
    unmatchedCount: plan.exceptionCases,
    exceptionCount: plan.exceptionCases,
    matchRate: plan.matchRate,
    processingTimeMs: 18420,
    startedAt: dateDaysAgo(now, 1),
    completedAt: now,
  });
  const jobId = Number((jobInsert as unknown as { insertId?: number }[])[0]?.insertId ?? 0);
  if (!jobId) throw new Error("Unable to create financial-services demo reconciliation job");

  const matchRows: Array<typeof matches.$inferInsert> = [];
  for (let index = 0; index < plan.matchedPairs; index += 1) {
    const rail = PAYMENT_RAILS[index % (PAYMENT_RAILS.length - 1)];
    const sequence = String(index + 1).padStart(4, "0");
    const amount = (25000 + ((index * 1375) % 475000)).toFixed(2);
    const transactionDate = dateDaysAgo(now, index % 10);
    const sourceBatchId = sourceBatchIds.get(rail.code);
    if (!sourceBatchId) throw new Error(`Missing source batch for ${rail.code}`);

    const sourceInsert = await db.insert(transactions).values({
      batchId: sourceBatchId,
      channelId: channelIds.get(rail.code)!,
      userId,
      organizationId,
      transactionRef: `${rail.code}-DEMO-MATCH-${sequence}`,
      externalRef: `FS-DEMO-ACCT-${sequence}`,
      description: `${rail.name} settlement matched to core-banking account`,
      amount,
      currency: "NGN",
      transactionDate,
      valueDate: transactionDate,
      debitCredit: "credit",
      counterparty: `Demo Customer ${sequence}`,
      status: "matched",
      rawData: demoTag({ kind: "settlement", rail: rail.code, controlOutcome: "matched" }),
    });
    const sourceTransactionId = Number((sourceInsert as unknown as { insertId?: number }[])[0]?.insertId ?? 0);

    const targetInsert = await db.insert(transactions).values({
      batchId: coreBatchId,
      channelId: coreChannelId,
      userId,
      organizationId,
      transactionRef: `CBS-DEMO-MATCH-${sequence}`,
      externalRef: `FS-DEMO-ACCT-${sequence}`,
      description: "Core-banking ledger posting matched to settlement reference",
      amount,
      currency: "NGN",
      transactionDate,
      valueDate: transactionDate,
      debitCredit: "credit",
      counterparty: `Demo Customer ${sequence}`,
      status: "matched",
      rawData: demoTag({ kind: "core-ledger", controlOutcome: "matched" }),
    });
    const targetTransactionId = Number((targetInsert as unknown as { insertId?: number }[])[0]?.insertId ?? 0);

    matchRows.push({
      organizationId,
      jobId,
      sourceTransactionId,
      targetTransactionId,
      matchType: index % 9 === 0 ? "date_window" : "exact",
      confidenceScore: index % 9 === 0 ? "97.50" : "99.60",
      amountDifference: "0.00",
      dateDifference: index % 9 === 0 ? 1 : 0,
      matchReason: index % 9 === 0 ? "Exact account and amount; posted on adjacent value date" : "Exact settlement reference, account and amount",
      status: "confirmed",
    });
  }
  for (let offset = 0; offset < matchRows.length; offset += 100) {
    await db.insert(matches).values(matchRows.slice(offset, offset + 100));
  }

  for (const scenario of plan.cases) {
    const transactionDate = dateDaysAgo(now, scenario.ageDays);
    const sourceBatchId = sourceBatchIds.get(scenario.railCode) ?? coreBatchId;
    const sourceChannelId = channelIds.get(scenario.railCode) ?? coreChannelId;

    const sourceInsert = await db.insert(transactions).values({
      batchId: sourceBatchId,
      channelId: sourceChannelId,
      userId,
      organizationId,
      transactionRef: scenario.sourceRef,
      externalRef: scenario.targetRef,
      description: scenario.sourceDescription,
      amount: scenario.sourceAmount,
      currency: "NGN",
      transactionDate,
      valueDate: transactionDate,
      debitCredit: "credit",
      counterparty: scenario.counterparty,
      status: "exception",
      isReversal: scenario.isReversal ?? false,
      originalTransactionRef: scenario.isReversal ? scenario.targetRef : null,
      rawData: demoTag({ kind: "settlement-exception", scenario: scenario.id, rail: scenario.railCode, controlOutcome: scenario.status }),
    });
    const sourceTransactionId = Number((sourceInsert as unknown as { insertId?: number }[])[0]?.insertId ?? 0);

    await db.insert(transactions).values({
      batchId: coreBatchId,
      channelId: coreChannelId,
      userId,
      organizationId,
      transactionRef: scenario.targetRef,
      externalRef: scenario.sourceRef,
      description: scenario.targetDescription,
      amount: scenario.targetAmount,
      currency: "NGN",
      transactionDate,
      valueDate: transactionDate,
      debitCredit: "debit",
      counterparty: scenario.counterparty,
      status: "unmatched",
      rawData: demoTag({ kind: "core-ledger-exception", scenario: scenario.id, controlOutcome: scenario.status }),
    });

    const diagnosis = JSON.stringify({
      rootCause: scenario.rootCause,
      recommendedAction: scenario.recommendedAction,
      plainLanguage: scenario.plainLanguage,
      confidence: scenario.confidence,
    });
    const exceptionInsert = await db.insert(exceptions).values({
      organizationId,
      jobId,
      transactionId: sourceTransactionId,
      category: scenario.category,
      severity: scenario.severity,
      currency: "NGN",
      description: `${scenario.sourceDescription} — ${scenario.targetDescription}`,
      suggestedResolution: scenario.recommendedAction,
      aiAnalysis: diagnosis,
      status: scenario.status,
      assignedTo: scenario.status === "in_review" || scenario.status === "escalated" ? userId : null,
      assignedAt: scenario.status === "in_review" || scenario.status === "escalated" ? transactionDate : null,
      assignedBy: scenario.status === "in_review" || scenario.status === "escalated" ? userId : null,
      resolvedBy: scenario.status === "resolved" ? userId : null,
      resolvedAt: scenario.status === "resolved" ? transactionDate : null,
      resolutionNotes: scenario.resolutionNotes ?? null,
      cbsStillAnomalous: scenario.cbsStillAnomalous ?? false,
      cbsVerificationNote: scenario.cbsStillAnomalous ? "Demo control: re-run still identifies the core-banking anomaly." : null,
      createdAt: transactionDate,
    });
    const exceptionId = Number((exceptionInsert as unknown as { insertId?: number }[])[0]?.insertId ?? 0);

    // The agent's evidence store may only learn from a completed or escalated
    // outcome. Open and in-review cases are intentionally excluded so a future
    // diagnosis never presents an unvalidated recommendation as prior practice.
    //
    // This seeder now refuses an org-less invocation before any row is written,
    // so every completed/escalated scenario has a real tenant owner.
    if (scenario.status === "resolved" || scenario.status === "escalated") {
      await db.insert(agentMemory).values({
        organizationId,
        exceptionId,
        exceptionCategory: scenario.category,
        transactionRef: scenario.sourceRef,
        amountRange: Number(scenario.sourceAmount) < 100_000 ? "0-100k" : Number(scenario.sourceAmount) < 1_000_000 ? "100k-1m" : "1m+",
        counterpartyType: "financial-services-demo",
        deductionType: scenario.category,
        resolution: scenario.resolutionNotes ?? scenario.recommendedAction,
        outcome: scenario.status === "resolved" ? "resolved" : "escalated",
        reasoning: diagnosis,
        embeddingText: `${scenario.id} ${scenario.railCode} ${scenario.category} ${scenario.rootCause} ${scenario.recommendedAction}`,
        resolvedBy: scenario.status === "resolved" ? userId : null,
      });
    }
  }

  await invalidateDashboardStatsCache(organizationId);

  return {
    segment: "finserv",
    jobId,
    totalTransactions: plan.transactionLegs,
    matchedCount: plan.matchedPairs,
    exceptionCount: plan.exceptionCases,
    matchRate: plan.matchRate,
    paymentRails: PAYMENT_RAILS.map((rail) => rail.name),
    reviewQueueOpenToday: plan.reviewQueueOpenToday,
    message: `Financial-services operational demo loaded: ${plan.settlementItems} settlement items / ${plan.transactionLegs} transaction legs across ${PAYMENT_RAILS.length} rails; ${plan.matchedPairs} matched pairs and ${plan.exceptionCases} control cases.`,
  };
}

/** Remove only this tenant's marker-tagged financial-services demo data. */
export async function wipeFinServDemoData(userId: number, organizationId: number | null): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const jobs = await db
    .select({ id: reconciliationJobs.id })
    .from(reconciliationJobs)
    .where(and(
      eq(reconciliationJobs.userId, userId),
      orgFilter(reconciliationJobs.organizationId, organizationId),
      or(
        like(reconciliationJobs.name, "FinServ — Multi-Rail Operations Control Run (Demo)%"),
        like(reconciliationJobs.name, "%FinServ Demo%"),
      ),
    ));
  const jobIds = jobs.map((row) => row.id);

  const exceptionRows = jobIds.length
    ? await db
      .select({ id: exceptions.id })
      .from(exceptions)
      // The reconciliation job has already been selected by user and tenant;
      // do not retain pre-migration exception rows whose organizationId was NULL.
      .where(inArray(exceptions.jobId, jobIds))
    : [];
  const exceptionIds = exceptionRows.map((row) => row.id);
  if (exceptionIds.length) {
    // A wipe must reach the rows an EARLIER seed wrote, not just the rows this
    // version would write.
    //
    // `agentMemory.organizationId` is NOT NULL, so orgFilter's null branch
    // (IS NULL) matches nothing and an org-less deactivation cleaned up
    // nothing — leaving the pseudo-tenant rows the previous `?? 0` code created
    // behind forever. Production carries 55 of them today. They are not inert:
    // eight read paths in routers.ts normalise a missing organisation with
    // `?? 0`, so every org-less guest sees the accumulated pool.
    //
    // So an org-less caller targets the legacy pseudo-tenant explicitly. The
    // `exceptionId` predicate below still confines the delete to the exceptions
    // this seed owns, which is what keeps it from reaching anything else.
    await db.delete(agentMemory).where(and(
      eq(agentMemory.organizationId, organizationId ?? LEGACY_PSEUDO_TENANT_ID),
      inArray(agentMemory.exceptionId, exceptionIds),
    ));
    await db.delete(exceptions).where(inArray(exceptions.id, exceptionIds));
  }
  if (jobIds.length) {
    // Same rationale as exceptions: legacy matches may pre-date the org column.
    await db.delete(matches).where(inArray(matches.jobId, jobIds));
  }

  const batches = await db
    .select({ id: uploadBatches.id })
    .from(uploadBatches)
    .where(and(
      eq(uploadBatches.userId, userId),
      orgFilter(uploadBatches.organizationId, organizationId),
      or(
        like(uploadBatches.fileName, "FinServ_Demo_%"),
        like(uploadBatches.fileName, "MFB_%_demo.csv"),
        like(uploadBatches.fileName, "LAPO_%_demo.csv"),
        like(uploadBatches.fileName, "REN_%_demo.csv"),
      ),
    ));
  const batchIds = batches.map((row) => row.id);
  if (batchIds.length) {
    await db.delete(transactions).where(inArray(transactions.batchId, batchIds));
    await db.delete(uploadBatches).where(inArray(uploadBatches.id, batchIds));
  }
  if (jobIds.length) await db.delete(reconciliationJobs).where(inArray(reconciliationJobs.id, jobIds));
  await invalidateDashboardStatsCache(organizationId);
}
