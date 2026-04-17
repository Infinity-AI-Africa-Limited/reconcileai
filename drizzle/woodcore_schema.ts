/**
 * Woodcore POC Schema
 * These tables mirror the Woodcore CBS production schema (read-only copy for POC).
 * All data is loaded from the August 2025 database dump.
 */

import {
  int,
  tinyint,
  smallint,
  mysqlTable,
  text,
  varchar,
  decimal,
  bigint,
  date,
  datetime,
  index,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

// ─── Woodcore: GL Accounts (Chart of Accounts) ───────────────────────────────
export const wc_acc_gl_account = mysqlTable("wc_acc_gl_account", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  name: varchar("name", { length: 150 }).notNull(),
  glCode: varchar("gl_code", { length: 100 }),
  disabled: tinyint("disabled").default(0),
  manualEntriesAllowed: tinyint("manual_entries_allowed").default(1),
  classificationEnum: smallint("classification_enum"), // 1=Asset,2=Liability,3=Equity,4=Income,5=Expense
  accountUsage: smallint("account_usage"), // 1=Header,2=Detail
  parentId: bigint("parent_id", { mode: "number" }),
  hierarchy: varchar("hierarchy", { length: 50 }),
  tagId: bigint("tag_id", { mode: "number" }),
  description: varchar("description", { length: 500 }),
  organizationRunningBalance: decimal("organization_running_balance", { precision: 19, scale: 6 }).default("0"),
});

// ─── Woodcore: Product Mapping (product → GL account) ────────────────────────
export const wc_acc_product_mapping = mysqlTable("wc_acc_product_mapping", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  glAccountId: bigint("gl_account_id", { mode: "number" }).notNull(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  productType: smallint("product_type").notNull(), // 1=loan, 2=savings
  chargeId: bigint("charge_id", { mode: "number" }),
  paymentTypeId: bigint("payment_type_id", { mode: "number" }),
  financialAccountType: smallint("financial_account_type").notNull(),
  // financial_account_type: 1=Savings Reference/Fund Source, 2=Loan Portfolio/Savings Control,
  // 3=Interest on Loans/Savings, 4=Income from Fees, 5=Income from Penalties,
  // 10=Transfers Suspense, 11=Overdraft Portfolio, 12=Overdraft Interest, 13=Write-Off,
  // 14=Savings Control (secondary), 15=Interest Payable, 16=Interest Receivable
});

// ─── Woodcore: GL Journal Entries ────────────────────────────────────────────
export const wc_acc_gl_journal_entry = mysqlTable("wc_acc_gl_journal_entry", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  accountId: bigint("account_id", { mode: "number" }).notNull(),
  officeId: bigint("office_id", { mode: "number" }).notNull(),
  reversalId: bigint("reversal_id", { mode: "number" }),
  currencyCode: varchar("currency_code", { length: 3 }).notNull(),
  transactionId: varchar("transaction_id", { length: 50 }).notNull(),
  loanTransactionId: bigint("loan_transaction_id", { mode: "number" }),
  savingsTransactionId: bigint("savings_transaction_id", { mode: "number" }),
  reversed: tinyint("reversed").default(0),
  refNum: varchar("ref_num", { length: 100 }),
  manualEntry: tinyint("manual_entry").default(0),
  entryDate: varchar("entry_date", { length: 10 }).notNull(),
  typeEnum: smallint("type_enum").notNull(), // 1=Credit, 2=Debit
  amount: decimal("amount", { precision: 30, scale: 6 }),
  description: varchar("description", { length: 500 }),
  createdDate: datetime("created_date").notNull(),
  uniqueRefKey: varchar("unique_ref_key", { length: 100 }),
}, (t) => [
  index("idx_wc_gl_account").on(t.accountId),
  index("idx_wc_gl_entry_date").on(t.entryDate),
  index("idx_wc_gl_transaction_id").on(t.transactionId),
]);

// ─── Woodcore: Bridge Table (GL batch → savings transaction) ─────────────────
export const wc_acc_to_gl_journal_entry = mysqlTable("wc_acc_to_gl_journal_entry", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  transactionId: varchar("transaction_id", { length: 50 }).notNull().unique(),
  reversedTransactionId: varchar("reversed_transaction_id", { length: 50 }),
  reversed: int("reversed").default(0),
});

export const wc_acc_to_gl_journal_entry_savings = mysqlTable("wc_acc_to_gl_journal_entry_savings", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  accToGlTransactionId: bigint("acc_to_gl_transaction_id", { mode: "number" }).notNull(),
  savingsId: bigint("savings_id", { mode: "number" }).notNull(),
  savingsTransactionId: bigint("savings_transaction_id", { mode: "number" }).notNull(),
  reversed: int("reversed").default(0),
}, (t) => [
  index("idx_wc_bridge_savings_txn").on(t.savingsTransactionId),
  index("idx_wc_bridge_acc_to_gl").on(t.accToGlTransactionId),
]);

// ─── Woodcore: Savings Products ──────────────────────────────────────────────
export const wc_m_savings_product = mysqlTable("wc_m_savings_product", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  shortName: varchar("short_name", { length: 4 }),
  description: varchar("description", { length: 500 }),
  depositAmount: decimal("deposit_amount", { precision: 19, scale: 6 }),
  currencyCode: varchar("currency_code", { length: 3 }),
  nominalAnnualInterestRate: decimal("nominal_annual_interest_rate", { precision: 19, scale: 6 }),
});

// ─── Woodcore: Loan Products ─────────────────────────────────────────────────
export const wc_m_product_loan = mysqlTable("wc_m_product_loan", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  shortName: varchar("short_name", { length: 4 }),
  currencyCode: varchar("currency_code", { length: 3 }),
  nominalInterestRatePerPeriod: decimal("nominal_interest_rate_per_period", { precision: 19, scale: 6 }),
});

// ─── Woodcore: Savings Accounts ──────────────────────────────────────────────
export const wc_m_savings_account = mysqlTable("wc_m_savings_account", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  accountNo: varchar("account_no", { length: 20 }).notNull(),
  clientId: bigint("client_id", { mode: "number" }),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  statusEnum: smallint("status_enum"), // 100=Submitted, 200=Approved, 300=Active, 400=Closed
  currencyCode: varchar("currency_code", { length: 3 }),
  accountBalanceDerived: decimal("account_balance_derived", { precision: 30, scale: 6 }),
  activatedOnDate: varchar("activated_on_date", { length: 10 }),
}, (t) => [
  index("idx_wc_savings_product").on(t.productId),
]);

// ─── Woodcore: Savings Account Transactions ───────────────────────────────────
export const wc_m_savings_account_transaction = mysqlTable("wc_m_savings_account_transaction", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  savingsAccountId: bigint("savings_account_id", { mode: "number" }).notNull(),
  transactionTypeEnum: smallint("transaction_type_enum").notNull(),
  // 1=Deposit, 2=Withdrawal, 3=Interest Posting, 4=Withdrawal Fee, 5=Annual Fee,
  // 6=Waive Charge, 7=Pay Charge, 8=Dividend Payout, 9=Initiate Transfer,
  // 10=Approve Transfer, 11=Withdraw Transfer, 12=Reject Transfer, 13=Overdraft Interest
  isReversed: tinyint("is_reversed").notNull().default(0),
  transactionDate: varchar("transaction_date", { length: 10 }).notNull(),
  amount: decimal("amount", { precision: 30, scale: 6 }),
  runningBalanceDerived: decimal("running_balance_derived", { precision: 30, scale: 6 }),
  isManual: tinyint("is_manual").default(0),
  createdDate: datetime("created_date").notNull(),
}, (t) => [
  index("idx_wc_sat_account").on(t.savingsAccountId),
  index("idx_wc_sat_date").on(t.transactionDate),
]);

// ─── Woodcore: Loan Accounts ─────────────────────────────────────────────────
export const wc_m_loan = mysqlTable("wc_m_loan", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  accountNo: varchar("account_no", { length: 20 }),
  clientId: bigint("client_id", { mode: "number" }),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  loanStatusId: int("loan_status_id"),
  principalAmount: decimal("principal_amount", { precision: 19, scale: 6 }),
  approvedPrincipal: decimal("approved_principal", { precision: 19, scale: 6 }),
  currencyCode: varchar("currency_code", { length: 3 }),
});

// ─── Woodcore: Loan Transactions ─────────────────────────────────────────────
export const wc_m_loan_transaction = mysqlTable("wc_m_loan_transaction", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  loanId: bigint("loan_id", { mode: "number" }).notNull(),
  transactionTypeEnum: smallint("transaction_type_enum").notNull(),
  // 1=Disbursement, 2=Repayment, 3=Contra, 4=Waive Interest, 5=Repayment At Disbursement,
  // 6=Writeoff, 7=Marked for Rescheduling, 8=Recovery Repayment, 9=Waive Charges,
  // 10=Accrual, 11=Initiate Transfer, 12=Approve Transfer, 13=Withdraw Transfer, 14=Reject Transfer
  isReversed: tinyint("is_reversed").notNull().default(0),
  transactionDate: varchar("transaction_date", { length: 10 }).notNull(),
  amount: decimal("amount", { precision: 19, scale: 6 }),
  principalPortion: decimal("principal_portion_derived", { precision: 19, scale: 6 }),
  interestPortion: decimal("interest_portion_derived", { precision: 19, scale: 6 }),
  createdDate: datetime("created_date").notNull(),
});

// ─── ReconcileAI: POC Reconciliation Runs ────────────────────────────────────
export const wc_reconciliation_runs = mysqlTable("wc_reconciliation_runs", {
  id: int("id").autoincrement().primaryKey(),
  productId: bigint("product_id", { mode: "number" }).notNull(),
  productName: varchar("product_name", { length: 100 }).notNull(),
  productType: varchar("product_type", { length: 10 }).notNull(), // LOAN | SAVINGS
  portfolioLedgerAccountId: bigint("portfolio_ledger_account_id", { mode: "number" }).notNull(),
  portfolioLedgerGlCode: varchar("portfolio_ledger_gl_code", { length: 100 }),
  reconciliationDate: varchar("reconciliation_date", { length: 10 }).notNull(),
  periodStart: varchar("period_start", { length: 10 }).notNull(),
  periodEnd: varchar("period_end", { length: 10 }).notNull(),
  expectedBalance: decimal("expected_balance", { precision: 30, scale: 6 }),
  actualGlBalance: decimal("actual_gl_balance", { precision: 30, scale: 6 }),
  varianceAmount: decimal("variance_amount", { precision: 30, scale: 6 }),
  varianceDirection: varchar("variance_direction", { length: 20 }), // OVER_POSTED | UNDER_POSTED | BALANCED
  status: varchar("status", { length: 20 }).notNull(), // BALANCED | VARIANCE_DETECTED
  thresholdApplied: decimal("threshold_applied", { precision: 30, scale: 6 }).default("0"),
  layer2Triggered: tinyint("layer2_triggered").default(0),
  currencyCode: varchar("currency_code", { length: 3 }).default("NGN"),
  totalGlEntries: int("total_gl_entries").default(0),
  totalSavingsTxns: int("total_savings_txns").default(0),
  createdAt: datetime("created_at").notNull(),
});

// ─── ReconcileAI: POC Exception Records ──────────────────────────────────────
export const wc_exceptions = mysqlTable("wc_exceptions", {
  id: int("id").autoincrement().primaryKey(),
  reconciliationRunId: int("reconciliation_run_id").notNull(),
  glEntryId: bigint("gl_entry_id", { mode: "number" }).notNull(),
  exceptionCategory: varchar("exception_category", { length: 50 }).notNull(),
  // CROSS_PRODUCT_MISPOSTING | MANUAL_POSTING | ORPHANED_ENTRY | REVERSAL_ANOMALY |
  // MANUAL_POSTING_ANOMALY | VALID | UNKNOWN
  exceptionContribution: decimal("exception_contribution", { precision: 30, scale: 6 }),
  glEntryAmount: decimal("gl_entry_amount", { precision: 30, scale: 6 }),
  glEntryDate: varchar("gl_entry_date", { length: 10 }),
  glEntryType: varchar("gl_entry_type", { length: 10 }), // CREDIT | DEBIT
  manualEntryFlag: tinyint("manual_entry_flag").default(0),
  linkedTransactionId: varchar("linked_transaction_id", { length: 50 }),
  linkedSavingsTxnId: bigint("linked_savings_txn_id", { mode: "number" }),
  linkedSavingsAccountId: bigint("linked_savings_account_id", { mode: "number" }),
  linkedProductId: bigint("linked_product_id", { mode: "number" }),
  productMatch: tinyint("product_match"),
  // Layer 3 fields
  agentClassification: varchar("agent_classification", { length: 50 }),
  agentExplanation: text("agent_explanation"),
  agentConfidence: int("agent_confidence"), // 0-100
  recommendedAction: text("recommended_action"),
  priorityLevel: varchar("priority_level", { length: 10 }), // CRITICAL | HIGH | MEDIUM | LOW
  passedToLayer3: tinyint("passed_to_layer3").default(0),
  layer3Processed: tinyint("layer3_processed").default(0),
  refNum: varchar("ref_num", { length: 100 }),
  description: varchar("description", { length: 500 }),
  // Exception status tracking
  reviewStatus: varchar("review_status", { length: 20 }).default("OPEN"),
  // OPEN | ACKNOWLEDGED | RESOLVED | ESCALATED
  reviewedBy: varchar("reviewed_by", { length: 100 }),
  reviewedAt: datetime("reviewed_at"),
  reviewNote: text("review_note"),
  createdAt: datetime("created_at").notNull(),
}, (t) => [
  index("idx_wc_exc_run").on(t.reconciliationRunId),
  index("idx_wc_exc_category").on(t.exceptionCategory),
]);
