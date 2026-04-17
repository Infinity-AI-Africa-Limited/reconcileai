/**
 * Woodcore POC Data Loader
 * Loads the August 2025 Woodcore database dump into the ReconcileAI prototype DB.
 * Run: node seed-woodcore-poc.mjs
 */

import { createConnection } from "mysql2/promise";
import { readFileSync } from "fs";
import { join } from "path";

const DATA_DIR = "/home/ubuntu/woodcore_data/woodcore data";
const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

// Parse MySQL connection URL
const url = new URL(DB_URL);
const conn = await createConnection({
  host: url.hostname,
  port: parseInt(url.port || "3306"),
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: false },
  multipleStatements: false,
});

console.log("✓ Connected to database");

// Helper: read SQL file and extract INSERT data
function extractInsertData(filename) {
  const content = readFileSync(join(DATA_DIR, filename), "utf-8");
  const match = content.match(/INSERT INTO `[^`]+` VALUES ([\s\S]+?);[\s\n]*(?:\/\*|UNLOCK|$)/);
  if (!match) return null;
  return match[1].trim();
}

// Helper: parse VALUES string into individual row strings
function parseValues(valuesStr) {
  const rows = [];
  let depth = 0;
  let start = 0;
  let inStr = false;
  let strChar = null;
  
  for (let i = 0; i < valuesStr.length; i++) {
    const ch = valuesStr[i];
    if (inStr) {
      if (ch === strChar && valuesStr[i-1] !== '\\') inStr = false;
    } else if (ch === "'" || ch === '"') {
      inStr = true; strChar = ch;
    } else if (ch === '(') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        rows.push(valuesStr.slice(start, i + 1));
      }
    }
  }
  return rows;
}

// Helper: batch insert
async function batchInsert(table, columns, rows, batchSize = 50) {
  if (rows.length === 0) {
    console.log(`  ${table}: no data`);
    return;
  }
  
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const sql = `INSERT IGNORE INTO ${table} (${columns}) VALUES ${batch.join(",")}`;
    try {
      await conn.execute(sql);
      inserted += batch.length;
    } catch (e) {
      console.error(`  Error inserting batch into ${table}: ${e.message.slice(0, 100)}`);
    }
  }
  console.log(`  ✓ ${table}: ${inserted} rows inserted`);
}

// ─── Clear existing Woodcore data ────────────────────────────────────────────
console.log("\n→ Clearing existing Woodcore data...");
const tables = [
  "wc_exceptions", "wc_reconciliation_runs",
  "wc_acc_to_gl_journal_entry_savings", "wc_acc_to_gl_journal_entry",
  "wc_acc_gl_journal_entry", "wc_acc_product_mapping", "wc_acc_gl_account",
  "wc_m_savings_account_transaction", "wc_m_savings_account",
  "wc_m_savings_product", "wc_m_loan_transaction", "wc_m_loan",
  "wc_m_product_loan",
];
for (const t of tables) {
  await conn.execute(`DELETE FROM ${t}`);
}
console.log("  ✓ Cleared");

// ─── Load GL Accounts ────────────────────────────────────────────────────────
console.log("\n→ Loading GL accounts...");
const glAccountData = extractInsertData("woodcore_acc_gl_account.sql");
if (glAccountData) {
  const rows = parseValues(glAccountData);
  // columns from schema: id, name, gl_code, disabled, manual_entries_allowed,
  // classification_enum, account_usage, parent_id, hierarchy, tag_id, description, organization_running_balance
  // Raw data has more columns - we extract what we need
  const mappedRows = rows.map(row => {
    // Parse the raw tuple: (id, name, disabled, manual_entries_allowed, classification_enum,
    // account_usage, parent_id, gl_code, root_gap, tag_id, description, organization_running_balance, hierarchy)
    // We'll use the raw values directly with a custom INSERT
    return row;
  });
  
  // Use raw INSERT with all columns from the dump
  // Schema columns: id, name, gl_code, disabled, manual_entries_allowed, classification_enum,
  // account_usage, parent_id, hierarchy, tag_id, description, organization_running_balance
  const sql = `INSERT IGNORE INTO wc_acc_gl_account 
    (id, name, gl_code, disabled, manual_entries_allowed, classification_enum, account_usage, parent_id, hierarchy, tag_id, description, organization_running_balance)
    SELECT id, name, gl_code, disabled, manual_entries_allowed, classification_enum, account_usage, parent_id, hierarchy, tag_id, description, organization_running_balance
    FROM (VALUES ${rows.join(",")}) AS t(id, name, disabled, manual_entries_allowed, classification_enum, account_usage, parent_id, gl_code, root_gap, tag_id, description, organization_running_balance, hierarchy)`;
  
  try {
    await conn.execute(sql);
    const [cnt] = await conn.execute("SELECT COUNT(*) as c FROM wc_acc_gl_account");
    console.log(`  ✓ wc_acc_gl_account: ${cnt[0].c} rows`);
  } catch (e) {
    console.error(`  Error loading GL accounts: ${e.message.slice(0, 200)}`);
    // Fallback: insert known accounts manually
    await loadGlAccountsManually();
  }
}

async function loadGlAccountsManually() {
  console.log("  → Falling back to manual GL account insert...");
  const accounts = [
    // id, name, gl_code, disabled, manual_entries_allowed, classification_enum, account_usage, parent_id, hierarchy, tag_id, description, organization_running_balance
    [1, 'Asset Account (Parent)', '100000', 0, 1, 1, 1, null, '.1.', null, null, 0],
    [2, 'Cash', '100001', 0, 1, 1, 2, 1, '.1.2.', null, null, 0],
    [14, 'WoodCore Savings Asset Account', '111626', 0, 1, 1, 1, 1, '.1.14.', null, null, 0],
    [15, 'WoodCore Savings Overdraft Portfolio', '111531', 0, 1, 1, 2, 14, '.1.14.15.', null, null, 0],
    [16, 'WoodCore Savings Reference', '119563', 0, 1, 1, 2, 14, '.1.14.16.', null, null, 0],
    [17, 'WoodCore Savings Overdraft Interest Receivable', '110770', 0, 1, 1, 2, 14, '.1.14.17.', null, null, 0],
    [18, 'WoodCore Savings Liability Account', '223620', 0, 1, 2, 1, null, '.18.', null, null, 0],
    [19, 'WoodCore Savings Control', '223681', 0, 1, 2, 2, 18, '.18.19.', null, null, 0],
    [20, 'WoodCore Savings Interest Payable', '226495', 0, 1, 2, 2, 18, '.18.20.', null, null, 0],
    [21, 'WoodCore Savings Transfer in Suspense', '220631', 0, 1, 2, 2, 18, '.18.21.', null, null, 0],
    [22, 'WoodCore Savings Income Account', '440167', 0, 1, 4, 1, null, '.22.', null, null, 0],
    [23, 'WoodCore Savings Income From Fees', '445753', 0, 1, 4, 2, 22, '.22.23.', null, null, 0],
    [24, 'WoodCore Savings Income From Penalties', '444744', 0, 1, 4, 2, 22, '.22.24.', null, null, 0],
    [25, 'WoodCore Savings Overdraft Interest Income', '448142', 0, 1, 4, 2, 22, '.22.25.', null, null, 0],
    [26, 'WoodCore Savings Expense Account', '550368', 0, 1, 5, 1, null, '.26.', null, null, 0],
    [27, 'WoodCore Savings Interest on Savings', '558574', 0, 1, 5, 2, 26, '.26.27.', null, null, 0],
    [28, 'WoodCore Savings Write-Off Account', '554550', 0, 1, 5, 2, 26, '.26.28.', null, null, 0],
    [31, 'SME Loan Asset Account', '113537', 0, 1, 1, 1, 1, '.1.31.', null, null, 0],
    [32, 'SME Fund Source Account', '113938', 0, 1, 1, 2, 31, '.1.31.32.', null, null, 0],
    [33, 'SME Loan Portfolio Account', '117083', 0, 1, 1, 2, 31, '.1.31.33.', null, null, 0],
    [34, 'SME Loan Interest Receivable', '111198', 0, 1, 1, 2, 31, '.1.31.34.', null, null, 0],
    [35, 'SME Loan Fees Receivable Account', '112123', 0, 1, 1, 2, 31, '.1.31.35.', null, null, 0],
    [36, 'SME Loan Penalties Receivable Account', '115449', 0, 1, 1, 2, 31, '.1.31.36.', null, null, 0],
    [37, 'SME Loan Transfer in Suspense', '111480', 0, 1, 1, 2, 31, '.1.31.37.', null, null, 0],
    [38, 'SME Loan Liability Account', '220659', 0, 1, 2, 1, null, '.38.', null, null, 0],
    [39, 'SME Loan Overpayment Liability', '222265', 0, 1, 2, 2, 38, '.38.39.', null, null, 0],
    [42, 'SME Loan Income Account', '443651', 0, 1, 4, 1, null, '.42.', null, null, 0],
    [43, 'SME Loan Income From Fees', '444864', 0, 1, 4, 2, 42, '.42.43.', null, null, 0],
    [44, 'SME Loan Income From Penalties', '441022', 0, 1, 4, 2, 42, '.42.44.', null, null, 0],
    [45, 'SME Loan Income From Interest', '443115', 0, 1, 4, 2, 42, '.42.45.', null, null, 0],
    [46, 'SME Loan Income From Recovery Repayments', '440063', 0, 1, 4, 2, 42, '.42.46.', null, null, 0],
  ];
  
  for (const a of accounts) {
    await conn.execute(
      `INSERT IGNORE INTO wc_acc_gl_account (id, name, gl_code, disabled, manual_entries_allowed, classification_enum, account_usage, parent_id, hierarchy, tag_id, description, organization_running_balance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      a
    );
  }
  const [cnt] = await conn.execute("SELECT COUNT(*) as c FROM wc_acc_gl_account");
  console.log(`  ✓ wc_acc_gl_account (manual): ${cnt[0].c} rows`);
}

// ─── Load Product Mapping ────────────────────────────────────────────────────
console.log("\n→ Loading product mappings...");
// From the dump: (id, gl_account_id, product_id, product_type, charge_id, payment_type_id, financial_account_type)
const productMappings = [
  // Savings products (product_type=2)
  // WoodCore Savings (product_id=2)
  [12, 2, 2, 2, 1, null, 1],   // Fund Source (financial_account_type=1)
  [13, 16, 2, 2, null, null, 1], // Savings Reference (Asset) - PORTFOLIO LEDGER
  [21, 19, 2, 2, null, null, 2], // Savings Control (Liability)
  [23, 19, 2, 2, null, null, 14], // Savings Control secondary
  [24, 20, 2, 2, null, null, 15], // Interest Payable
  [16, 23, 2, 2, null, null, 4], // Income from Fees
  [17, 24, 2, 2, null, null, 5], // Income from Penalties
  [18, 25, 2, 2, null, null, 12], // Overdraft Interest
  [19, 27, 2, 2, null, null, 3], // Interest on Savings (Expense)
  [20, 28, 2, 2, null, null, 13], // Write-Off
  [22, 21, 2, 2, null, null, 10], // Transfer in Suspense
  [14, 15, 2, 2, null, null, 11], // Overdraft Portfolio
  [15, 17, 2, 2, null, null, 16], // Overdraft Interest Receivable
  // WC DEP (product_id=1, USD savings)
  [1, 2, 1, 2, null, null, 1],
  [2, 1, 1, 2, null, null, 11],
  [3, 3, 1, 2, null, null, 16],
  // Fair Savings (product_id=3)
  [25, 16, 3, 2, null, null, 1],
  [26, 16, 3, 2, null, null, 1],
  // Safelock (product_id=4)
  [33, 16, 4, 2, null, null, 1],
  // SME Loan (product_type=1, product_id=1)
  [40, 32, 1, 1, null, null, 1],  // Fund Source
  [41, 33, 1, 1, null, null, 2],  // Loan Portfolio (PORTFOLIO LEDGER)
  [42, 37, 1, 1, null, null, 10], // Transfer in Suspense
  [43, 34, 1, 1, null, null, 7],  // Interest Receivable
  [44, 35, 1, 1, null, null, 8],  // Fees Receivable
  [45, 36, 1, 1, null, null, 9],  // Penalties Receivable
  [46, 45, 1, 1, null, null, 3],  // Income from Interest
  [47, 43, 1, 1, null, null, 4],  // Income from Fees
  [48, 44, 1, 1, null, null, 5],  // Income from Penalties
  [49, 46, 1, 1, null, null, 12], // Recovery Repayments
  [51, 39, 1, 1, null, null, 11], // Overpayment Liability
];

for (const m of productMappings) {
  await conn.execute(
    `INSERT IGNORE INTO wc_acc_product_mapping (id, gl_account_id, product_id, product_type, charge_id, payment_type_id, financial_account_type) VALUES (?,?,?,?,?,?,?)`,
    m
  );
}
const [pmCnt] = await conn.execute("SELECT COUNT(*) as c FROM wc_acc_product_mapping");
console.log(`  ✓ wc_acc_product_mapping: ${pmCnt[0].c} rows`);

// ─── Load Savings Products ───────────────────────────────────────────────────
console.log("\n→ Loading savings products...");
const savingsProducts = [
  [1, 'WC DEP', 'JDEP', 'JDD', 100, 'USD', 1.000000],
  [2, 'WoodCore Savings', 'WCSV', 'WoodCore Savings Product', 100, 'NGN', 2.500000],
  [3, 'Fair Savings', 'FAIR', null, 100, 'NGN', 12.000000],
  [4, 'Safelock', 'SAFE', 'Safelock', 200, 'NGN', 17.000000],
];
for (const p of savingsProducts) {
  await conn.execute(
    `INSERT IGNORE INTO wc_m_savings_product (id, name, short_name, description, deposit_amount, currency_code, nominal_annual_interest_rate) VALUES (?,?,?,?,?,?,?)`,
    p
  );
}
console.log(`  ✓ wc_m_savings_product: ${savingsProducts.length} rows`);

// ─── Load Loan Products ──────────────────────────────────────────────────────
console.log("\n→ Loading loan products...");
await conn.execute(
  `INSERT IGNORE INTO wc_m_product_loan (id, name, short_name, currency_code, nominal_interest_rate_per_period) VALUES (?,?,?,?,?)`,
  [1, 'SME Loan', 'SMEL', 'NGN', 9.000000]
);
console.log(`  ✓ wc_m_product_loan: 1 row`);

// ─── Load Savings Accounts ───────────────────────────────────────────────────
console.log("\n→ Loading savings accounts...");
// (id, account_no, client_id, product_id, status_enum, currency_code, account_balance_derived, activated_on_date)
const savingsAccounts = [
  [1, '000000001', null, 1, 300, 'USD', 800.008334, '2025-04-01'],
  [2, '000000002', null, 2, 300, 'NGN', 2000.027778, '2024-01-02'],
  [3, '000000003', null, 2, 300, 'NGN', 4600.000000, '2025-04-02'],
  [4, '000000004', null, 2, 300, 'NGN', 500.104166, '2024-01-02'],
  [5, '0000000051', null, 2, 300, 'NGN', 22302.944444, '2025-05-12'],
  [6, '000000006', null, 1, 300, 'USD', 400.022222, '2024-10-18'],
  [7, '000000007', null, 4, 200, 'NGN', null, '2025-06-09'],
  [8, '000000008', null, 2, 200, 'NGN', null, '2025-06-17'],
  [9, '000000009', null, 1, 300, 'USD', 2000000.000000, '2025-06-17'],
  [10, '000000010', null, 4, 200, 'NGN', null, '2025-07-23'],
];
for (const a of savingsAccounts) {
  await conn.execute(
    `INSERT IGNORE INTO wc_m_savings_account (id, account_no, client_id, product_id, status_enum, currency_code, account_balance_derived, activated_on_date) VALUES (?,?,?,?,?,?,?,?)`,
    a
  );
}
console.log(`  ✓ wc_m_savings_account: ${savingsAccounts.length} rows`);

// ─── Load Savings Transactions ───────────────────────────────────────────────
console.log("\n→ Loading savings transactions...");
// (id, savings_account_id, transaction_type_enum, is_reversed, transaction_date, amount, running_balance_derived, is_manual, created_date)
const savingsTxns = [
  [1, 1, 1, 0, '2025-04-01', 100.000000, 100.000000, 0, '2025-04-10 12:05:48'],
  [5, 3, 1, 0, '2025-04-16', 1500.000000, 1500.000000, 0, '2025-04-16 19:45:04'],
  [6, 4, 1, 0, '2025-04-22', 500.000000, 500.000000, 0, '2025-04-22 02:08:45'],
  [7, 3, 1, 0, '2025-04-22', 1000.000000, 2500.000000, 0, '2025-04-22 02:11:49'],
  [8, 3, 1, 0, '2025-04-22', 200.000000, 2700.000000, 0, '2025-04-22 02:22:26'],
  [9, 3, 1, 0, '2025-04-22', 150.000000, 2850.000000, 0, '2025-04-22 02:43:06'],
  [10, 3, 1, 0, '2025-04-22', 100.000000, 2950.000000, 0, '2025-04-22 03:04:02'],
  [11, 3, 1, 0, '2025-04-22', 250.000000, 3200.000000, 0, '2025-04-22 03:20:18'],
  [12, 3, 2, 0, '2025-04-22', 150.000000, 3050.000000, 0, '2025-04-22 03:23:52'],
  [13, 3, 1, 0, '2025-04-22', 500.000000, 3550.000000, 0, '2025-04-22 03:52:39'],
  [14, 3, 2, 0, '2025-04-22', 400.000000, 3150.000000, 0, '2025-04-22 03:56:12'],
  [15, 3, 2, 0, '2025-04-22', 150.000000, 3000.000000, 0, '2025-04-22 04:01:33'],
  [16, 3, 1, 0, '2025-04-22', 450.000000, 3450.000000, 0, '2025-04-22 04:02:15'],
  [17, 3, 1, 0, '2025-04-22', 450.000000, 3900.000000, 0, '2025-04-22 04:02:17'],
  [18, 3, 7, 0, '2025-04-30', 100.000000, 3800.000000, 0, '2025-04-30 01:40:57'],
  [19, 4, 1, 0, '2025-04-30', 0.034722, 500.034722, 0, '2025-04-30 02:42:08'],
  [20, 1, 1, 0, '2025-04-30', 0.002778, 100.002778, 0, '2025-04-30 02:42:08'],
  [22, 1, 1, 0, '2025-05-26', 400.000000, 500.002778, 0, '2025-05-26 10:21:44'],
  [23, 6, 1, 0, '2025-05-26', 400.000000, 400.000000, 0, '2025-05-26 10:21:45'],
  [24, 2, 1, 0, '2025-05-26', 400.000000, 400.000000, 0, '2025-05-26 10:21:45'],
  [25, 1, 1, 0, '2025-06-09', 300.000000, 800.002778, 0, '2025-06-09 10:19:22'],
  [26, 5, 1, 0, '2025-06-09', 20000.000000, 20000.000000, 0, '2025-06-09 11:25:17'],
  [28, 5, 7, 0, '2025-06-10', 100.000000, 19900.000000, 0, '2025-06-10 23:57:58'],
  [29, 2, 1, 0, '2025-06-10', 1600.027778, 2000.027778, 0, '2025-06-10 23:57:58'],
  [34, 5, 1, 0, '2025-06-23', 1000.000000, 21000.000000, 0, '2025-06-23 15:09:46'],
  [35, 5, 7, 0, '2025-06-23', 100.000000, 20900.000000, 0, '2025-06-23 15:09:46'],
  [38, 4, 1, 0, '2025-06-30', 0.034722, 500.069444, 0, '2025-06-30 02:16:39'],
  [39, 6, 1, 0, '2025-06-30', 0.011111, 400.011111, 0, '2025-06-30 02:16:39'],
  [40, 1, 1, 0, '2025-06-30', 0.002778, 800.005556, 0, '2025-06-30 02:16:39'],
  [41, 5, 1, 0, '2025-06-30', 1.472222, 21302.944444, 0, '2025-06-30 02:16:39'],
  [46, 6, 1, 0, '2025-07-31', 0.011111, 400.022222, 0, '2025-07-31 02:02:51'],
  [47, 2, 1, 0, '2025-07-31', 0.000000, 2000.027778, 0, '2025-07-31 02:02:51'],
  [48, 4, 1, 0, '2025-07-31', 0.034722, 500.104166, 0, '2025-07-31 02:02:51'],
  [49, 1, 1, 0, '2025-07-31', 0.002778, 800.008334, 0, '2025-07-31 02:02:51'],
  [50, 5, 1, 0, '2025-07-31', 1000.000000, 22302.944444, 0, '2025-07-31 02:02:51'],
];

for (const t of savingsTxns) {
  await conn.execute(
    `INSERT IGNORE INTO wc_m_savings_account_transaction (id, savings_account_id, transaction_type_enum, is_reversed, transaction_date, amount, running_balance_derived, is_manual, created_date) VALUES (?,?,?,?,?,?,?,?,?)`,
    t
  );
}
console.log(`  ✓ wc_m_savings_account_transaction: ${savingsTxns.length} rows`);

// ─── Load GL Journal Entries ─────────────────────────────────────────────────
console.log("\n→ Loading GL journal entries...");
// (id, account_id, office_id, reversal_id, currency_code, transaction_id, loan_transaction_id,
//  savings_transaction_id, reversed, ref_num, manual_entry, entry_date, type_enum, amount, description, created_date, unique_ref_key)
// From the SQL dump analysis: entries cover savings transactions for WoodCore Savings product
const glEntries = [
  // April 22 - Savings deposits (WC Savings product_id=2, account_id=19=WCSavings Control Liability, account_id=27=WCSavings Interest on Savings Expense)
  // Entry 7: Debit to WCSavings Interest Expense (account 27), transaction_id=25A86640...
  [7, 27, 1, null, 'NGN', '25A86640-0ECD-42CB-BDD7-80239B340987', null, null, 0, 'test-sms-event-001', 1, '2025-04-22', 2, 500.000000, 'tar', '2025-04-22 02:08:45', null],
  // Entry 8: Credit to WCSavings Control (account 19), transaction_id=25A86640...
  [8, 19, 1, null, 'NGN', '25A86640-0ECD-42CB-BDD7-80239B340987', null, 6, 0, 'test-sms-event-001', 0, '2025-04-22', 1, 500.000000, null, '2025-04-22 02:08:45', null],
  // Entry 9: Debit accrual (account 27 - Interest Expense)
  [9, 27, 1, null, 'NGN', 'A8814027216', null, null, 0, 'f7dca507-22da-4389-b6d2-1ae5532eb3c9', 0, '2025-04-22', 1, 0.034722, 'DAILY ACCURAL FOR /QA Test 000000004/ 2025-04-22', '2025-04-22 01:11:36', null],
  // Entry 10: Credit (account 20 - WCSavings Interest Payable)
  [10, 20, 1, null, 'NGN', 'A8814027216', null, null, 0, 'f7dca507-22da-4389-b6d2-1ae5532eb3c9', 0, '2025-04-22', 2, 0.034722, 'DAILY ACCURAL FOR /QA Test 000000004/ 2025-04-22', '2025-04-22 01:11:36', null],
  // Entry 11: Debit (account 27)
  [11, 27, 1, null, 'NGN', '638210AA-80D4-4234-8284-4C90D95E0E86', null, null, 0, 'test-sms-002', 1, '2025-04-22', 2, 1000.000000, 'tar', '2025-04-22 02:11:49', null],
  // Entry 12: Credit (account 19 - WCSavings Control)
  [12, 19, 1, null, 'NGN', '638210AA-80D4-4234-8284-4C90D95E0E86', null, 7, 0, 'test-sms-002', 0, '2025-04-22', 1, 1000.000000, null, '2025-04-22 02:11:49', null],
  // Entry 13: Debit (account 27)
  [13, 27, 1, null, 'NGN', '72ABE382-1BE6-4190-8902-3DEFF91281B1', null, null, 0, 'SMS-TEST-003', 1, '2025-04-22', 2, 200.000000, 'tar', '2025-04-22 02:22:26', null],
  // Entry 14: Credit (account 19)
  [14, 19, 1, null, 'NGN', '72ABE382-1BE6-4190-8902-3DEFF91281B1', null, 8, 0, 'SMS-TEST-003', 0, '2025-04-22', 1, 200.000000, null, '2025-04-22 02:22:26', null],
  // Entry 15: Debit (account 27)
  [15, 27, 1, null, 'NGN', '804E9479-1FC0-4047-BEC8-A078ED197B95', null, null, 0, 'SMS-TEST-004', 1, '2025-04-22', 2, 150.000000, 'tar', '2025-04-22 02:43:06', null],
  // Entry 16: Credit (account 19)
  [16, 19, 1, null, 'NGN', '804E9479-1FC0-4047-BEC8-A078ED197B95', null, 9, 0, 'SMS-TEST-004', 0, '2025-04-22', 1, 150.000000, null, '2025-04-22 02:43:06', null],
  // Entry 17: Debit (account 27)
  [17, 27, 1, null, 'NGN', '97073938-3163-4E4D-8F72-454A1FB45C9C', null, null, 0, 'SMS-TEST-005', 1, '2025-04-22', 2, 100.000000, 'tar', '2025-04-22 03:04:02', null],
  // Entry 18: Credit (account 19)
  [18, 19, 1, null, 'NGN', '97073938-3163-4E4D-8F72-454A1FB45C9C', null, 10, 0, 'SMS-TEST-005', 0, '2025-04-22', 1, 100.000000, null, '2025-04-22 03:04:02', null],
  // Entry 19: Debit (account 27)
  [19, 27, 1, null, 'NGN', 'D2B2ACC3-FDAA-4753-8CD1-90E29A3260F9', null, null, 0, 'SMS-TEST-006', 1, '2025-04-22', 2, 250.000000, 'tar', '2025-04-22 03:20:18', null],
  // Entry 20: Credit (account 19)
  [20, 19, 1, null, 'NGN', 'D2B2ACC3-FDAA-4753-8CD1-90E29A3260F9', null, 11, 0, 'SMS-TEST-006', 0, '2025-04-22', 1, 250.000000, null, '2025-04-22 03:20:18', null],
  // Entry 21: Debit (account 19 - withdrawal)
  [21, 19, 1, null, 'NGN', '4910C3D7-6A88-415C-90CD-FA569BE15684', null, null, 0, 'SMS-TEST-007', 1, '2025-04-22', 2, 150.000000, 'tar', '2025-04-22 03:23:52', null],
  // Entry 22: Credit (account 27)
  [22, 27, 1, null, 'NGN', '4910C3D7-6A88-415C-90CD-FA569BE15684', null, 12, 0, 'SMS-TEST-007', 0, '2025-04-22', 1, 150.000000, null, '2025-04-22 03:23:52', null],
  // Entry 23: Debit (account 27)
  [23, 27, 1, null, 'NGN', '8DF5CE3E-CB53-4539-A885-348438BFF1B7', null, null, 0, 'SMS-TEST-008', 1, '2025-04-22', 2, 500.000000, 'tar', '2025-04-22 03:52:39', null],
  // Entry 24: Credit (account 19)
  [24, 19, 1, null, 'NGN', '8DF5CE3E-CB53-4539-A885-348438BFF1B7', null, 13, 0, 'SMS-TEST-008', 0, '2025-04-22', 1, 500.000000, null, '2025-04-22 03:52:39', null],
  // Entry 25: Debit (account 19 - withdrawal)
  [25, 19, 1, null, 'NGN', '31C752AA-54EF-44AF-8403-96ED21749553', null, null, 0, 'SMS-TEST-009', 1, '2025-04-22', 2, 400.000000, 'tar', '2025-04-22 03:56:12', null],
  // Entry 26: Credit (account 27)
  [26, 27, 1, null, 'NGN', '31C752AA-54EF-44AF-8403-96ED21749553', null, 14, 0, 'SMS-TEST-009', 0, '2025-04-22', 1, 400.000000, null, '2025-04-22 03:56:12', null],
  // Entry 27: Debit (account 19 - withdrawal)
  [27, 19, 1, null, 'NGN', '036022B0-C839-479E-9144-85987C8940CF', null, null, 0, 'SMS-TEST-010', 1, '2025-04-22', 2, 150.000000, 'tar', '2025-04-22 04:01:33', null],
  // Entry 28: Credit (account 27)
  [28, 27, 1, null, 'NGN', '036022B0-C839-479E-9144-85987C8940CF', null, 15, 0, 'SMS-TEST-010', 0, '2025-04-22', 1, 150.000000, null, '2025-04-22 04:01:33', null],
  // Entry 29: Debit (account 27)
  [29, 27, 1, null, 'NGN', '31C7D93C-F21A-433D-BE65-00CD18E96276', null, null, 0, 'SMS-TEST-011', 1, '2025-04-22', 2, 450.000000, 'tar', '2025-04-22 04:02:15', null],
  // Entry 30: Credit (account 19)
  [30, 19, 1, null, 'NGN', '31C7D93C-F21A-433D-BE65-00CD18E96276', null, 16, 0, 'SMS-TEST-011', 0, '2025-04-22', 1, 450.000000, null, '2025-04-22 04:02:15', null],
  // Entry 31: Debit (account 27)
  [31, 27, 1, null, 'NGN', 'B701CF11-A156-4766-B3A1-A7B3429AD269', null, null, 0, 'SMS-TEST-012', 1, '2025-04-22', 2, 450.000000, 'tar', '2025-04-22 04:02:17', null],
  // Entry 32: Credit (account 19)
  [32, 19, 1, null, 'NGN', 'B701CF11-A156-4766-B3A1-A7B3429AD269', null, 17, 0, 'SMS-TEST-012', 0, '2025-04-22', 1, 450.000000, null, '2025-04-22 04:02:17', null],
  // April 30 - Interest accrual postings
  [33, 27, 1, null, 'NGN', '87AB8F60-A3B4-4879-9A22-DD54099BE01F', null, null, 0, 'INT-APR-001', 0, '2025-04-30', 2, 0.034722, 'Interest accrual Apr 30 - Account 000000004', '2025-04-30 02:42:08', null],
  [34, 20, 1, null, 'NGN', '87AB8F60-A3B4-4879-9A22-DD54099BE01F', null, null, 0, 'INT-APR-001', 0, '2025-04-30', 1, 0.034722, 'Interest accrual Apr 30 - Account 000000004', '2025-04-30 02:42:08', null],
  [35, 27, 1, null, 'NGN', 'F09A123B-87C4-45A7-8B38-014F280F4C99', null, null, 0, 'INT-APR-002', 0, '2025-04-30', 2, 0.002778, 'Interest accrual Apr 30 - Account 000000001', '2025-04-30 02:42:09', null],
  [36, 20, 1, null, 'NGN', 'F09A123B-87C4-45A7-8B38-014F280F4C99', null, null, 0, 'INT-APR-002', 0, '2025-04-30', 1, 0.002778, 'Interest accrual Apr 30 - Account 000000001', '2025-04-30 02:42:09', null],
  // May 26 - Deposits
  [37, 27, 1, null, 'NGN', '68B7BBD5-7AF6-4F2C-9EFD-74176A1206DB', null, null, 0, 'DEP-MAY-001', 0, '2025-05-26', 2, 400.000000, 'Deposit - Account 000000001', '2025-05-26 10:21:44', null],
  [38, 19, 1, null, 'NGN', '68B7BBD5-7AF6-4F2C-9EFD-74176A1206DB', null, 22, 0, 'DEP-MAY-001', 0, '2025-05-26', 1, 400.000000, 'Deposit - Account 000000001', '2025-05-26 10:21:44', null],
  [39, 27, 1, null, 'NGN', '9A3CD28B-10C8-4BB2-843E-DD9873DA89DC', null, null, 0, 'DEP-MAY-002', 0, '2025-05-26', 2, 400.000000, 'Deposit - Account 000000002', '2025-05-26 10:21:45', null],
  [40, 19, 1, null, 'NGN', '9A3CD28B-10C8-4BB2-843E-DD9873DA89DC', null, 24, 0, 'DEP-MAY-002', 0, '2025-05-26', 1, 400.000000, 'Deposit - Account 000000002', '2025-05-26 10:21:45', null],
  // June 9 - Deposits
  [41, 27, 1, null, 'NGN', '72F81BBC-A5E7-43DA-BD76-2CD180BBB587', null, null, 0, 'DEP-JUN-001', 0, '2025-06-09', 2, 300.000000, 'Deposit - Account 000000001', '2025-06-09 10:19:22', null],
  [42, 19, 1, null, 'NGN', '72F81BBC-A5E7-43DA-BD76-2CD180BBB587', null, 25, 0, 'DEP-JUN-001', 0, '2025-06-09', 1, 300.000000, 'Deposit - Account 000000001', '2025-06-09 10:19:22', null],
  // June 10 - Charge payment (manual entry - this will be an exception)
  [43, 23, 1, null, 'NGN', '57BC2F9C-5B9B-40E6-B7EC-C35C9AC4DA6A', null, null, 0, 'CHG-JUN-001', 1, '2025-06-10', 2, 100.000000, 'Manual charge posting - Account 0000000051', '2025-06-10 23:57:58', null],
  [44, 19, 1, null, 'NGN', '57BC2F9C-5B9B-40E6-B7EC-C35C9AC4DA6A', null, 28, 0, 'CHG-JUN-001', 0, '2025-06-10', 1, 100.000000, 'Charge payment - Account 0000000051', '2025-06-10 23:57:58', null],
  // June 10 - Deposit Account 000000002
  [45, 27, 1, null, 'NGN', 'DEP-002-JUN10', null, null, 0, 'DEP-JUN-002', 0, '2025-06-10', 2, 1600.027778, 'Deposit - Account 000000002', '2025-06-10 23:57:58', null],
  [46, 19, 1, null, 'NGN', 'DEP-002-JUN10', null, 29, 0, 'DEP-JUN-002', 0, '2025-06-10', 1, 1600.027778, 'Deposit - Account 000000002', '2025-06-10 23:57:58', null],
  // June 23 - Deposit + charge
  [47, 27, 1, null, 'NGN', '4AA1A806-3323-4BC1-BE6B-288252E24570', null, null, 0, 'DEP-JUN-003', 0, '2025-06-23', 2, 1000.000000, 'Deposit - Account 0000000051', '2025-06-23 15:09:46', null],
  [48, 19, 1, null, 'NGN', '4AA1A806-3323-4BC1-BE6B-288252E24570', null, 34, 0, 'DEP-JUN-003', 0, '2025-06-23', 1, 1000.000000, 'Deposit - Account 0000000051', '2025-06-23 15:09:46', null],
  // June 30 - Interest postings
  [49, 27, 1, null, 'NGN', '110A7448-3EEB-47A0-A855-5B71DF124F12', null, null, 0, 'INT-JUN-001', 0, '2025-06-30', 2, 0.002778, 'Interest posting - Account 000000001', '2025-06-30 02:16:39', null],
  [50, 20, 1, null, 'NGN', '110A7448-3EEB-47A0-A855-5B71DF124F12', null, null, 0, 'INT-JUN-001', 0, '2025-06-30', 1, 0.002778, 'Interest posting - Account 000000001', '2025-06-30 02:16:39', null],
  [51, 27, 1, null, 'NGN', '4164F9C9-CF7F-402E-A064-54F7AE4478FA', null, null, 0, 'INT-JUN-002', 0, '2025-06-30', 2, 1.472222, 'Interest posting - Account 0000000051', '2025-06-30 02:16:39', null],
  [52, 20, 1, null, 'NGN', '4164F9C9-CF7F-402E-A064-54F7AE4478FA', null, null, 0, 'INT-JUN-002', 0, '2025-06-30', 1, 1.472222, 'Interest posting - Account 0000000051', '2025-06-30 02:16:39', null],
  [53, 27, 1, null, 'NGN', '5D6C7CCC-1CAA-4D61-BFFF-D062CE053E58', null, null, 0, 'INT-JUN-003', 0, '2025-06-30', 2, 0.034722, 'Interest posting - Account 000000004', '2025-06-30 02:16:39', null],
  [54, 20, 1, null, 'NGN', '5D6C7CCC-1CAA-4D61-BFFF-D062CE053E58', null, null, 0, 'INT-JUN-003', 0, '2025-06-30', 1, 0.034722, 'Interest posting - Account 000000004', '2025-06-30 02:16:39', null],
  [55, 27, 1, null, 'NGN', '6638848A-A439-46FB-8632-B32CCDEEA8D4', null, null, 0, 'INT-JUN-004', 0, '2025-06-30', 2, 0.011111, 'Interest posting - Account 000000006', '2025-06-30 02:16:39', null],
  [56, 20, 1, null, 'NGN', '6638848A-A439-46FB-8632-B32CCDEEA8D4', null, null, 0, 'INT-JUN-004', 0, '2025-06-30', 1, 0.011111, 'Interest posting - Account 000000006', '2025-06-30 02:16:39', null],
  // July 31 - Interest postings
  [57, 27, 1, null, 'NGN', 'C610B40F-3C0F-417C-8A28-E5BBA863E45C', null, null, 0, 'INT-JUL-001', 0, '2025-07-31', 2, 0.011111, 'Interest posting - Account 000000006', '2025-07-31 02:02:51', null],
  [58, 20, 1, null, 'NGN', 'C610B40F-3C0F-417C-8A28-E5BBA863E45C', null, null, 0, 'INT-JUL-001', 0, '2025-07-31', 1, 0.011111, 'Interest posting - Account 000000006', '2025-07-31 02:02:51', null],
  [59, 27, 1, null, 'NGN', '880C786F-2E1B-4156-AA3A-C43859FEB23B', null, null, 0, 'INT-JUL-002', 0, '2025-07-31', 2, 0.000000, 'Interest posting - Account 000000002', '2025-07-31 02:02:51', null],
  [60, 20, 1, null, 'NGN', '880C786F-2E1B-4156-AA3A-C43859FEB23B', null, null, 0, 'INT-JUL-002', 0, '2025-07-31', 1, 0.000000, 'Interest posting - Account 000000002', '2025-07-31 02:02:51', null],
  [61, 27, 1, null, 'NGN', '7EBE8648-0943-4152-898F-6C78CA08603E', null, null, 0, 'INT-JUL-003', 0, '2025-07-31', 2, 1000.000000, 'Deposit - Account 0000000051', '2025-07-31 02:02:51', null],
  [62, 19, 1, null, 'NGN', '7EBE8648-0943-4152-898F-6C78CA08603E', null, 50, 0, 'INT-JUL-003', 0, '2025-07-31', 1, 1000.000000, 'Deposit - Account 0000000051', '2025-07-31 02:02:51', null],
  [63, 27, 1, null, 'NGN', '139A73FB-F927-448D-94B6-4C78A2EC212D', null, null, 0, 'INT-JUL-004', 0, '2025-07-31', 2, 0.034722, 'Interest posting - Account 000000004', '2025-07-31 02:02:51', null],
  [64, 20, 1, null, 'NGN', '139A73FB-F927-448D-94B6-4C78A2EC212D', null, null, 0, 'INT-JUL-004', 0, '2025-07-31', 1, 0.034722, 'Interest posting - Account 000000004', '2025-07-31 02:02:51', null],
  [65, 27, 1, null, 'NGN', '3E45723F-D4F2-4FE7-85F4-1AD7F8B7313F', null, null, 0, 'INT-JUL-005', 0, '2025-07-31', 2, 0.002778, 'Interest posting - Account 000000001', '2025-07-31 02:02:51', null],
  [66, 20, 1, null, 'NGN', '3E45723F-D4F2-4FE7-85F4-1AD7F8B7313F', null, null, 0, 'INT-JUL-005', 0, '2025-07-31', 1, 0.002778, 'Interest posting - Account 000000001', '2025-07-31 02:02:51', null],
  // ANOMALOUS ENTRY: Manual posting to WCSavings Control (account 19) with no bridge linkage
  // This simulates a cross-product misposting from a different product
  [67, 19, 1, null, 'NGN', 'MANUAL-XPROD-001', null, null, 0, 'MAN-001', 1, '2025-06-15', 1, 2000.000000, 'Manual adjustment - cross-product entry', '2025-06-15 14:30:00', 'MANUAL-XPROD-001'],
  // ANOMALOUS ENTRY: Orphaned entry - no bridge table linkage
  [68, 19, 1, null, 'NGN', 'ORPHAN-001', null, null, 0, 'ORP-001', 0, '2025-05-15', 2, 750.000000, 'System posting - no linked transaction', '2025-05-15 09:00:00', 'ORPHAN-001'],
];

for (const e of glEntries) {
  await conn.execute(
    `INSERT IGNORE INTO wc_acc_gl_journal_entry (id, account_id, office_id, reversal_id, currency_code, transaction_id, loan_transaction_id, savings_transaction_id, reversed, ref_num, manual_entry, entry_date, type_enum, amount, description, created_date, unique_ref_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    e
  );
}
console.log(`  ✓ wc_acc_gl_journal_entry: ${glEntries.length} rows`);

// ─── Load Bridge Tables ──────────────────────────────────────────────────────
console.log("\n→ Loading bridge tables...");
// acc_to_gl_journal_entry: (id, transaction_id, reversed_transaction_id, reversed)
const bridgeEntries = [
  [1, '25A86640-0ECD-42CB-BDD7-80239B340987', null, 0],
  [2, '638210AA-80D4-4234-8284-4C90D95E0E86', null, 0],
  [3, '72ABE382-1BE6-4190-8902-3DEFF91281B1', null, 0],
  [4, '804E9479-1FC0-4047-BEC8-A078ED197B95', null, 0],
  [5, '97073938-3163-4E4D-8F72-454A1FB45C9C', null, 0],
  [6, 'D2B2ACC3-FDAA-4753-8CD1-90E29A3260F9', null, 0],
  [7, '4910C3D7-6A88-415C-90CD-FA569BE15684', null, 0],
  [8, '8DF5CE3E-CB53-4539-A885-348438BFF1B7', null, 0],
  [9, '31C752AA-54EF-44AF-8403-96ED21749553', null, 0],
  [10, '036022B0-C839-479E-9144-85987C8940CF', null, 0],
  [11, '31C7D93C-F21A-433D-BE65-00CD18E96276', null, 0],
  [12, 'B701CF11-A156-4766-B3A1-A7B3429AD269', null, 0],
  [13, '87AB8F60-A3B4-4879-9A22-DD54099BE01F', null, 0],
  [14, 'F09A123B-87C4-45A7-8B38-014F280F4C99', null, 0],
  [15, '68B7BBD5-7AF6-4F2C-9EFD-74176A1206DB', null, 0],
  [16, '9A3CD28B-10C8-4BB2-843E-DD9873DA89DC', null, 0],
  [17, 'E42499E0-0E68-4D43-BEC4-24570EF16C01', null, 0],
  [18, '72F81BBC-A5E7-43DA-BD76-2CD180BBB587', null, 0],
  [22, '57BC2F9C-5B9B-40E6-B7EC-C35C9AC4DA6A', null, 0],
  [23, 'DEP-002-JUN10', null, 0],
  [25, '4AA1A806-3323-4BC1-BE6B-288252E24570', null, 0],
  [26, '110A7448-3EEB-47A0-A855-5B71DF124F12', null, 0],
  [27, '4164F9C9-CF7F-402E-A064-54F7AE4478FA', null, 0],
  [28, '5D6C7CCC-1CAA-4D61-BFFF-D062CE053E58', null, 0],
  [29, '6638848A-A439-46FB-8632-B32CCDEEA8D4', null, 0],
  [30, 'C610B40F-3C0F-417C-8A28-E5BBA863E45C', null, 0],
  [31, '880C786F-2E1B-4156-AA3A-C43859FEB23B', null, 0],
  [32, '7EBE8648-0943-4152-898F-6C78CA08603E', null, 0],
  [33, '139A73FB-F927-448D-94B6-4C78A2EC212D', null, 0],
  [34, '3E45723F-D4F2-4FE7-85F4-1AD7F8B7313F', null, 0],
];

for (const b of bridgeEntries) {
  await conn.execute(
    `INSERT IGNORE INTO wc_acc_to_gl_journal_entry (id, transaction_id, reversed_transaction_id, reversed) VALUES (?,?,?,?)`,
    b
  );
}
console.log(`  ✓ wc_acc_to_gl_journal_entry: ${bridgeEntries.length} rows`);

// acc_to_gl_journal_entry_savings: (id, acc_to_gl_transaction_id, savings_id, savings_transaction_id, reversed)
const bridgeSavings = [
  [1, 1, 4, 6, 0],
  [2, 2, 3, 7, 0],
  [3, 3, 3, 8, 0],
  [4, 4, 3, 9, 0],
  [5, 5, 3, 10, 0],
  [6, 6, 3, 11, 0],
  [7, 7, 3, 12, 0],
  [8, 8, 3, 13, 0],
  [9, 9, 3, 14, 0],
  [10, 10, 3, 15, 0],
  [11, 11, 3, 16, 0],
  [12, 12, 3, 17, 0],
  [13, 13, 4, 19, 0],
  [14, 14, 1, 20, 0],
  [15, 15, 1, 22, 0],
  [16, 16, 6, 23, 0],
  [17, 17, 2, 24, 0],  // Account 2 (product_id=2 ✓)
  [18, 18, 1, 25, 0],
  [19, 22, 2, 29, 0],  // Account 2 (product_id=2 ✓)
  [20, 23, 2, 29, 0],  // DEP-002-JUN10
  [21, 25, 5, 34, 0],
  [22, 25, 5, 35, 0],
  [23, 28, 4, 38, 0],
  [24, 26, 6, 39, 0],  // Account 6 (product_id=1, USD - CROSS-PRODUCT for NGN reconciliation!)
  [25, 27, 5, 41, 0],
  [26, 31, 2, 47, 0],
  [27, 32, 5, 50, 0],
  [28, 33, 4, 48, 0],
  [29, 30, 6, 46, 0],  // Account 6 (product_id=1, USD - CROSS-PRODUCT!)
  [30, 34, 1, 49, 0],
];

for (const b of bridgeSavings) {
  await conn.execute(
    `INSERT IGNORE INTO wc_acc_to_gl_journal_entry_savings (id, acc_to_gl_transaction_id, savings_id, savings_transaction_id, reversed) VALUES (?,?,?,?,?)`,
    b
  );
}
console.log(`  ✓ wc_acc_to_gl_journal_entry_savings: ${bridgeSavings.length} rows`);

// ─── Final counts ────────────────────────────────────────────────────────────
console.log("\n=== FINAL RECORD COUNTS ===");
const checkTables = [
  "wc_acc_gl_account", "wc_acc_product_mapping", "wc_acc_gl_journal_entry",
  "wc_acc_to_gl_journal_entry", "wc_acc_to_gl_journal_entry_savings",
  "wc_m_savings_product", "wc_m_savings_account", "wc_m_savings_account_transaction",
];
for (const t of checkTables) {
  const [rows] = await conn.execute(`SELECT COUNT(*) as c FROM ${t}`);
  console.log(`  ${t}: ${rows[0].c} rows`);
}

await conn.end();
console.log("\n✓ Woodcore POC data loaded successfully");
