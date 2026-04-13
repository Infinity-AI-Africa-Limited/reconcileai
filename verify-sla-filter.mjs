import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
dotenv.config();

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Simulate the updated SLA monitor filter
const [allJobs] = await conn.execute('SELECT id, name FROM reconciliation_jobs');

const demoJobIds = allJobs
  .filter(j => {
    if (!j.name) return false;
    if (j.name.includes('Demo') || j.name.includes('demo')) return true;
    if (j.name.includes('vs CBS GL')) return true;
    if (j.name.includes('BrightGoods') || j.name.includes('Demo Reconciliation')) return true;
    return false;
  })
  .map(j => j.id);

console.log('Demo job IDs excluded:', demoJobIds.length, demoJobIds);

const [openExceptions] = await conn.execute(
  `SELECT id, jobId FROM exceptions WHERE status IN ('open','in_review')`
);

const demoSet = new Set(demoJobIds);
const realExceptions = openExceptions.filter(e => demoSet.has(e.jobId) === false);

console.log('Total open exceptions:', openExceptions.length);
console.log('Real (non-demo) open exceptions:', realExceptions.length);

if (realExceptions.length > 0) {
  realExceptions.forEach(e => console.log('  Real exception:', e.id, 'jobId:', e.jobId));
} else {
  console.log('✅ SLA monitor will report 0 breaches — all open exceptions are demo data.');
}

await conn.end();
