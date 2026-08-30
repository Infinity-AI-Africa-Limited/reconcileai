/**
 * SLA Monitoring Service
 *
 * Watches open exceptions and alerts the platform operator when they age past
 * the 24-hour resolution target. Demo tenants are excluded, and every breach is
 * attributed to the organisation it belongs to.
 *
 * ── Why this was rewritten ────────────────────────────────────────────────────
 *
 * Demo-ness was inferred by substring-matching reconciliation job NAMES for
 * "Demo" / "demo" / "vs CBS GL" / "BrightGoods" / "Demo Reconciliation". That is
 * a case-sensitive match against free text each seeder invents for itself, and
 * it failed the first time a seeder chose a different convention: jobs named
 * "… vs Core Banking — FSDEMO-v2" matched none of the five patterns, because
 * `"FSDEMO".includes("Demo")` is false. 374 fabricated exceptions were reported
 * to the owner as real SLA breaches — under a footer stating that demo data was
 * excluded, which made the email confidently wrong rather than merely noisy.
 *
 * Demo-ness is now read from `organizations.isDemo`, a fact stored where the
 * fact lives. A new seeder cannot defeat it by picking a different job name.
 *
 * The scan was also completely untenanted — it selected every exception on the
 * platform with no organizationId in the predicate, and reported bare ids and
 * ages with no attribution. Harmless while one demo tenant existed; with real
 * banks it emails one client's operational posture into an undifferentiated
 * list. Exceptions are now grouped and reported per organisation.
 */
import { notifyOwner } from "./_core/notification";
import { getDb, getAllUsers } from "./db";
import { and, eq, or, inArray } from "drizzle-orm";
import { exceptions, organizations } from "../drizzle/schema";

// SLA thresholds in hours
const SLA_WARNING_THRESHOLD = 20; // Yellow alert
const SLA_BREACH_THRESHOLD = 24; // Red alert

interface SLABreach {
  exceptionId: number;
  organizationId: number | null;
  organizationName: string;
  hoursOpen: number;
  severity: 'warning' | 'critical';
  assignedTo?: number;
  assignedUserName?: string;
}

/**
 * The platform operator's own organisation, identified by its stable code.
 *
 * Deliberately NOT `segment === "super_admin"`, which is how this was first
 * written. A segment is a mutable property of an organisation —
 * `superAdmin.updateOrganizationSegment` can retype any org, including a real
 * customer's — and using it here would mean one mis-set field silently removes a
 * paying client from SLA monitoring. Their genuine breaches would then go
 * unreported, with nothing on screen to say so.
 *
 * That failure is strictly worse than the one this exclusion exists to fix. A
 * false alert about Infinity AI is noise the owner can see; silence about a
 * customer's breached SLA is invisible until they raise it. So the exclusion
 * names ONE organisation, and anything else stays monitored.
 *
 * navItems.ts reached the same conclusion for `staffOnly` and for the same
 * reason. This is that rule applied to alerting.
 */
export const OPERATOR_ORG_CODE = "INFINITY_AI";

/**
 * Which organisations are real CLIENTS, keyed by id.
 *
 * Excludes demo tenants, and excludes the platform operator itself. An exception
 * whose organizationId is not in this map — a demo tenant, Infinity AI, or an
 * org-less legacy row — is never alerted on. Exported for the test, which is the
 * point: the rule is a pure lookup rather than a pattern buried in a filter.
 *
 * The operator exclusion is not tidiness. An SLA is a promise to a customer, and
 * Infinity AI has none with itself, so a breach there is not a breach of
 * anything. It also happens to be the ONLY organisation with isDemo = 0 today,
 * which made it the single point where any stray row pages the owner: a demo
 * seed run by a super admin filed 66 FMCG exceptions against it, and the 24-hour
 * timer then produced a CRITICAL alert naming "Infinity AI Africa Limited" as
 * the affected client.
 *
 * Not solved by marking Infinity AI as a demo tenant either: that would be false,
 * and would quietly change every other rule that reads `isDemo`.
 */
export function realOrganizations(
  orgs: Array<{ id: number; name: string; isDemo: boolean; code: string | null }>,
): Map<number, string> {
  return new Map(
    orgs
      .filter((o) => !o.isDemo && o.code !== OPERATOR_ORG_CODE)
      .map((o) => [o.id, o.name]),
  );
}

/**
 * Check open exceptions for SLA breaches and notify the platform operator.
 *
 * Demo tenants are excluded by `organizations.isDemo`, not by guessing from job
 * names. Breaches are attributed to their organisation.
 */
export async function checkSLABreaches(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;

    // 1. Real (non-demo) organisations. Everything else is out of scope before a
    //    single exception is examined.
    const orgs = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        isDemo: organizations.isDemo,
        code: organizations.code,
      })
      .from(organizations);
    const real = realOrganizations(orgs);

    if (real.size === 0) {
      console.log('[SLA Monitor] No client organisations (demo and operator excluded) — nothing to check.');
      return;
    }

    // 2. Open exceptions BELONGING TO those organisations. The organizationId
    //    predicate is in the query rather than a post-filter, so an org-less
    //    legacy exception cannot arrive and be attributed to nobody.
    const openExceptions = await db
      .select()
      .from(exceptions)
      .where(
        and(
          or(eq(exceptions.status, "open"), eq(exceptions.status, "in_review")),
          inArray(exceptions.organizationId, Array.from(real.keys())),
        ),
      )
      .limit(10000);

    const breaches: SLABreach[] = [];
    const now = new Date();

    for (const exception of openExceptions) {
      if (!exception.createdAt) continue;
      const orgName = exception.organizationId === null ? null : real.get(exception.organizationId);
      if (!orgName) continue; // belt and braces; the query already excluded these

      const hoursOpen = (now.getTime() - exception.createdAt.getTime()) / (1000 * 60 * 60);
      const severity =
        hoursOpen >= SLA_BREACH_THRESHOLD ? 'critical'
        : hoursOpen >= SLA_WARNING_THRESHOLD ? 'warning'
        : null;
      if (!severity) continue;

      breaches.push({
        exceptionId: exception.id,
        organizationId: exception.organizationId,
        organizationName: orgName,
        hoursOpen: Math.round(hoursOpen * 10) / 10,
        severity,
        assignedTo: exception.assignedTo || undefined,
      });
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

    if (breaches.length > 0) {
      await sendSLABreachNotification(breaches);
    }

    const demoCount = orgs.length - real.size;
    console.log(
      `[SLA Monitor] Checked ${openExceptions.length} open exceptions across ${real.size} client organisation(s) ` +
      `(${demoCount} demo organisation(s) excluded), found ${breaches.length} SLA breaches`,
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

  const lines: string[] = [];

  // Lead with the per-organisation split. 374 bare exception ids told the reader
  // nothing about who was affected or where to start; once more than one client
  // exists, the tenant is the first thing that matters.
  const byOrg = new Map<string, { critical: number; warning: number }>();
  for (const b of breaches) {
    const row = byOrg.get(b.organizationName) ?? { critical: 0, warning: 0 };
    row[b.severity]++;
    byOrg.set(b.organizationName, row);
  }
  if (byOrg.size > 0) {
    lines.push('By organisation:');
    for (const [name, c] of Array.from(byOrg.entries()).sort((a, b) => (b[1].critical + b[1].warning) - (a[1].critical + a[1].warning))) {
      lines.push(`  ${name} — ${c.critical} breached, ${c.warning} approaching`);
    }
    lines.push('');
  }

  const describe = (b: SLABreach) =>
    `${b.organizationName} · Exception #${b.exceptionId} — ${b.hoursOpen}hrs open — ` +
    (b.assignedUserName ? `Assigned to: ${b.assignedUserName}` : 'Unassigned');

  if (criticalBreaches.length > 0) {
    lines.push(`🔴 CRITICAL — ${criticalBreaches.length} exception${criticalBreaches.length !== 1 ? 's' : ''} breached the 24-hour SLA:`);
    lines.push('');
    // Oldest first — the reader should see the worst, not the lowest id.
    criticalBreaches.slice()
      .sort((a, b) => b.hoursOpen - a.hoursOpen)
      .slice(0, 10)
      .forEach((breach, i) => lines.push(`  ${i + 1}. ${describe(breach)}`));
    if (criticalBreaches.length > 10) {
      lines.push(`  ...and ${criticalBreaches.length - 10} more critical exceptions`);
    }
    lines.push('');
  }

  if (warningBreaches.length > 0) {
    lines.push(`⚠️ WARNING — ${warningBreaches.length} exception${warningBreaches.length !== 1 ? 's' : ''} approaching the 24-hour SLA limit:`);
    lines.push('');
    warningBreaches.slice()
      .sort((a, b) => b.hoursOpen - a.hoursOpen)
      .slice(0, 10)
      .forEach((breach, i) => {
        const timeRemaining = SLA_BREACH_THRESHOLD - breach.hoursOpen;
        lines.push(`  ${i + 1}. ${describe(breach)} — ${timeRemaining.toFixed(1)}hrs remaining`);
      });
    if (warningBreaches.length > 10) {
      lines.push(`  ...and ${warningBreaches.length - 10} more warning exceptions`);
    }
    lines.push('');
  }

  lines.push('Action Required: Please review and resolve these exceptions to maintain SLA compliance.');
  lines.push(`${SLA_BREACH_THRESHOLD}-hour SLA Target: All exceptions should be resolved within ${SLA_BREACH_THRESHOLD} hours of creation.`);
  lines.push('');
  // States the MECHANISM, not a bare assurance. The previous footer promised
  // "Demo data exceptions are excluded" while the alert was made almost entirely
  // of demo data — a claim the reader could not check and that happened to be
  // false. Naming the rule makes the promise falsifiable.
  lines.push('Scope: organisations flagged as demo tenants (organizations.isDemo) are excluded from this alert.');

  const content = lines.join('\n');

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
