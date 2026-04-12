/**
 * ReconcileAI — Fix Match Rates Script
 * Updates reconciliation jobs to reflect 90–95% match rates
 * and adds additional GL transactions to support proper matching.
 *
 * Run: node seed-fix-matchrates.mjs
 */

import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomAmount(min, max) { return (Math.random() * (max - min) + min).toFixed(2); }
function randomDate(start, end) { return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime())); }

function nipSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${String(randInt(100000,999999))}`;
}
function accountNumber() { return String(randInt(1000000000, 9999999999)); }

const NIGERIAN_BANKS = [
  "GTBank", "Access Bank", "Zenith Bank", "UBA", "First Bank",
  "Fidelity Bank", "Union Bank", "Sterling Bank", "Wema Bank", "Stanbic IBTC"
];

const GL_ACCOUNTS = [
  "1001-NOSTRO", "1002-SETTLEMENT", "2001-CUSTOMER-LIAB",
  "3001-INCOME", "4001-EXPENSE", "5001-SUSPENSE"
];

async function fix() {
  const conn = await mysql.createConnection(DB_URL);
  console.log("✅ Connected to database");

  try {
    // Get org and admin
    const [orgs] = await conn.execute("SELECT id FROM organizations WHERE code = 'GLOBUS_DEMO' LIMIT 1");
    if (!orgs.length) { console.error("No demo org found"); process.exit(1); }
    const orgId = orgs[0].id;

    const [admins] = await conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    const adminUserId = admins[0].id;

    // Get all channels
    const [channels] = await conn.execute(
      "SELECT id, code, name FROM channels WHERE organizationId = ?", [orgId]
    );
    const channelMap = {};
    channels.forEach(c => { channelMap[c.code] = c.id; });
    console.log("Channels found:", Object.keys(channelMap).join(", "));

    const glChannelId = channelMap["BANK_CORE_GL"];
    if (!glChannelId) { console.error("GL channel not found"); process.exit(1); }

    // Get source channel transaction counts
    const sourceChannels = [
      "NIBSS_NIP", "POS_INTERSWITCH", "CARD_PAYMENTS", "USSD_CHANNEL",
      "AGENT_MONIEPOINT", "MOBILE_MONEY_OPAY", "MOBILE_BANKING_GTB"
    ];

    const dateStart = new Date("2026-03-01T00:00:00Z");
    const dateEnd   = new Date("2026-04-10T23:59:59Z");

    // For each source channel, get transaction count and update the job
    for (const srcCode of sourceChannels) {
      const srcId = channelMap[srcCode];
      if (!srcId) { console.log(`  ⚠️  Channel ${srcCode} not found, skipping`); continue; }

      // Get all source transactions
      const [srcTxns] = await conn.execute(
        "SELECT id, amount FROM transactions WHERE channelId = ? AND organizationId = ? ORDER BY id ASC",
        [srcId, orgId]
      );

      const totalSrc = srcTxns.length;
      if (totalSrc === 0) { console.log(`  ⚠️  No transactions for ${srcCode}`); continue; }

      // Target match rate: 90–95%
      const targetMatchRate = 0.90 + Math.random() * 0.05; // 90–95%
      const matchCount = Math.round(totalSrc * targetMatchRate);
      const exceptionCount = Math.round(totalSrc * 0.03); // 3% exceptions
      const unmatchedCount = totalSrc - matchCount - exceptionCount;

      // Get or create GL transactions to match against
      const [glTxns] = await conn.execute(
        "SELECT id FROM transactions WHERE channelId = ? AND organizationId = ? ORDER BY id ASC",
        [glChannelId, orgId]
      );

      // We need at least matchCount GL transactions
      let glTxnIds = glTxns.map(t => t.id);

      if (glTxnIds.length < matchCount) {
        // Add more GL transactions
        const needed = matchCount - glTxnIds.length;
        console.log(`  📝 Adding ${needed} GL transactions to support ${srcCode} matching...`);

        // Create a batch for the new GL transactions
        const [batchRes] = await conn.execute(
          `INSERT INTO upload_batches (userId, channelId, organizationId, fileName, fileHash, totalRows, validRows, invalidRows, status, createdAt, completedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'completed', NOW(), NOW())`,
          [adminUserId, glChannelId, orgId, `gl_supplement_${srcCode}_${Date.now()}.csv`,
           `${Date.now()}${Math.random()}`.substring(0, 32), needed, needed]
        );
        const batchId = batchRes.insertId;

        // Insert GL transactions in batches of 50
        const BATCH = 50;
        for (let start = 0; start < needed; start += BATCH) {
          const end = Math.min(start + BATCH, needed);
          const vals = [];
          const ph = [];
          for (let i = start; i < end; i++) {
            const txDate = randomDate(dateStart, dateEnd);
            const glRef = `GL${new Date().getFullYear()}${String(randInt(100000,999999))}`;
            const txRef = `TXN${nipSessionId()}`;
            const glAcct = randFrom(GL_ACCOUNTS);
            const amt = srcTxns[i] ? srcTxns[i].amount : randomAmount(5000, 5000000);
            const dc = i % 2 === 0 ? "debit" : "credit";

            vals.push(
              batchId, glChannelId, adminUserId, orgId,
              glRef, txRef,
              `CBS GL Entry | ${glAcct} | Daily Settlement`,
              amt, "NGN", txDate, txDate,
              dc, `GL Account ${glAcct}`,
              0, null, "matched", null,
              JSON.stringify({ glRef, transactionRef: txRef, glAccount: glAcct })
            );
            ph.push("(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
          }

          const [insertRes] = await conn.execute(
            `INSERT INTO transactions (batchId, channelId, userId, organizationId, transactionRef, externalRef, description, amount, currency, transactionDate, valueDate, debitCredit, counterparty, isReversal, originalTransactionRef, status, matchId, rawData)
             VALUES ${ph.join(",")}`,
            vals
          );

          const firstId = insertRes.insertId;
          for (let j = 0; j < (end - start); j++) {
            glTxnIds.push(firstId + j);
          }
        }
        console.log(`  ✅ Added ${needed} GL transactions`);
      }

      // Delete existing job and matches/exceptions for this channel pair
      const [existingJobs] = await conn.execute(
        "SELECT id FROM reconciliation_jobs WHERE sourceChannelId = ? AND targetChannelId = ? AND organizationId = ?",
        [srcId, glChannelId, orgId]
      );

      for (const job of existingJobs) {
        await conn.execute("DELETE FROM matches WHERE jobId = ?", [job.id]);
        await conn.execute("DELETE FROM exceptions WHERE jobId = ?", [job.id]);
        await conn.execute("DELETE FROM reconciliation_jobs WHERE id = ?", [job.id]);
      }

      // Create new reconciliation job with correct match rate
      const matchRatePct = (matchCount / totalSrc * 100).toFixed(2);
      const [jobRes] = await conn.execute(
        `INSERT INTO reconciliation_jobs
           (userId, organizationId, moduleType, name, sourceChannelId, targetChannelId,
            dateFrom, dateTo, amountTolerance, dateWindowDays, status,
            totalSourceTxns, totalTargetTxns, matchedCount, exceptionCount, unmatchedCount,
            matchRate, processingTimeMs, startedAt, completedAt, createdAt)
         VALUES (?, ?, 'transaction_integrity', ?, ?, ?, ?, ?, 0.005, 3, 'completed',
                 ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
        [
          adminUserId, orgId,
          `${srcCode} vs CBS GL — April 2026`,
          srcId, glChannelId,
          dateStart, dateEnd,
          totalSrc, glTxnIds.length,
          matchCount, exceptionCount, unmatchedCount,
          matchRatePct,
          randInt(1200, 8500),
        ]
      );
      const jobId = jobRes.insertId;

      // Update source transactions: matched ones → status = 'matched', rest → 'exception' or 'unmatched'
      const matchedTxnIds = srcTxns.slice(0, matchCount).map(t => t.id);
      const exceptionTxnIds = srcTxns.slice(matchCount, matchCount + exceptionCount).map(t => t.id);
      const unmatchedTxnIds = srcTxns.slice(matchCount + exceptionCount).map(t => t.id);

      if (matchedTxnIds.length > 0) {
        await conn.execute(
          `UPDATE transactions SET status = 'matched' WHERE id IN (${matchedTxnIds.join(",")}) AND organizationId = ?`,
          [orgId]
        );
      }
      if (exceptionTxnIds.length > 0) {
        await conn.execute(
          `UPDATE transactions SET status = 'exception' WHERE id IN (${exceptionTxnIds.join(",")}) AND organizationId = ?`,
          [orgId]
        );
      }
      if (unmatchedTxnIds.length > 0) {
        await conn.execute(
          `UPDATE transactions SET status = 'unmatched' WHERE id IN (${unmatchedTxnIds.join(",")}) AND organizationId = ?`,
          [orgId]
        );
      }

      // Insert match records
      const matchTypes = ["exact", "exact", "exact", "fuzzy", "amount_tolerance", "date_window"];
      const MBATCH = 50;
      for (let i = 0; i < matchCount; i += MBATCH) {
        const end = Math.min(i + MBATCH, matchCount);
        const vals = [];
        const ph = [];
        for (let j = i; j < end; j++) {
          const srcTxnId = matchedTxnIds[j];
          const tgtTxnId = glTxnIds[j % glTxnIds.length];
          const mType = randFrom(matchTypes);
          const confidence = mType === "exact" ? "100.00" : (85 + Math.random() * 14).toFixed(2);
          const amtDiff = mType === "exact" ? "0.00" : (Math.random() * 50).toFixed(2);
          const dateDiff = mType === "date_window" ? randInt(1, 3) : 0;
          vals.push(
            jobId, srcTxnId, tgtTxnId, mType, confidence, amtDiff, dateDiff,
            `${mType === "exact" ? "Exact reference match" : "Fuzzy match on amount + date window"} — ${srcCode}`,
            "confirmed"
          );
          ph.push("(?,?,?,?,?,?,?,?,?)");
        }
        await conn.execute(
          `INSERT INTO matches (jobId, sourceTransactionId, targetTransactionId, matchType, confidenceScore, amountDifference, dateDifference, matchReason, status)
           VALUES ${ph.join(",")}`,
          vals
        );
      }

      // Insert exceptions
      const exceptionTypes = [
        ["amount_mismatch", "Amount in source differs from CBS GL by more than tolerance threshold"],
        ["missing_counterparty", "Counterparty account not found in CBS customer master"],
        ["timing_difference", "Transaction date falls outside 3-day settlement window"],
        ["duplicate_transaction", "Duplicate reference detected — possible double-posting"],
        ["format_error", "Reference format does not match expected pattern"],
      ];

      for (let i = 0; i < exceptionTxnIds.length; i++) {
        const [etype, edesc] = randFrom(exceptionTypes);
        const severity = randFrom(["low", "medium", "high"]);
        await conn.execute(
          `INSERT INTO exceptions (jobId, transactionId, category, severity, description, suggestedResolution, status, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, 'open', NOW())`,
          [jobId, exceptionTxnIds[i], etype, severity, edesc,
           `Review ${etype.replace(/_/g," ")} and verify against CBS GL entry`]
        );
      }

      console.log(`  ✅ ${srcCode}: ${totalSrc} txns | Matched: ${matchCount} (${matchRatePct}%) | Exceptions: ${exceptionCount} | Unmatched: ${unmatchedCount}`);
    }

    // Final summary
    console.log("\n🎉 Match rate fix complete!");
    const [summary] = await conn.execute(
      `SELECT sourceChannelId, matchRate, matchedCount, totalSourceTxns, exceptionCount
       FROM reconciliation_jobs WHERE organizationId = ? ORDER BY id DESC`,
      [orgId]
    );
    console.log("\nFinal match rates:");
    for (const row of summary) {
      const ch = channels.find(c => c.id === row.sourceChannelId);
      console.log(`  ${ch ? ch.code : row.sourceChannelId}: ${row.matchRate}% (${row.matchedCount}/${row.totalSourceTxns} matched, ${row.exceptionCount} exceptions)`);
    }

  } catch (err) {
    console.error("❌ Error:", err);
    throw err;
  } finally {
    await conn.end();
  }
}

fix().catch((e) => { console.error(e); process.exit(1); });
