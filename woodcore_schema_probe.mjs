import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({
  host: '203.123.87.130', port: 3306, user: 'reconcileai',
  password: '123ReconK#7v!mQ9$zW2', database: 'fineract_default',
});
const [cols] = await conn.query('DESCRIBE acc_gl_journal_entry');
console.log('acc_gl_journal_entry:', cols.map(c => c.Field).join(', '));
const [cols2] = await conn.query('DESCRIBE m_savings_account_transaction');
console.log('m_savings_account_transaction:', cols2.map(c => c.Field).join(', '));
await conn.end();
process.exit(0);
