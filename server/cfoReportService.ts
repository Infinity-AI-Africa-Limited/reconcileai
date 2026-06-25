/**
 * CFO Report Service
 * - Weekly CSV channel metrics email (triggered by Heartbeat cron)
 * - Threshold breach checker (called on-demand or by a cron)
 * - Channel 30-day drill-down data
 */
import * as db from "./db";
import { notifyOwner } from "./_core/notification";
import { sendEmail, renderBrandedHtml, markdownToBasicHtml } from "./_core/email";
import { storagePut } from "./storage";
import { loadExcelJS } from "./exceljsLoader";

// ─── Types ──────────────────────────────────────────────────────────

export interface ChannelMetricRow {
  channel: string;
  channelCode: string;
  volume: number;
  matched: number;
  exceptions: number;
  matchRate: number;
  /** Sum of amounts of exception-status transactions — the at-risk value for this channel. */
  exceptionAmount: number;
}

export interface BoardSummary {
  period: string;
  periodLabel: string;
  generatedAt: string;
  channelsReported: number;
  totalVolume: number;
  totalMatched: number;
  totalExceptions: number;
  /** Volume-weighted overall match rate across all channels. */
  overallMatchRate: number;
  /** Total at-risk value (sum of exception transaction amounts). */
  estimatedExposure: number;
  channelHealth: { good: number; warning: number; critical: number };
  exceptionsBySeverity: { critical: number; high: number; medium: number; low: number };
  topChannelsByExceptions: { channel: string; exceptions: number; matchRate: number }[];
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

/** 0-based quarter index (Jan–Mar = 0) for a date. */
function quarterOf(d: Date): number {
  return Math.floor(d.getMonth() / 3);
}

/** Human label for a quarter, e.g. "Q2 2026". */
function quarterLabel(year: number, q: number): string {
  return `Q${q + 1} ${year}`;
}

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
  } else if (period === "quarterly" || period === "qtd") {
    // Current quarter to date.
    dateFrom = new Date(now.getFullYear(), quarterOf(now) * 3, 1);
  } else if (period === "last_quarter") {
    // The previous complete calendar quarter.
    const q = quarterOf(now);
    if (q === 0) {
      dateFrom = new Date(now.getFullYear() - 1, 9, 1); // Q4 last year
      return { dateFrom, dateTo: new Date(now.getFullYear(), 0, 1) };
    }
    dateFrom = new Date(now.getFullYear(), (q - 1) * 3, 1);
    return { dateFrom, dateTo: new Date(now.getFullYear(), q * 3, 1) };
  } else {
    // Default: last 7 days
    dateFrom = new Date(now);
    dateFrom.setDate(dateFrom.getDate() - 7);
  }
  return { dateFrom, dateTo };
}

/** Single source of truth for period labels (used by CSV, Excel, email). */
export function periodLabel(period: string): string {
  const now = new Date();
  switch (period) {
    case "7d": return "Last 7 Days";
    case "30d": return "Last 30 Days";
    case "mtd": return "Month to Date";
    case "quarterly":
    case "qtd":
      return `${quarterLabel(now.getFullYear(), quarterOf(now))} (to date)`;
    case "last_quarter": {
      const q = quarterOf(now);
      return q === 0 ? quarterLabel(now.getFullYear() - 1, 3) : quarterLabel(now.getFullYear(), q - 1);
    }
    default: return period;
  }
}

/** Quarterly periods get the board-level executive treatment. */
export function isBoardPeriod(period: string): boolean {
  return period === "quarterly" || period === "qtd" || period === "last_quarter";
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
      // Exact SQL aggregate — not capped by the 500-row list limit.
      const agg = await db.getChannelTxnAggregate(channel.id, dateFrom, dateTo);
      if (agg.total === 0) return; // skip zero-data channels
      rows.push({
        channel: channel.name,
        channelCode: channel.code,
        volume: agg.total,
        matched: agg.matched,
        exceptions: agg.exceptions,
        matchRate: parseFloat(((agg.matched / agg.total) * 100).toFixed(1)),
        exceptionAmount: parseFloat(agg.exceptionAmount.toFixed(2)),
      });
    })
  );
  return rows.sort((a, b) => b.volume - a.volume);
}

// ─── Board-level executive summary (quarterly) ───────────────────────

export async function buildBoardSummary(period: string): Promise<BoardSummary> {
  const rows = await buildChannelMetrics(period);
  const { dateFrom, dateTo } = getDateRange(period);

  const totalVolume = rows.reduce((s, r) => s + r.volume, 0);
  const totalMatched = rows.reduce((s, r) => s + r.matched, 0);
  const totalExceptions = rows.reduce((s, r) => s + r.exceptions, 0);
  const estimatedExposure = parseFloat(rows.reduce((s, r) => s + r.exceptionAmount, 0).toFixed(2));
  // Volume-weighted overall match rate (a board cares about the blended figure,
  // not the simple average of channel rates).
  const overallMatchRate = totalVolume > 0 ? parseFloat(((totalMatched / totalVolume) * 100).toFixed(1)) : 0;

  const channelHealth = {
    good: rows.filter((r) => r.matchRate >= 95).length,
    warning: rows.filter((r) => r.matchRate >= 85 && r.matchRate < 95).length,
    critical: rows.filter((r) => r.matchRate < 85).length,
  };

  // Exception severity breakdown across the period. Use the DB's exact COUNT
  // (via getExceptions().total) per severity rather than fetching rows — list
  // queries are clamped to MAX_QUERY_LIMIT, which would silently undercount.
  const exceptionsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  try {
    await Promise.all(
      (["critical", "high", "medium", "low"] as const).map(async (sev) => {
        const { total } = await db.getExceptions({ severity: sev, dateFrom, dateTo, limit: 1 });
        exceptionsBySeverity[sev] = total;
      }),
    );
  } catch (err) {
    console.error("[CfoReport] severity breakdown unavailable (non-fatal):", err);
  }

  const topChannelsByExceptions = [...rows]
    .sort((a, b) => b.exceptions - a.exceptions)
    .slice(0, 3)
    .map((r) => ({ channel: r.channel, exceptions: r.exceptions, matchRate: r.matchRate }));

  return {
    period,
    periodLabel: periodLabel(period),
    generatedAt: new Date().toISOString(),
    channelsReported: rows.length,
    totalVolume,
    totalMatched,
    totalExceptions,
    overallMatchRate,
    estimatedExposure,
    channelHealth,
    exceptionsBySeverity,
    topChannelsByExceptions,
  };
}

// ─── Generate CSV string ─────────────────────────────────────────────

export function buildCsvContent(rows: ChannelMetricRow[], period: string): string {
  const label = periodLabel(period);
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
): Promise<{ success: boolean; channelsReported: number; xlsxUrl?: string; error?: string }> {
  try {
    const rows = await buildChannelMetrics(period);
    if (rows.length === 0) {
      return { success: true, channelsReported: 0 };
    }

    const label = periodLabel(period);
    const boardMode = isBoardPeriod(period);
    const board = boardMode ? await buildBoardSummary(period) : null;
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });

    // ── Build Excel workbook ────────────────────────────────────────────
    let xlsxUrl: string | undefined;
    let xlsxBuffer: Buffer | undefined;
    let xlsxFileName: string | undefined;
    try {
      const ExcelJS = await loadExcelJS();
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "ReconcileAI";
      workbook.created = now;

      const headerStyle = {
        font: { bold: true, color: { argb: "FFFFFFFF" } },
        fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1B365D" } },
        alignment: { horizontal: "left" as const },
      };
      const altRow = {
        fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF8F9FA" } },
      };

      // Sheet 0 (board reports only): Board Executive Summary — the headline KPIs
      // a board/audit committee reads first.
      if (board) {
        const bws = workbook.addWorksheet("Board Executive Summary");
        bws.columns = [
          { header: "Metric", key: "metric", width: 36 },
          { header: "Value", key: "value", width: 34 },
        ];
        bws.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
        bws.getRow(1).height = 20;
        bws.views = [{ state: "frozen", ySplit: 1 }];
        const ngn = (n: number) => `₦${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const boardRows = [
          { metric: "Reporting Period", value: board.periodLabel },
          { metric: "Generated At (UTC)", value: board.generatedAt },
          { metric: "Overall Match Rate (volume-weighted)", value: `${board.overallMatchRate}%` },
          { metric: "Total Transactions Reconciled", value: board.totalVolume },
          { metric: "Total Matched", value: board.totalMatched },
          { metric: "Total Exceptions", value: board.totalExceptions },
          { metric: "Estimated Financial Exposure (at-risk)", value: ngn(board.estimatedExposure) },
          { metric: "Channels — Healthy (≥95%)", value: board.channelHealth.good },
          { metric: "Channels — Warning (85–95%)", value: board.channelHealth.warning },
          { metric: "Channels — Critical (<85%)", value: board.channelHealth.critical },
          { metric: "Exceptions — Critical severity", value: board.exceptionsBySeverity.critical },
          { metric: "Exceptions — High severity", value: board.exceptionsBySeverity.high },
          { metric: "Exceptions — Medium severity", value: board.exceptionsBySeverity.medium },
          { metric: "Exceptions — Low severity", value: board.exceptionsBySeverity.low },
          ...board.topChannelsByExceptions.map((c, i) => ({
            metric: `Top Exception Channel #${i + 1}`,
            value: `${c.channel} — ${c.exceptions} exceptions (${c.matchRate}% match)`,
          })),
        ];
        boardRows.forEach((item, i) => {
          const r = bws.addRow(item);
          if (i % 2 === 1) r.eachCell((cell) => { cell.style = altRow; });
        });
      }

      // Sheet: Channel Metrics
      const ws = workbook.addWorksheet("Channel Metrics");
      ws.columns = [
        { header: "Channel", key: "channel", width: 28 },
        { header: "Channel Code", key: "channelCode", width: 16 },
        { header: "Total Transactions", key: "volume", width: 20 },
        { header: "Matched", key: "matched", width: 14 },
        { header: "Exceptions", key: "exceptions", width: 14 },
        { header: "Match Rate (%)", key: "matchRate", width: 16 },
        { header: "Status", key: "status", width: 12 },
        { header: "Period", key: "period", width: 16 },
      ];
      ws.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
      ws.getRow(1).height = 20;
      ws.views = [{ state: "frozen", ySplit: 1 }];
      (ws as any).autoFilter = ws.dimensions;
      // Number formatting
      ws.getColumn("volume").numFmt = "#,##0";
      ws.getColumn("matched").numFmt = "#,##0";
      ws.getColumn("exceptions").numFmt = "#,##0";
      ws.getColumn("matchRate").numFmt = "0.00";

      rows.forEach((r, i) => {
        const status = r.matchRate >= 95 ? "✅ Good" : r.matchRate >= 85 ? "⚠️ Warning" : "🔴 Critical";
        const row = ws.addRow({
          channel: r.channel,
          channelCode: r.channelCode,
          volume: r.volume,
          matched: r.matched,
          exceptions: r.exceptions,
          matchRate: r.matchRate,
          status,
          period: label,
        });
        if (i % 2 === 1) row.eachCell((cell) => { cell.style = altRow; });
      });

      // Sheet 2: Summary
      const summaryWs = workbook.addWorksheet("Summary");
      summaryWs.columns = [
        { header: "Field", key: "field", width: 28 },
        { header: "Value", key: "value", width: 32 },
      ];
      summaryWs.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
      summaryWs.getRow(1).height = 20;
      summaryWs.views = [{ state: "frozen", ySplit: 1 }];

      const totalVol = rows.reduce((s, r) => s + r.volume, 0);
      const totalMatched = rows.reduce((s, r) => s + r.matched, 0);
      const totalExceptions = rows.reduce((s, r) => s + r.exceptions, 0);
      const avgMatchRate = rows.length > 0
        ? parseFloat((rows.reduce((s, r) => s + r.matchRate, 0) / rows.length).toFixed(1))
        : 0;

      [
        { field: "Report Period", value: label },
        { field: "Generated At (UTC)", value: now.toISOString() },
        { field: "Channels Reported", value: rows.length },
        { field: "Total Transactions", value: totalVol },
        { field: "Total Matched", value: totalMatched },
        { field: "Total Exceptions", value: totalExceptions },
        { field: "Average Match Rate (%)", value: avgMatchRate },
        { field: "Channels Below 95% Threshold", value: rows.filter((r) => r.matchRate < 95).length },
        { field: "Generated By", value: "ReconcileAI Automated Report" },
      ].forEach((item, i) => {
        const r = summaryWs.addRow(item);
        if (i % 2 === 1) r.eachCell((cell) => { cell.style = altRow; });
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const fileName = `cfo-channel-report-${period}-${now.getTime()}.xlsx`;
      xlsxBuffer = Buffer.from(buffer);
      xlsxFileName = fileName;
      const { url } = await storagePut(
        `reports/cfo/${fileName}`,
        xlsxBuffer,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      xlsxUrl = url;
    } catch (xlsxErr) {
      console.error("[CfoReport] Excel generation failed (non-fatal):", xlsxErr);
    }

    // ── Build markdown notification ─────────────────────────────────────
    let content = board
      ? `# Quarterly Board Reconciliation Report\n\n`
      : `# Weekly Channel Performance Report\n\n`;
    content += `**Period:** ${label}  |  **Generated:** ${dateStr}\n\n`;

    if (board) {
      content += `## Board Executive Summary\n\n`;
      content += `- **Overall match rate (volume-weighted):** ${board.overallMatchRate}%\n`;
      content += `- **Total transactions reconciled:** ${board.totalVolume.toLocaleString()}\n`;
      content += `- **Total exceptions:** ${board.totalExceptions.toLocaleString()}\n`;
      content += `- **Estimated financial exposure (at-risk):** ₦${board.estimatedExposure.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
      content += `- **Channel health:** ${board.channelHealth.good} healthy · ${board.channelHealth.warning} warning · ${board.channelHealth.critical} critical\n`;
      content += `- **Exceptions by severity:** ${board.exceptionsBySeverity.critical} critical · ${board.exceptionsBySeverity.high} high · ${board.exceptionsBySeverity.medium} medium · ${board.exceptionsBySeverity.low} low\n\n`;
    }

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

    if (xlsxUrl) {
      content += `\n\n---\n📥 **[Download Excel Report](${xlsxUrl})**  *(link valid for 7 days)*`;
    }

    content += `\n\n---\n*This report was automatically generated by ReconcileAI. ${rows.length} channels with data.*`;

    const title = board
      ? `🏛️ Quarterly Board Report — ${label} (${dateStr})`
      : `📊 Weekly Channel Report — ${label} (${dateStr})`;

    // Deliver to the schedule owner's email (with the Excel attached); fall back
    // to a platform-owner notification if the owner has no email on file.
    const owner = await db.getUserById(userId);
    let sent = false;
    if (owner?.email) {
      const result = await sendEmail({
        to: owner.email,
        subject: title,
        html: renderBrandedHtml(title, markdownToBasicHtml(content)),
        text: content,
        attachments: xlsxBuffer
          ? [
              {
                filename: xlsxFileName ?? `cfo-channel-report-${period}.xlsx`,
                content: xlsxBuffer,
                contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              },
            ]
          : undefined,
      });
      sent = result.success;
    } else {
      sent = await notifyOwner({ title, content });
    }

    if (!sent) {
      return { success: false, channelsReported: 0, error: "Email delivery unavailable" };
    }

    await db.updateCfoReportScheduleLastSent(userId);
    return { success: true, channelsReported: rows.length, xlsxUrl };
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
    const owner = await db.getUserById(userId);
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
        const title = `🔴 Threshold Breach: ${channel.name} — ${matchRate.toFixed(1)}%`;
        const contentMd = `**Channel:** ${channel.name}\n**Current Match Rate:** ${matchRate.toFixed(1)}% (threshold: ${threshold}%)\n**Exceptions (last 24h):** ${exceptions}\n**Total Transactions:** ${txns.length}\n\nReview this channel at reconcileai.vip/dashboard/cfo`;
        let sent = false;
        if (owner?.email) {
          const result = await sendEmail({
            to: owner.email,
            subject: title,
            html: renderBrandedHtml(title, markdownToBasicHtml(contentMd)),
            text: contentMd,
          });
          sent = result.success;
        } else {
          sent = await notifyOwner({ title, content: contentMd });
        }

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
