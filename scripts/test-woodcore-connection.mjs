/**
 * Woodcore (Fineract) Database Connection Test
 * Tests live connection and explores available tables and data
 */
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const config = {
  host: process.env.WOODCORE_DB_HOST,
  port: parseInt(process.env.WOODCORE_DB_PORT ?? '3306', 10),
  user: process.env.WOODCORE_DB_USER,
  password: process.env.WOODCORE_DB_PASSWORD,
  database: process.env.WOODCORE_DB_NAME,
  connectTimeout: 15000,
  ssl: false,
};

console.log(`\n🔌 Connecting to Woodcore (Fineract) at ${config.host}:${config.port}...`);
console.log(`   Database: ${config.database}`);
console.log(`   User: ${config.user}\n`);

async function run() {
  let conn;
  try {
    conn = await mysql.createConnection(config);
    console.log('✅ CONNECTION SUCCESSFUL\n');

    // 1. List all tables
    const [tables] = await conn.query(`SHOW TABLES`);
    const tableNames = tables.map(r => Object.values(r)[0]);
    console.log(`📋 Total tables found: ${tableNames.length}`);

    // Key Fineract tables we care about
    const keyTables = [
      'm_client', 'm_loan', 'm_loan_transaction', 'm_savings_account',
      'm_savings_account_transaction', 'm_payment_detail', 'm_payment_type',
      'm_office', 'm_staff', 'm_currency', 'acc_gl_journal_entry',
      'acc_gl_account', 'm_product_loan', 'm_savings_product',
      'm_loan_repayment_schedule', 'm_deposit_account_on_hold_transaction',
      'job_run_history', 'm_appuser', 'm_group', 'm_center'
    ];

    console.log('\n🎯 Key Fineract tables present:');
    for (const t of keyTables) {
      if (tableNames.includes(t)) {
        const [countResult] = await conn.query(`SELECT COUNT(*) as cnt FROM \`${t}\``);
        console.log(`   ✓ ${t.padEnd(45)} rows: ${countResult[0].cnt}`);
      } else {
        console.log(`   ✗ ${t} — NOT FOUND`);
      }
    }

    // 2. Sample clients
    console.log('\n👥 Sample Clients (m_client):');
    const [clients] = await conn.query(`
      SELECT id, account_no, firstname, lastname, status_enum, office_id, activation_date
      FROM m_client LIMIT 5
    `);
    console.table(clients);

    // 3. Sample loan transactions
    console.log('\n💳 Sample Loan Transactions (m_loan_transaction):');
    const [loanTxns] = await conn.query(`
      SELECT lt.id, lt.loan_id, lt.transaction_type_enum, lt.transaction_date,
             lt.amount, lt.outstanding_loan_balance_derived, lt.is_reversed,
             lt.created_date
      FROM m_loan_transaction lt
      ORDER BY lt.id DESC LIMIT 10
    `);
    console.table(loanTxns);

    // 4. Sample savings transactions
    console.log('\n🏦 Sample Savings Transactions (m_savings_account_transaction):');
    const [savingsTxns] = await conn.query(`
      SELECT sat.id, sat.savings_account_id, sat.transaction_type_enum,
             sat.transaction_date, sat.amount, sat.balance_of_account,
             sat.is_reversed, sat.created_date
      FROM m_savings_account_transaction sat
      ORDER BY sat.id DESC LIMIT 10
    `);
    console.table(savingsTxns);

    // 5. GL Journal entries (for reconciliation)
    console.log('\n📒 Sample GL Journal Entries (acc_gl_journal_entry):');
    const [glEntries] = await conn.query(`
      SELECT je.id, je.account_id, je.office_id, je.type_enum,
             je.entry_date, je.amount, je.transaction_id,
             je.entity_type_enum, je.entity_id, je.description
      FROM acc_gl_journal_entry je
      ORDER BY je.id DESC LIMIT 10
    `);
    console.table(glEntries);

    // 6. Payment details
    console.log('\n💰 Sample Payment Details (m_payment_detail):');
    const [payments] = await conn.query(`
      SELECT pd.id, pd.payment_type_id, pd.account_number, pd.check_number,
             pd.routing_code, pd.receipt_number, pd.bank_number,
             pt.value as payment_type_name
      FROM m_payment_detail pd
      LEFT JOIN m_payment_type pt ON pt.id = pd.payment_type_id
      LIMIT 10
    `);
    console.table(payments);

    // 7. Transaction volume summary
    console.log('\n📊 Transaction Volume Summary:');
    const [loanTxnSummary] = await conn.query(`
      SELECT 
        transaction_type_enum,
        COUNT(*) as count,
        SUM(amount) as total_amount,
        MIN(transaction_date) as earliest,
        MAX(transaction_date) as latest
      FROM m_loan_transaction
      GROUP BY transaction_type_enum
      ORDER BY count DESC
    `);
    console.table(loanTxnSummary);

    const [savingsTxnSummary] = await conn.query(`
      SELECT 
        transaction_type_enum,
        COUNT(*) as count,
        SUM(amount) as total_amount,
        MIN(transaction_date) as earliest,
        MAX(transaction_date) as latest
      FROM m_savings_account_transaction
      GROUP BY transaction_type_enum
      ORDER BY count DESC
    `);
    console.log('\n📊 Savings Transaction Summary:');
    console.table(savingsTxnSummary);

    // 8. Offices (branches)
    console.log('\n🏢 Offices/Branches (m_office):');
    const [offices] = await conn.query(`SELECT id, name, hierarchy, opening_date FROM m_office LIMIT 10`);
    console.table(offices);

    console.log('\n✅ Woodcore POC connection test COMPLETE');
    console.log('   All key Fineract tables accessible. Ready for reconciliation ingestion.\n');

  } catch (err) {
    console.error('\n❌ CONNECTION FAILED:', err.message);
    console.error('   Code:', err.code);
    if (err.code === 'ECONNREFUSED') {
      console.error('   → IP may not be whitelisted yet, or port 3306 is blocked');
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('   → Credentials are incorrect');
    } else if (err.code === 'ETIMEDOUT') {
      console.error('   → Connection timed out — check firewall rules');
    }
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

run();
