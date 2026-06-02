import mysql from 'mysql2/promise';

const config = {
  host: '203.123.87.130',
  port: 3306,
  user: 'reconcileai',
  password: '123ReconK#7v!mQ9$zW2',
  database: 'fineract_default',
  connectTimeout: 10000,
};

async function run() {
  let conn;
  try {
    console.log('🔌 Connecting to Woodcore at', config.host + ':' + config.port, '...');
    conn = await mysql.createConnection(config);
    console.log('✅ Connected successfully\n');

    // 1. List all tables
    const [tables] = await conn.query('SHOW TABLES');
    const tableNames = tables.map(r => Object.values(r)[0]);
    console.log('📋 Tables accessible (' + tableNames.length + '):');
    tableNames.forEach(t => console.log('   -', t));

    // 2. Row counts for each accessible table
    console.log('\n📊 Row counts:');
    for (const t of tableNames) {
      try {
        const [[{ cnt }]] = await conn.query(`SELECT COUNT(*) AS cnt FROM \`${t}\``);
        console.log(`   ${t.padEnd(50)} ${cnt.toLocaleString()} rows`);
      } catch (e) {
        console.log(`   ${t.padEnd(50)} (no SELECT access)`);
      }
    }

    // 3. Sample from m_loan_transaction (key reconciliation table)
    if (tableNames.includes('m_loan_transaction')) {
      console.log('\n💳 Sample loan transactions (latest 5):');
      const [rows] = await conn.query(
        `SELECT id, loan_id, transaction_type_enum, transaction_date, amount, is_reversed
         FROM m_loan_transaction ORDER BY id DESC LIMIT 5`
      );
      console.table(rows);
    }

    // 4. Sample from m_savings_account_transaction
    if (tableNames.includes('m_savings_account_transaction')) {
      console.log('\n🏦 Sample savings transactions (latest 5):');
      const [rows] = await conn.query(
        `SELECT id, savings_account_id, transaction_type_enum, transaction_date, amount, running_balance_derived
         FROM m_savings_account_transaction ORDER BY id DESC LIMIT 5`
      );
      console.table(rows);
    }

    // 5. Sample GL journal entries
    if (tableNames.includes('acc_gl_journal_entry')) {
      console.log('\n📒 Sample GL journal entries (latest 5):');
      const [rows] = await conn.query(
        `SELECT id, account_id, office_id, type_enum, entry_date, amount, transaction_id
         FROM acc_gl_journal_entry ORDER BY id DESC LIMIT 5`
      );
      console.table(rows);
    }

    console.log('\n✅ Woodcore connection test COMPLETE — DB is accessible and ready for reconciliation ingestion.');
  } catch (err) {
    console.error('\n❌ FAILED:', err.message, '| code:', err.code);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

run();
