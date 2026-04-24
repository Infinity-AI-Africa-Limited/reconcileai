/**
 * seed-woodcore-loans.mjs
 * Seeds realistic SME Loan principal balance reconciliation data for the Woodcore POC demo.
 *
 * Loan reconciliation logic:
 *   Expected GL Portfolio Balance = Sum of all disbursements (principal) 
 *                                 - Sum of all principal repayment portions
 *                                 - Sum of all write-offs
 *
 * GL Account used: SME Loan Portfolio Account (id=33, gl_code=117083) — ASSET
 *   DEBIT = disbursement (increases outstanding principal)
 *   CREDIT = repayment principal portion (reduces outstanding principal)
 *
 * Anomalies seeded:
 *   1. DISBURSEMENT_MISPOSTING: Loan 103 disbursement posted to Fund Source (id=32) instead of Portfolio (id=33)
 *   2. REPAYMENT_NOT_POSTED: Loan 105 repayment recorded in wc_m_loan_transaction but no GL entry
 *   3. PRINCIPAL_ADJUSTMENT_ANOMALY: Manual credit to portfolio GL with no loan_transaction_id linkage
 *   4. ORPHANED_LOAN_ENTRY: GL debit entry with a loan_transaction_id that doesn't exist in wc_m_loan_transaction
 */

import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const conn = await mysql.createConnection(DATABASE_URL);
console.log("✓ Connected to database");

// ─── Clear existing loan data ────────────────────────────────────────────────
console.log("\n→ Clearing existing loan data...");
await conn.execute("DELETE FROM wc_m_loan_transaction WHERE id >= 1001");
await conn.execute("DELETE FROM wc_m_loan WHERE id >= 101");
// Remove loan GL entries (ids 1001-1100 range)
await conn.execute("DELETE FROM wc_acc_gl_journal_entry WHERE id >= 1001 AND id <= 1100");
console.log("  ✓ Cleared");

// ─── Loan Accounts (wc_m_loan) ───────────────────────────────────────────────
// product_id=1 (SME Loan), loanStatusId: 300=Active, 600=Closed
// principalAmount = original disbursed, approvedPrincipal = approved amount
console.log("\n→ Seeding loan accounts (wc_m_loan)...");
const loanAccounts = [
  // id, account_no, client_id, product_id, loan_status_id, principal_amount, approved_principal, currency_code
  [101, 'SML-2025-001', 1001, 1, 300, 5000000.000000, 5000000.000000, 'NGN'],  // ₦5M — Active, fully performing
  [102, 'SML-2025-002', 1002, 1, 300, 3000000.000000, 3000000.000000, 'NGN'],  // ₦3M — Active, 2 repayments made
  [103, 'SML-2025-003', 1003, 1, 300, 8000000.000000, 8000000.000000, 'NGN'],  // ₦8M — ANOMALY: disbursement misposted
  [104, 'SML-2025-004', 1004, 1, 300, 2500000.000000, 2500000.000000, 'NGN'],  // ₦2.5M — Active, 1 repayment
  [105, 'SML-2025-005', 1005, 1, 300, 4000000.000000, 4000000.000000, 'NGN'],  // ₦4M — ANOMALY: repayment not posted to GL
  [106, 'SML-2025-006', 1006, 1, 300, 6000000.000000, 6000000.000000, 'NGN'],  // ₦6M — Active, performing
  [107, 'SML-2025-007', 1007, 1, 300, 1500000.000000, 1500000.000000, 'NGN'],  // ₦1.5M — Active
  [108, 'SML-2025-008', 1008, 1, 600, 3500000.000000, 3500000.000000, 'NGN'],  // ₦3.5M — Closed (fully repaid)
  [109, 'SML-2025-009', 1009, 1, 300, 7000000.000000, 7000000.000000, 'NGN'],  // ₦7M — Active
  [110, 'SML-2025-010', 1010, 1, 300, 2000000.000000, 2000000.000000, 'NGN'],  // ₦2M — Active
];
for (const a of loanAccounts) {
  await conn.execute(
    `INSERT IGNORE INTO wc_m_loan (id, account_no, client_id, product_id, loan_status_id, principal_amount, approved_principal, currency_code) VALUES (?,?,?,?,?,?,?,?)`,
    a
  );
}
console.log(`  ✓ wc_m_loan: ${loanAccounts.length} rows`);

// ─── Loan Transactions (wc_m_loan_transaction) ───────────────────────────────
// transaction_type_enum: 1=Disbursement, 2=Repayment
// principal_portion_derived = the portion of repayment that reduces outstanding principal
console.log("\n→ Seeding loan transactions (wc_m_loan_transaction)...");
const loanTxns = [
  // id, loan_id, transaction_type_enum, is_reversed, transaction_date, amount, principal_portion, interest_portion, created_date

  // Loan 101 — ₦5M disbursed Apr 2025, 2 repayments
  [1001, 101, 1, 0, '2025-04-05', 5000000.000000, 5000000.000000, 0.000000, '2025-04-05 09:00:00'],  // Disbursement
  [1002, 101, 2, 0, '2025-05-05', 583333.330000,  416666.670000,  166666.660000, '2025-05-05 10:00:00'],  // Repayment 1
  [1003, 101, 2, 0, '2025-06-05', 583333.330000,  420833.340000,  162499.990000, '2025-06-05 10:00:00'],  // Repayment 2

  // Loan 102 — ₦3M disbursed Apr 2025, 3 repayments
  [1004, 102, 1, 0, '2025-04-10', 3000000.000000, 3000000.000000, 0.000000, '2025-04-10 09:30:00'],  // Disbursement
  [1005, 102, 2, 0, '2025-05-10', 350000.000000,  245000.000000,  105000.000000, '2025-05-10 10:00:00'],  // Repayment 1
  [1006, 102, 2, 0, '2025-06-10', 350000.000000,  247205.000000,  102795.000000, '2025-06-10 10:00:00'],  // Repayment 2
  [1007, 102, 2, 0, '2025-07-10', 350000.000000,  249430.000000,  100570.000000, '2025-07-10 10:00:00'],  // Repayment 3

  // Loan 103 — ₦8M disbursed May 2025 — ANOMALY: disbursement GL entry misposted to Fund Source (id=32) not Portfolio (id=33)
  // The loan transaction exists here but the GL entry will point to wrong account
  [1008, 103, 1, 0, '2025-05-02', 8000000.000000, 8000000.000000, 0.000000, '2025-05-02 09:00:00'],  // Disbursement (GL misposted)
  [1009, 103, 2, 0, '2025-06-02', 933333.330000,  666666.670000,  266666.660000, '2025-06-02 10:00:00'],  // Repayment 1

  // Loan 104 — ₦2.5M disbursed Apr 2025, 1 repayment
  [1010, 104, 1, 0, '2025-04-15', 2500000.000000, 2500000.000000, 0.000000, '2025-04-15 09:00:00'],  // Disbursement
  [1011, 104, 2, 0, '2025-05-15', 291666.670000,  204166.670000,  87500.000000, '2025-05-15 10:00:00'],  // Repayment 1

  // Loan 105 — ₦4M disbursed Apr 2025 — ANOMALY: repayment recorded in loan_transaction but NO GL entry posted
  [1012, 105, 1, 0, '2025-04-20', 4000000.000000, 4000000.000000, 0.000000, '2025-04-20 09:00:00'],  // Disbursement
  [1013, 105, 2, 0, '2025-05-20', 466666.670000,  326666.670000,  140000.000000, '2025-05-20 10:00:00'],  // Repayment — NO GL ENTRY (anomaly)
  [1014, 105, 2, 0, '2025-06-20', 466666.670000,  329333.340000,  137333.330000, '2025-06-20 10:00:00'],  // Repayment 2 — properly posted

  // Loan 106 — ₦6M disbursed May 2025, 2 repayments
  [1015, 106, 1, 0, '2025-05-08', 6000000.000000, 6000000.000000, 0.000000, '2025-05-08 09:00:00'],  // Disbursement
  [1016, 106, 2, 0, '2025-06-08', 700000.000000,  490000.000000,  210000.000000, '2025-06-08 10:00:00'],  // Repayment 1
  [1017, 106, 2, 0, '2025-07-08', 700000.000000,  494410.000000,  205590.000000, '2025-07-08 10:00:00'],  // Repayment 2

  // Loan 107 — ₦1.5M disbursed Jun 2025
  [1018, 107, 1, 0, '2025-06-01', 1500000.000000, 1500000.000000, 0.000000, '2025-06-01 09:00:00'],  // Disbursement
  [1019, 107, 2, 0, '2025-07-01', 175000.000000,  122500.000000,  52500.000000, '2025-07-01 10:00:00'],  // Repayment 1

  // Loan 108 — ₦3.5M fully repaid (closed)
  [1020, 108, 1, 0, '2025-04-01', 3500000.000000, 3500000.000000, 0.000000, '2025-04-01 09:00:00'],  // Disbursement
  [1021, 108, 2, 0, '2025-05-01', 408333.330000,  285833.330000,  122500.000000, '2025-05-01 10:00:00'],  // Repayment 1
  [1022, 108, 2, 0, '2025-06-01', 408333.330000,  288291.670000,  120041.660000, '2025-06-01 10:00:00'],  // Repayment 2
  [1023, 108, 2, 0, '2025-07-01', 3214166.670000, 2925875.000000, 288291.670000, '2025-07-01 10:00:00'], // Final settlement

  // Loan 109 — ₦7M disbursed Jun 2025
  [1024, 109, 1, 0, '2025-06-15', 7000000.000000, 7000000.000000, 0.000000, '2025-06-15 09:00:00'],  // Disbursement
  [1025, 109, 2, 0, '2025-07-15', 816666.670000,  571666.670000,  245000.000000, '2025-07-15 10:00:00'],  // Repayment 1

  // Loan 110 — ₦2M disbursed Jul 2025
  [1026, 110, 1, 0, '2025-07-05', 2000000.000000, 2000000.000000, 0.000000, '2025-07-05 09:00:00'],  // Disbursement
];
for (const t of loanTxns) {
  await conn.execute(
    `INSERT IGNORE INTO wc_m_loan_transaction (id, loan_id, transaction_type_enum, is_reversed, transaction_date, amount, principal_portion_derived, interest_portion_derived, created_date) VALUES (?,?,?,?,?,?,?,?,?)`,
    t
  );
}
console.log(`  ✓ wc_m_loan_transaction: ${loanTxns.length} rows`);

// ─── GL Journal Entries for Loan Portfolio (wc_acc_gl_journal_entry) ─────────
// SME Loan Portfolio Account = id=33, gl_code=117083 (ASSET)
//   DEBIT (type_enum=2) = disbursement → increases outstanding principal
//   CREDIT (type_enum=1) = repayment principal portion → reduces outstanding principal
//
// SME Fund Source Account = id=32, gl_code=113938 (ASSET — contra to portfolio on disbursement)
//
// For each disbursement: DEBIT Portfolio (33) + CREDIT Fund Source (32)
// For each repayment:    DEBIT Fund Source (32) + CREDIT Portfolio (33) [principal portion only]
//
// ANOMALY 1 (Loan 103): Disbursement posted to Fund Source (32) DEBIT instead of Portfolio (33) DEBIT
// ANOMALY 2 (Loan 105 repayment 1): No GL entry at all — the loan_transaction_id 1013 has no GL entry
// ANOMALY 3: Manual credit to Portfolio (33) with no loan_transaction_id — principal adjustment anomaly
// ANOMALY 4: GL debit entry with loan_transaction_id=9999 (non-existent) — orphaned entry

console.log("\n→ Seeding loan GL journal entries...");
const loanGlEntries = [
  // id, account_id, office_id, reversal_id, currency_code, transaction_id, loan_transaction_id,
  // savings_transaction_id, reversed, ref_num, manual_entry, entry_date, type_enum, amount, description, created_date, unique_ref_key

  // ── Loan 101 Disbursement (Apr 5, 2025) ──────────────────────────────────
  // DEBIT Portfolio (33) — increases outstanding principal
  [1001, 33, 1, null, 'NGN', 'LN-DISB-101-001', 1001, null, 0, 'LN-DISB-101', 0, '2025-04-05', 2, 5000000.000000, 'Loan Disbursement - SML-2025-001', '2025-04-05 09:00:00', 'LN-DISB-101-001-DR'],
  // CREDIT Fund Source (32) — cash out
  [1002, 32, 1, null, 'NGN', 'LN-DISB-101-001', 1001, null, 0, 'LN-DISB-101', 0, '2025-04-05', 1, 5000000.000000, 'Loan Disbursement - SML-2025-001', '2025-04-05 09:00:00', 'LN-DISB-101-001-CR'],

  // ── Loan 101 Repayment 1 (May 5, 2025) — principal portion ₦416,666.67 ──
  [1003, 32, 1, null, 'NGN', 'LN-REP-101-001', 1002, null, 0, 'LN-REP-101-1', 0, '2025-05-05', 2, 583333.330000, 'Loan Repayment - SML-2025-001 Inst 1', '2025-05-05 10:00:00', 'LN-REP-101-001-DR'],
  [1004, 33, 1, null, 'NGN', 'LN-REP-101-001', 1002, null, 0, 'LN-REP-101-1', 0, '2025-05-05', 1, 416666.670000, 'Loan Repayment Principal - SML-2025-001 Inst 1', '2025-05-05 10:00:00', 'LN-REP-101-001-CR'],

  // ── Loan 101 Repayment 2 (Jun 5, 2025) ──────────────────────────────────
  [1005, 32, 1, null, 'NGN', 'LN-REP-101-002', 1003, null, 0, 'LN-REP-101-2', 0, '2025-06-05', 2, 583333.330000, 'Loan Repayment - SML-2025-001 Inst 2', '2025-06-05 10:00:00', 'LN-REP-101-002-DR'],
  [1006, 33, 1, null, 'NGN', 'LN-REP-101-002', 1003, null, 0, 'LN-REP-101-2', 0, '2025-06-05', 1, 420833.340000, 'Loan Repayment Principal - SML-2025-001 Inst 2', '2025-06-05 10:00:00', 'LN-REP-101-002-CR'],

  // ── Loan 102 Disbursement (Apr 10, 2025) ─────────────────────────────────
  [1007, 33, 1, null, 'NGN', 'LN-DISB-102-001', 1004, null, 0, 'LN-DISB-102', 0, '2025-04-10', 2, 3000000.000000, 'Loan Disbursement - SML-2025-002', '2025-04-10 09:30:00', 'LN-DISB-102-001-DR'],
  [1008, 32, 1, null, 'NGN', 'LN-DISB-102-001', 1004, null, 0, 'LN-DISB-102', 0, '2025-04-10', 1, 3000000.000000, 'Loan Disbursement - SML-2025-002', '2025-04-10 09:30:00', 'LN-DISB-102-001-CR'],

  // ── Loan 102 Repayments 1–3 ───────────────────────────────────────────────
  [1009, 32, 1, null, 'NGN', 'LN-REP-102-001', 1005, null, 0, 'LN-REP-102-1', 0, '2025-05-10', 2, 350000.000000, 'Loan Repayment - SML-2025-002 Inst 1', '2025-05-10 10:00:00', 'LN-REP-102-001-DR'],
  [1010, 33, 1, null, 'NGN', 'LN-REP-102-001', 1005, null, 0, 'LN-REP-102-1', 0, '2025-05-10', 1, 245000.000000, 'Loan Repayment Principal - SML-2025-002 Inst 1', '2025-05-10 10:00:00', 'LN-REP-102-001-CR'],
  [1011, 32, 1, null, 'NGN', 'LN-REP-102-002', 1006, null, 0, 'LN-REP-102-2', 0, '2025-06-10', 2, 350000.000000, 'Loan Repayment - SML-2025-002 Inst 2', '2025-06-10 10:00:00', 'LN-REP-102-002-DR'],
  [1012, 33, 1, null, 'NGN', 'LN-REP-102-002', 1006, null, 0, 'LN-REP-102-2', 0, '2025-06-10', 1, 247205.000000, 'Loan Repayment Principal - SML-2025-002 Inst 2', '2025-06-10 10:00:00', 'LN-REP-102-002-CR'],
  [1013, 32, 1, null, 'NGN', 'LN-REP-102-003', 1007, null, 0, 'LN-REP-102-3', 0, '2025-07-10', 2, 350000.000000, 'Loan Repayment - SML-2025-002 Inst 3', '2025-07-10 10:00:00', 'LN-REP-102-003-DR'],
  [1014, 33, 1, null, 'NGN', 'LN-REP-102-003', 1007, null, 0, 'LN-REP-102-3', 0, '2025-07-10', 1, 249430.000000, 'Loan Repayment Principal - SML-2025-002 Inst 3', '2025-07-10 10:00:00', 'LN-REP-102-003-CR'],

  // ── ANOMALY 1: Loan 103 Disbursement MISPOSTED to Fund Source (32) DEBIT instead of Portfolio (33) ──
  // The debit goes to account 32 (Fund Source) instead of 33 (Portfolio) — this is the anomaly
  // Both sides of the entry use account 32, meaning Portfolio (33) is never debited
  [1015, 32, 1, null, 'NGN', 'LN-DISB-103-001', 1008, null, 0, 'LN-DISB-103', 0, '2025-05-02', 2, 8000000.000000, 'Loan Disbursement - SML-2025-003 [MISPOSTED]', '2025-05-02 09:00:00', 'LN-DISB-103-001-DR'],
  [1016, 32, 1, null, 'NGN', 'LN-DISB-103-001', 1008, null, 0, 'LN-DISB-103', 0, '2025-05-02', 1, 8000000.000000, 'Loan Disbursement - SML-2025-003 [MISPOSTED]', '2025-05-02 09:00:00', 'LN-DISB-103-001-CR'],

  // ── Loan 103 Repayment 1 (Jun 2, 2025) — properly posted ─────────────────
  [1017, 32, 1, null, 'NGN', 'LN-REP-103-001', 1009, null, 0, 'LN-REP-103-1', 0, '2025-06-02', 2, 933333.330000, 'Loan Repayment - SML-2025-003 Inst 1', '2025-06-02 10:00:00', 'LN-REP-103-001-DR'],
  [1018, 33, 1, null, 'NGN', 'LN-REP-103-001', 1009, null, 0, 'LN-REP-103-1', 0, '2025-06-02', 1, 666666.670000, 'Loan Repayment Principal - SML-2025-003 Inst 1', '2025-06-02 10:00:00', 'LN-REP-103-001-CR'],

  // ── Loan 104 Disbursement (Apr 15, 2025) ─────────────────────────────────
  [1019, 33, 1, null, 'NGN', 'LN-DISB-104-001', 1010, null, 0, 'LN-DISB-104', 0, '2025-04-15', 2, 2500000.000000, 'Loan Disbursement - SML-2025-004', '2025-04-15 09:00:00', 'LN-DISB-104-001-DR'],
  [1020, 32, 1, null, 'NGN', 'LN-DISB-104-001', 1010, null, 0, 'LN-DISB-104', 0, '2025-04-15', 1, 2500000.000000, 'Loan Disbursement - SML-2025-004', '2025-04-15 09:00:00', 'LN-DISB-104-001-CR'],

  // ── Loan 104 Repayment 1 ─────────────────────────────────────────────────
  [1021, 32, 1, null, 'NGN', 'LN-REP-104-001', 1011, null, 0, 'LN-REP-104-1', 0, '2025-05-15', 2, 291666.670000, 'Loan Repayment - SML-2025-004 Inst 1', '2025-05-15 10:00:00', 'LN-REP-104-001-DR'],
  [1022, 33, 1, null, 'NGN', 'LN-REP-104-001', 1011, null, 0, 'LN-REP-104-1', 0, '2025-05-15', 1, 204166.670000, 'Loan Repayment Principal - SML-2025-004 Inst 1', '2025-05-15 10:00:00', 'LN-REP-104-001-CR'],

  // ── Loan 105 Disbursement (Apr 20, 2025) — properly posted ───────────────
  [1023, 33, 1, null, 'NGN', 'LN-DISB-105-001', 1012, null, 0, 'LN-DISB-105', 0, '2025-04-20', 2, 4000000.000000, 'Loan Disbursement - SML-2025-005', '2025-04-20 09:00:00', 'LN-DISB-105-001-DR'],
  [1024, 32, 1, null, 'NGN', 'LN-DISB-105-001', 1012, null, 0, 'LN-DISB-105', 0, '2025-04-20', 1, 4000000.000000, 'Loan Disbursement - SML-2025-005', '2025-04-20 09:00:00', 'LN-DISB-105-001-CR'],

  // ── ANOMALY 2: Loan 105 Repayment 1 — NO GL ENTRY (loan_transaction_id=1013 has no GL entry) ──
  // Intentionally omitted — the loan_transaction 1013 exists but has no corresponding GL entry

  // ── Loan 105 Repayment 2 (Jun 20, 2025) — properly posted ────────────────
  [1025, 32, 1, null, 'NGN', 'LN-REP-105-002', 1014, null, 0, 'LN-REP-105-2', 0, '2025-06-20', 2, 466666.670000, 'Loan Repayment - SML-2025-005 Inst 2', '2025-06-20 10:00:00', 'LN-REP-105-002-DR'],
  [1026, 33, 1, null, 'NGN', 'LN-REP-105-002', 1014, null, 0, 'LN-REP-105-2', 0, '2025-06-20', 1, 329333.340000, 'Loan Repayment Principal - SML-2025-005 Inst 2', '2025-06-20 10:00:00', 'LN-REP-105-002-CR'],

  // ── Loan 106 Disbursement (May 8, 2025) ──────────────────────────────────
  [1027, 33, 1, null, 'NGN', 'LN-DISB-106-001', 1015, null, 0, 'LN-DISB-106', 0, '2025-05-08', 2, 6000000.000000, 'Loan Disbursement - SML-2025-006', '2025-05-08 09:00:00', 'LN-DISB-106-001-DR'],
  [1028, 32, 1, null, 'NGN', 'LN-DISB-106-001', 1015, null, 0, 'LN-DISB-106', 0, '2025-05-08', 1, 6000000.000000, 'Loan Disbursement - SML-2025-006', '2025-05-08 09:00:00', 'LN-DISB-106-001-CR'],

  // ── Loan 106 Repayments ───────────────────────────────────────────────────
  [1029, 32, 1, null, 'NGN', 'LN-REP-106-001', 1016, null, 0, 'LN-REP-106-1', 0, '2025-06-08', 2, 700000.000000, 'Loan Repayment - SML-2025-006 Inst 1', '2025-06-08 10:00:00', 'LN-REP-106-001-DR'],
  [1030, 33, 1, null, 'NGN', 'LN-REP-106-001', 1016, null, 0, 'LN-REP-106-1', 0, '2025-06-08', 1, 490000.000000, 'Loan Repayment Principal - SML-2025-006 Inst 1', '2025-06-08 10:00:00', 'LN-REP-106-001-CR'],
  [1031, 32, 1, null, 'NGN', 'LN-REP-106-002', 1017, null, 0, 'LN-REP-106-2', 0, '2025-07-08', 2, 700000.000000, 'Loan Repayment - SML-2025-006 Inst 2', '2025-07-08 10:00:00', 'LN-REP-106-002-DR'],
  [1032, 33, 1, null, 'NGN', 'LN-REP-106-002', 1017, null, 0, 'LN-REP-106-2', 0, '2025-07-08', 1, 494410.000000, 'Loan Repayment Principal - SML-2025-006 Inst 2', '2025-07-08 10:00:00', 'LN-REP-106-002-CR'],

  // ── Loan 107 Disbursement (Jun 1, 2025) ──────────────────────────────────
  [1033, 33, 1, null, 'NGN', 'LN-DISB-107-001', 1018, null, 0, 'LN-DISB-107', 0, '2025-06-01', 2, 1500000.000000, 'Loan Disbursement - SML-2025-007', '2025-06-01 09:00:00', 'LN-DISB-107-001-DR'],
  [1034, 32, 1, null, 'NGN', 'LN-DISB-107-001', 1018, null, 0, 'LN-DISB-107', 0, '2025-06-01', 1, 1500000.000000, 'Loan Disbursement - SML-2025-007', '2025-06-01 09:00:00', 'LN-DISB-107-001-CR'],

  // ── Loan 107 Repayment 1 ─────────────────────────────────────────────────
  [1035, 32, 1, null, 'NGN', 'LN-REP-107-001', 1019, null, 0, 'LN-REP-107-1', 0, '2025-07-01', 2, 175000.000000, 'Loan Repayment - SML-2025-007 Inst 1', '2025-07-01 10:00:00', 'LN-REP-107-001-DR'],
  [1036, 33, 1, null, 'NGN', 'LN-REP-107-001', 1019, null, 0, 'LN-REP-107-1', 0, '2025-07-01', 1, 122500.000000, 'Loan Repayment Principal - SML-2025-007 Inst 1', '2025-07-01 10:00:00', 'LN-REP-107-001-CR'],

  // ── Loan 108 Disbursement (Apr 1, 2025) — fully repaid ───────────────────
  [1037, 33, 1, null, 'NGN', 'LN-DISB-108-001', 1020, null, 0, 'LN-DISB-108', 0, '2025-04-01', 2, 3500000.000000, 'Loan Disbursement - SML-2025-008', '2025-04-01 09:00:00', 'LN-DISB-108-001-DR'],
  [1038, 32, 1, null, 'NGN', 'LN-DISB-108-001', 1020, null, 0, 'LN-DISB-108', 0, '2025-04-01', 1, 3500000.000000, 'Loan Disbursement - SML-2025-008', '2025-04-01 09:00:00', 'LN-DISB-108-001-CR'],
  [1039, 32, 1, null, 'NGN', 'LN-REP-108-001', 1021, null, 0, 'LN-REP-108-1', 0, '2025-05-01', 2, 408333.330000, 'Loan Repayment - SML-2025-008 Inst 1', '2025-05-01 10:00:00', 'LN-REP-108-001-DR'],
  [1040, 33, 1, null, 'NGN', 'LN-REP-108-001', 1021, null, 0, 'LN-REP-108-1', 0, '2025-05-01', 1, 285833.330000, 'Loan Repayment Principal - SML-2025-008 Inst 1', '2025-05-01 10:00:00', 'LN-REP-108-001-CR'],
  [1041, 32, 1, null, 'NGN', 'LN-REP-108-002', 1022, null, 0, 'LN-REP-108-2', 0, '2025-06-01', 2, 408333.330000, 'Loan Repayment - SML-2025-008 Inst 2', '2025-06-01 10:00:00', 'LN-REP-108-002-DR'],
  [1042, 33, 1, null, 'NGN', 'LN-REP-108-002', 1022, null, 0, 'LN-REP-108-2', 0, '2025-06-01', 1, 288291.670000, 'Loan Repayment Principal - SML-2025-008 Inst 2', '2025-06-01 10:00:00', 'LN-REP-108-002-CR'],
  [1043, 32, 1, null, 'NGN', 'LN-REP-108-003', 1023, null, 0, 'LN-REP-108-3', 0, '2025-07-01', 2, 3214166.670000, 'Loan Final Settlement - SML-2025-008', '2025-07-01 10:00:00', 'LN-REP-108-003-DR'],
  [1044, 33, 1, null, 'NGN', 'LN-REP-108-003', 1023, null, 0, 'LN-REP-108-3', 0, '2025-07-01', 1, 2925875.000000, 'Loan Final Settlement Principal - SML-2025-008', '2025-07-01 10:00:00', 'LN-REP-108-003-CR'],

  // ── Loan 109 Disbursement (Jun 15, 2025) ─────────────────────────────────
  [1045, 33, 1, null, 'NGN', 'LN-DISB-109-001', 1024, null, 0, 'LN-DISB-109', 0, '2025-06-15', 2, 7000000.000000, 'Loan Disbursement - SML-2025-009', '2025-06-15 09:00:00', 'LN-DISB-109-001-DR'],
  [1046, 32, 1, null, 'NGN', 'LN-DISB-109-001', 1024, null, 0, 'LN-DISB-109', 0, '2025-06-15', 1, 7000000.000000, 'Loan Disbursement - SML-2025-009', '2025-06-15 09:00:00', 'LN-DISB-109-001-CR'],

  // ── Loan 109 Repayment 1 ─────────────────────────────────────────────────
  [1047, 32, 1, null, 'NGN', 'LN-REP-109-001', 1025, null, 0, 'LN-REP-109-1', 0, '2025-07-15', 2, 816666.670000, 'Loan Repayment - SML-2025-009 Inst 1', '2025-07-15 10:00:00', 'LN-REP-109-001-DR'],
  [1048, 33, 1, null, 'NGN', 'LN-REP-109-001', 1025, null, 0, 'LN-REP-109-1', 0, '2025-07-15', 1, 571666.670000, 'Loan Repayment Principal - SML-2025-009 Inst 1', '2025-07-15 10:00:00', 'LN-REP-109-001-CR'],

  // ── Loan 110 Disbursement (Jul 5, 2025) ──────────────────────────────────
  [1049, 33, 1, null, 'NGN', 'LN-DISB-110-001', 1026, null, 0, 'LN-DISB-110', 0, '2025-07-05', 2, 2000000.000000, 'Loan Disbursement - SML-2025-010', '2025-07-05 09:00:00', 'LN-DISB-110-001-DR'],
  [1050, 32, 1, null, 'NGN', 'LN-DISB-110-001', 1026, null, 0, 'LN-DISB-110', 0, '2025-07-05', 1, 2000000.000000, 'Loan Disbursement - SML-2025-010', '2025-07-05 09:00:00', 'LN-DISB-110-001-CR'],

  // ── ANOMALY 3: Manual principal adjustment — no loan_transaction_id ───────
  // A credit to Portfolio (33) for ₦1,250,000 with manual_entry=1 and no loan_transaction_id
  // This reduces the GL balance without any corresponding loan repayment record
  [1051, 33, 1, null, 'NGN', 'MAN-PRIN-ADJ-001', null, null, 0, 'MAN-ADJ-001', 1, '2025-06-30', 1, 1250000.000000, 'Manual principal adjustment - authorised by CFO', '2025-06-30 16:45:00', 'MAN-PRIN-ADJ-001'],

  // ── ANOMALY 4: Orphaned GL entry — loan_transaction_id=9999 does not exist ─
  // A debit to Portfolio (33) referencing a loan_transaction_id that has no record in wc_m_loan_transaction
  [1052, 33, 1, null, 'NGN', 'ORPHAN-LN-001', 9999, null, 0, 'ORP-LN-001', 0, '2025-07-20', 2, 500000.000000, 'System disbursement - no linked loan transaction', '2025-07-20 11:00:00', 'ORPHAN-LN-001'],
];

for (const e of loanGlEntries) {
  await conn.execute(
    `INSERT IGNORE INTO wc_acc_gl_journal_entry (id, account_id, office_id, reversal_id, currency_code, transaction_id, loan_transaction_id, savings_transaction_id, reversed, ref_num, manual_entry, entry_date, type_enum, amount, description, created_date, unique_ref_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    e
  );
}
console.log(`  ✓ wc_acc_gl_journal_entry (loan entries): ${loanGlEntries.length} rows`);

// ─── Verify counts ────────────────────────────────────────────────────────────
console.log("\n→ Verifying seeded data...");
const [loanCount] = await conn.execute("SELECT COUNT(*) as c FROM wc_m_loan");
const [loanTxnCount] = await conn.execute("SELECT COUNT(*) as c FROM wc_m_loan_transaction");
const [glCount] = await conn.execute("SELECT COUNT(*) as c FROM wc_acc_gl_journal_entry WHERE account_id IN (32, 33) AND id >= 1001");
console.log(`  wc_m_loan: ${loanCount[0].c} rows`);
console.log(`  wc_m_loan_transaction: ${loanTxnCount[0].c} rows`);
console.log(`  Loan GL entries (portfolio/fund source): ${glCount[0].c} rows`);

// ─── Summary of expected reconciliation results ───────────────────────────────
console.log("\n→ Expected reconciliation results (SME Loan, Apr–Jul 2025):");
console.log("  Portfolio GL Account: id=33 (SME Loan Portfolio Account, gl_code=117083)");
console.log("  Disbursements to GL (DEBIT to account 33):");
console.log("    Loan 101: ₦5,000,000");
console.log("    Loan 102: ₦3,000,000");
console.log("    Loan 103: ₦0 (MISPOSTED to account 32 — ANOMALY 1)");
console.log("    Loan 104: ₦2,500,000");
console.log("    Loan 105: ₦4,000,000");
console.log("    Loan 106: ₦6,000,000");
console.log("    Loan 107: ₦1,500,000");
console.log("    Loan 108: ₦3,500,000");
console.log("    Loan 109: ₦7,000,000");
console.log("    Loan 110: ₦2,000,000");
console.log("    Orphaned: ₦500,000 (ANOMALY 4)");
console.log("  Total GL Debits to Portfolio: ₦35,000,000 (excl. Loan 103 mispost)");
console.log("  Repayment Principal Credits to GL (CREDIT to account 33):");
console.log("    Loan 101: ₦837,500.01");
console.log("    Loan 102: ₦741,635");
console.log("    Loan 103: ₦666,666.67 (repayment correctly posted)");
console.log("    Loan 104: ₦204,166.67");
console.log("    Loan 105: ₦329,333.34 (Repayment 1 NOT posted — ANOMALY 2)");
console.log("    Loan 106: ₦984,410");
console.log("    Loan 107: ₦122,500");
console.log("    Loan 108: ₦3,500,000 (fully repaid)");
console.log("    Loan 109: ₦571,666.67");
console.log("    Manual adj: ₦1,250,000 (ANOMALY 3)");
console.log("  Expected principal outstanding (from loan_transaction table):");
console.log("    = Total disbursements - Total principal repaid");
console.log("    Variance = GL balance - Expected balance (should show anomalies)");

await conn.end();
console.log("\n✓ Loan seed complete.");
