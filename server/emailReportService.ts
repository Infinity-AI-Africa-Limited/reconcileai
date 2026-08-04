/**
 * Email Report Service
 * Generates detailed HTML reconciliation reports and sends them via the notification system.
 * Designed for Nigerian and African banking environments.
 */
import { notifyOwner } from "./_core/notification";
import * as db from "./db";

// ─── Types ──────────────────────────────────────────────────────────

export interface ReportData {
  jobId: number;
  jobName: string;
  sourceChannel: string;
  targetChannel: string;
  dateFrom: string;
  dateTo: string;
  totalSourceTxns: number;
  totalTargetTxns: number;
  matchedCount: number;
  exceptionCount: number;
  unmatchedCount: number;
  matchRate: string | null;
  processingTimeMs: number | null;
  matchBreakdown: Record<string, number>;
  exceptionBreakdown: Record<string, number>;
  severityBreakdown: Record<string, number>;
  topExceptions: Array<{
    category: string;
    severity: string;
    description: string | null;
    transactionId: number;
  }>;
}

export interface EmailReportOptions {
  includeMatchBreakdown?: boolean;
  includeExceptionDetails?: boolean;
  includeChannelPerformance?: boolean;
  includeTrendAnalysis?: boolean;
}

// ─── Report Data Collection ─────────────────────────────────────────

export async function collectReportData(jobId: number): Promise<ReportData | null> {
  const job = await db.getReconciliationJob(jobId);
  if (!job) return null;

  const jobMatches = await db.getMatchesByJob(jobId);
  const { data: jobExceptions } = await db.getExceptions({
    organizationId: job.organizationId ?? null,
    jobId,
    limit: 500,
  });

  const sourceChannel = await db.getChannelById(job.sourceChannelId);
  const targetChannel = await db.getChannelById(job.targetChannelId);

  const matchBreakdown: Record<string, number> = {};
  for (const m of jobMatches) {
    matchBreakdown[m.matchType] = (matchBreakdown[m.matchType] || 0) + 1;
  }

  const exceptionBreakdown: Record<string, number> = {};
  const severityBreakdown: Record<string, number> = {};
  for (const e of jobExceptions) {
    exceptionBreakdown[e.category] = (exceptionBreakdown[e.category] || 0) + 1;
    severityBreakdown[e.severity] = (severityBreakdown[e.severity] || 0) + 1;
  }

  const topExceptions = jobExceptions
    .filter((e) => e.severity === "critical" || e.severity === "high")
    .slice(0, 10)
    .map((e) => ({
      category: e.category,
      severity: e.severity,
      description: e.description,
      transactionId: e.transactionId,
    }));

  return {
    jobId: job.id,
    jobName: job.name,
    sourceChannel: sourceChannel?.name || `Channel #${job.sourceChannelId}`,
    targetChannel: targetChannel?.name || `Channel #${job.targetChannelId}`,
    dateFrom: job.dateFrom ? new Date(job.dateFrom).toISOString().split("T")[0] : "N/A",
    dateTo: job.dateTo ? new Date(job.dateTo).toISOString().split("T")[0] : "N/A",
    totalSourceTxns: job.totalSourceTxns,
    totalTargetTxns: job.totalTargetTxns,
    matchedCount: job.matchedCount,
    exceptionCount: job.exceptionCount,
    unmatchedCount: job.unmatchedCount,
    matchRate: job.matchRate,
    processingTimeMs: job.processingTimeMs,
    matchBreakdown,
    exceptionBreakdown,
    severityBreakdown,
    topExceptions,
  };
}

// ─── Report Formatting ──────────────────────────────────────────────

function formatDuration(ms: number | null): string {
  if (!ms) return "N/A";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatCategory(category: string): string {
  return category
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getSeverityEmoji(severity: string): string {
  switch (severity) {
    case "critical": return "🔴";
    case "high": return "🟠";
    case "medium": return "🟡";
    case "low": return "🟢";
    default: return "⚪";
  }
}

function getMatchRateStatus(rate: number): { label: string; color: string } {
  if (rate >= 95) return { label: "Excellent", color: "#22c55e" };
  if (rate >= 85) return { label: "Good", color: "#3b82f6" };
  if (rate >= 70) return { label: "Fair", color: "#f59e0b" };
  return { label: "Needs Attention", color: "#ef4444" };
}

// ─── HTML Report Generation ─────────────────────────────────────────

export function generateEmailReportContent(
  data: ReportData,
  options: EmailReportOptions = {}
): { title: string; content: string } {
  const {
    includeMatchBreakdown = true,
    includeExceptionDetails = true,
  } = options;

  const matchRate = parseFloat(data.matchRate || "0");
  const rateStatus = getMatchRateStatus(matchRate);
  const totalTxns = data.totalSourceTxns + data.totalTargetTxns;

  const title = `ReconcileAI Report: ${data.jobName} — ${matchRate.toFixed(1)}% Match Rate`;

  let content = `# Reconciliation Report: ${data.jobName}\n\n`;
  content += `**Date Range:** ${data.dateFrom} to ${data.dateTo}\n`;
  content += `**Source:** ${data.sourceChannel} | **Target:** ${data.targetChannel}\n`;
  content += `**Generated:** ${new Date().toISOString().replace("T", " ").split(".")[0]} UTC\n\n`;

  // Summary section
  content += `## Summary\n\n`;
  content += `| Metric | Value |\n|---|---|\n`;
  content += `| Match Rate | **${matchRate.toFixed(1)}%** (${rateStatus.label}) |\n`;
  content += `| Total Transactions | ${totalTxns.toLocaleString()} |\n`;
  content += `| Source Transactions | ${data.totalSourceTxns.toLocaleString()} |\n`;
  content += `| Target Transactions | ${data.totalTargetTxns.toLocaleString()} |\n`;
  content += `| Matched | ${data.matchedCount.toLocaleString()} |\n`;
  content += `| Exceptions | ${data.exceptionCount.toLocaleString()} |\n`;
  content += `| Unmatched | ${data.unmatchedCount.toLocaleString()} |\n`;
  content += `| Processing Time | ${formatDuration(data.processingTimeMs)} |\n\n`;

  // Match breakdown
  if (includeMatchBreakdown && Object.keys(data.matchBreakdown).length > 0) {
    content += `## Match Breakdown\n\n`;
    content += `| Match Type | Count | % of Matches |\n|---|---|---|\n`;
    for (const [type, count] of Object.entries(data.matchBreakdown)) {
      const pct = data.matchedCount > 0 ? ((count / data.matchedCount) * 100).toFixed(1) : "0.0";
      content += `| ${formatCategory(type)} | ${count} | ${pct}% |\n`;
    }
    content += "\n";
  }

  // Exception breakdown
  if (includeExceptionDetails && Object.keys(data.exceptionBreakdown).length > 0) {
    content += `## Exception Breakdown\n\n`;
    content += `| Category | Count | Severity Distribution |\n|---|---|---|\n`;
    for (const [category, count] of Object.entries(data.exceptionBreakdown)) {
      content += `| ${formatCategory(category)} | ${count} | — |\n`;
    }
    content += "\n";

    // Severity summary
    content += `### Severity Summary\n\n`;
    content += `| Severity | Count |\n|---|---|\n`;
    for (const [severity, count] of Object.entries(data.severityBreakdown)) {
      content += `| ${getSeverityEmoji(severity)} ${formatCategory(severity)} | ${count} |\n`;
    }
    content += "\n";

    // Top critical/high exceptions
    if (data.topExceptions.length > 0) {
      content += `### High-Priority Exceptions (Top ${data.topExceptions.length})\n\n`;
      for (const exc of data.topExceptions) {
        content += `- ${getSeverityEmoji(exc.severity)} **${formatCategory(exc.category)}** (Txn #${exc.transactionId}): ${exc.description || "No description"}\n`;
      }
      content += "\n";
    }
  }

  // Action items
  content += `## Recommended Actions\n\n`;
  if (matchRate < 70) {
    content += `- ⚠️ Match rate is below 70%. Review channel configurations and data quality.\n`;
  }
  if (data.severityBreakdown["critical"] > 0) {
    content += `- 🔴 ${data.severityBreakdown["critical"]} critical exceptions require immediate attention.\n`;
  }
  if (data.severityBreakdown["high"] > 0) {
    content += `- 🟠 ${data.severityBreakdown["high"]} high-severity exceptions should be reviewed within 24 hours.\n`;
  }
  if (data.unmatchedCount > totalTxns * 0.2) {
    content += `- 📊 Over 20% of transactions are unmatched. Consider adjusting tolerance parameters.\n`;
  }
  if (matchRate >= 95 && data.exceptionCount === 0) {
    content += `- ✅ Reconciliation completed successfully with no issues.\n`;
  }

  content += `\n---\n*This report was automatically generated by ReconcileAI. Job ID: ${data.jobId}*\n`;

  return { title, content };
}

// ─── Send Report ────────────────────────────────────────────────────

export async function sendReconciliationReport(
  jobId: number,
  options: EmailReportOptions = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    const data = await collectReportData(jobId);
    if (!data) {
      return { success: false, error: "Job not found" };
    }

    const { title, content } = generateEmailReportContent(data, options);

    // Send via notification system
    const sent = await notifyOwner({ title, content });

    if (!sent) {
      return { success: false, error: "Notification service unavailable" };
    }

    return { success: true };
  } catch (error) {
    console.error("[EmailReport] Failed to send report:", error);
    return { success: false, error: String(error) };
  }
}

// ─── Threshold Alert ────────────────────────────────────────────────

export async function checkAndSendAlerts(
  jobId: number,
  userId: number
): Promise<void> {
  try {
    const prefs = await db.getEmailPreferences(userId);
    if (!prefs || !prefs.emailEnabled) return;

    const job = await db.getReconciliationJob(jobId);
    if (!job) return;

    const matchRate = parseFloat(job.matchRate || "0");
    const lowThreshold = parseFloat(String(prefs.lowMatchRateThreshold) || "80");

    // Check low match rate
    if (prefs.notifyOnHighExceptions && matchRate < lowThreshold) {
      await notifyOwner({
        title: `⚠️ Low Match Rate Alert: ${job.name}`,
        content: `Reconciliation job "${job.name}" completed with a match rate of ${matchRate.toFixed(1)}%, which is below your threshold of ${lowThreshold}%. Please review the results in ReconcileAI.`,
      });
    }

    // Check high exception count
    if (prefs.notifyOnHighExceptions && job.exceptionCount > prefs.highExceptionThreshold) {
      await notifyOwner({
        title: `⚠️ High Exception Count: ${job.name}`,
        content: `Reconciliation job "${job.name}" generated ${job.exceptionCount} exceptions, exceeding your threshold of ${prefs.highExceptionThreshold}. Please review the exceptions in ReconcileAI.`,
      });
    }

    // Notify on failure
    if (prefs.notifyOnFailure && job.status === "failed") {
      await notifyOwner({
        title: `❌ Reconciliation Failed: ${job.name}`,
        content: `Reconciliation job "${job.name}" has failed. Please check the job details in ReconcileAI for more information.`,
      });
    }

    // Notify on completion
    if (prefs.notifyOnCompletion && job.status === "completed") {
      const { title, content } = generateEmailReportContent(
        (await collectReportData(jobId))!,
        {
          includeMatchBreakdown: prefs.includeMatchBreakdown,
          includeExceptionDetails: prefs.includeExceptionDetails,
          includeChannelPerformance: prefs.includeChannelPerformance,
          includeTrendAnalysis: prefs.includeTrendAnalysis,
        }
      );
      await notifyOwner({ title, content });
    }
  } catch (error) {
    console.error("[EmailReport] Alert check failed:", error);
  }
}
