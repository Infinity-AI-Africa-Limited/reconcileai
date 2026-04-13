/**
 * ReconcileAI — Guest Link + AR Supervisor + Audit Trail Seed Script
 *
 * 1. Creates a shareable investor guest link (30-day expiry)
 * 2. Adds a second demo user with AR Supervisor role
 * 3. Resolves 4 open exceptions and seeds 18 audit trail lifecycle entries
 *    showing the full lifecycle: assigned → reviewed → AI draft generated →
 *    draft approved → exception resolved → audit finalised
 *
 * Run: node seed-guest-audit.mjs
 */

import mysql from "mysql2/promise";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const DB_URL = process.env.DATABASE_URL;
const APP_ID = process.env.VITE_APP_ID || "fGjDi9wkBzgbvTayKYVoMB";
const BASE_URL = `https://${APP_ID}.manus.space`;

if (!DB_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

function hoursAgo(h) { return new Date(Date.now() - h * 3600 * 1000); }
function minutesAgo(m) { return new Date(Date.now() - m * 60 * 1000); }

async function run() {
  const conn = await mysql.createConnection(DB_URL);
  console.log("✅ Connected to database\n");

  try {
    const orgId = 1;
    const adminId = 1;

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Create shareable investor guest link (30-day expiry)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("🔗 Step 1: Creating investor guest link...");

    // Revoke any old guest links first
    await conn.execute(
      "UPDATE guest_tokens SET isActive = 0 WHERE organizationId = ? AND label LIKE '%Investor%'",
      [orgId]
    );

    const token = crypto.randomBytes(24).toString("hex"); // 48-char hex
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days

    await conn.execute(
      `INSERT INTO guest_tokens (token, createdBy, organizationId, label, expiresAt, viewCount, isActive, createdAt)
       VALUES (?, ?, ?, ?, ?, 0, 1, NOW())`,
      [token, adminId, orgId, "Investor Demo Link — ReconcileAI", expiresAt]
    );

    const guestUrl = `${BASE_URL}/demo/${token}`;
    console.log(`  ✅ Guest link created`);
    console.log(`  🔗 URL: ${guestUrl}`);
    console.log(`  📅 Expires: ${expiresAt.toDateString()}`);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: Add AR Supervisor demo user
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n👤 Step 2: Adding AR Supervisor demo user...");

    // Check if AR supervisor already exists
    const [existing] = await conn.execute(
      "SELECT id FROM users WHERE email = 'ar.supervisor@reconcileai.demo' LIMIT 1"
    );

    let supervisorId;
    if (existing.length > 0) {
      supervisorId = existing[0].id;
      console.log(`  ℹ️  AR Supervisor already exists (id=${supervisorId}), updating...`);
      await conn.execute(
        "UPDATE users SET name = ?, role = ?, isActive = 1, organizationId = ? WHERE id = ?",
        ["Amaka Okonkwo (AR Supervisor)", "user", orgId, supervisorId]
      );
    } else {
      const openId = `demo-ar-supervisor-${crypto.randomBytes(8).toString("hex")}`;
      const [insertResult] = await conn.execute(
        `INSERT INTO users (openId, name, email, loginMethod, role, organizationId, isActive, isGuest, createdAt, updatedAt)
         VALUES (?, ?, ?, 'demo', 'user', ?, 1, 0, NOW(), NOW())`,
        [openId, "Amaka Okonkwo (AR Supervisor)", "ar.supervisor@reconcileai.demo", orgId]
      );
      supervisorId = insertResult.insertId;
      console.log(`  ✅ Created AR Supervisor: Amaka Okonkwo (id=${supervisorId})`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3: Resolve 4 open exceptions for audit trail
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🔍 Step 3: Selecting 4 exceptions for full lifecycle audit trail...");

    const [openExcs] = await conn.execute(`
      SELECT e.id, e.category, e.severity, e.transactionId, e.jobId
      FROM exceptions e
      JOIN reconciliation_jobs rj ON rj.id = e.jobId
      WHERE e.status = 'open' AND rj.organizationId = ?
      ORDER BY e.severity DESC, e.id ASC
      LIMIT 4
    `, [orgId]);

    console.log(`  Selected ${openExcs.length} exceptions: ${openExcs.map(e => `#${e.id}(${e.category})`).join(", ")}`);

    // Get transaction refs
    const txnIds = openExcs.map(e => e.transactionId).filter(Boolean);
    let txnMap = {};
    if (txnIds.length > 0) {
      const [txns] = await conn.execute(
        `SELECT id, transactionRef, amount, counterparty FROM transactions WHERE id IN (${txnIds.join(",")})`,
        []
      );
      txns.forEach(t => { txnMap[t.id] = t; });
    }

    // Mark these 4 as resolved
    for (const exc of openExcs) {
      await conn.execute(
        `UPDATE exceptions SET status = 'resolved', resolvedBy = ?, resolvedAt = ?, 
         resolutionNotes = ? WHERE id = ?`,
        [
          adminId,
          minutesAgo(5),
          "Resolved via ReconcileAI Super Agent workflow. AI draft reviewed and approved by AR Supervisor. Journal entry posted to CBS.",
          exc.id
        ]
      );
    }
    console.log(`  ✅ Marked ${openExcs.length} exceptions as resolved`);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 4: Seed 18 audit trail lifecycle entries (4-5 per exception)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📋 Step 4: Seeding audit trail lifecycle entries...");

    const auditEntries = [];

    const lifecycleTemplates = {
      amount_mismatch: [
        {
          action: "exception_detected",
          actor: adminId,
          hoursBack: 48,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            category: "amount_mismatch",
            severity: exc.severity,
            transactionRef: txn?.transactionRef || `TXN-${exc.id}`,
            detectedBy: "ReconcileAI Balance Engine (Pass 2)",
            matchConfidence: 0,
            description: "Amount discrepancy detected between NIP settlement and CBS GL posting",
          }),
        },
        {
          action: "exception_assigned",
          actor: adminId,
          hoursBack: 47,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            assignedTo: supervisorId,
            assignedToName: "Amaka Okonkwo (AR Supervisor)",
            assignedBy: "Richard Anwanakak (Admin)",
            priority: exc.severity,
            slaDeadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          }),
        },
        {
          action: "agent_draft_generated",
          actor: adminId,
          hoursBack: 46,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            draftType: "vendor_email",
            diagnosisConfidence: 92,
            shortfallAmount: 45000,
            currency: "NGN",
            generatedBy: "ReconcileAI Super Agent v1.0",
            subject: `Payment Reference Discrepancy — ${txn?.transactionRef || `TXN-${exc.id}`}`,
          }),
        },
        {
          action: "draft_approved",
          actor: supervisorId,
          hoursBack: 24,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            approvedBy: "Amaka Okonkwo (AR Supervisor)",
            draftType: "vendor_email",
            approvalNote: "Confirmed shortfall matches distributor's partial payment record. Email approved for dispatch.",
            timeToApproval: "22 hours",
          }),
        },
        {
          action: "exception_resolved",
          actor: adminId,
          hoursBack: 1,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            resolvedBy: "Richard Anwanakak (Admin)",
            resolutionMethod: "vendor_email_response",
            resolutionNote: "Counterparty confirmed partial payment. Remaining balance of ₦45,000 scheduled for next settlement cycle.",
            totalResolutionTime: "47 hours",
            auditHash: crypto.createHash("sha256").update(`${exc.id}-resolved-${Date.now()}`).digest("hex").slice(0, 16),
          }),
        },
      ],
      duplicate_transaction: [
        {
          action: "exception_detected",
          actor: adminId,
          hoursBack: 72,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            category: "duplicate_transaction",
            severity: exc.severity,
            transactionRef: txn?.transactionRef || `TXN-${exc.id}`,
            detectedBy: "ReconcileAI Anomaly Detection Engine",
            duplicateSessionId: `${txn?.transactionRef || "NIP"}-DUP`,
            description: "Identical NIP session ID detected in two separate settlement batches",
          }),
        },
        {
          action: "exception_assigned",
          actor: adminId,
          hoursBack: 71,
          details: (exc) => ({
            exceptionId: exc.id,
            assignedTo: supervisorId,
            assignedToName: "Amaka Okonkwo (AR Supervisor)",
            priority: "high",
            escalationFlag: true,
            slaDeadline: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
          }),
        },
        {
          action: "agent_draft_generated",
          actor: adminId,
          hoursBack: 70,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            draftType: "journal_entry",
            diagnosisConfidence: 97,
            description: "Reversal journal entry drafted for duplicate CBS credit",
            generatedBy: "ReconcileAI Super Agent v1.0",
            debitAccount: "5001-SUSPENSE",
            creditAccount: "2001-CUSTOMER",
            amount: txn?.amount || 250000,
          }),
        },
        {
          action: "draft_approved",
          actor: supervisorId,
          hoursBack: 68,
          details: (exc) => ({
            exceptionId: exc.id,
            approvedBy: "Amaka Okonkwo (AR Supervisor)",
            draftType: "journal_entry",
            approvalNote: "Duplicate confirmed via NIBSS portal query. Journal entry approved. Finance Manager cc'd per CBN policy.",
            timeToApproval: "2 hours",
          }),
        },
        {
          action: "exception_resolved",
          actor: adminId,
          hoursBack: 0.5,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            resolvedBy: "Richard Anwanakak (Admin)",
            resolutionMethod: "journal_entry_posted",
            journalRef: `JNL-${new Date().getFullYear()}-${String(exc.id).padStart(5, "0")}`,
            reversalAmount: txn?.amount || 250000,
            currency: "NGN",
            totalResolutionTime: "71.5 hours",
            auditHash: crypto.createHash("sha256").update(`${exc.id}-resolved-${Date.now()}`).digest("hex").slice(0, 16),
          }),
        },
      ],
      timing_difference: [
        {
          action: "exception_detected",
          actor: adminId,
          hoursBack: 36,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            category: "timing_difference",
            severity: exc.severity,
            transactionRef: txn?.transactionRef || `TXN-${exc.id}`,
            detectedBy: "ReconcileAI Balance Engine (Pass 3)",
            settlementDelay: "T+3",
            description: "Transaction posted 3 days after value date — outside standard T+1 window",
          }),
        },
        {
          action: "exception_assigned",
          actor: adminId,
          hoursBack: 35,
          details: (exc) => ({
            exceptionId: exc.id,
            assignedTo: supervisorId,
            assignedToName: "Amaka Okonkwo (AR Supervisor)",
            priority: exc.severity,
          }),
        },
        {
          action: "agent_draft_generated",
          actor: adminId,
          hoursBack: 34,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            draftType: "payment_allocation",
            diagnosisConfidence: 89,
            description: "Backdated payment allocation instruction drafted",
            valueDate: new Date(Date.now() - 3 * 86400000).toISOString().split("T")[0],
            amount: txn?.amount || 180000,
          }),
        },
        {
          action: "exception_resolved",
          actor: adminId,
          hoursBack: 2,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            resolvedBy: "Richard Anwanakak (Admin)",
            resolutionMethod: "payment_allocation_posted",
            backdatedValueDate: new Date(Date.now() - 3 * 86400000).toISOString().split("T")[0],
            totalResolutionTime: "34 hours",
            auditHash: crypto.createHash("sha256").update(`${exc.id}-resolved-${Date.now()}`).digest("hex").slice(0, 16),
          }),
        },
      ],
      missing_counterparty: [
        {
          action: "exception_detected",
          actor: adminId,
          hoursBack: 60,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            category: "missing_counterparty",
            severity: exc.severity,
            transactionRef: txn?.transactionRef || `TXN-${exc.id}`,
            detectedBy: "ReconcileAI Anomaly Detection Engine",
            description: "Incoming payment cannot be matched to any known counterparty in Distributor Registry",
          }),
        },
        {
          action: "exception_assigned",
          actor: adminId,
          hoursBack: 59,
          details: (exc) => ({
            exceptionId: exc.id,
            assignedTo: supervisorId,
            assignedToName: "Amaka Okonkwo (AR Supervisor)",
            priority: exc.severity,
          }),
        },
        {
          action: "agent_draft_generated",
          actor: adminId,
          hoursBack: 58,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            draftType: "vendor_email",
            diagnosisConfidence: 84,
            description: "Counterparty identification email drafted",
            suspenseAccount: "5001-SUSPENSE",
            amount: txn?.amount || 95000,
          }),
        },
        {
          action: "distributor_registry_updated",
          actor: supervisorId,
          hoursBack: 30,
          details: (exc) => ({
            exceptionId: exc.id,
            action: "new_distributor_added",
            distributorName: "Kano Central Distributors Ltd",
            addedBy: "Amaka Okonkwo (AR Supervisor)",
            note: "New distributor identified from payment reference. Added to registry with canonical name and bank account.",
          }),
        },
        {
          action: "exception_resolved",
          actor: adminId,
          hoursBack: 0.25,
          details: (exc, txn) => ({
            exceptionId: exc.id,
            resolvedBy: "Richard Anwanakak (Admin)",
            resolutionMethod: "counterparty_identified_and_allocated",
            newDistributor: "Kano Central Distributors Ltd",
            allocatedAmount: txn?.amount || 95000,
            totalResolutionTime: "59.75 hours",
            auditHash: crypto.createHash("sha256").update(`${exc.id}-resolved-${Date.now()}`).digest("hex").slice(0, 16),
          }),
        },
      ],
    };

    // Fallback to amount_mismatch template
    const fallbackTemplate = lifecycleTemplates.amount_mismatch;

    let totalAuditEntries = 0;
    for (let i = 0; i < openExcs.length; i++) {
      const exc = openExcs[i];
      const txn = txnMap[exc.transactionId] || null;
      const template = lifecycleTemplates[exc.category] || fallbackTemplate;

      console.log(`\n  Exception #${exc.id} (${exc.category}) — ${template.length} lifecycle entries:`);

      for (const step of template) {
        const ts = hoursAgo(step.hoursBack);
        const details = step.details(exc, txn);

        await conn.execute(
          `INSERT INTO audit_logs (userId, action, entityType, entityId, details, ipAddress, createdAt, organizationId, userAgent)
           VALUES (?, ?, 'exception', ?, ?, '10.0.0.1', ?, ?, 'ReconcileAI-SuperAgent/1.0')`,
          [
            step.actor,
            step.action,
            exc.id,
            JSON.stringify(details),
            ts,
            orgId,
          ]
        );
        totalAuditEntries++;
        console.log(`    ✅ [${ts.toLocaleString("en-NG")}] ${step.action} (actor: ${step.actor === adminId ? "Admin" : "AR Supervisor"})`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 5: Add a system-level audit entry for the guest link creation
    // ─────────────────────────────────────────────────────────────────────────
    await conn.execute(
      `INSERT INTO audit_logs (userId, action, entityType, entityId, details, ipAddress, createdAt, organizationId, userAgent)
       VALUES (?, 'guest_link_created', 'guest_token', NULL, ?, '10.0.0.1', NOW(), ?, 'ReconcileAI-Admin/1.0')`,
      [
        adminId,
        JSON.stringify({
          label: "Investor Demo Link — ReconcileAI",
          expiresAt: expiresAt.toISOString(),
          url: guestUrl,
          createdBy: "Richard Anwanakak (Admin)",
          purpose: "Investor due diligence demo access",
        }),
        orgId,
      ]
    );
    totalAuditEntries++;

    // ─────────────────────────────────────────────────────────────────────────
    // FINAL SUMMARY
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n\n📊 Final Summary:");
    const [auditCount] = await conn.execute(
      "SELECT COUNT(*) as cnt FROM audit_logs WHERE organizationId = ?", [orgId]
    );
    const [resolvedCount] = await conn.execute(`
      SELECT COUNT(*) as cnt FROM exceptions e
      JOIN reconciliation_jobs rj ON rj.id = e.jobId
      WHERE e.status = 'resolved' AND rj.organizationId = ?
    `, [orgId]);
    const [guestLinks] = await conn.execute(
      "SELECT label, expiresAt FROM guest_tokens WHERE organizationId = ? AND isActive = 1", [orgId]
    );
    const [supervisorUser] = await conn.execute(
      "SELECT id, name, role FROM users WHERE id = ?", [supervisorId]
    );

    console.log(`  🔗 Guest Links (active): ${guestLinks.length}`);
    guestLinks.forEach(g => console.log(`     • "${g.label}" — expires ${new Date(g.expiresAt).toDateString()}`));
    console.log(`  👤 AR Supervisor: ${supervisorUser[0]?.name} (id=${supervisorId})`);
    console.log(`  ✅ Resolved exceptions: ${resolvedCount[0].cnt}`);
    console.log(`  📋 Total audit log entries: ${auditCount[0].cnt} (added ${totalAuditEntries} this run)`);
    console.log(`\n  🔗 INVESTOR GUEST LINK:`);
    console.log(`     ${guestUrl}`);
    console.log(`\n🎉 All done!`);

  } catch (err) {
    console.error("❌ Error:", err.message, err.stack);
    throw err;
  } finally {
    await conn.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
