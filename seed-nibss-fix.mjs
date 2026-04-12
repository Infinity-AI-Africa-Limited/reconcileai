/**
 * ReconcileAI — NIBSS NIP Channel Fix
 * Creates a fresh NIBSS NIP channel under org 1 and seeds it at 90–95% match rate.
 * Run: node seed-nibss-fix.mjs
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
function rrn() { return String(randInt(100000000000, 999999999999)); }
function accountNumber() { return String(randInt(1000000000, 9999999999)); }

const NIGERIAN_BANKS = [
  { name: "Guaranty Trust Bank", code: "058", shortName: "GTBank" },
  { name: "Access Bank", code: "044", shortName: "Access" },
  { name: "Zenith Bank", code: "057", shortName: "Zenith" },
  { name: "United Bank for Africa", code: "033", shortName: "UBA" },
  { name: "First Bank of Nigeria", code: "011", shortName: "FirstBank" },
  { name: "Fidelity Bank", code: "070", shortName: "Fidelity" },
  { name: "Globus Bank", code: "103", shortName: "Globus" },
  { name: "Kuda Bank", code: "090267", shortName: "Kuda" },
  { name: "Opay", code: "999992", shortName: "Opay" },
  { name: "Moniepoint MFB", code: "090405", shortName: "Moniepoint" },
];

const GL_ACCOUNTS = ["1001-NOSTRO", "1002-SETTLEMENT", "2001-CUSTOMER-LIAB", "3001-INCOME", "5001-SUSPENSE"];

async function fix() {
  const conn = await mysql.createConnection(DB_URL);
  console.log("✅ Connected to database");

  try {
    const orgId = 1;
    const [admins] = await conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    const adminUserId = admins[0].id;

    // Deactivate the old NIBSS_NIP channel (don't delete — preserve history)
    await conn.execute("UPDATE channels SET isActive = 0, code = 'NIBSS_NIP_LEGACY' WHERE id = 60002");
    console.log("✅ Deactivated legacy NIBSS_NIP channel (id=60002)");

    // Create fresh NIBSS NIP channel
    const [chRes] = await conn.execute(
      `INSERT INTO channels (organizationId, name, code, description, channelType, matchingConfig, fileFormat, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [
        orgId,
        "NIBSS NIP (Instant Payments)",
        "NIBSS_NIP",
        "NIBSS Instant Payment (NIP) — real-time interbank transfers via NIP rails",
        "nibss",
        JSON.stringify({ amountTolerance: 0, dateWindowDays: 1, primaryRef: "nipSessionId", secondaryRef: "rrn" }),
        JSON.stringify({ columns: ["sessionId", "rrn", "amount", "senderBank", "receiverBank", "narration", "transactionDate", "status"] }),
      ]
    );
    const nibssChannelId = chRes.insertId;
    console.log(`✅ Created fresh NIBSS_NIP channel: id=${nibssChannelId}`);

    // Get GL channel
    const [glCh] = await conn.execute("SELECT id FROM channels WHERE code = 'BANK_CORE_GL' AND organizationId = ?", [orgId]);
    if (!glCh.length) { console.error("GL channel not found"); process.exit(1); }
    const glChannelId = glCh[0].id;

    const dateStart = new Date("2026-03-01T00:00:00Z");
    const dateEnd   = new Date("2026-04-10T23:59:59Z");
    const count = 200;

    // Create upload batch
    const [batchRes] = await conn.execute(
      `INSERT INTO upload_batches (userId, channelId, organizationId, fileName, fileHash, totalRows, validRows, invalidRows, status, createdAt, completedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'completed', NOW(), NOW())`,
      [adminUserId, nibssChannelId, orgId, `demo_nibss_nip_${Date.now()}.csv`,
       `nibss${Date.now()}`.substring(0, 32), count, count]
    );
    const batchId = batchRes.insertId;

    // Target 92% match rate
    const matchCount = Math.round(count * 0.92);
    const exceptionCount = Math.round(count * 0.03);
    const unmatchedCount = count - matchCount - exceptionCount;

    // Insert NIP transactions
    const txnIds = [];
    const BATCH = 50;
    for (let start = 0; start < count; start += BATCH) {
      const end = Math.min(start + BATCH, count);
      const vals = [];
      const ph = [];
      for (let i = start; i < end; i++) {
        const txDate = randomDate(dateStart, dateEnd);
        const senderBank = randFrom(NIGERIAN_BANKS);
        const receiverBank = randFrom(NIGERIAN_BANKS);
        const sessionId = nipSessionId();
        const rrnVal = rrn();
        const amt = randomAmount(5000, 5000000);
        const narrations = ["Salary Payment", "Vendor Payment", "Customer Refund", "Invoice Settlement", "Loan Disbursement", "School Fees", "Rent Payment"];

        let status;
        if (i < matchCount) status = "matched";
        else if (i < matchCount + exceptionCount) status = "exception";
        else status = "unmatched";

        vals.push(
          batchId, nibssChannelId, adminUserId, orgId,
          sessionId, rrnVal,
          `NIP Transfer from ${senderBank.shortName} to ${receiverBank.shortName} | ${randFrom(narrations)}`,
          amt, "NGN", txDate, txDate,
          i % 3 === 0 ? "debit" : "credit",
          `${senderBank.name} → ${receiverBank.name}`,
          0, null, status, null,
          JSON.stringify({ nipSessionId: sessionId, rrn: rrnVal, senderBank: senderBank.code, receiverBank: receiverBank.code, senderAccount: accountNumber(), receiverAccount: accountNumber() })
        );
        ph.push("(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      }

      const [insertRes] = await conn.execute(
        `INSERT INTO transactions (batchId, channelId, userId, organizationId, transactionRef, externalRef, description, amount, currency, transactionDate, valueDate, debitCredit, counterparty, isReversal, originalTransactionRef, status, matchId, rawData)
         VALUES ${ph.join(",")}`,
        vals
      );
      const firstId = insertRes.insertId;
      for (let j = 0; j < (end - start); j++) txnIds.push(firstId + j);
    }
    console.log(`✅ Inserted ${count} NIP transactions`);

    // Get GL transactions to match against
    const [glTxns] = await conn.execute(
      `SELECT id FROM transactions WHERE channelId = ? AND organizationId = ? ORDER BY id ASC LIMIT ${matchCount}`,
      [glChannelId, orgId]
    );
    const glTxnIds = glTxns.map(t => t.id);

    // If not enough GL transactions, add more
    if (glTxnIds.length < matchCount) {
      const needed = matchCount - glTxnIds.length;
      console.log(`📝 Adding ${needed} supplementary GL transactions...`);
      const [glBatch] = await conn.execute(
        `INSERT INTO upload_batches (userId, channelId, organizationId, fileName, fileHash, totalRows, validRows, invalidRows, status, createdAt, completedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'completed', NOW(), NOW())`,
        [adminUserId, glChannelId, orgId, `gl_nibss_supp_${Date.now()}.csv`,
         `glsupp${Date.now()}`.substring(0, 32), needed, needed]
      );
      const glBatchId = glBatch.insertId;

      for (let start = 0; start < needed; start += BATCH) {
        const end = Math.min(start + BATCH, needed);
        const vals = [];
        const ph = [];
        for (let i = start; i < end; i++) {
          const txDate = randomDate(dateStart, dateEnd);
          const glRef = `GL${new Date().getFullYear()}${String(randInt(100000,999999))}`;
          const txRef = `TXN${nipSessionId()}`;
          const glAcct = randFrom(GL_ACCOUNTS);
          vals.push(
            glBatchId, glChannelId, adminUserId, orgId,
            glRef, txRef,
            `CBS GL Entry | ${glAcct} | NIP Settlement`,
            randomAmount(5000, 5000000), "NGN", txDate, txDate,
            i % 2 === 0 ? "debit" : "credit", `GL Account ${glAcct}`,
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
        for (let j = 0; j < (end - start); j++) glTxnIds.push(firstId + j);
      }
      console.log(`✅ Added ${needed} GL transactions`);
    }

    // Create reconciliation job
    const matchRatePct = (matchCount / count * 100).toFixed(2);
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
        "NIBSS NIP vs CBS GL — April 2026",
        nibssChannelId, glChannelId,
        dateStart, dateEnd,
        count, glTxnIds.length,
        matchCount, exceptionCount, unmatchedCount,
        matchRatePct,
        randInt(1200, 8500),
      ]
    );
    const jobId = jobRes.insertId;

    // Insert match records
    const matchedTxnIds = txnIds.slice(0, matchCount);
    const matchTypes = ["exact", "exact", "exact", "fuzzy", "amount_tolerance", "date_window"];
    for (let i = 0; i < matchCount; i += BATCH) {
      const end = Math.min(i + BATCH, matchCount);
      const vals = [];
      const ph = [];
      for (let j = i; j < end; j++) {
        const mType = randFrom(matchTypes);
        const confidence = mType === "exact" ? "100.00" : (85 + Math.random() * 14).toFixed(2);
        vals.push(
          jobId, matchedTxnIds[j], glTxnIds[j % glTxnIds.length],
          mType, confidence,
          mType === "exact" ? "0.00" : (Math.random() * 50).toFixed(2),
          mType === "date_window" ? randInt(1, 3) : 0,
          `${mType === "exact" ? "Exact NIP session ID match" : "Fuzzy match on amount + date"} — NIBSS_NIP`,
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
      ["amount_mismatch", "Amount in NIP source differs from CBS GL by more than tolerance threshold"],
      ["missing_counterparty", "Counterparty NUBAN not found in CBS customer master"],
      ["timing_difference", "NIP transaction date falls outside 1-day settlement window"],
      ["duplicate_transaction", "Duplicate NIP session ID detected — possible double-posting"],
    ];
    const exceptionTxnIds = txnIds.slice(matchCount, matchCount + exceptionCount);
    for (let i = 0; i < exceptionTxnIds.length; i++) {
      const [etype, edesc] = randFrom(exceptionTypes);
      await conn.execute(
        `INSERT INTO exceptions (jobId, transactionId, category, severity, description, suggestedResolution, status, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, 'open', NOW())`,
        [jobId, exceptionTxnIds[i], etype, randFrom(["low", "medium", "high"]), edesc,
         `Review ${etype.replace(/_/g," ")} and verify against CBS GL entry`]
      );
    }

    console.log(`\n✅ NIBSS NIP channel seeded successfully!`);
    console.log(`   Channel ID: ${nibssChannelId}`);
    console.log(`   Transactions: ${count}`);
    console.log(`   Match rate: ${matchRatePct}% (${matchCount} matched, ${exceptionCount} exceptions, ${unmatchedCount} unmatched)`);
    console.log(`   Job ID: ${jobId}`);

    // Final summary of all channels
    console.log("\n📊 Final summary — all reconciliation jobs:");
    const [allJobs] = await conn.execute(
      `SELECT rj.id, c.code, rj.matchRate, rj.matchedCount, rj.totalSourceTxns, rj.exceptionCount
       FROM reconciliation_jobs rj
       JOIN channels c ON c.id = rj.sourceChannelId
       WHERE rj.organizationId = ?
       ORDER BY rj.id DESC`,
      [orgId]
    );
    for (const job of allJobs) {
      console.log(`  ${job.code}: ${job.matchRate}% (${job.matchedCount}/${job.totalSourceTxns} matched, ${job.exceptionCount} exceptions)`);
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    throw err;
  } finally {
    await conn.end();
  }
}

fix().catch((e) => { console.error(e); process.exit(1); });
