/**
 * ReconcileAI — Demo Setup Script
 * 1. Assigns all open exceptions to admin user (AR Supervisor role) for Review Queue
 * 2. Seeds 10 Super Agent action draft records linked to open exceptions
 * 3. Activates Demo Mode (FinServ segment) via direct DB seed
 *
 * Run: node seed-demo-setup.mjs
 */

import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

function randFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function setup() {
  const conn = await mysql.createConnection(DB_URL);
  console.log("✅ Connected to database");

  try {
    const orgId = 1;
    const [admins] = await conn.execute("SELECT id, name FROM users WHERE role = 'admin' LIMIT 1");
    const adminId = admins[0].id;
    const adminName = admins[0].name;
    console.log(`Admin: ${adminName} (id=${adminId})`);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Assign all open exceptions to admin (AR Supervisor)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📋 Step 1: Assigning open exceptions to Review Queue...");

    const [openExcs] = await conn.execute(`
      SELECT e.id, e.category, e.severity, e.transactionId
      FROM exceptions e
      JOIN reconciliation_jobs rj ON rj.id = e.jobId
      WHERE e.status = 'open' AND rj.organizationId = ?
      ORDER BY e.id ASC
    `, [orgId]);

    console.log(`  Found ${openExcs.length} open exceptions`);

    // Assign in batches of 50
    const BATCH = 50;
    for (let i = 0; i < openExcs.length; i += BATCH) {
      const batch = openExcs.slice(i, Math.min(i + BATCH, openExcs.length));
      const ids = batch.map(e => e.id);
      await conn.execute(
        `UPDATE exceptions SET assignedTo = ?, assignedAt = NOW(), assignedBy = ? WHERE id IN (${ids.join(",")})`,
        [adminId, adminId]
      );
    }

    console.log(`  ✅ Assigned ${openExcs.length} exceptions to ${adminName} (AR Supervisor)`);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: Seed Super Agent action drafts
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🤖 Step 2: Seeding Super Agent action drafts...");

    // Check agent_action_drafts table columns
    const [draftCols] = await conn.execute("DESCRIBE agent_action_drafts");
    const colNames = draftCols.map(c => c.Field);
    console.log("  Draft columns:", colNames.join(", "));

    // Delete any existing drafts for this org to start clean
    await conn.execute("DELETE FROM agent_action_drafts WHERE organizationId = ?", [orgId]);

    // Get first 10 open exceptions for drafts
    const draftExceptions = openExcs.slice(0, 10);

    // Get transaction refs for context
    const txnIds = draftExceptions.map(e => e.transactionId).filter(Boolean);
    let txnMap = {};
    if (txnIds.length > 0) {
      const [txns] = await conn.execute(
        `SELECT id, transactionRef, amount, counterparty, description FROM transactions WHERE id IN (${txnIds.join(",")})`,
        []
      );
      txns.forEach(t => { txnMap[t.id] = t; });
    }

    // Draft templates by exception category
    const draftTemplates = {
      amount_mismatch: {
        actionType: "vendor_email",
        subject: (ref, amt, counterparty) =>
          `Payment Reference Discrepancy — ${ref} | Shortfall of ₦${Number(amt || 50000).toLocaleString()} Requires Clarification`,
        body: (ref, amt, counterparty, channel) => `Dear ${counterparty || "Finance Team"},

I hope this message finds you well.

Our automated reconciliation system has flagged a discrepancy on the following transaction:

  Payment Reference: ${ref}
  Expected Amount:   ₦${(Number(amt || 50000) + randInt(5000, 50000)).toLocaleString()}
  Received Amount:   ₦${Number(amt || 50000).toLocaleString()}
  Shortfall:         ₦${randInt(5000, 50000).toLocaleString()}
  Channel:           ${channel || "NIBSS NIP"}
  Date:              ${new Date().toLocaleDateString("en-NG")}

Could you please confirm whether this represents a partial payment, a deduction, or a processing error? If a deduction has been applied, kindly provide the relevant deduction code and supporting documentation.

We would appreciate your response within 48 hours to avoid any disruption to your account status.

Best regards,
AR Operations Team
ReconcileAI — Powered by Infinity AI Africa Limited`,
        diagnosisCategory: "amount_mismatch",
        diagnosisConfidence: randInt(87, 97),
      },
      duplicate_transaction: {
        actionType: "journal_entry",
        subject: (ref) =>
          `Duplicate Transaction Detected — ${ref} | Reversal Entry Required`,
        body: (ref, amt, counterparty) => `DRAFT JOURNAL ENTRY — PENDING APPROVAL

Date:           ${new Date().toLocaleDateString("en-NG")}
Reference:      ${ref}
Prepared by:    ReconcileAI Super Agent
Status:         PENDING HUMAN APPROVAL — DO NOT EXECUTE WITHOUT SIGN-OFF

DEBIT:   Suspense Account (5001-SUSPENSE)     ₦${Number(amt || 50000).toLocaleString()}
CREDIT:  Customer Liability (2001-CUSTOMER)   ₦${Number(amt || 50000).toLocaleString()}

Narration: Reversal of duplicate NIP credit — original transaction ${ref} was posted twice. 
Second posting identified by ReconcileAI anomaly detection engine (confidence: ${randInt(88, 97)}%).

Supporting evidence:
- Duplicate session ID detected in NIP settlement report
- Both entries carry identical amount, counterparty, and value date
- CBS GL shows double credit to customer account

Recommended action: Post reversal entry above and notify customer of correction.
Escalation path: If customer disputes, escalate to Head of eBusiness Operations.`,
        diagnosisCategory: "duplicate_transaction",
        diagnosisConfidence: randInt(90, 99),
      },
      missing_counterparty: {
        actionType: "vendor_email",
        subject: (ref) =>
          `Unmatched Payment — ${ref} | Counterparty Identification Required`,
        body: (ref, amt, counterparty) => `Dear Customer Relations Team,

Our reconciliation system has identified an incoming payment that cannot be matched to a known counterparty:

  Payment Reference: ${ref}
  Amount:            ₦${Number(amt || 50000).toLocaleString()}
  Date Received:     ${new Date().toLocaleDateString("en-NG")}
  Current Status:    Held in Suspense Account (5001-SUSPENSE)

The payment reference does not match any active account or invoice in our system. This may be due to:
  • A new distributor or supplier making their first payment
  • An incorrect beneficiary account number
  • A reference format that differs from our expected pattern

Please review and confirm the correct allocation for this payment within 24 hours. If unresolved, the amount will remain in suspense and may affect your account standing.

Regards,
Reconciliation Operations
ReconcileAI — Powered by Infinity AI Africa Limited`,
        diagnosisCategory: "missing_counterparty",
        diagnosisConfidence: randInt(82, 94),
      },
      timing_difference: {
        actionType: "payment_allocation",
        subject: (ref) =>
          `Settlement Window Exception — ${ref} | T+${randInt(2,4)} Day Posting Requires Allocation`,
        body: (ref, amt, counterparty) => `PAYMENT ALLOCATION INSTRUCTION — DRAFT

Reference:    ${ref}
Amount:       ₦${Number(amt || 50000).toLocaleString()}
Issue:        Transaction posted outside the standard T+1 settlement window
Delay:        T+${randInt(2,4)} days

ReconcileAI has identified this transaction as a late-posting item that fell outside the automated matching window. The transaction has been verified as legitimate and is recommended for manual allocation.

Allocation instruction:
  Debit:  Nostro / Settlement Account (1002-SETTLEMENT)
  Credit: Customer Account — ${counterparty || "Counterparty Account"}
  Amount: ₦${Number(amt || 50000).toLocaleString()}
  Value Date: ${new Date(Date.now() - randInt(1,3) * 86400000).toLocaleDateString("en-NG")} (backdated to original value date)

Approver note: Please verify value date before posting. Backdated entries require Finance Manager sign-off per CBN guidelines.`,
        diagnosisCategory: "timing_difference",
        diagnosisConfidence: randInt(85, 95),
      },
      format_error: {
        actionType: "no_action",
        subject: (ref) =>
          `Reference Format Exception — ${ref} | Manual Verification Required`,
        body: (ref, amt, counterparty) => `EXCEPTION ANALYSIS — ReconcileAI Super Agent

Transaction Reference: ${ref}
Exception Type:        Reference Format Error
Confidence:            ${randInt(78, 92)}%

DIAGNOSIS:
The transaction reference does not conform to the expected NIBSS NIP session ID format 
(YYYYMMDDHHmmssNNNNNN). The reference appears to have been truncated or reformatted 
by an intermediary system, preventing automated matching.

RECOMMENDED ACTION: No automated action — manual verification required.

INVESTIGATION STEPS:
1. Query the originating bank's portal for the original session ID using the partial reference
2. Cross-reference with the NIBSS settlement report for the value date
3. If confirmed legitimate, update the transaction reference in the system and re-run matching
4. If unresolvable within 48 hours, escalate to NIBSS dispute resolution

SIMILAR CASES: ReconcileAI has seen this pattern 3 times in the past 30 days, all originating 
from the same intermediary bank. Recommend raising a formal query with the bank's technical team.`,
        diagnosisCategory: "format_error",
        diagnosisConfidence: randInt(75, 88),
      },
    };

    // Fallback template
    const fallbackTemplate = draftTemplates.amount_mismatch;

    let draftsInserted = 0;
    for (let i = 0; i < draftExceptions.length; i++) {
      const exc = draftExceptions[i];
      const txn = txnMap[exc.transactionId] || {};
      const ref = txn.transactionRef || `TXN-DEMO-${String(exc.id).padStart(6, "0")}`;
      const amt = txn.amount || randInt(50000, 2000000);
      const counterparty = txn.counterparty || "Finance Operations Team";
      const channel = "NIBSS NIP";

      const template = draftTemplates[exc.category] || fallbackTemplate;
      const subject = template.subject(ref, amt, counterparty);
      const body = template.body(ref, amt, counterparty, channel);

      // Vary status: 7 pending_approval, 2 approved, 1 modified
      let status = "pending_approval";
      if (i === 3) status = "approved";
      if (i === 7) status = "approved";
      if (i === 9) status = "modified";

      const shortfall = exc.category === "amount_mismatch" ? randInt(5000, 100000) : null;

      await conn.execute(
        `INSERT INTO agent_action_drafts
           (organizationId, exceptionId, transactionRef, actionType, subject, body, metadata,
            status, diagnosisCategory, diagnosisConfidence, shortfallAmount, currency,
            createdByAgent, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NGN', 1, NOW(), NOW())`,
        [
          orgId,
          exc.id,
          ref,
          template.actionType,
          subject,
          body,
          JSON.stringify({
            exceptionCategory: exc.category,
            severity: exc.severity,
            channel,
            transactionId: exc.transactionId,
            agentVersion: "v1.0-super-agent",
            generatedAt: new Date().toISOString(),
          }),
          status,
          template.diagnosisCategory,
          template.diagnosisConfidence,
          shortfall,
        ]
      );
      draftsInserted++;
      console.log(`  ✅ Draft ${i + 1}/10: [${template.actionType}] ${exc.category} — ${status}`);
    }

    console.log(`\n  ✅ Seeded ${draftsInserted} Super Agent action drafts`);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3: Verify final state
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📊 Final verification:");

    const [assignedCount] = await conn.execute(
      `SELECT COUNT(*) as cnt FROM exceptions e
       JOIN reconciliation_jobs rj ON rj.id = e.jobId
       WHERE e.assignedTo IS NOT NULL AND e.status = 'open' AND rj.organizationId = ?`,
      [orgId]
    );
    console.log(`  Review Queue: ${assignedCount[0].cnt} exceptions assigned`);

    const [draftCount] = await conn.execute(
      "SELECT status, COUNT(*) as cnt FROM agent_action_drafts WHERE organizationId = ? GROUP BY status",
      [orgId]
    );
    console.log("  Super Agent drafts by status:", JSON.stringify(draftCount));

    const [draftTypes] = await conn.execute(
      "SELECT actionType, COUNT(*) as cnt FROM agent_action_drafts WHERE organizationId = ? GROUP BY actionType",
      [orgId]
    );
    console.log("  Super Agent drafts by type:", JSON.stringify(draftTypes));

    console.log("\n🎉 Demo setup complete!");
    console.log("   ✅ Review Queue: all open exceptions assigned to AR Supervisor");
    console.log("   ✅ Super Agent: 10 action drafts seeded (7 pending, 2 approved, 1 modified)");
    console.log("   ℹ️  Demo Mode: Toggle ON via sidebar — it loads the FMCG/FinServ demo dataset");

  } catch (err) {
    console.error("❌ Error:", err.message);
    throw err;
  } finally {
    await conn.end();
  }
}

setup().catch((e) => { console.error(e); process.exit(1); });
