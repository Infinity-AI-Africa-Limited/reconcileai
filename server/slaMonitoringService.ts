/**
 * SLA Monitoring Service
 * Monitors exception resolution times and sends alerts when SLA thresholds are breached.
 * Demo job exceptions (jobs whose name contains "Demo") are excluded from all alerts.
 */
import { notifyOwner } from "./_core/notification";
import { getDb, getAllUsers } from "./db";
import { eq, and, or } from "drizzle-orm";
import { exceptions, reconciliationJobs } from "../drizzle/schema";

// SLA thresholds in hours
const SLA_WARNING_THRESHOLD = 20; // Yellow alert
const SLA_BREACH_THRESHOLD = 24; // Red alert

interface SLABreach {
  exceptionId: number;
  hoursOpen: number;
  severity: 'warning' | 'critical';
  assignedTo?: number;
  assignedUserName?: string;
}

/**
 * Check all open exceptions for SLA breaches and send notifications.
 * Exceptions linked to demo reconciliation jobs are intentionally excluded.
 */
export async function checkSLABreaches(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;

    // 1. Find all demo/seeded job IDs so we can exclude their exceptions.
    //    Demo jobs are identified by:
    //    - Having "Demo" or "demo" in their name
    //    - Being seeded reconciliation jobs (name contains "vs CBS GL" — these are
    //      the bulk-seeded FinServ demo jobs, not real user-created jobs)
    const allJobs = await db
      .select({ id: reconciliationJobs.id, name: reconciliationJobs.name })
      .from(reconciliationJobs);

    const demoJobIds = allJobs
      .filter(j => {
        if (!j.name) return false;
        // Explicitly seeded demo jobs
        if (j.name.includes("Demo") || j.name.includes("demo")) return true;
        // Bulk-seeded FinServ channel jobs (e.g. "NIBSS_NIP vs CBS GL — April 2026")
        if (j.name.includes("vs CBS GL")) return true;
        return false;
      })
      .map(j => j.id);

    // 2. Fetch all open/in-review exceptions
    const openExceptions = await db
      .select()
      .from(exceptions)
      .where(
        or(
          eq(exceptions.status, "open"),
          eq(exceptions.status, "in_review")
        )
      )
      .limit(10000);

    // Filter out demo job exceptions in JS
    const demoJobIdSet = new Set(demoJobIds);
    const realExceptions = openExceptions.filter(
      (e) => !demoJobIdSet.has(e.jobId)
    );

    const breaches: SLABreach[] = [];
    const now = new Date();

    for (const exception of realExceptions) {
      if (!exception.createdAt) continue;

      const hoursOpen = (now.getTime() - exception.createdAt.getTime()) / (1000 * 60 * 60);

      if (hoursOpen >= SLA_BREACH_THRESHOLD) {
        breaches.push({
          exceptionId: exception.id,
          hoursOpen: Math.round(hoursOpen * 10) / 10,
          severity: 'critical',
          assignedTo: exception.assignedTo || undefined,
        });
      } else if (hoursOpen >= SLA_WARNING_THRESHOLD) {
        breaches.push({
          exceptionId: exception.id,
          hoursOpen: Math.round(hoursOpen * 10) / 10,
          severity: 'warning',
          assignedTo: exception.assignedTo || undefined,
        });
      }
    }

    // Enrich with assigned user names if needed
    if (breaches.some(b => b.assignedTo)) {
      const allUsers = await getAllUsers();
      for (const breach of breaches) {
        if (breach.assignedTo) {
          const user = allUsers.find((u: any) => u.id === breach.assignedTo);
          breach.assignedUserName = user?.name || user?.email || `User #${breach.assignedTo}`;
        }
      }
    }

    // Send notifications if there are breaches
    if (breaches.length > 0) {
      await sendSLABreachNotification(breaches);
    }

    console.log(
      `[SLA Monitor] Checked ${realExceptions.length} real exceptions (excluded ${openExceptions.length - realExceptions.length} demo exceptions), found ${breaches.length} SLA breaches`
    );
  } catch (error) {
    console.error('[SLA Monitor] Error checking SLA breaches:', error);
  }
}

/**
 * Send SLA breach notification to the owner
 */
async function sendSLABreachNotification(breaches: SLABreach[]): Promise<void> {
  const criticalBreaches = breaches.filter(b => b.severity === 'critical');
  const warningBreaches = breaches.filter(b => b.severity === 'warning');

  let content = '## SLA Breach Alert\n\n';

  if (criticalBreaches.length > 0) {
    content += `### 🔴 Critical (>24 hours): ${criticalBreaches.length} exceptions\n\n`;
    criticalBreaches.slice(0, 10).forEach(breach => {
      const assignedInfo = breach.assignedUserName
        ? `Assigned to: ${breach.assignedUserName}`
        : 'Unassigned';
      content += `- Exception #${breach.exceptionId} - ${breach.hoursOpen}hrs open - ${assignedInfo}\n`;
    });
    if (criticalBreaches.length > 10) {
      content += `\n_...and ${criticalBreaches.length - 10} more critical exceptions_\n`;
    }
    content += '\n';
  }

  if (warningBreaches.length > 0) {
    content += `### ⚠️ Warning (>20 hours): ${warningBreaches.length} exceptions\n\n`;
    warningBreaches.slice(0, 10).forEach(breach => {
      const assignedInfo = breach.assignedUserName
        ? `Assigned to: ${breach.assignedUserName}`
        : 'Unassigned';
      const timeRemaining = 24 - breach.hoursOpen;
      content += `- Exception #${breach.exceptionId} - ${breach.hoursOpen}hrs open - ${timeRemaining.toFixed(1)}hrs remaining - ${assignedInfo}\n`;
    });
    if (warningBreaches.length > 10) {
      content += `\n_...and ${warningBreaches.length - 10} more warning exceptions_\n`;
    }
  }

  content += '\n---\n\n';
  content += `**Action Required:** Please review and resolve these exceptions to maintain SLA compliance.\n`;
  content += `**24-hour SLA Target:** All exceptions should be resolved within 24 hours of creation.\n`;
  content += `\n_Note: Demo data exceptions are excluded from this alert._\n`;

  await notifyOwner({
    title: `⚠️ SLA Breach Alert: ${breaches.length} Exception${breaches.length !== 1 ? 's' : ''} Require Attention`,
    content,
  });
}

/**
 * Start SLA monitoring with periodic checks
 * @param intervalMinutes How often to check for SLA breaches (default: 60 minutes)
 */
export function startSLAMonitoring(intervalMinutes: number = 60): NodeJS.Timeout {
  console.log(`[SLA Monitor] Starting with ${intervalMinutes}-minute interval`);

  // Run immediately on start
  checkSLABreaches();

  // Then run periodically
  return setInterval(() => {
    checkSLABreaches();
  }, intervalMinutes * 60 * 1000);
}
