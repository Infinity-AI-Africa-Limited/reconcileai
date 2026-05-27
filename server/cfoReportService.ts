/**
 * CFO Report Service
 * - Weekly CSV channel metrics email (triggered by Heartbeat cron)
 * - Threshold breach checker (called on-demand or by a cron)
 * - Channel 30-day drill-down data
 */
import * as db from "./db";
import { notifyOwner } from "./_core/notification";

// ─── Types ──────────────────────────────────────────────────────────

export interface ChannelMetricRow {
  channel: string;
  channelCode: string;
  volume: number;
  matched: number;
  exceptions: number;
  matchRate: number;
}

export interface ChannelDrillDown {
  channelCode: string;
  channelName: string;
  // 30-day daily breakdown
  dailyTrend: { day: string; total: number; matched: number; matchRate: number }[];
  // Top exception types
  topExceptionTypes: { category: string; count: number; severity: string }[];
  // Recent reconciliation jobs that touched this channel
  recentJobs: { id: number; name: string; status: string; matchRate: string | null; createdAt: Date }[];
}

// ─── Date helpers ────────────────────────────────────────────────────

function getDateRange(period: string): { dateFrom: Date; dateTo: Date } {
  const now = new Date();
  const dateTo = new Date(now);
  let dateFrom: Date;
  if (period === "7d") {
    dateFrom = new Date(now);
    dateFrom.setDate(dateFrom.getDate() - 7);
  } else if (period === "30d") {
    dateFrom = new Date(now);
    dateFrom.setDate(dateFrom.getDate() - 30);
  } else if (period === "mtd") {
    dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    // Default: last 7 days
    dateFrom = new Date(now);
    dateFrom.setDate(dateFrom.getDate() - 7);
  }
  return { dateFrom, dateTo };
}

// ─── Build channel metrics for a period ─────────────────────────────

export async function buildChannelMetrics(
  period: string,
  channelCodes?: string[]
): Promise<ChannelMetricRow[]> {
  const { dateFrom, dateTo } = getDateRange(period);
  const channels = await db.getChannels();
  const filtered = channelCodes && channelCodes.length > 0
    ? channels.filter((c) => channelCodes.includes(c.code))
    : channels;

  const rows: ChannelMetricRow[] = [];
  await Promise.all(
    filtered.map(async (channel) => {
      const { data: txns } = await db.getTransactions({
        channelId: channel.id,
        dateFrom,
        dateTo,
        limit: 10000,
      });
      const total = txns.length;
      if (total === 0) return; // skip zero-data channels
      const matched = txns.filter((t) => t.status === "matched").length;
      const exceptions = txns.filter((t) => t.status === "exception").length;
      rows.push({
        channel: channel.name,
        channelCode: channel.code,
        volume: total,
        matched,
        exceptions,
        matchRate: parseFloat(((matched / total) * 100).toFixed(1)),
      });
    })
  );
  return rows.sort((a, b) => b.volume - a.volume);
}

// ─── Generate CSV string ─────────────────────────────────────────────

export function buildCsvContent(rows: ChannelMetricRow[], period: string): string {
  const periodLabels: Record<string, string> = {
    "7d": "Last 7 Days",
    "30d": "Last 30 Days",
    mtd: "Month to Date",
  };
  const label = periodLabels[period] ?? period;
  const header = ["Channel", "Total Transactions", "Matched", "Exceptions", "Match Rate (%)", "Period"];
  const lines = [
    header.map((h) => `"${h}"`).join(","),
    ...rows.map((r) =>
      [`"${r.channel}"`, r.volume, r.matched, r.exceptions, r.matchRate.toFixed(1), `"${label}"`].join(",")
    ),
  ];
  return lines.join("\n");
}

// ─── Send weekly CSV report via notification ─────────────────────────

export async function sendWeeklyChannelReport(
  userId: number,
  period: string = "7d"
): Promise<{ success: boolean; channelsReported: number; error?: string }> {
  try {
    const rows = await buildChannelMetrics(period);
    if (rows.length === 0) {
      return { success: true, channelsReported: 0 };
    }

    const periodLabels: Record<string, string> = {
      "7d": "Last 7 Days",
      "30d": "Last 30 Days",
      mtd: "Month to Date",
    };
    const label = periodLabels[period] ?? period;
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });

    // Build markdown table for the notification
    let content = `# Weekly Channel Performance Report\n\n`;
    content += `**Period:** ${label}  |  **Generated:** ${dateStr}\n\n`;
    content += `| Channel | Total | Matched | Exceptions | Match Rate |\n`;
    content += `|---|---|---|---|---|\n`;
    for (const r of rows) {
      const status = r.matchRate >= 95 ? "✅" : r.matchRate >= 85 ? "⚠️" : "🔴";
      content += `| ${r.channel} | ${r.volume.toLocaleString()} | ${r.matched.toLocaleString()} | ${r.exceptions.toLocaleString()} | ${status} ${r.matchRate.toFixed(1)}% |\n`;
    }

    const belowThreshold = rows.filter((r) => r.matchRate < 95);
    if (belowThreshold.length > 0) {
      content += `\n## ⚠️ Channels Below 95% Threshold\n\n`;
      for (const r of belowThreshold) {
        content += `- **${r.channel}**: ${r.matchRate.toFixed(1)}% (${r.exceptions} exceptions)\n`;
      }
    }

    content += `\n---\n*This report was automatically generated by ReconcileAI. ${rows.length} channels with data.*`;

    const sent = await notifyOwner({
      title: `📊 Weekly Channel Report — ${label} (${dateStr})`,
      content,
    });

    if (!sent) {
      return { success: false, channelsReported: 0, error: "Notification service unavailable" };
    }

    await db.updateCfoReportScheduleLastSent(userId);
    return { success: true, channelsReported: rows.length };
  } catch (error) {
    console.error("[CfoReport] Weekly report failed:", error);
    return { success: false, channelsReported: 0, error: String(error) };
  }
}

// ─── Threshold breach checker ────────────────────────────────────────

export async function checkChannelThresholdBreaches(userId: number): Promise<{
  breachesFound: number;
  alertsSent: number;
}> {
  try {
    const alertSettings = await db.getChannelAlertSettings(userId);
    const enabledAlerts = alertSettings.filter((a) => a.alertEnabled);
    if (enabledAlerts.length === 0) return { breachesFound: 0, alertsSent: 0 };

    // Get current metrics for last 24h
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const channels = await db.getChannels();
    let breachesFound = 0;
    let alertsSent = 0;

    for (const alert of enabledAlerts) {
      const channel = channels.find((c) => c.code === alert.channelCode);
      if (!channel) continue;

      const { data: txns } = await db.getTransactions({
        channelId: channel.id,
        dateFrom: yesterday,
        dateTo: now,
        limit: 10000,
      });

      if (txns.length === 0) continue;

      const matched = txns.filter((t) => t.status === "matched").length;
      const matchRate = (matched / txns.length) * 100;
      const threshold = parseFloat(String(alert.threshold));

      if (matchRate < threshold) {
        breachesFound++;

        // Throttle: don't send more than one alert per channel per 4 hours
        const lastSent = alert.lastAlertSentAt;
        const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);
        if (lastSent && lastSent > fourHoursAgo) continue;

        const exceptions = txns.filter((t) => t.status === "exception").length;
        const sent = await notifyOwner({
          title: `🔴 Threshold Breach: ${channel.name} — ${matchRate.toFixed(1)}%`,
          content: `**Channel:** ${channel.name}\n**Current Match Rate:** ${matchRate.toFixed(1)}% (threshold: ${threshold}%)\n**Exceptions (last 24h):** ${exceptions}\n**Total Transactions:** ${txns.length}\n\nReview this channel at reconcileai.vip/dashboard/cfo`,
        });

        if (sent) {
          alertsSent++;
          await db.updateChannelAlertLastSent(userId, alert.channelCode);
        }
      }
    }

    return { breachesFound, alertsSent };
  } catch (error) {
    console.error("[CfoReport] Threshold check failed:", error);
    return { breachesFound: 0, alertsSent: 0 };
  }
}

// ─── Channel 30-day drill-down ────────────────────────────────────────

export async function getChannelDrillDown(channelCode: string): Promise<ChannelDrillDown | null> {
  const channels = await db.getChannels();
  const channel = channels.find((c) => c.code === channelCode);
  if (!channel) return null;

  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Build 30 daily buckets
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (29 - i));
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const dailyTrend: ChannelDrillDown["dailyTrend"] = [];
  for (const day of days) {
    const dayEnd = new Date(day);
    dayEnd.setHours(23, 59, 59, 999);
    const { data: txns } = await db.getTransactions({
      channelId: channel.id,
      dateFrom: day,
      dateTo: dayEnd,
      limit: 5000,
    });
    const total = txns.length;
    const matched = txns.filter((t) => t.status === "matched").length;
    dailyTrend.push({
      day: day.toISOString().slice(5, 10), // MM-DD
      total,
      matched,
      matchRate: total > 0 ? parseFloat(((matched / total) * 100).toFixed(1)) : 0,
    });
  }

  // Top exception types from last 30 days
  const { data: exceptions } = await db.getExceptions({
    limit: 500,
  });
  const channelExceptions = exceptions.filter((e) => {
    // Filter by channel via transaction (approximate: use exceptions in date range)
    const created = new Date(e.createdAt);
    return created >= thirtyDaysAgo;
  });

  const exceptionMap: Record<string, { count: number; severity: string }> = {};
  for (const e of channelExceptions) {
    if (!exceptionMap[e.category]) {
      exceptionMap[e.category] = { count: 0, severity: e.severity };
    }
    exceptionMap[e.category].count++;
  }
  const topExceptionTypes = Object.entries(exceptionMap)
    .map(([category, { count, severity }]) => ({ category, count, severity }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Recent jobs that used this channel
  const allJobs = await db.getReconciliationJobs(-1, true);
  const recentJobs = allJobs
    .filter((j) => j.sourceChannelId === channel.id || j.targetChannelId === channel.id)
    .slice(0, 5)
    .map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      matchRate: j.matchRate,
      createdAt: new Date(j.createdAt),
    }));

  return {
    channelCode: channel.code,
    channelName: channel.name,
    dailyTrend,
    topExceptionTypes,
    recentJobs,
  };
}
