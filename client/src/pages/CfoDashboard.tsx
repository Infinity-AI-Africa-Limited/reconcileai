import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, AlertCircle, Clock, Activity, Download, Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import jsPDF from "jspdf";
import { useState, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
} from "recharts";

// ── Date range presets ──────────────────────────────────────────────
type DatePreset = "7d" | "30d" | "mtd" | "all";

function getDateRange(preset: DatePreset): { dateFrom?: Date; dateTo?: Date } {
  const now = new Date();
  if (preset === "7d") {
    const from = new Date(now);
    from.setDate(from.getDate() - 7);
    return { dateFrom: from, dateTo: now };
  }
  if (preset === "30d") {
    const from = new Date(now);
    from.setDate(from.getDate() - 30);
    return { dateFrom: from, dateTo: now };
  }
  if (preset === "mtd") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { dateFrom: from, dateTo: now };
  }
  return {};
}

const MATCH_THRESHOLD = 95;

// ── Custom bar shape — colour by match rate threshold ───────────────
const ThresholdBar = (props: any) => {
  const { x, y, width, height, matchRate } = props;
  const fill =
    matchRate === undefined
      ? "#10B981"
      : matchRate >= MATCH_THRESHOLD
      ? "#10B981"
      : matchRate >= 85
      ? "#F59E0B"
      : "#EF4444";
  return <rect x={x} y={y} width={width} height={height} fill={fill} rx={2} />;
};

export default function CfoDashboard() {
  const [isExporting, setIsExporting] = useState(false);
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [channelSearch, setChannelSearch] = useState("");

  const dateRange = useMemo(() => getDateRange(datePreset), [datePreset]);

  const { data: kpis, isLoading: kpisLoading } = trpc.dashboard.cfoKpis.useQuery();
  const { data: allChannelHealth, isLoading: channelLoading } = trpc.dashboard.cfoChannelHealth.useQuery(
    { dateFrom: dateRange.dateFrom, dateTo: dateRange.dateTo }
  );

  // All unique channel names for the filter dropdown
  const allChannelNames = useMemo(
    () => (allChannelHealth ?? []).map((c) => ({ name: c.channel, code: c.channelCode })),
    [allChannelHealth]
  );

  // Apply channel filter client-side (fast, no extra round-trip)
  const chartData = useMemo(() => {
    if (!allChannelHealth) return [];
    if (selectedChannels.length === 0) return allChannelHealth;
    return allChannelHealth.filter((c) => selectedChannels.includes(c.channelCode));
  }, [allChannelHealth, selectedChannels]);

  const filteredSearch = useMemo(
    () =>
      allChannelNames.filter((c) =>
        c.name.toLowerCase().includes(channelSearch.toLowerCase())
      ),
    [allChannelNames, channelSearch]
  );

  const toggleChannel = (code: string) => {
    setSelectedChannels((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  const clearChannels = () => setSelectedChannels([]);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-NG").format(num);
  const formatPercentage = (num: number) => `${num.toFixed(1)}%`;
  const formatTime = (hours: number) => {
    if (hours < 1) return `${Math.round(hours * 60)}min`;
    return `${hours.toFixed(1)}hrs`;
  };

  const exportToPDF = async () => {
    setIsExporting(true);
    try {
      const jsPDF = (await import("jspdf")).default;
      const pdf = new jsPDF("p", "mm", "a4");
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 15;
      let yPosition = margin;

      pdf.setFillColor(27, 54, 93);
      pdf.rect(0, 0, pageWidth, 35, "F");
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(24);
      pdf.setFont("helvetica", "bold");
      pdf.text("ReconcileAI", margin, 15);
      pdf.setFontSize(14);
      pdf.setFont("helvetica", "normal");
      pdf.text("CFO Dashboard Report", margin, 25);
      pdf.setFontSize(10);
      pdf.text(`Generated: ${new Date().toLocaleString("en-NG")}`, margin, 30);

      yPosition = 45;
      pdf.setTextColor(0, 0, 0);
      pdf.setFontSize(16);
      pdf.setFont("helvetica", "bold");
      pdf.text("Key Performance Indicators", margin, yPosition);
      yPosition += 10;

      pdf.setFontSize(11);
      pdf.setFont("helvetica", "normal");
      const kpiData = [
        ["Total Transactions", formatNumber(kpis?.totalTransactions || 0)],
        ["Match Rate", formatPercentage(kpis?.matchRate || 0)],
        ["Total Exceptions", String(kpis?.totalExceptions || 0)],
        ["Avg Processing Time", formatTime(kpis?.avgProcessingTime || 0)],
      ];
      kpiData.forEach(([label, value]) => {
        pdf.setFont("helvetica", "bold");
        pdf.text(label + ":", margin, yPosition);
        pdf.setFont("helvetica", "normal");
        pdf.text(value, margin + 60, yPosition);
        yPosition += 7;
      });

      yPosition += 5;
      pdf.setFontSize(16);
      pdf.setFont("helvetica", "bold");
      pdf.text("Channel Health Metrics", margin, yPosition);
      yPosition += 10;

      pdf.setFillColor(240, 240, 240);
      pdf.rect(margin, yPosition - 5, pageWidth - 2 * margin, 8, "F");
      pdf.setFontSize(10);
      pdf.setFont("helvetica", "bold");
      pdf.text("Channel", margin + 2, yPosition);
      pdf.text("Volume", margin + 50, yPosition);
      pdf.text("Match Rate", margin + 90, yPosition);
      pdf.text("Exceptions", margin + 130, yPosition);
      pdf.text("Status", margin + 165, yPosition);
      yPosition += 8;

      pdf.setFont("helvetica", "normal");
      chartData.forEach((channel: any, index: number) => {
        if (yPosition > pageHeight - 20) {
          pdf.addPage();
          yPosition = margin;
        }
        if (index % 2 === 0) {
          pdf.setFillColor(250, 250, 250);
          pdf.rect(margin, yPosition - 5, pageWidth - 2 * margin, 7, "F");
        }
        pdf.text(channel.channel, margin + 2, yPosition);
        pdf.text(formatNumber(channel.volume), margin + 50, yPosition);
        pdf.text(formatPercentage(channel.matchRate), margin + 90, yPosition);
        pdf.text(String(channel.exceptions), margin + 130, yPosition);
        const statusColor =
          channel.matchRate >= 95
            ? [34, 197, 94]
            : channel.matchRate >= 85
            ? [251, 146, 60]
            : [239, 68, 68];
        pdf.setTextColor(statusColor[0], statusColor[1], statusColor[2]);
        pdf.text(
          channel.matchRate >= 95 ? "Excellent" : channel.matchRate >= 85 ? "Good" : "Needs Attention",
          margin + 165,
          yPosition
        );
        pdf.setTextColor(0, 0, 0);
        yPosition += 7;
      });

      pdf.setFontSize(8);
      pdf.setTextColor(140, 117, 125);
      pdf.text("ReconcileAI - Confidential Report", margin, pageHeight - 10);
      pdf.save(`CFO-Dashboard-Report-${new Date().toISOString().split("T")[0]}.pdf`);
    } catch (error) {
      console.error("PDF export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  if (kpisLoading || channelLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-[#1B365D]">CFO Dashboard</h1>
          <p className="text-[#8C757D] mt-1">Executive financial reconciliation overview</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="pb-2">
                <div className="h-4 bg-gray-200 rounded w-24"></div>
              </CardHeader>
              <CardContent>
                <div className="h-8 bg-gray-200 rounded w-16 mb-2"></div>
                <div className="h-3 bg-gray-200 rounded w-32"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const presetLabels: Record<DatePreset, string> = {
    "7d": "Last 7 Days",
    "30d": "Last 30 Days",
    mtd: "Month to Date",
    all: "All Time",
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[#1B365D]">CFO Dashboard</h1>
          <p className="text-[#8C757D] mt-1">Executive financial reconciliation overview</p>
        </div>
        <Button
          onClick={exportToPDF}
          disabled={isExporting}
          className="gap-2 bg-[#1B365D] hover:bg-[#2A4A7C]"
        >
          <Download className={`h-4 w-4 ${isExporting ? "animate-bounce" : ""}`} />
          {isExporting ? "Exporting..." : "Export PDF"}
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">Total Transactions</CardTitle>
            <Activity className="h-4 w-4 text-[#F47458]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">{formatNumber(kpis?.totalTransactions || 0)}</div>
            <p className="text-xs text-[#8C757D] mt-1">Across all channels</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">Match Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">{formatPercentage(kpis?.matchRate || 0)}</div>
            <p className="text-xs text-[#8C757D] mt-1">
              {kpis?.matchRate && kpis.matchRate >= 95 ? "Excellent performance" : "Needs attention"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">Open Exceptions</CardTitle>
            <AlertCircle className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">{formatNumber(kpis?.totalExceptions || 0)}</div>
            <p className="text-xs text-[#8C757D] mt-1">Requiring review</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">Avg Processing Time</CardTitle>
            <Clock className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">{formatTime(kpis?.avgProcessingTime || 0)}</div>
            <p className="text-xs text-[#8C757D] mt-1">Per reconciliation job</p>
          </CardContent>
        </Card>
      </div>

      {/* Channel Performance Chart */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-lg font-semibold text-[#1B365D]">Channel Performance Overview</CardTitle>
              <p className="text-sm text-[#8C757D] mt-1">Match rates and exception counts by payment channel</p>
            </div>

            {/* Controls row */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Date range presets */}
              <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                {(["7d", "30d", "mtd", "all"] as DatePreset[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setDatePreset(p)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      datePreset === p
                        ? "bg-[#1B365D] text-white shadow-sm"
                        : "text-[#8C757D] hover:text-[#1B365D]"
                    }`}
                  >
                    {presetLabels[p]}
                  </button>
                ))}
              </div>

              {/* Channel filter dropdown */}
              <div className="relative group">
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-xs font-medium text-[#1B365D] hover:border-[#1B365D] transition-colors">
                  <Filter className="h-3 w-3" />
                  Channels
                  {selectedChannels.length > 0 && (
                    <Badge className="ml-1 h-4 px-1.5 text-[10px] bg-[#F47458] text-white">
                      {selectedChannels.length}
                    </Badge>
                  )}
                </button>
                {/* Dropdown panel */}
                <div className="absolute right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-20 hidden group-focus-within:block group-hover:block">
                  <div className="p-2 border-b border-gray-100">
                    <input
                      type="text"
                      placeholder="Search channels…"
                      value={channelSearch}
                      onChange={(e) => setChannelSearch(e.target.value)}
                      className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-[#1B365D]"
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto p-1">
                    {filteredSearch.map((c) => (
                      <label
                        key={c.code}
                        className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedChannels.includes(c.code)}
                          onChange={() => toggleChannel(c.code)}
                          className="rounded border-gray-300 text-[#1B365D]"
                        />
                        <span className="text-xs text-[#1B365D]">{c.name}</span>
                      </label>
                    ))}
                    {filteredSearch.length === 0 && (
                      <p className="text-xs text-gray-400 px-2 py-2">No channels found</p>
                    )}
                  </div>
                  {selectedChannels.length > 0 && (
                    <div className="p-2 border-t border-gray-100">
                      <button
                        onClick={clearChannels}
                        className="w-full text-xs text-[#F47458] hover:underline"
                      >
                        Clear all filters
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Active filter chips */}
          {selectedChannels.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {selectedChannels.map((code) => {
                const ch = allChannelNames.find((c) => c.code === code);
                return (
                  <span
                    key={code}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#EEF2F8] text-[#1B365D] rounded-full text-xs font-medium"
                  >
                    {ch?.name ?? code}
                    <button onClick={() => toggleChannel(code)} className="hover:text-[#F47458]">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
              <button onClick={clearChannels} className="text-xs text-[#8C757D] hover:text-[#F47458] ml-1">
                Clear all
              </button>
            </div>
          )}

          {/* Legend for bar colours */}
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5 text-xs text-[#8C757D]">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#10B981]"></span>≥ 95% (Excellent)
            </div>
            <div className="flex items-center gap-1.5 text-xs text-[#8C757D]">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#F59E0B]"></span>85–94% (Good)
            </div>
            <div className="flex items-center gap-1.5 text-xs text-[#8C757D]">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#EF4444]"></span>&lt; 85% (Needs Attention)
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                <XAxis
                  dataKey="channel"
                  tick={{ fill: "#8C757D", fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={80}
                />
                <YAxis yAxisId="left" tick={{ fill: "#8C757D", fontSize: 12 }} />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fill: "#10B981", fontSize: 12 }}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#FFFFFF",
                    border: "1px solid #E5E7EB",
                    borderRadius: "8px",
                  }}
                  formatter={(value: any, name: string) => {
                    if (name === "Match Rate") return [`${Number(value).toFixed(1)}%`, "Match Rate"];
                    return [formatNumber(value), "Exceptions"];
                  }}
                />
                <Legend />
                {/* 95% threshold reference line on right axis */}
                <ReferenceLine
                  yAxisId="right"
                  y={MATCH_THRESHOLD}
                  stroke="#F47458"
                  strokeDasharray="5 3"
                  strokeWidth={1.5}
                  label={{ value: "95% target", position: "insideTopRight", fill: "#F47458", fontSize: 10 }}
                />
                <Bar
                  yAxisId="right"
                  dataKey="matchRate"
                  name="Match Rate"
                  shape={(props: any) => (
                    <ThresholdBar {...props} matchRate={props.matchRate ?? props?.payload?.matchRate} />
                  )}
                />
                <Bar yAxisId="left" dataKey="exceptions" fill="#F47458" name="Exceptions" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Channel Health Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold text-[#1B365D]">Detailed Channel Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[#1B365D]">Channel</th>
                  <th className="text-right py-3 px-4 text-sm font-semibold text-[#1B365D]">Total</th>
                  <th className="text-right py-3 px-4 text-sm font-semibold text-[#1B365D]">Matched</th>
                  <th className="text-right py-3 px-4 text-sm font-semibold text-[#1B365D]">Exceptions</th>
                  <th className="text-right py-3 px-4 text-sm font-semibold text-[#1B365D]">Match Rate</th>
                  <th className="text-right py-3 px-4 text-sm font-semibold text-[#1B365D]">Status</th>
                </tr>
              </thead>
              <tbody>
                {chartData.map((channel, idx) => (
                  <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-3 px-4 text-sm text-[#1B365D] font-medium">{channel.channel}</td>
                    <td className="py-3 px-4 text-sm text-[#8C757D] text-right">{formatNumber(channel.volume)}</td>
                    <td className="py-3 px-4 text-sm text-[#8C757D] text-right">
                      {formatNumber(Math.round((channel.volume * channel.matchRate) / 100))}
                    </td>
                    <td className="py-3 px-4 text-sm text-[#8C757D] text-right">{formatNumber(channel.exceptions)}</td>
                    <td
                      className={`py-3 px-4 text-sm text-right font-semibold ${
                        channel.matchRate >= MATCH_THRESHOLD
                          ? "text-green-600"
                          : channel.matchRate >= 85
                          ? "text-amber-600"
                          : "text-red-600"
                      }`}
                    >
                      {formatPercentage(channel.matchRate)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          channel.matchRate >= MATCH_THRESHOLD
                            ? "bg-green-100 text-green-800"
                            : channel.matchRate >= 85
                            ? "bg-yellow-100 text-yellow-800"
                            : "bg-red-100 text-red-800"
                        }`}
                      >
                        {channel.matchRate >= MATCH_THRESHOLD
                          ? "Excellent"
                          : channel.matchRate >= 85
                          ? "Good"
                          : "Needs Attention"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
