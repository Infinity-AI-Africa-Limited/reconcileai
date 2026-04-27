/**
 * seed-woodcore-loans-batch2.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Second batch of SME loan seed data with richer anomaly types spread across
 * April, May, June and July 2025.  Uses IDs that do NOT overlap with batch 1:
 *   wc_m_loan              : 111–125
 *   wc_m_loan_transaction  : 2001–2060
 *   wc_acc_gl_journal_entry: 2001–2100
 *
 * Anomaly catalogue (new types beyond batch 1):
 *   A5  – DOUBLE_POSTED_REPAYMENT   : Repayment posted twice to GL (loan 113)
 *   A6  – PARTIAL_DISBURSEMENT_MISMATCH : GL disbursement amount ≠ loan_transaction amount (loan 115)
 *   A7  – REVERSED_ENTRY_NOT_MATCHED: GL reversal entry exists but original not reversed in CBS (loan 117)
 *   A8  – LATE_POSTING_ANOMALY      : Repayment transaction dated May but GL entry dated July (loan 119)
 *   A9  – DUPLICATE_DISBURSEMENT    : Same loan disbursed twice in GL (loan 121)
 *   A10 – UNMATCHED_CREDIT          : Credit to portfolio GL with no loan reference at all (manual, Jun)
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

// ─── Clean up batch-2 data only ──────────────────────────────────────────────
console.log("\n→ Clearing existing batch-2 loan data...");
await conn.execute("DELETE FROM wc_acc_gl_journal_entry WHERE id >= 2001 AND id <= 2100");
await conn.execute("DELETE FROM wc_m_loan_transaction WHERE id >= 2001 AND id <= 2060");
await conn.execute("DELETE FROM wc_m_loan WHERE id >= 111 AND id <= 125");
console.log("  ✓ Cleared");

// ─── Loan Accounts (wc_m_loan) ───────────────────────────────────────────────
// id, account_no, client_id, product_id, loan_status_id, principal_amount, approved_principal, currency_code
// loan_status_id: 1=active, 2=closed
console.log("\n→ Seeding batch-2 loan accounts...");
const loanAccounts = [
  [111, 'SML-2025-011', 1011, 1, 300, 4500000.0, 4500000.0, 'NGN'],  // ₦4.5M — Active
  [112, 'SML-2025-012', 1012, 1, 300, 2800000.0, 2800000.0, 'NGN'],  // ₦2.8M — Active
  [113, 'SML-2025-013', 1013, 1, 300, 6000000.0, 6000000.0, 'NGN'],  // ₦6M — ANOMALY A5: double-posted repayment
  [114, 'SML-2025-014', 1014, 1, 300, 3200000.0, 3200000.0, 'NGN'],  // ₦3.2M — Active
  [115, 'SML-2025-015', 1015, 1, 300, 9000000.0, 9000000.0, 'NGN'],  // ₦9M — ANOMALY A6: partial disbursement mismatch
  [116, 'SML-2025-016', 1016, 1, 300, 1800000.0, 1800000.0, 'NGN'],  // ₦1.8M — Active
  [117, 'SML-2025-017', 1017, 1, 300, 5500000.0, 5500000.0, 'NGN'],  // ₦5.5M — ANOMALY A7: reversed entry not matched
  [118, 'SML-2025-018', 1018, 1, 300, 2200000.0, 2200000.0, 'NGN'],  // ₦2.2M — Active
  [119, 'SML-2025-019', 1019, 1, 300, 7500000.0, 7500000.0, 'NGN'],  // ₦7.5M — ANOMALY A8: late posting
  [120, 'SML-2025-020', 1020, 1, 300, 3800000.0, 3800000.0, 'NGN'],  // ₦3.8M — Active
  [121, 'SML-2025-021', 1021, 1, 300, 5000000.0, 5000000.0, 'NGN'],  // ₦5M — ANOMALY A9: duplicate disbursement in GL
  [122, 'SML-2025-022', 1022, 1, 300, 4200000.0, 4200000.0, 'NGN'],  // ₦4.2M — Active
  [123, 'SML-2025-023', 1023, 1, 300, 1500000.0, 1500000.0, 'NGN'],  // ₦1.5M — Active (Jun)
  [124, 'SML-2025-024', 1024, 1, 300, 6500000.0, 6500000.0, 'NGN'],  // ₦6.5M — Active (Jul)
  [125, 'SML-2025-025', 1025, 1, 300, 2600000.0, 2600000.0, 'NGN'],  // ₦2.6M — Active (Jul)
];
for (const a of loanAccounts) {
  await conn.execute(
    `INSERT IGNORE INTO wc_m_loan (id, account_no, client_id, product_id, loan_status_id, principal_amount, approved_principal, currency_code) VALUES (?,?,?,?,?,?,?,?)`,
    a
  );
}
console.log(`  ✓ wc_m_loan: ${loanAccounts.length} rows`);

// ─── Loan Transactions (wc_m_loan_transaction) ───────────────────────────────
// id, loan_id, transaction_type_enum, is_reversed, transaction_date, amount, principal_portion, interest_portion, created_date
// type: 1=Disbursement, 2=Repayment
console.log("\n→ Seeding batch-2 loan transactions...");
const loanTxns = [
  // ── Loan 111 — ₦4.5M disbursed Apr 2025, 2 repayments ──────────────────
  [2001, 111, 1, 0, '2025-04-03', 4500000.0, 4500000.0, 0.0,       '2025-04-03 09:00:00'],  // Disbursement
  [2002, 111, 2, 0, '2025-05-03', 525000.0,  367500.0,  157500.0,  '2025-05-03 10:00:00'],  // Repayment 1
  [2003, 111, 2, 0, '2025-06-03', 525000.0,  370170.0,  154830.0,  '2025-06-03 10:00:00'],  // Repayment 2

  // ── Loan 112 — ₦2.8M disbursed Apr 2025, 2 repayments ──────────────────
  [2004, 112, 1, 0, '2025-04-07', 2800000.0, 2800000.0, 0.0,       '2025-04-07 09:00:00'],  // Disbursement
  [2005, 112, 2, 0, '2025-05-07', 326666.67, 228666.67, 98000.0,   '2025-05-07 10:00:00'],  // Repayment 1
  [2006, 112, 2, 0, '2025-06-07', 326666.67, 230266.67, 96400.0,   '2025-06-07 10:00:00'],  // Repayment 2

  // ── Loan 113 — ₦6M disbursed Apr 2025 — ANOMALY A5: double-posted repayment ──
  // Repayment 1 (May) was posted to GL twice — both GL entries exist
  [2007, 113, 1, 0, '2025-04-12', 6000000.0, 6000000.0, 0.0,       '2025-04-12 09:00:00'],  // Disbursement
  [2008, 113, 2, 0, '2025-05-12', 700000.0,  490000.0,  210000.0,  '2025-05-12 10:00:00'],  // Repayment 1 — DOUBLE POSTED in GL
  [2009, 113, 2, 0, '2025-06-12', 700000.0,  493570.0,  206430.0,  '2025-06-12 10:00:00'],  // Repayment 2 — normal

  // ── Loan 114 — ₦3.2M disbursed May 2025, 2 repayments ──────────────────
  [2010, 114, 1, 0, '2025-05-05', 3200000.0, 3200000.0, 0.0,       '2025-05-05 09:00:00'],  // Disbursement
  [2011, 114, 2, 0, '2025-06-05', 373333.33, 261333.33, 112000.0,  '2025-06-05 10:00:00'],  // Repayment 1
  [2012, 114, 2, 0, '2025-07-05', 373333.33, 263200.0,  110133.33, '2025-07-05 10:00:00'],  // Repayment 2

  // ── Loan 115 — ₦9M disbursed May 2025 — ANOMALY A6: partial disbursement mismatch ──
  // CBS records full ₦9M disbursement but GL only posted ₦7,500,000 (₦1.5M shortfall)
  [2013, 115, 1, 0, '2025-05-15', 9000000.0, 9000000.0, 0.0,       '2025-05-15 09:00:00'],  // Disbursement (CBS=₦9M, GL=₦7.5M)
  [2014, 115, 2, 0, '2025-06-15', 1050000.0, 735000.0,  315000.0,  '2025-06-15 10:00:00'],  // Repayment 1
  [2015, 115, 2, 0, '2025-07-15', 1050000.0, 740250.0,  309750.0,  '2025-07-15 10:00:00'],  // Repayment 2

  // ── Loan 116 — ₦1.8M disbursed May 2025, 1 repayment ──────────────────
  [2016, 116, 1, 0, '2025-05-20', 1800000.0, 1800000.0, 0.0,       '2025-05-20 09:00:00'],  // Disbursement
  [2017, 116, 2, 0, '2025-06-20', 210000.0,  147000.0,  63000.0,   '2025-06-20 10:00:00'],  // Repayment 1

  // ── Loan 117 — ₦5.5M disbursed Apr 2025 — ANOMALY A7: reversed entry not matched ──
  // GL has a reversal entry (type_enum=1, reversed=1) for the May repayment
  // but the CBS loan_transaction is NOT marked as reversed (is_reversed=0)
  [2018, 117, 1, 0, '2025-04-18', 5500000.0, 5500000.0, 0.0,       '2025-04-18 09:00:00'],  // Disbursement
  [2019, 117, 2, 0, '2025-05-18', 641666.67, 449166.67, 192500.0,  '2025-05-18 10:00:00'],  // Repayment 1 — CBS NOT reversed
  [2020, 117, 2, 0, '2025-06-18', 641666.67, 452366.67, 189300.0,  '2025-06-18 10:00:00'],  // Repayment 2 — normal

  // ── Loan 118 — ₦2.2M disbursed Jun 2025, 1 repayment ──────────────────
  [2021, 118, 1, 0, '2025-06-10', 2200000.0, 2200000.0, 0.0,       '2025-06-10 09:00:00'],  // Disbursement
  [2022, 118, 2, 0, '2025-07-10', 256666.67, 179666.67, 77000.0,   '2025-07-10 10:00:00'],  // Repayment 1

  // ── Loan 119 — ₦7.5M disbursed Apr 2025 — ANOMALY A8: late posting ──────
  // Repayment 1 transaction_date=May 25 but GL entry_date=Jul 25 (2-month lag)
  [2023, 119, 1, 0, '2025-04-25', 7500000.0, 7500000.0, 0.0,       '2025-04-25 09:00:00'],  // Disbursement
  [2024, 119, 2, 0, '2025-05-25', 875000.0,  612500.0,  262500.0,  '2025-05-25 10:00:00'],  // Repayment 1 — GL posted Jul 25
  [2025, 119, 2, 0, '2025-06-25', 875000.0,  616875.0,  258125.0,  '2025-06-25 10:00:00'],  // Repayment 2 — normal

  // ── Loan 120 — ₦3.8M disbursed May 2025, 2 repayments ──────────────────
  [2026, 120, 1, 0, '2025-05-28', 3800000.0, 3800000.0, 0.0,       '2025-05-28 09:00:00'],  // Disbursement
  [2027, 120, 2, 0, '2025-06-28', 443333.33, 310333.33, 133000.0,  '2025-06-28 10:00:00'],  // Repayment 1
  [2028, 120, 2, 0, '2025-07-28', 443333.33, 312546.67, 130786.67, '2025-07-28 10:00:00'],  // Repayment 2

  // ── Loan 121 — ₦5M disbursed Jun 2025 — ANOMALY A9: duplicate disbursement ──
  // GL has TWO debit entries for the same disbursement (₦5M posted twice)
  [2029, 121, 1, 0, '2025-06-05', 5000000.0, 5000000.0, 0.0,       '2025-06-05 09:00:00'],  // Disbursement (GL duplicated)
  [2030, 121, 2, 0, '2025-07-05', 583333.33, 408333.33, 175000.0,  '2025-07-05 10:00:00'],  // Repayment 1 — normal

  // ── Loan 122 — ₦4.2M disbursed Jun 2025, 1 repayment ──────────────────
  [2031, 122, 1, 0, '2025-06-20', 4200000.0, 4200000.0, 0.0,       '2025-06-20 09:00:00'],  // Disbursement
  [2032, 122, 2, 0, '2025-07-20', 490000.0,  343000.0,  147000.0,  '2025-07-20 10:00:00'],  // Repayment 1

  // ── Loan 123 — ₦1.5M disbursed Jun 2025 ────────────────────────────────
  [2033, 123, 1, 0, '2025-06-25', 1500000.0, 1500000.0, 0.0,       '2025-06-25 09:00:00'],  // Disbursement
  [2034, 123, 2, 0, '2025-07-25', 175000.0,  122500.0,  52500.0,   '2025-07-25 10:00:00'],  // Repayment 1

  // ── Loan 124 — ₦6.5M disbursed Jul 2025 ────────────────────────────────
  [2035, 124, 1, 0, '2025-07-08', 6500000.0, 6500000.0, 0.0,       '2025-07-08 09:00:00'],  // Disbursement

  // ── Loan 125 — ₦2.6M disbursed Jul 2025 ────────────────────────────────
  [2036, 125, 1, 0, '2025-07-22', 2600000.0, 2600000.0, 0.0,       '2025-07-22 09:00:00'],  // Disbursement
];
for (const t of loanTxns) {
  await conn.execute(
    `INSERT IGNORE INTO wc_m_loan_transaction (id, loan_id, transaction_type_enum, is_reversed, transaction_date, amount, principal_portion_derived, interest_portion_derived, created_date) VALUES (?,?,?,?,?,?,?,?,?)`,
    t
  );
}
console.log(`  ✓ wc_m_loan_transaction: ${loanTxns.length} rows`);

// ─── GL Journal Entries (wc_acc_gl_journal_entry) ────────────────────────────
// id, account_id, office_id, reversal_id, currency_code, transaction_id, loan_transaction_id,
// savings_transaction_id, reversed, ref_num, manual_entry, entry_date, type_enum, amount,
// description, created_date, unique_ref_key
//
// account_id: 33 = SME Loan Portfolio (ASSET), 32 = Fund Source (LIABILITY)
// type_enum:  2 = DEBIT (increases asset), 1 = CREDIT (decreases asset)
// For disbursement: DEBIT portfolio (33), CREDIT fund source (32)
// For repayment:    DEBIT fund source (32), CREDIT portfolio (33) — principal portion only
console.log("\n→ Seeding batch-2 loan GL journal entries...");
const loanGlEntries = [
  // ── Loan 111 Disbursement (Apr 3) ────────────────────────────────────────
  [2001, 33, 1, null, 'NGN', 'LN-DISB-111-001', 2001, null, 0, 'LN-DISB-111', 0, '2025-04-03', 2, 4500000.0, 'Loan Disbursement - SML-2025-011', '2025-04-03 09:00:00', 'LN-DISB-111-001-DR'],
  [2002, 32, 1, null, 'NGN', 'LN-DISB-111-001', 2001, null, 0, 'LN-DISB-111', 0, '2025-04-03', 1, 4500000.0, 'Loan Disbursement - SML-2025-011', '2025-04-03 09:00:00', 'LN-DISB-111-001-CR'],
  // Loan 111 Repayment 1 (May)
  [2003, 32, 1, null, 'NGN', 'LN-REP-111-001', 2002, null, 0, 'LN-REP-111-1', 0, '2025-05-03', 2, 525000.0,  'Loan Repayment - SML-2025-011 Inst 1', '2025-05-03 10:00:00', 'LN-REP-111-001-DR'],
  [2004, 33, 1, null, 'NGN', 'LN-REP-111-001', 2002, null, 0, 'LN-REP-111-1', 0, '2025-05-03', 1, 367500.0,  'Loan Repayment Principal - SML-2025-011 Inst 1', '2025-05-03 10:00:00', 'LN-REP-111-001-CR'],
  // Loan 111 Repayment 2 (Jun)
  [2005, 32, 1, null, 'NGN', 'LN-REP-111-002', 2003, null, 0, 'LN-REP-111-2', 0, '2025-06-03', 2, 525000.0,  'Loan Repayment - SML-2025-011 Inst 2', '2025-06-03 10:00:00', 'LN-REP-111-002-DR'],
  [2006, 33, 1, null, 'NGN', 'LN-REP-111-002', 2003, null, 0, 'LN-REP-111-2', 0, '2025-06-03', 1, 370170.0,  'Loan Repayment Principal - SML-2025-011 Inst 2', '2025-06-03 10:00:00', 'LN-REP-111-002-CR'],

  // ── Loan 112 Disbursement (Apr 7) ────────────────────────────────────────
  [2007, 33, 1, null, 'NGN', 'LN-DISB-112-001', 2004, null, 0, 'LN-DISB-112', 0, '2025-04-07', 2, 2800000.0, 'Loan Disbursement - SML-2025-012', '2025-04-07 09:00:00', 'LN-DISB-112-001-DR'],
  [2008, 32, 1, null, 'NGN', 'LN-DISB-112-001', 2004, null, 0, 'LN-DISB-112', 0, '2025-04-07', 1, 2800000.0, 'Loan Disbursement - SML-2025-012', '2025-04-07 09:00:00', 'LN-DISB-112-001-CR'],
  // Loan 112 Repayment 1 (May)
  [2009, 32, 1, null, 'NGN', 'LN-REP-112-001', 2005, null, 0, 'LN-REP-112-1', 0, '2025-05-07', 2, 326666.67, 'Loan Repayment - SML-2025-012 Inst 1', '2025-05-07 10:00:00', 'LN-REP-112-001-DR'],
  [2010, 33, 1, null, 'NGN', 'LN-REP-112-001', 2005, null, 0, 'LN-REP-112-1', 0, '2025-05-07', 1, 228666.67, 'Loan Repayment Principal - SML-2025-012 Inst 1', '2025-05-07 10:00:00', 'LN-REP-112-001-CR'],
  // Loan 112 Repayment 2 (Jun)
  [2011, 32, 1, null, 'NGN', 'LN-REP-112-002', 2006, null, 0, 'LN-REP-112-2', 0, '2025-06-07', 2, 326666.67, 'Loan Repayment - SML-2025-012 Inst 2', '2025-06-07 10:00:00', 'LN-REP-112-002-DR'],
  [2012, 33, 1, null, 'NGN', 'LN-REP-112-002', 2006, null, 0, 'LN-REP-112-2', 0, '2025-06-07', 1, 230266.67, 'Loan Repayment Principal - SML-2025-012 Inst 2', '2025-06-07 10:00:00', 'LN-REP-112-002-CR'],

  // ── Loan 113 Disbursement (Apr 12) ───────────────────────────────────────
  [2013, 33, 1, null, 'NGN', 'LN-DISB-113-001', 2007, null, 0, 'LN-DISB-113', 0, '2025-04-12', 2, 6000000.0, 'Loan Disbursement - SML-2025-013', '2025-04-12 09:00:00', 'LN-DISB-113-001-DR'],
  [2014, 32, 1, null, 'NGN', 'LN-DISB-113-001', 2007, null, 0, 'LN-DISB-113', 0, '2025-04-12', 1, 6000000.0, 'Loan Disbursement - SML-2025-013', '2025-04-12 09:00:00', 'LN-DISB-113-001-CR'],
  // Loan 113 Repayment 1 (May) — ANOMALY A5: DOUBLE POSTED (two GL credit entries for same loan_transaction_id=2008)
  [2015, 32, 1, null, 'NGN', 'LN-REP-113-001', 2008, null, 0, 'LN-REP-113-1', 0, '2025-05-12', 2, 700000.0,  'Loan Repayment - SML-2025-013 Inst 1', '2025-05-12 10:00:00', 'LN-REP-113-001-DR'],
  [2016, 33, 1, null, 'NGN', 'LN-REP-113-001', 2008, null, 0, 'LN-REP-113-1', 0, '2025-05-12', 1, 490000.0,  'Loan Repayment Principal - SML-2025-013 Inst 1', '2025-05-12 10:00:00', 'LN-REP-113-001-CR'],
  // DUPLICATE GL entry — same loan_transaction_id 2008, different unique_ref_key (system error)
  [2017, 32, 1, null, 'NGN', 'LN-REP-113-001B', 2008, null, 0, 'LN-REP-113-1B', 0, '2025-05-12', 2, 700000.0,  'Loan Repayment - SML-2025-013 Inst 1 [DUPLICATE]', '2025-05-12 10:02:00', 'LN-REP-113-001B-DR'],
  [2018, 33, 1, null, 'NGN', 'LN-REP-113-001B', 2008, null, 0, 'LN-REP-113-1B', 0, '2025-05-12', 1, 490000.0,  'Loan Repayment Principal - SML-2025-013 Inst 1 [DUPLICATE]', '2025-05-12 10:02:00', 'LN-REP-113-001B-CR'],
  // Loan 113 Repayment 2 (Jun) — normal
  [2019, 32, 1, null, 'NGN', 'LN-REP-113-002', 2009, null, 0, 'LN-REP-113-2', 0, '2025-06-12', 2, 700000.0,  'Loan Repayment - SML-2025-013 Inst 2', '2025-06-12 10:00:00', 'LN-REP-113-002-DR'],
  [2020, 33, 1, null, 'NGN', 'LN-REP-113-002', 2009, null, 0, 'LN-REP-113-2', 0, '2025-06-12', 1, 493570.0,  'Loan Repayment Principal - SML-2025-013 Inst 2', '2025-06-12 10:00:00', 'LN-REP-113-002-CR'],

  // ── Loan 114 Disbursement (May 5) ────────────────────────────────────────
  [2021, 33, 1, null, 'NGN', 'LN-DISB-114-001', 2010, null, 0, 'LN-DISB-114', 0, '2025-05-05', 2, 3200000.0, 'Loan Disbursement - SML-2025-014', '2025-05-05 09:00:00', 'LN-DISB-114-001-DR'],
  [2022, 32, 1, null, 'NGN', 'LN-DISB-114-001', 2010, null, 0, 'LN-DISB-114', 0, '2025-05-05', 1, 3200000.0, 'Loan Disbursement - SML-2025-014', '2025-05-05 09:00:00', 'LN-DISB-114-001-CR'],
  // Loan 114 Repayment 1 (Jun)
  [2023, 32, 1, null, 'NGN', 'LN-REP-114-001', 2011, null, 0, 'LN-REP-114-1', 0, '2025-06-05', 2, 373333.33, 'Loan Repayment - SML-2025-014 Inst 1', '2025-06-05 10:00:00', 'LN-REP-114-001-DR'],
  [2024, 33, 1, null, 'NGN', 'LN-REP-114-001', 2011, null, 0, 'LN-REP-114-1', 0, '2025-06-05', 1, 261333.33, 'Loan Repayment Principal - SML-2025-014 Inst 1', '2025-06-05 10:00:00', 'LN-REP-114-001-CR'],
  // Loan 114 Repayment 2 (Jul)
  [2025, 32, 1, null, 'NGN', 'LN-REP-114-002', 2012, null, 0, 'LN-REP-114-2', 0, '2025-07-05', 2, 373333.33, 'Loan Repayment - SML-2025-014 Inst 2', '2025-07-05 10:00:00', 'LN-REP-114-002-DR'],
  [2026, 33, 1, null, 'NGN', 'LN-REP-114-002', 2012, null, 0, 'LN-REP-114-2', 0, '2025-07-05', 1, 263200.0,  'Loan Repayment Principal - SML-2025-014 Inst 2', '2025-07-05 10:00:00', 'LN-REP-114-002-CR'],

  // ── Loan 115 Disbursement (May 15) — ANOMALY A6: GL posts only ₦7.5M, CBS=₦9M ──
  [2027, 33, 1, null, 'NGN', 'LN-DISB-115-001', 2013, null, 0, 'LN-DISB-115', 0, '2025-05-15', 2, 7500000.0, 'Loan Disbursement - SML-2025-015 [PARTIAL: ₦1.5M shortfall]', '2025-05-15 09:00:00', 'LN-DISB-115-001-DR'],
  [2028, 32, 1, null, 'NGN', 'LN-DISB-115-001', 2013, null, 0, 'LN-DISB-115', 0, '2025-05-15', 1, 7500000.0, 'Loan Disbursement - SML-2025-015 [PARTIAL: ₦1.5M shortfall]', '2025-05-15 09:00:00', 'LN-DISB-115-001-CR'],
  // Loan 115 Repayment 1 (Jun)
  [2029, 32, 1, null, 'NGN', 'LN-REP-115-001', 2014, null, 0, 'LN-REP-115-1', 0, '2025-06-15', 2, 1050000.0, 'Loan Repayment - SML-2025-015 Inst 1', '2025-06-15 10:00:00', 'LN-REP-115-001-DR'],
  [2030, 33, 1, null, 'NGN', 'LN-REP-115-001', 2014, null, 0, 'LN-REP-115-1', 0, '2025-06-15', 1, 735000.0,  'Loan Repayment Principal - SML-2025-015 Inst 1', '2025-06-15 10:00:00', 'LN-REP-115-001-CR'],
  // Loan 115 Repayment 2 (Jul)
  [2031, 32, 1, null, 'NGN', 'LN-REP-115-002', 2015, null, 0, 'LN-REP-115-2', 0, '2025-07-15', 2, 1050000.0, 'Loan Repayment - SML-2025-015 Inst 2', '2025-07-15 10:00:00', 'LN-REP-115-002-DR'],
  [2032, 33, 1, null, 'NGN', 'LN-REP-115-002', 2015, null, 0, 'LN-REP-115-2', 0, '2025-07-15', 1, 740250.0,  'Loan Repayment Principal - SML-2025-015 Inst 2', '2025-07-15 10:00:00', 'LN-REP-115-002-CR'],

  // ── Loan 116 Disbursement (May 20) ───────────────────────────────────────
  [2033, 33, 1, null, 'NGN', 'LN-DISB-116-001', 2016, null, 0, 'LN-DISB-116', 0, '2025-05-20', 2, 1800000.0, 'Loan Disbursement - SML-2025-016', '2025-05-20 09:00:00', 'LN-DISB-116-001-DR'],
  [2034, 32, 1, null, 'NGN', 'LN-DISB-116-001', 2016, null, 0, 'LN-DISB-116', 0, '2025-05-20', 1, 1800000.0, 'Loan Disbursement - SML-2025-016', '2025-05-20 09:00:00', 'LN-DISB-116-001-CR'],
  // Loan 116 Repayment 1 (Jun)
  [2035, 32, 1, null, 'NGN', 'LN-REP-116-001', 2017, null, 0, 'LN-REP-116-1', 0, '2025-06-20', 2, 210000.0,  'Loan Repayment - SML-2025-016 Inst 1', '2025-06-20 10:00:00', 'LN-REP-116-001-DR'],
  [2036, 33, 1, null, 'NGN', 'LN-REP-116-001', 2017, null, 0, 'LN-REP-116-1', 0, '2025-06-20', 1, 147000.0,  'Loan Repayment Principal - SML-2025-016 Inst 1', '2025-06-20 10:00:00', 'LN-REP-116-001-CR'],

  // ── Loan 117 Disbursement (Apr 18) ───────────────────────────────────────
  [2037, 33, 1, null, 'NGN', 'LN-DISB-117-001', 2018, null, 0, 'LN-DISB-117', 0, '2025-04-18', 2, 5500000.0, 'Loan Disbursement - SML-2025-017', '2025-04-18 09:00:00', 'LN-DISB-117-001-DR'],
  [2038, 32, 1, null, 'NGN', 'LN-DISB-117-001', 2018, null, 0, 'LN-DISB-117', 0, '2025-04-18', 1, 5500000.0, 'Loan Disbursement - SML-2025-017', '2025-04-18 09:00:00', 'LN-DISB-117-001-CR'],
  // Loan 117 Repayment 1 (May) — ANOMALY A7: GL marks entry as reversed but CBS is_reversed=0
  // The GL entry has reversed=1 (meaning the GL entry itself was reversed/cancelled)
  // but the CBS loan_transaction 2019 is NOT reversed — mismatch
  [2039, 32, 1, null, 'NGN', 'LN-REP-117-001', 2019, null, 1, 'LN-REP-117-1', 0, '2025-05-18', 2, 641666.67, 'Loan Repayment - SML-2025-017 Inst 1 [GL REVERSED]', '2025-05-18 10:00:00', 'LN-REP-117-001-DR'],
  [2040, 33, 1, null, 'NGN', 'LN-REP-117-001', 2019, null, 1, 'LN-REP-117-1', 0, '2025-05-18', 1, 449166.67, 'Loan Repayment Principal - SML-2025-017 Inst 1 [GL REVERSED]', '2025-05-18 10:00:00', 'LN-REP-117-001-CR'],
  // Loan 117 Repayment 2 (Jun) — normal
  [2041, 32, 1, null, 'NGN', 'LN-REP-117-002', 2020, null, 0, 'LN-REP-117-2', 0, '2025-06-18', 2, 641666.67, 'Loan Repayment - SML-2025-017 Inst 2', '2025-06-18 10:00:00', 'LN-REP-117-002-DR'],
  [2042, 33, 1, null, 'NGN', 'LN-REP-117-002', 2020, null, 0, 'LN-REP-117-2', 0, '2025-06-18', 1, 452366.67, 'Loan Repayment Principal - SML-2025-017 Inst 2', '2025-06-18 10:00:00', 'LN-REP-117-002-CR'],

  // ── Loan 118 Disbursement (Jun 10) ───────────────────────────────────────
  [2043, 33, 1, null, 'NGN', 'LN-DISB-118-001', 2021, null, 0, 'LN-DISB-118', 0, '2025-06-10', 2, 2200000.0, 'Loan Disbursement - SML-2025-018', '2025-06-10 09:00:00', 'LN-DISB-118-001-DR'],
  [2044, 32, 1, null, 'NGN', 'LN-DISB-118-001', 2021, null, 0, 'LN-DISB-118', 0, '2025-06-10', 1, 2200000.0, 'Loan Disbursement - SML-2025-018', '2025-06-10 09:00:00', 'LN-DISB-118-001-CR'],
  // Loan 118 Repayment 1 (Jul)
  [2045, 32, 1, null, 'NGN', 'LN-REP-118-001', 2022, null, 0, 'LN-REP-118-1', 0, '2025-07-10', 2, 256666.67, 'Loan Repayment - SML-2025-018 Inst 1', '2025-07-10 10:00:00', 'LN-REP-118-001-DR'],
  [2046, 33, 1, null, 'NGN', 'LN-REP-118-001', 2022, null, 0, 'LN-REP-118-1', 0, '2025-07-10', 1, 179666.67, 'Loan Repayment Principal - SML-2025-018 Inst 1', '2025-07-10 10:00:00', 'LN-REP-118-001-CR'],

  // ── Loan 119 Disbursement (Apr 25) ───────────────────────────────────────
  [2047, 33, 1, null, 'NGN', 'LN-DISB-119-001', 2023, null, 0, 'LN-DISB-119', 0, '2025-04-25', 2, 7500000.0, 'Loan Disbursement - SML-2025-019', '2025-04-25 09:00:00', 'LN-DISB-119-001-DR'],
  [2048, 32, 1, null, 'NGN', 'LN-DISB-119-001', 2023, null, 0, 'LN-DISB-119', 0, '2025-04-25', 1, 7500000.0, 'Loan Disbursement - SML-2025-019', '2025-04-25 09:00:00', 'LN-DISB-119-001-CR'],
  // Loan 119 Repayment 1 — ANOMALY A8: CBS transaction_date=May 25, GL entry_date=Jul 25 (2-month lag)
  [2049, 32, 1, null, 'NGN', 'LN-REP-119-001', 2024, null, 0, 'LN-REP-119-1', 0, '2025-07-25', 2, 875000.0,  'Loan Repayment - SML-2025-019 Inst 1 [LATE POST: CBS=May25]', '2025-07-25 10:00:00', 'LN-REP-119-001-DR'],
  [2050, 33, 1, null, 'NGN', 'LN-REP-119-001', 2024, null, 0, 'LN-REP-119-1', 0, '2025-07-25', 1, 612500.0,  'Loan Repayment Principal - SML-2025-019 Inst 1 [LATE POST]', '2025-07-25 10:00:00', 'LN-REP-119-001-CR'],
  // Loan 119 Repayment 2 (Jun) — normal
  [2051, 32, 1, null, 'NGN', 'LN-REP-119-002', 2025, null, 0, 'LN-REP-119-2', 0, '2025-06-25', 2, 875000.0,  'Loan Repayment - SML-2025-019 Inst 2', '2025-06-25 10:00:00', 'LN-REP-119-002-DR'],
  [2052, 33, 1, null, 'NGN', 'LN-REP-119-002', 2025, null, 0, 'LN-REP-119-2', 0, '2025-06-25', 1, 616875.0,  'Loan Repayment Principal - SML-2025-019 Inst 2', '2025-06-25 10:00:00', 'LN-REP-119-002-CR'],

  // ── Loan 120 Disbursement (May 28) ───────────────────────────────────────
  [2053, 33, 1, null, 'NGN', 'LN-DISB-120-001', 2026, null, 0, 'LN-DISB-120', 0, '2025-05-28', 2, 3800000.0, 'Loan Disbursement - SML-2025-020', '2025-05-28 09:00:00', 'LN-DISB-120-001-DR'],
  [2054, 32, 1, null, 'NGN', 'LN-DISB-120-001', 2026, null, 0, 'LN-DISB-120', 0, '2025-05-28', 1, 3800000.0, 'Loan Disbursement - SML-2025-020', '2025-05-28 09:00:00', 'LN-DISB-120-001-CR'],
  // Loan 120 Repayment 1 (Jun)
  [2055, 32, 1, null, 'NGN', 'LN-REP-120-001', 2027, null, 0, 'LN-REP-120-1', 0, '2025-06-28', 2, 443333.33, 'Loan Repayment - SML-2025-020 Inst 1', '2025-06-28 10:00:00', 'LN-REP-120-001-DR'],
  [2056, 33, 1, null, 'NGN', 'LN-REP-120-001', 2027, null, 0, 'LN-REP-120-1', 0, '2025-06-28', 1, 310333.33, 'Loan Repayment Principal - SML-2025-020 Inst 1', '2025-06-28 10:00:00', 'LN-REP-120-001-CR'],

  // ── Loan 121 Disbursement (Jun 5) — ANOMALY A9: DUPLICATE DISBURSEMENT in GL ──
  // CBS has one disbursement (2029) but GL has two debit entries for the same loan
  [2057, 33, 1, null, 'NGN', 'LN-DISB-121-001', 2029, null, 0, 'LN-DISB-121', 0, '2025-06-05', 2, 5000000.0, 'Loan Disbursement - SML-2025-021', '2025-06-05 09:00:00', 'LN-DISB-121-001-DR'],
  [2058, 32, 1, null, 'NGN', 'LN-DISB-121-001', 2029, null, 0, 'LN-DISB-121', 0, '2025-06-05', 1, 5000000.0, 'Loan Disbursement - SML-2025-021', '2025-06-05 09:00:00', 'LN-DISB-121-001-CR'],
  // DUPLICATE GL disbursement entry — same loan_transaction_id 2029, different ref
  [2059, 33, 1, null, 'NGN', 'LN-DISB-121-001B', 2029, null, 0, 'LN-DISB-121B', 0, '2025-06-05', 2, 5000000.0, 'Loan Disbursement - SML-2025-021 [DUPLICATE ENTRY]', '2025-06-05 09:05:00', 'LN-DISB-121-001B-DR'],
  [2060, 32, 1, null, 'NGN', 'LN-DISB-121-001B', 2029, null, 0, 'LN-DISB-121B', 0, '2025-06-05', 1, 5000000.0, 'Loan Disbursement - SML-2025-021 [DUPLICATE ENTRY]', '2025-06-05 09:05:00', 'LN-DISB-121-001B-CR'],
  // Loan 121 Repayment 1 (Jul)
  [2061, 32, 1, null, 'NGN', 'LN-REP-121-001', 2030, null, 0, 'LN-REP-121-1', 0, '2025-07-05', 2, 583333.33, 'Loan Repayment - SML-2025-021 Inst 1', '2025-07-05 10:00:00', 'LN-REP-121-001-DR'],
  [2062, 33, 1, null, 'NGN', 'LN-REP-121-001', 2030, null, 0, 'LN-REP-121-1', 0, '2025-07-05', 1, 408333.33, 'Loan Repayment Principal - SML-2025-021 Inst 1', '2025-07-05 10:00:00', 'LN-REP-121-001-CR'],

  // ── Loan 122 Disbursement (Jun 20) ───────────────────────────────────────
  [2063, 33, 1, null, 'NGN', 'LN-DISB-122-001', 2031, null, 0, 'LN-DISB-122', 0, '2025-06-20', 2, 4200000.0, 'Loan Disbursement - SML-2025-022', '2025-06-20 09:00:00', 'LN-DISB-122-001-DR'],
  [2064, 32, 1, null, 'NGN', 'LN-DISB-122-001', 2031, null, 0, 'LN-DISB-122', 0, '2025-06-20', 1, 4200000.0, 'Loan Disbursement - SML-2025-022', '2025-06-20 09:00:00', 'LN-DISB-122-001-CR'],
  // Loan 122 Repayment 1 (Jul)
  [2065, 32, 1, null, 'NGN', 'LN-REP-122-001', 2032, null, 0, 'LN-REP-122-1', 0, '2025-07-20', 2, 490000.0,  'Loan Repayment - SML-2025-022 Inst 1', '2025-07-20 10:00:00', 'LN-REP-122-001-DR'],
  [2066, 33, 1, null, 'NGN', 'LN-REP-122-001', 2032, null, 0, 'LN-REP-122-1', 0, '2025-07-20', 1, 343000.0,  'Loan Repayment Principal - SML-2025-022 Inst 1', '2025-07-20 10:00:00', 'LN-REP-122-001-CR'],

  // ── Loan 123 Disbursement (Jun 25) ───────────────────────────────────────
  [2067, 33, 1, null, 'NGN', 'LN-DISB-123-001', 2033, null, 0, 'LN-DISB-123', 0, '2025-06-25', 2, 1500000.0, 'Loan Disbursement - SML-2025-023', '2025-06-25 09:00:00', 'LN-DISB-123-001-DR'],
  [2068, 32, 1, null, 'NGN', 'LN-DISB-123-001', 2033, null, 0, 'LN-DISB-123', 0, '2025-06-25', 1, 1500000.0, 'Loan Disbursement - SML-2025-023', '2025-06-25 09:00:00', 'LN-DISB-123-001-CR'],

  // ── Loan 124 Disbursement (Jul 8) ────────────────────────────────────────
  [2069, 33, 1, null, 'NGN', 'LN-DISB-124-001', 2035, null, 0, 'LN-DISB-124', 0, '2025-07-08', 2, 6500000.0, 'Loan Disbursement - SML-2025-024', '2025-07-08 09:00:00', 'LN-DISB-124-001-DR'],
  [2070, 32, 1, null, 'NGN', 'LN-DISB-124-001', 2035, null, 0, 'LN-DISB-124', 0, '2025-07-08', 1, 6500000.0, 'Loan Disbursement - SML-2025-024', '2025-07-08 09:00:00', 'LN-DISB-124-001-CR'],

  // ── Loan 125 Disbursement (Jul 22) ───────────────────────────────────────
  [2071, 33, 1, null, 'NGN', 'LN-DISB-125-001', 2036, null, 0, 'LN-DISB-125', 0, '2025-07-22', 2, 2600000.0, 'Loan Disbursement - SML-2025-025', '2025-07-22 09:00:00', 'LN-DISB-125-001-DR'],
  [2072, 32, 1, null, 'NGN', 'LN-DISB-125-001', 2036, null, 0, 'LN-DISB-125', 0, '2025-07-22', 1, 2600000.0, 'Loan Disbursement - SML-2025-025', '2025-07-22 09:00:00', 'LN-DISB-125-001-CR'],

  // ── ANOMALY A10: Unmatched credit — no loan reference, Jun 30 ────────────
  // A credit to Portfolio (33) for ₦2,100,000 with no loan_transaction_id and no transaction_id
  // Appears as an unexplained reduction in the GL portfolio balance
  [2073, 33, 1, null, 'NGN', 'UNMATCHED-CR-001', null, null, 0, 'UNM-CR-001', 1, '2025-06-30', 1, 2100000.0, 'Unmatched credit - source unknown, pending investigation', '2025-06-30 17:30:00', 'UNMATCHED-CR-001'],

  // ── Loan 120 Repayment 2 (Jul) ───────────────────────────────────────────
  [2074, 32, 1, null, 'NGN', 'LN-REP-120-002', 2028, null, 0, 'LN-REP-120-2', 0, '2025-07-28', 2, 443333.33, 'Loan Repayment - SML-2025-020 Inst 2', '2025-07-28 10:00:00', 'LN-REP-120-002-DR'],
  [2075, 33, 1, null, 'NGN', 'LN-REP-120-002', 2028, null, 0, 'LN-REP-120-2', 0, '2025-07-28', 1, 312546.67, 'Loan Repayment Principal - SML-2025-020 Inst 2', '2025-07-28 10:00:00', 'LN-REP-120-002-CR'],

  // ── Loan 123 Repayment 1 (Jul 25) ────────────────────────────────────────
  [2076, 32, 1, null, 'NGN', 'LN-REP-123-001', 2034, null, 0, 'LN-REP-123-1', 0, '2025-07-25', 2, 175000.0,  'Loan Repayment - SML-2025-023 Inst 1', '2025-07-25 10:00:00', 'LN-REP-123-001-DR'],
  [2077, 33, 1, null, 'NGN', 'LN-REP-123-001', 2034, null, 0, 'LN-REP-123-1', 0, '2025-07-25', 1, 122500.0,  'Loan Repayment Principal - SML-2025-023 Inst 1', '2025-07-25 10:00:00', 'LN-REP-123-001-CR'],
];

for (const e of loanGlEntries) {
  await conn.execute(
    `INSERT IGNORE INTO wc_acc_gl_journal_entry (id, account_id, office_id, reversal_id, currency_code, transaction_id, loan_transaction_id, savings_transaction_id, reversed, ref_num, manual_entry, entry_date, type_enum, amount, description, created_date, unique_ref_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    e
  );
}
console.log(`  ✓ wc_acc_gl_journal_entry (batch-2 loan entries): ${loanGlEntries.length} rows`);

// ─── Verify ───────────────────────────────────────────────────────────────────
console.log("\n→ Verifying seeded data...");
const [loanCount] = await conn.execute("SELECT COUNT(*) as c FROM wc_m_loan WHERE id >= 111 AND id <= 125");
const [txnCount]  = await conn.execute("SELECT COUNT(*) as c FROM wc_m_loan_transaction WHERE id >= 2001 AND id <= 2060");
const [glCount]   = await conn.execute("SELECT COUNT(*) as c FROM wc_acc_gl_journal_entry WHERE id >= 2001 AND id <= 2100");
console.log(`  wc_m_loan (batch 2):              ${loanCount[0].c} rows`);
console.log(`  wc_m_loan_transaction (batch 2):  ${txnCount[0].c} rows`);
console.log(`  wc_acc_gl_journal_entry (batch 2): ${glCount[0].c} rows`);

console.log("\n→ Anomaly summary (batch 2):");
console.log("  A5  – DOUBLE_POSTED_REPAYMENT      : Loan 113, May repayment (txn 2008) posted twice in GL");
console.log("  A6  – PARTIAL_DISBURSEMENT_MISMATCH: Loan 115, GL=₦7.5M vs CBS=₦9M (₦1.5M shortfall)");
console.log("  A7  – REVERSED_ENTRY_NOT_MATCHED   : Loan 117, GL reversed May repayment but CBS is_reversed=0");
console.log("  A8  – LATE_POSTING_ANOMALY          : Loan 119, CBS=May 25 but GL entry_date=Jul 25");
console.log("  A9  – DUPLICATE_DISBURSEMENT        : Loan 121, GL has two debit entries for same disbursement");
console.log("  A10 – UNMATCHED_CREDIT              : Jun 30, ₦2.1M credit to portfolio GL with no loan ref");

await conn.end();
console.log("\n✓ Batch-2 loan seed complete.");
