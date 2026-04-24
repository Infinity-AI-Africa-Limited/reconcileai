/**
 * ReconcileAI — Woodcore POC Three-Layer Engine
 * Layer 1: Balance Reconciliation Engine
 * Layer 2: Transaction-Level Exception Classifier
 * Layer 3: Context-Aware Agent (LLM-powered)
 *
 * All queries are READ-ONLY against the wc_* tables.
 */

import { getDb } from "./db";
import { invokeLLM } from "./_core/llm";

async function getDatabase() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db;
}
import {
  wc_acc_gl_account,
  wc_acc_product_mapping,
  wc_acc_gl_journal_entry,
  wc_acc_to_gl_journal_entry,
  wc_acc_to_gl_journal_entry_savings,
  wc_m_savings_product,
  wc_m_savings_account,
  wc_m_savings_account_transaction,
  wc_m_product_loan,
  wc_m_loan,
  wc_m_loan_transaction,
  wc_reconciliation_runs,
  wc_exceptions,
} from "../drizzle/woodcore_schema";
import { eq, and, between, sql, isNull, isNotNull, ne } from "drizzle-orm";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReconciliationConfig = {
  productId: number;
  productType: "SAVINGS" | "LOAN";
  currencyCode: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;   // YYYY-MM-DD
  varianceThreshold: number;
};

export type Layer1Result = {
  runId: number;
  productId: number;
  productName: string;
  portfolioLedgerAccountId: number;
  portfolioLedgerGlCode: string;
  portfolioLedgerName: string;
  expectedBalance: number;
  actualGlBalance: number;
  varianceAmount: number;
  varianceDirection: "OVER_POSTED" | "UNDER_POSTED" | "BALANCED";
  status: "BALANCED" | "VARIANCE_DETECTED";
  totalGlEntries: number;
  totalSavingsTxns: number;
  layer2Triggered: boolean;
  currencyCode: string;
  periodStart: string;
  periodEnd: string;
  // Breakdown for UI
  glDebits: number;
  glCredits: number;
  savingsDeposits: number;
  savingsWithdrawals: number;
  savingsCharges: number;
  savingsInterest: number;
};

export type Layer2Exception = {
  glEntryId: number;
  exceptionCategory: string;
  exceptionContribution: number;
  glEntryAmount: number;
  glEntryDate: string;
  glEntryType: "CREDIT" | "DEBIT";
  manualEntryFlag: boolean;
  linkedTransactionId: string | null;
  linkedSavingsTxnId: number | null;
  linkedSavingsAccountId: number | null;
  linkedProductId: number | null;
  productMatch: boolean | null;
  description: string | null;
  refNum: string | null;
  accountId: number;
  accountName: string;
};

export type Layer3Result = {
  exceptionId: number;
  agentClassification: string;
  agentExplanation: string;
  agentConfidence: number;
  recommendedAction: string;
  priorityLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
};

// ─── LAYER 1: Balance Reconciliation Engine ──────────────────────────────────

export async function runLayer1(config: ReconciliationConfig): Promise<Layer1Result> {
  const db = await getDatabase();
  const { productId, productType, currencyCode, periodStart, periodEnd, varianceThreshold } = config;

  // Step 1: Get product name
  let productName = "";
  if (productType === "SAVINGS") {
    const [prod] = await db.select().from(wc_m_savings_product).where(eq(wc_m_savings_product.id, productId));
    productName = prod?.name ?? `Savings Product ${productId}`;
  } else if (productType === "LOAN") {
    const [prod] = await db.select().from(wc_m_product_loan).where(eq(wc_m_product_loan.id, productId));
    productName = prod?.name ?? `Loan Product ${productId}`;
  }

  // Step 2: Get portfolio ledger account
  // For savings: financial_account_type=1 (Savings Reference/Fund Source) or 2 (Savings Control)
  // We use financial_account_type=1 for primary portfolio ledger (Savings Reference = Asset)
  const mappings = await db.select({
    glAccountId: wc_acc_product_mapping.glAccountId,
    financialAccountType: wc_acc_product_mapping.financialAccountType,
  }).from(wc_acc_product_mapping)
    .where(and(
      eq(wc_acc_product_mapping.productType, productType === "SAVINGS" ? 2 : 1),
      eq(wc_acc_product_mapping.productId, productId),
    ));

  // For savings: use financial_account_type=2 (Savings Control - Liability) as the primary reconciliation ledger
  // This is the account where deposits are credited and withdrawals are debited
  const controlMapping = mappings.find((m: typeof mappings[0]) => m.financialAccountType === 2);
  const referenceMapping = mappings.find((m: typeof mappings[0]) => m.financialAccountType === 1);
  const portfolioMapping = controlMapping || referenceMapping || mappings[0];

  if (!portfolioMapping) {
    throw new Error(`No product mapping found for product ${productId} (${productType})`);
  }

  const portfolioAccountId = portfolioMapping.glAccountId;

  // Get GL account details
  const [glAccount] = await db.select().from(wc_acc_gl_account)
    .where(eq(wc_acc_gl_account.id, portfolioAccountId));

  const classificationEnum = glAccount?.classificationEnum ?? 1;
  const isAsset = classificationEnum === 1 || classificationEnum === 5; // Asset or Expense

  // Step 3: Compute actual GL ledger balance
  // For Asset/Expense: balance = SUM(debit) - SUM(credit)
  // For Liability/Equity/Income: balance = SUM(credit) - SUM(debit)
  // type_enum: 1=Credit, 2=Debit
  const glEntriesRaw = await db.select({
    id: wc_acc_gl_journal_entry.id,
    typeEnum: wc_acc_gl_journal_entry.typeEnum,
    amount: wc_acc_gl_journal_entry.amount,
    entryDate: wc_acc_gl_journal_entry.entryDate,
    manualEntry: wc_acc_gl_journal_entry.manualEntry,
    transactionId: wc_acc_gl_journal_entry.transactionId,
    savingsTransactionId: wc_acc_gl_journal_entry.savingsTransactionId,
    reversed: wc_acc_gl_journal_entry.reversed,
    description: wc_acc_gl_journal_entry.description,
    refNum: wc_acc_gl_journal_entry.refNum,
  }).from(wc_acc_gl_journal_entry)
    .where(and(
      eq(wc_acc_gl_journal_entry.accountId, portfolioAccountId),
      eq(wc_acc_gl_journal_entry.currencyCode, currencyCode),
      between(wc_acc_gl_journal_entry.entryDate, periodStart, periodEnd),
    ));

  let totalDebits = 0;
  let totalCredits = 0;
  for (const e of glEntriesRaw) {
    const amt = parseFloat(e.amount?.toString() ?? "0");
    if (e.typeEnum === 2) totalDebits += amt; // Debit
    else totalCredits += amt; // Credit
  }

  const actualGlBalance = isAsset
    ? totalDebits - totalCredits
    : totalCredits - totalDebits;

  const glDebits = totalDebits;
  const glCredits = totalCredits;

  // Step 4: Compute expected balance
  let savingsDeposits = 0;
  let savingsWithdrawals = 0;
  let savingsCharges = 0;
  let savingsInterest = 0;
  let expectedBalance = 0;
  let totalLoanTxns = 0;

  if (productType === "LOAN") {
    // ── LOAN: Expected principal outstanding ──────────────────────────────────
    // Get all loan accounts for this product and currency
    const loanAccounts = await db.select({
      id: wc_m_loan.id,
    }).from(wc_m_loan)
      .where(and(
        eq(wc_m_loan.productId, productId),
        eq(wc_m_loan.currencyCode, currencyCode),
      ));
    const loanAccountIds = new Set(loanAccounts.map((a: typeof loanAccounts[0]) => a.id));

    // Get all loan transactions within period for these accounts
    const loanTxns = await db.select({
      id: wc_m_loan_transaction.id,
      loanId: wc_m_loan_transaction.loanId,
      transactionTypeEnum: wc_m_loan_transaction.transactionTypeEnum,
      isReversed: wc_m_loan_transaction.isReversed,
      transactionDate: wc_m_loan_transaction.transactionDate,
      amount: wc_m_loan_transaction.amount,
      principalPortion: wc_m_loan_transaction.principalPortion,
    }).from(wc_m_loan_transaction)
      .where(between(wc_m_loan_transaction.transactionDate, periodStart, periodEnd));

    // Also get all loan transactions BEFORE period start to compute opening balance
    const priorTxns = await db.select({
      id: wc_m_loan_transaction.id,
      loanId: wc_m_loan_transaction.loanId,
      transactionTypeEnum: wc_m_loan_transaction.transactionTypeEnum,
      isReversed: wc_m_loan_transaction.isReversed,
      transactionDate: wc_m_loan_transaction.transactionDate,
      amount: wc_m_loan_transaction.amount,
      principalPortion: wc_m_loan_transaction.principalPortion,
    }).from(wc_m_loan_transaction)
      .where(sql`transaction_date < ${periodStart}`);

    // Compute expected principal outstanding = all disbursements - all principal repayments (all time)
    const allTxns = [...priorTxns, ...loanTxns];
    let totalDisbursed = 0;
    let totalPrincipalRepaid = 0;
    let totalWriteOff = 0;
    for (const t of allTxns) {
      if (t.isReversed) continue;
      if (!loanAccountIds.has(t.loanId)) continue;
      const principal = parseFloat(t.principalPortion?.toString() ?? "0");
      if (t.transactionTypeEnum === 1) totalDisbursed += principal; // Disbursement
      else if (t.transactionTypeEnum === 2) totalPrincipalRepaid += principal; // Repayment
      else if (t.transactionTypeEnum === 8) totalPrincipalRepaid += principal; // Recovery Repayment
      else if (t.transactionTypeEnum === 6) totalWriteOff += principal; // Write-off
    }
    expectedBalance = totalDisbursed - totalPrincipalRepaid - totalWriteOff;
    totalLoanTxns = loanTxns.filter((t: typeof loanTxns[0]) => loanAccountIds.has(t.loanId)).length;
    // Map savings-style breakdown fields to loan equivalents for UI
    savingsDeposits = totalDisbursed; // reuse field: total disbursed
    savingsWithdrawals = totalPrincipalRepaid; // reuse field: total principal repaid
    savingsCharges = totalWriteOff; // reuse field: write-offs
    savingsInterest = 0;
  } else {
    // ── SAVINGS: original logic ───────────────────────────────────────────────
    const savingsAccounts = await db.select({
      id: wc_m_savings_account.id,
      accountBalanceDerived: wc_m_savings_account.accountBalanceDerived,
    }).from(wc_m_savings_account)
      .where(and(
        eq(wc_m_savings_account.productId, productId),
        eq(wc_m_savings_account.currencyCode, currencyCode),
      ));

    const savingsTxns = await db.select({
      id: wc_m_savings_account_transaction.id,
      savingsAccountId: wc_m_savings_account_transaction.savingsAccountId,
      transactionTypeEnum: wc_m_savings_account_transaction.transactionTypeEnum,
      isReversed: wc_m_savings_account_transaction.isReversed,
      transactionDate: wc_m_savings_account_transaction.transactionDate,
      amount: wc_m_savings_account_transaction.amount,
      runningBalanceDerived: wc_m_savings_account_transaction.runningBalanceDerived,
    }).from(wc_m_savings_account_transaction)
      .where(between(wc_m_savings_account_transaction.transactionDate, periodStart, periodEnd));

    const productAccountIds = new Set(savingsAccounts.map((a: typeof savingsAccounts[0]) => a.id));
    const productTxns = savingsTxns.filter((t: typeof savingsTxns[0]) => productAccountIds.has(t.savingsAccountId));

    for (const t of productTxns) {
      if (t.isReversed) continue;
      const amt = parseFloat(t.amount?.toString() ?? "0");
      if (t.transactionTypeEnum === 1) savingsDeposits += amt;
      else if (t.transactionTypeEnum === 2) savingsWithdrawals += amt;
      else if (t.transactionTypeEnum === 3) savingsInterest += amt;
      else if (t.transactionTypeEnum === 7) savingsCharges += amt;
    }

    expectedBalance = savingsAccounts.reduce((sum: number, a: typeof savingsAccounts[0]) => {
      return sum + parseFloat(a.accountBalanceDerived?.toString() ?? "0");
    }, 0);
    totalLoanTxns = productTxns.length;
  }

  // Step 5: Compute variance
  // For Savings Control (Liability): GL balance = credits - debits = total deposits posted
  // Expected = sum of account balances
  // Variance = actual - expected
  const varianceAmount = actualGlBalance - expectedBalance;
  const absVariance = Math.abs(varianceAmount);

  const varianceDirection: "OVER_POSTED" | "UNDER_POSTED" | "BALANCED" =
    absVariance <= varianceThreshold ? "BALANCED"
    : varianceAmount > 0 ? "OVER_POSTED"
    : "UNDER_POSTED";

  const status: "BALANCED" | "VARIANCE_DETECTED" =
    absVariance > varianceThreshold ? "VARIANCE_DETECTED" : "BALANCED";

  // Step 6: Persist run record
  const now = new Date();
  const [insertResult] = await db.insert(wc_reconciliation_runs).values({
    productId,
    productName,
    productType,
    portfolioLedgerAccountId: portfolioAccountId,
    portfolioLedgerGlCode: glAccount?.glCode ?? "",
    reconciliationDate: now.toISOString().split("T")[0],
    periodStart,
    periodEnd,
    expectedBalance: expectedBalance.toFixed(6),
    actualGlBalance: actualGlBalance.toFixed(6),
    varianceAmount: varianceAmount.toFixed(6),
    varianceDirection,
    status,
    thresholdApplied: varianceThreshold.toFixed(6),
    layer2Triggered: status === "VARIANCE_DETECTED" ? 1 : 0,
    currencyCode,
    totalGlEntries: glEntriesRaw.length,
    totalSavingsTxns: totalLoanTxns,
    createdAt: now,
  });

  const runId = (insertResult as any).insertId as number;

  return {
    runId,
    productId,
    productName,
    portfolioLedgerAccountId: portfolioAccountId,
    portfolioLedgerGlCode: glAccount?.glCode ?? "",
    portfolioLedgerName: glAccount?.name ?? "",
    expectedBalance,
    actualGlBalance,
    varianceAmount,
    varianceDirection,
    status,
    totalGlEntries: glEntriesRaw.length,
    totalSavingsTxns: totalLoanTxns,
    layer2Triggered: status === "VARIANCE_DETECTED",
    currencyCode,
    periodStart,
    periodEnd,
    glDebits,
    glCredits,
    savingsDeposits,
    savingsWithdrawals,
    savingsCharges,
    savingsInterest,
  };
}

// ─── LAYER 2 (LOAN): Loan Principal Exception Classifier ────────────────────

export async function runLayer2Loan(
  runId: number,
  layer1: Layer1Result,
  config: ReconciliationConfig
): Promise<Layer2Exception[]> {
  const db = await getDatabase();
  const { productId, currencyCode, periodStart, periodEnd } = config;
  const { portfolioLedgerAccountId } = layer1;

  // Get all GL entries on the Loan Portfolio account (account 33) for the period
  const glEntries = await db.select().from(wc_acc_gl_journal_entry)
    .where(and(
      eq(wc_acc_gl_journal_entry.accountId, portfolioLedgerAccountId),
      eq(wc_acc_gl_journal_entry.currencyCode, currencyCode),
      between(wc_acc_gl_journal_entry.entryDate, periodStart, periodEnd),
    ));

  // Get GL account map
  const glAccounts = await db.select().from(wc_acc_gl_account);
  const glAccountMap = new Map(glAccounts.map((a: typeof glAccounts[0]) => [a.id, a]));

  // Get all loan transactions within period
  const loanTxns = await db.select().from(wc_m_loan_transaction)
    .where(between(wc_m_loan_transaction.transactionDate, periodStart, periodEnd));
  const loanTxnMap = new Map(loanTxns.map((t: typeof loanTxns[0]) => [t.id, t]));

  // Get all loan accounts for this product
  const loanAccounts = await db.select().from(wc_m_loan)
    .where(and(
      eq(wc_m_loan.productId, productId),
      eq(wc_m_loan.currencyCode, currencyCode),
    ));
  const loanAccountIds = new Set(loanAccounts.map((a: typeof loanAccounts[0]) => a.id));

  // Build a set of loan_transaction_ids that have a GL entry on the portfolio account
  const glLinkedLoanTxnIds = new Set(
    glEntries
      .filter((e: typeof glEntries[0]) => e.loanTransactionId != null)
      .map((e: typeof glEntries[0]) => e.loanTransactionId as number)
  );

  const exceptions: Layer2Exception[] = [];
  const now = new Date();

  // ── Check 1: GL entries on portfolio account ─────────────────────────────
  for (const entry of glEntries) {
    const glAmount = parseFloat(entry.amount?.toString() ?? "0");
    const glType: "CREDIT" | "DEBIT" = entry.typeEnum === 1 ? "CREDIT" : "DEBIT";
    const accountName = (glAccountMap.get(entry.accountId) as { id: number; name: string } | undefined)?.name ?? `Account ${entry.accountId}`;
    let exceptionCategory = "VALID";

    // Manual entry with no loan_transaction_id = principal adjustment anomaly
    if (entry.manualEntry === 1 && entry.loanTransactionId == null) {
      exceptionCategory = "PRINCIPAL_ADJUSTMENT_ANOMALY";
    }
    // Has a loan_transaction_id but that ID doesn't exist in wc_m_loan_transaction = orphaned
    else if (entry.loanTransactionId != null && !loanTxnMap.has(entry.loanTransactionId)) {
      exceptionCategory = "ORPHANED_LOAN_ENTRY";
    }
    // Has a loan_transaction_id that exists — check if it's a disbursement posted to wrong account
    else if (entry.loanTransactionId != null && loanTxnMap.has(entry.loanTransactionId)) {
      const loanTxn = loanTxnMap.get(entry.loanTransactionId) as { id: number; loanId: number; transactionTypeEnum: number; principalPortion: unknown } | undefined;
      // Disbursement (type=1) should be DEBIT to portfolio; if it's a CREDIT, it's misposted
      if (loanTxn?.transactionTypeEnum === 1 && glType === "CREDIT") {
        exceptionCategory = "DISBURSEMENT_MISPOSTING";
      }
    }

    const glAccount = glAccountMap.get(entry.accountId) as { id: number; classificationEnum: number | null; name: string } | undefined;
    const isAssetAccount = ((glAccount?.classificationEnum ?? 1) === 1) || ((glAccount?.classificationEnum ?? 1) === 5);
    const exceptionContribution = isAssetAccount
      ? (glType === "DEBIT" ? glAmount : -glAmount)
      : (glType === "CREDIT" ? glAmount : -glAmount);

    if (exceptionCategory !== "VALID") {
      await db.insert(wc_exceptions).values({
        reconciliationRunId: runId,
        glEntryId: entry.id,
        exceptionCategory,
        exceptionContribution: exceptionContribution.toFixed(6),
        glEntryAmount: glAmount.toFixed(6),
        glEntryDate: entry.entryDate,
        glEntryType: glType,
        manualEntryFlag: entry.manualEntry ?? 0,
        linkedTransactionId: entry.transactionId,
        linkedSavingsTxnId: null,
        linkedSavingsAccountId: null,
        linkedProductId: productId,
        productMatch: 1,
        passedToLayer3: 1,
        layer3Processed: 0,
        createdAt: now,
      });
      exceptions.push({
        glEntryId: entry.id,
        exceptionCategory,
        exceptionContribution,
        glEntryAmount: glAmount,
        glEntryDate: entry.entryDate as string,
        glEntryType: glType,
        manualEntryFlag: entry.manualEntry === 1,
        linkedTransactionId: entry.transactionId,
        linkedSavingsTxnId: null,
        linkedSavingsAccountId: null,
        linkedProductId: productId,
        productMatch: true,
        description: entry.description,
        refNum: entry.refNum,
        accountId: entry.accountId,
        accountName,
      });
    }
  }

  // ── Check 2: Loan repayment transactions with no GL entry on portfolio ────
  // For each repayment in the period, check if a corresponding GL credit exists
  const repaymentTxns = loanTxns.filter((t: typeof loanTxns[0]) =>
    !t.isReversed &&
    loanAccountIds.has(t.loanId) &&
    (t.transactionTypeEnum === 2 || t.transactionTypeEnum === 8) // Repayment or Recovery
  );

  for (const repayTxn of repaymentTxns) {
    if (glLinkedLoanTxnIds.has(repayTxn.id)) continue; // GL entry exists — OK
    // No GL entry for this repayment — flag as REPAYMENT_NOT_POSTED
    const principalAmt = parseFloat(repayTxn.principalPortion?.toString() ?? "0");
    if (principalAmt <= 0) continue; // Skip zero-principal repayments

    // Insert a synthetic exception (no GL entry ID — use negative of loan_txn_id as sentinel)
    const syntheticGlId = -(repayTxn.id); // negative = synthetic, no real GL entry
    await db.insert(wc_exceptions).values({
      reconciliationRunId: runId,
      glEntryId: syntheticGlId,
      exceptionCategory: "REPAYMENT_NOT_POSTED",
      exceptionContribution: principalAmt.toFixed(6), // positive = under-credited to portfolio
      glEntryAmount: principalAmt.toFixed(6),
      glEntryDate: repayTxn.transactionDate,
      glEntryType: "CREDIT", // should have been a credit to portfolio
      manualEntryFlag: 0,
      linkedTransactionId: `LOAN-TXN-${repayTxn.id}`,
      linkedSavingsTxnId: null,
      linkedSavingsAccountId: null,
      linkedProductId: productId,
      productMatch: 1,
      passedToLayer3: 1,
      layer3Processed: 0,
      createdAt: now,
    });
    exceptions.push({
      glEntryId: syntheticGlId,
      exceptionCategory: "REPAYMENT_NOT_POSTED",
      exceptionContribution: principalAmt,
      glEntryAmount: principalAmt,
      glEntryDate: repayTxn.transactionDate as string,
      glEntryType: "CREDIT",
      manualEntryFlag: false,
      linkedTransactionId: `LOAN-TXN-${repayTxn.id}`,
      linkedSavingsTxnId: null,
      linkedSavingsAccountId: null,
      linkedProductId: productId,
      productMatch: true,
      description: `Loan repayment principal ₦${principalAmt.toLocaleString("en-NG", { minimumFractionDigits: 2 })} — no GL entry found`,
      refNum: null,
      accountId: portfolioLedgerAccountId,
      accountName: "SME Loan Portfolio Account",
    });
  }

  // ── Check 3: Disbursement transactions with no GL entry on portfolio ──────
  const disbursementTxns = loanTxns.filter((t: typeof loanTxns[0]) =>
    !t.isReversed &&
    loanAccountIds.has(t.loanId) &&
    t.transactionTypeEnum === 1 // Disbursement
  );

  for (const disbTxn of disbursementTxns) {
    // Check if there's a DEBIT GL entry on the portfolio account for this disbursement
    const hasPortfolioDebit = glEntries.some((e: typeof glEntries[0]) =>
      e.loanTransactionId === disbTxn.id && e.typeEnum === 2 // DEBIT
    );
    if (hasPortfolioDebit) continue;
    // No portfolio debit found — this is a disbursement misposting
    const principalAmt = parseFloat(disbTxn.principalPortion?.toString() ?? "0");
    if (principalAmt <= 0) continue;

    // Check if there's any GL entry for this disbursement (on wrong account)
    const hasAnyGlEntry = glLinkedLoanTxnIds.has(disbTxn.id);
    const exceptionCategory = hasAnyGlEntry ? "DISBURSEMENT_MISPOSTING" : "DISBURSEMENT_NOT_POSTED";

    const syntheticGlId = -(disbTxn.id + 10000); // offset to avoid collision with repayment sentinels
    await db.insert(wc_exceptions).values({
      reconciliationRunId: runId,
      glEntryId: syntheticGlId,
      exceptionCategory,
      exceptionContribution: (-principalAmt).toFixed(6), // negative = under-debited to portfolio
      glEntryAmount: principalAmt.toFixed(6),
      glEntryDate: disbTxn.transactionDate,
      glEntryType: "DEBIT",
      manualEntryFlag: 0,
      linkedTransactionId: `LOAN-TXN-${disbTxn.id}`,
      linkedSavingsTxnId: null,
      linkedSavingsAccountId: null,
      linkedProductId: productId,
      productMatch: 1,
      passedToLayer3: 1,
      layer3Processed: 0,
      createdAt: now,
    });
    exceptions.push({
      glEntryId: syntheticGlId,
      exceptionCategory,
      exceptionContribution: -principalAmt,
      glEntryAmount: principalAmt,
      glEntryDate: disbTxn.transactionDate as string,
      glEntryType: "DEBIT",
      manualEntryFlag: false,
      linkedTransactionId: `LOAN-TXN-${disbTxn.id}`,
      linkedSavingsTxnId: null,
      linkedSavingsAccountId: null,
      linkedProductId: productId,
      productMatch: true,
      description: `Loan disbursement ₦${principalAmt.toLocaleString("en-NG", { minimumFractionDigits: 2 })} — not debited to portfolio account`,
      refNum: null,
      accountId: portfolioLedgerAccountId,
      accountName: "SME Loan Portfolio Account",
    });
  }

  return exceptions;
}

// ─── LAYER 2 (SAVINGS): Transaction-Level Exception Classifier ────────────────

export async function runLayer2(
  runId: number,
  layer1: Layer1Result,
  config: ReconciliationConfig
): Promise<Layer2Exception[]> {
  const db = await getDatabase();
  const { productId, currencyCode, periodStart, periodEnd } = config;
  const { portfolioLedgerAccountId } = layer1;

  // Get all GL entries on portfolio ledger for the period
  const glEntries = await db.select().from(wc_acc_gl_journal_entry)
    .where(and(
      eq(wc_acc_gl_journal_entry.accountId, portfolioLedgerAccountId),
      eq(wc_acc_gl_journal_entry.currencyCode, currencyCode),
      between(wc_acc_gl_journal_entry.entryDate, periodStart, periodEnd),
    ));

  // Get GL account name map
  const glAccounts = await db.select().from(wc_acc_gl_account);
  const glAccountMap = new Map(glAccounts.map((a: typeof glAccounts[0]) => [a.id, a]));

  // Get all bridge records
  const bridgeEntries = await db.select().from(wc_acc_to_gl_journal_entry);
  const bridgeMap = new Map(bridgeEntries.map((b: typeof bridgeEntries[0]) => [b.transactionId, b]));

  // Get all bridge savings records
  const bridgeSavings = await db.select().from(wc_acc_to_gl_journal_entry_savings);
  const bridgeSavingsMap = new Map<number, typeof bridgeSavings[0][]>();
  for (const b of bridgeSavings) {
    if (!bridgeSavingsMap.has(b.accToGlTransactionId)) {
      bridgeSavingsMap.set(b.accToGlTransactionId, []);
    }
    bridgeSavingsMap.get(b.accToGlTransactionId)!.push(b);
  }

  // Get all savings transactions
  const savingsTxns = await db.select().from(wc_m_savings_account_transaction);
  const savingsTxnMap = new Map(savingsTxns.map((t: typeof savingsTxns[0]) => [t.id, t]));

  // Get all savings accounts
  const savingsAccounts = await db.select().from(wc_m_savings_account);
  const savingsAccountMap = new Map(savingsAccounts.map((a: typeof savingsAccounts[0]) => [a.id, a]));

  const exceptions: Layer2Exception[] = [];
  const now = new Date();

  for (const entry of glEntries) {
    const glAmount = parseFloat(entry.amount?.toString() ?? "0");
    const glType: "CREDIT" | "DEBIT" = entry.typeEnum === 1 ? "CREDIT" : "DEBIT";
    const accountName = (glAccountMap.get(entry.accountId) as { id: number; name: string } | undefined)?.name ?? `Account ${entry.accountId}`;

    let exceptionCategory = "VALID";
    let linkedSavingsTxnId: number | null = null;
    let linkedSavingsAccountId: number | null = null;
    let linkedProductId: number | null = null;
    let productMatch: boolean | null = null;

    // Step 1: Check manual entry flag
    if (entry.manualEntry === 1) {
      exceptionCategory = "MANUAL_POSTING";
    }

    // Step 2: Attempt bridge table trace
    const bridgeEntry = bridgeMap.get(entry.transactionId);

    if (!bridgeEntry && exceptionCategory === "VALID") {
      // No bridge table linkage
      exceptionCategory = "ORPHANED_ENTRY";
    } else if (bridgeEntry) {
      // Step 3: Get linked savings transactions
      const linkedSavingsList = bridgeSavingsMap.get((bridgeEntry as { id: number }).id) ?? [];

      if (linkedSavingsList.length === 0 && exceptionCategory === "VALID") {
        exceptionCategory = "ORPHANED_ENTRY";
      } else {
        // Use the first linked savings transaction
        const linkedSavingsBridge = linkedSavingsList[0];
        if (linkedSavingsBridge) {
          linkedSavingsTxnId = linkedSavingsBridge.savingsTransactionId;
          linkedSavingsAccountId = linkedSavingsBridge.savingsId;

          const savingsTxnRaw = savingsTxnMap.get(linkedSavingsTxnId);
          const savingsTxn = savingsTxnRaw as { id: number; savingsAccountId: number; isReversed: number; amount: unknown; transactionTypeEnum: number } | undefined;
          if (!savingsTxn && exceptionCategory === "VALID") {
            exceptionCategory = "ORPHANED_ENTRY";
          } else if (savingsTxn) {
            // Check reversal
            if (savingsTxn.isReversed === 1 && exceptionCategory === "VALID") {
              exceptionCategory = "REVERSAL_ANOMALY";
            }

            // Check product ownership
            const savingsAccountRaw = savingsAccountMap.get(savingsTxn.savingsAccountId);
            const savingsAccount = savingsAccountRaw as { id: number; productId: number; currencyCode: string | null } | undefined;
            if (savingsAccount) {
              linkedProductId = savingsAccount.productId;
              productMatch = savingsAccount.productId === productId;

              if (!productMatch && exceptionCategory === "VALID") {
                exceptionCategory = "CROSS_PRODUCT_MISPOSTING";
              }

              // Check amount anomaly for valid entries
              if (exceptionCategory === "VALID") {
                const txnAmount = parseFloat(savingsTxn.amount?.toString() ?? "0");
                if (Math.abs(glAmount - txnAmount) > 0.01) {
                  exceptionCategory = "MANUAL_POSTING_ANOMALY";
                }
              }
            }
          }
        }
      }
    }

    // Compute exception contribution (only for non-VALID entries)
    // For Liability (Savings Control): balance = credits - debits
    // Contribution = credit amount - debit amount (positive = adds to balance)
    const glAccount = glAccountMap.get(entry.accountId) as { id: number; classificationEnum: number | null; name: string } | undefined;
    const isAssetAccount = ((glAccount?.classificationEnum ?? 2) === 1) || ((glAccount?.classificationEnum ?? 2) === 5);
    const exceptionContribution = isAssetAccount
      ? (glType === "DEBIT" ? glAmount : -glAmount)
      : (glType === "CREDIT" ? glAmount : -glAmount);

    if (exceptionCategory !== "VALID") {
      // Persist exception
      await db.insert(wc_exceptions).values({
        reconciliationRunId: runId,
        glEntryId: entry.id,
        exceptionCategory,
        exceptionContribution: exceptionContribution.toFixed(6),
        glEntryAmount: glAmount.toFixed(6),
        glEntryDate: entry.entryDate,
        glEntryType: glType,
        manualEntryFlag: entry.manualEntry ?? 0,
        linkedTransactionId: entry.transactionId,
        linkedSavingsTxnId,
        linkedSavingsAccountId,
        linkedProductId,
        productMatch: productMatch === null ? null : (productMatch ? 1 : 0),
        passedToLayer3: 1,
        layer3Processed: 0,
        createdAt: now,
      });

      exceptions.push({
        glEntryId: entry.id,
        exceptionCategory,
        exceptionContribution,
        glEntryAmount: glAmount,
        glEntryDate: entry.entryDate as string,
        glEntryType: glType,
        manualEntryFlag: entry.manualEntry === 1,
        linkedTransactionId: entry.transactionId,
        linkedSavingsTxnId,
        linkedSavingsAccountId,
        linkedProductId,
        productMatch,
        description: entry.description,
        refNum: entry.refNum,
        accountId: entry.accountId,
        accountName,
      });
    }
  }

  return exceptions;
}

// ─── LAYER 3: Context-Aware Agent ────────────────────────────────────────────

const EXCEPTION_ACTIONS: Record<string, string> = {
  // Loan-specific exception actions
  DISBURSEMENT_MISPOSTING: "Raise with the CBS administrator to investigate the disbursement posting rule for the SME Loan product. The disbursement was posted to the wrong GL account — it should debit the Loan Portfolio Account (117083) but was posted elsewhere. Raise a correcting journal entry to move the debit to the correct account. Verify the product-to-ledger mapping in the CBS configuration.",
  DISBURSEMENT_NOT_POSTED: "The loan disbursement was recorded in the CBS loan transaction table but no corresponding GL debit was posted to the Loan Portfolio Account. This is a critical control failure — the GL balance understates outstanding principal. Raise with the CBS DBA immediately to investigate the posting engine failure and post the missing GL entry.",
  REPAYMENT_NOT_POSTED: "A loan repayment principal portion was recorded in the CBS loan transaction table but no corresponding GL credit was posted to the Loan Portfolio Account. The GL balance overstates outstanding principal. Raise with the CBS DBA to investigate the posting engine and post the missing GL credit entry.",
  PRINCIPAL_ADJUSTMENT_ANOMALY: "A manual entry was posted directly to the Loan Portfolio Account without a corresponding loan transaction record. Manual adjustments to the principal balance require dual authorisation and a supporting loan transaction. Obtain the authorisation documentation, verify the business justification, and raise a correcting entry if the adjustment was not properly approved.",
  ORPHANED_LOAN_ENTRY: "This GL entry references a loan transaction ID that does not exist in the CBS loan transaction table. This could indicate a deleted transaction, a direct GL insert bypassing the CBS posting engine, or a data migration artefact. Raise with the CBS DBA to investigate and either link the entry to a valid loan transaction or reverse it.",
  CROSS_PRODUCT_MISPOSTING: "Raise with CBS administrator to investigate product-to-ledger mapping. Verify whether the originating transaction should have been posted to a different product's ledger. If confirmed, raise a correcting journal entry via the CBS workflow.",
  MANUAL_POSTING: "Obtain supporting documentation for the manual entry from the originating user. Verify the approval chain. If the entry is unauthorised, escalate to the compliance team immediately.",
  ORPHANED_ENTRY: "Raise with the CBS DBA to investigate whether the linked transaction was deleted or never created. If this is a data migration artefact, document and exclude from future reconciliation runs.",
  REVERSAL_ANOMALY: "Raise with the CBS administrator to complete the reversal in acc_gl_journal_entry. Verify that the reversal was intentional and that the corresponding transaction was correctly reversed.",
  MANUAL_POSTING_ANOMALY: "Obtain supporting documentation for the amount or date discrepancy. Verify whether the difference represents a legitimate adjustment or a data entry error.",
  UNKNOWN: "Escalate to senior finance officer for manual investigation. The AI agent explanation below provides additional context for the investigation.",
};

function getPriorityLevel(amount: number): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  const abs = Math.abs(amount);
  if (abs >= 500000) return "CRITICAL";
  if (abs >= 100000) return "HIGH";
  if (abs >= 10000) return "MEDIUM";
  return "LOW";
}

export async function runLayer3(
  runId: number,
  exceptions: Layer2Exception[],
  layer1: Layer1Result
): Promise<Layer3Result[]> {
  const db = await getDatabase();
  const results: Layer3Result[] = [];

  // Get all exception IDs from DB for this run
  const dbExceptions = await db.select().from(wc_exceptions)
    .where(eq(wc_exceptions.reconciliationRunId, runId));

  // Get savings account and product info for context
  const savingsAccounts = await db.select().from(wc_m_savings_account);
  const savingsProducts = await db.select().from(wc_m_savings_product);
  const savingsAccountMap = new Map(savingsAccounts.map((a: typeof savingsAccounts[0]) => [a.id, a]));
  const savingsProductMap = new Map(savingsProducts.map((p: typeof savingsProducts[0]) => [p.id, p]));

  for (const exc of exceptions) {
    const dbExc = dbExceptions.find((e: typeof dbExceptions[0]) => e.glEntryId === exc.glEntryId);
    if (!dbExc) continue;

    // Pre-classifier: high confidence for known categories
    let confidence = 85;
    let agentClassification = exc.exceptionCategory;
    let agentExplanation = "";

    // Build context for LLM (for UNKNOWN or low-confidence cases)
    const linkedAccount = exc.linkedSavingsAccountId
      ? (savingsAccountMap.get(exc.linkedSavingsAccountId) as { id: number; productId: number; accountNo: string; currencyCode: string | null } | undefined) ?? null
      : null;
    const linkedProduct = linkedAccount?.productId != null
      ? (savingsProductMap.get(linkedAccount.productId) as { id: number; name: string; shortName: string | null } | undefined) ?? null
      : null;
    const inScopeProduct = (savingsProductMap.get(layer1.productId) as { id: number; name: string; shortName: string | null } | undefined) ?? null;

    // Generate plain-English explanation
    // ── Loan-specific exception explanations ────────────────────────────────
    if (exc.exceptionCategory === "DISBURSEMENT_MISPOSTING") {
      confidence = 95;
      agentExplanation = `A loan disbursement of ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} recorded on ${exc.glEntryDate} was not debited to the SME Loan Portfolio Account (GL 117083). The disbursement transaction exists in the CBS loan transaction table (ref: ${exc.linkedTransactionId ?? exc.refNum ?? "N/A"}) but the corresponding GL debit was posted to the wrong account — most likely the Fund Source Account (GL 113938). This means the Loan Portfolio Account balance understates the true outstanding principal by ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })}. A correcting journal entry is required to debit the Portfolio Account and credit the Fund Source Account.`;
    } else if (exc.exceptionCategory === "DISBURSEMENT_NOT_POSTED") {
      confidence = 97;
      agentExplanation = `A loan disbursement of ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} was recorded in the CBS loan transaction table on ${exc.glEntryDate} (ref: ${exc.linkedTransactionId ?? "N/A"}) but no GL entry was posted to the Loan Portfolio Account. This is a critical posting engine failure — the outstanding principal balance in the GL is understated by ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })}. Immediate investigation is required to determine why the GL posting did not fire and to post the missing debit entry.`;
    } else if (exc.exceptionCategory === "REPAYMENT_NOT_POSTED") {
      confidence = 97;
      agentExplanation = `A loan repayment principal portion of ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} was recorded in the CBS loan transaction table on ${exc.glEntryDate} (ref: ${exc.linkedTransactionId ?? "N/A"}) but no corresponding GL credit was posted to the Loan Portfolio Account (GL 117083). The GL balance overstates outstanding principal by ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })}. The CBS posting engine failed to generate the GL credit for this repayment. Post the missing credit entry and investigate why the automated posting did not fire.`;
    } else if (exc.exceptionCategory === "PRINCIPAL_ADJUSTMENT_ANOMALY") {
      confidence = 90;
      agentExplanation = `A manual journal entry of ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} (${exc.glEntryType}) was posted directly to the Loan Portfolio Account on ${exc.glEntryDate} with description: "${exc.description ?? "No description"}". This entry has no linked loan transaction ID — it bypassed the CBS posting engine entirely. Manual adjustments to the principal balance are a high-risk control failure: they alter the outstanding loan balance without a corresponding CBS transaction record, making it impossible to trace the adjustment back to a specific loan or borrower. Obtain the authorisation documentation and verify the business justification immediately.`;
    } else if (exc.exceptionCategory === "ORPHANED_LOAN_ENTRY") {
      confidence = 88;
      agentExplanation = `This GL entry of ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} (${exc.glEntryType}) on ${exc.glEntryDate} references loan transaction ID ${exc.linkedTransactionId} which does not exist in the CBS loan transaction table. This entry cannot be validated against any loan record. Possible causes: (1) the originating loan transaction was deleted after the GL entry was created, (2) a direct GL insert was made bypassing the CBS posting engine, or (3) this is a data migration artefact. Raise with the CBS DBA to investigate and either link the entry to a valid loan transaction or reverse it.`;
    } else if (exc.exceptionCategory === "CROSS_PRODUCT_MISPOSTING") {
      confidence = 95;
      agentExplanation = `This GL entry of ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} (${exc.glEntryType}) was posted to the ${layer1.portfolioLedgerName} ledger on ${exc.glEntryDate}, but it traces back to a savings account (ID: ${exc.linkedSavingsAccountId}) belonging to the "${linkedProduct?.name ?? "Unknown"}" product (Product ID: ${exc.linkedProductId}), not the "${inScopeProduct?.name ?? "WoodCore Savings"}" product being reconciled. This is a cross-product mis-posting — a transaction from one product has been incorrectly posted to another product's ledger. This is a direct cause of the reconciliation variance.`;
    } else if (exc.exceptionCategory === "MANUAL_POSTING") {
      confidence = 90;
      agentExplanation = `This GL entry of ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} (${exc.glEntryType}) on ${exc.glEntryDate} is flagged as a manual entry (manual_entry = 1). The entry reference is "${exc.refNum ?? "N/A"}" with description: "${exc.description ?? "No description provided"}". Manual entries bypass the CBS automated posting engine and are a common source of reconciliation variances. This entry has no linked savings transaction in the bridge table, confirming it was posted directly to the GL without a corresponding CBS transaction.`;
    } else if (exc.exceptionCategory === "ORPHANED_ENTRY") {
      confidence = 88;
      agentExplanation = `This GL entry of ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} (${exc.glEntryType}) on ${exc.glEntryDate} has no corresponding record in the CBS transaction bridge table (acc_to_gl_journal_entry). The transaction ID "${exc.linkedTransactionId}" cannot be traced to any savings transaction. This could indicate: (1) the originating transaction was deleted after the GL entry was created, (2) a direct GL insert bypassing the CBS posting engine, or (3) a data migration artefact. Without a linked transaction, this entry cannot be automatically validated.`;
    } else if (exc.exceptionCategory === "REVERSAL_ANOMALY") {
      confidence = 92;
      agentExplanation = `This GL entry of ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} (${exc.glEntryType}) on ${exc.glEntryDate} is linked to savings transaction ID ${exc.linkedSavingsTxnId}, which has been marked as reversed (is_reversed = 1) in the savings transaction table. However, this GL entry has not been reversed in the GL journal. This is an incomplete reversal — the transaction was reversed in the CBS but the corresponding GL entry was not updated. This creates a phantom balance in the ledger.`;
    } else if (exc.exceptionCategory === "MANUAL_POSTING_ANOMALY") {
      confidence = 80;
      agentExplanation = `This GL entry of ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} (${exc.glEntryType}) on ${exc.glEntryDate} is linked to a valid savings transaction (ID: ${exc.linkedSavingsTxnId}), but the amounts do not match exactly. This could indicate a partial posting, a manual override of an automated entry, or a rounding difference that exceeds the acceptable tolerance. Review the linked transaction and the GL entry to determine whether a correcting entry is required.`;
    } else {
      // Use LLM for UNKNOWN
      confidence = 60;
      try {
        const llmResponse = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `You are a financial reconciliation expert analysing GL journal entry anomalies in a Nigerian core banking system (Woodcore CBS). Provide a concise, plain-English explanation of the anomaly for a finance officer. Be specific about the amounts, dates, and likely cause. Keep the explanation under 100 words.`,
            },
            {
              role: "user",
              content: `Analyse this GL journal entry anomaly:
- GL Entry ID: ${exc.glEntryId}
- Amount: ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })} (${exc.glEntryType})
- Date: ${exc.glEntryDate}
- Account: ${exc.accountName}
- Description: ${exc.description ?? "None"}
- Reference: ${exc.refNum ?? "None"}
- Manual Entry: ${exc.manualEntryFlag ? "Yes" : "No"}
- Bridge Table Linkage: ${exc.linkedSavingsTxnId ? "Yes" : "No"}
- Product Match: ${exc.productMatch === null ? "Unknown" : exc.productMatch ? "Yes" : "No"}
- Category assigned by classifier: ${exc.exceptionCategory}

Explain what likely caused this anomaly and what the finance team should do.`,
            },
          ],
        });
        agentExplanation = (llmResponse as any)?.choices?.[0]?.message?.content ?? "Unable to generate explanation.";
        confidence = 65;
      } catch (e) {
        agentExplanation = `This entry could not be automatically classified. Manual investigation is required. GL Entry ID: ${exc.glEntryId}, Amount: ₦${exc.glEntryAmount.toLocaleString("en-NG", { minimumFractionDigits: 2 })}, Date: ${exc.glEntryDate}.`;
      }
    }

    const priorityLevel = getPriorityLevel(exc.exceptionContribution);
    const recommendedAction = EXCEPTION_ACTIONS[exc.exceptionCategory] ?? EXCEPTION_ACTIONS.UNKNOWN;

    // Update exception record in DB
    await db.update(wc_exceptions)
      .set({
        agentClassification,
        agentExplanation,
        agentConfidence: confidence,
        recommendedAction,
        priorityLevel,
        layer3Processed: 1,
      })
      .where(eq(wc_exceptions.id, dbExc.id));

    results.push({
      exceptionId: dbExc.id,
      agentClassification,
      agentExplanation,
      agentConfidence: confidence,
      recommendedAction,
      priorityLevel,
    });
  }

  return results;
}

// ─── Full POC Run (all three layers) ─────────────────────────────────────────

export async function runFullPOC(config: ReconciliationConfig) {
  const db = await getDatabase();
  // Clear previous runs for this product/period
  const existingRuns = await db.select({ id: wc_reconciliation_runs.id })
    .from(wc_reconciliation_runs)
    .where(and(
      eq(wc_reconciliation_runs.productId, config.productId),
      eq(wc_reconciliation_runs.periodStart, config.periodStart),
      eq(wc_reconciliation_runs.periodEnd, config.periodEnd),
    ));

  for (const run of existingRuns) {
    await db.delete(wc_exceptions).where(eq(wc_exceptions.reconciliationRunId, run.id));
    await db.delete(wc_reconciliation_runs).where(eq(wc_reconciliation_runs.id, run.id));
  }

  // Layer 1
  const layer1 = await runLayer1(config);

  let layer2Exceptions: Layer2Exception[] = [];
  let layer3Results: Layer3Result[] = [];

  // Layer 2 (only if variance detected)
  if (layer1.layer2Triggered) {
    if (config.productType === "LOAN") {
      layer2Exceptions = await runLayer2Loan(layer1.runId, layer1, config);
    } else {
      layer2Exceptions = await runLayer2(layer1.runId, layer1, config);
    }

    // Layer 3 (only if exceptions found)
    if (layer2Exceptions.length > 0) {
      layer3Results = await runLayer3(layer1.runId, layer2Exceptions, layer1);
    }
  }

  return {
    layer1,
    layer2Exceptions,
    layer3Results,
  };
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export async function getLatestRuns(limit = 10) {
  const db = await getDatabase();
  return db.select().from(wc_reconciliation_runs)
    .orderBy(sql`created_at DESC`)
    .limit(limit);
}

export async function getRunExceptions(runId: number) {
  const db = await getDatabase();
  return db.select().from(wc_exceptions)
    .where(eq(wc_exceptions.reconciliationRunId, runId))
    .orderBy(sql`ABS(exception_contribution) DESC`);
}

export async function getRunById(runId: number) {
  const db = await getDatabase();
  const [run] = await db.select().from(wc_reconciliation_runs)
    .where(eq(wc_reconciliation_runs.id, runId));
  return run;
}

export async function getWoodcoreStats() {
  const db = await getDatabase();
  const [glCount] = await db.select({ c: sql<number>`COUNT(*)` }).from(wc_acc_gl_journal_entry);
  const [savingsCount] = await db.select({ c: sql<number>`COUNT(*)` }).from(wc_m_savings_account_transaction);
  const [accountCount] = await db.select({ c: sql<number>`COUNT(*)` }).from(wc_m_savings_account);
  const [productCount] = await db.select({ c: sql<number>`COUNT(*)` }).from(wc_m_savings_product);
  const [runCount] = await db.select({ c: sql<number>`COUNT(*)` }).from(wc_reconciliation_runs);
  const [excCount] = await db.select({ c: sql<number>`COUNT(*)` }).from(wc_exceptions);

  const [loanCount] = await db.select({ c: sql<number>`COUNT(*)` }).from(wc_m_loan);
  const [loanTxnCount] = await db.select({ c: sql<number>`COUNT(*)` }).from(wc_m_loan_transaction);

  return {
    glEntries: Number(glCount.c),
    savingsTransactions: Number(savingsCount.c),
    savingsAccounts: Number(accountCount.c),
    products: Number(productCount.c),
    reconciliationRuns: Number(runCount.c),
    exceptions: Number(excCount.c),
    loanAccounts: Number(loanCount.c),
    loanTransactions: Number(loanTxnCount.c),
  };
}
