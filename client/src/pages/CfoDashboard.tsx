import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  TrendingUp, AlertCircle, Clock, Activity, Download, Filter, X, Settings2,
  FileDown, Bell, BellRing, Mail, ChevronRight, Calendar, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState, useMemo, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
  LineChart, Line, Area, AreaChart,
} from "recharts";

// ── Date range presets ──────────────────────────────────────────────
type DatePreset = "7d" | "30d" | "mtd" | "all";

function getDateRange(preset: DatePreset): { dateFrom?: Date; dateTo?: Date } {
  const now = new Date();
  if (preset === "7d") {
    const from = new Date(now); from.setDate(from.getDate() - 7);
    return { dateFrom: from, dateTo: now };
  }
  if (preset === "30d") {
    const from = new Date(now); from.setDate(from.getDate() - 30);
    return { dateFrom: from, dateTo: now };
  }
  if (preset === "mtd") {
    return { dateFrom: new Date(now.getFullYear(), now.getMonth(), 1), dateTo: now };
  }
  return {};
}

const DEFAULT_THRESHOLD = 95;

function barColor(matchRate: number, threshold: number) {
  if (matchRate >= threshold) return "#10B981";
  if (matchRate >= 85) return "#F59E0B";
  return "#EF4444";
}

const ThresholdBar = (props: any) => {
  const { x, y, width, height, payload, threshold } = props;
  const rate = payload?.matchRate ?? 0;
  const fill = barColor(rate, threshold ?? DEFAULT_THRESHOLD);
  return <rect x={x} y={y} width={width} height={height} fill={fill} rx={2} />;
};

function Sparkline({ data, threshold }: { data: { day: string; matchRate: number }[]; threshold: number }) {
  if (!data || data.length === 0) return <span className="text-xs text-gray-300">—</span>;
  const last = data[data.length - 1].matchRate;
  const prev = data[data.length - 2]?.matchRate ?? last;
  const trend = last > prev ? "↑" : last < prev ? "↓" : "→";
  const trendColor = last >= threshold ? "text-green-600" : last >= 85 ? "text-amber-600" : "text-red-500";
  return (
    <div className="flex items-center gap-1.5">
      <div style={{ width: 64, height: 28 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
            <Line type="monotone" dataKey="matchRate" stroke={barColor(last, threshold)} strokeWidth={1.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <span className={`text-xs font-semibold ${trendColor}`}>{trend}</span>
    </div>
  );
}

// ── Threshold settings panel ────────────────────────────────────────
function ThresholdPanel({
  channels, thresholds, globalThreshold, onGlobalChange, onChannelChange, onClose,
}: {
  channels: { name: string; code: string }[];
  thresholds: Record<string, number>;
  globalThreshold: number;
  onGlobalChange: (v: number) => void;
  onChannelChange: (code: string, v: number) => void;
  onClose: () => void;
}) {
  const saveAlertSetting = trpc.cfoReports.saveAlertSetting.useMutation();
  const checkBreaches = trpc.cfoReports.checkBreaches.useMutation();
  const [breachResult, setBreachResult] = useState<{ breachesFound: number; alertsSent: number } | null>(null);

  const handleSave = async (code: string, val: number) => {
    onChannelChange(code, val);
    await saveAlertSetting.mutateAsync({ channelCode: code, threshold: val, alertEnabled: true });
  };

  const handleCheckBreaches = async () => {
    const result = await checkBreaches.mutateAsync();
    setBreachResult(result);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative z-10 h-full w-80 bg-white shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-[#1B365D]">Alert Threshold Settings</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[#1B365D] mb-1">Global Threshold (all channels)</label>
            <div className="flex items-center gap-2">
              <input type="range" min={50} max={100} step={1} value={globalThreshold}
                onChange={(e) => onGlobalChange(Number(e.target.value))} className="flex-1 accent-[#1B365D]" />
              <span className="text-sm font-bold text-[#1B365D] w-10 text-right">{globalThreshold}%</span>
            </div>
            <p className="text-xs text-[#8C757D] mt-1">Sets the reference line and bar colouring for all channels unless overridden below.</p>
          </div>
          <div className="border-t border-gray-100 pt-3">
            <p className="text-xs font-semibold text-[#1B365D] mb-2">Per-Channel Overrides</p>
            <div className="space-y-3">
              {channels.map((ch) => {
                const val = thresholds[ch.code] ?? globalThreshold;
                return (
                  <div key={ch.code}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs text-[#1B365D] truncate max-w-[160px]">{ch.name}</span>
                      <span className="text-xs font-semibold text-[#1B365D]">{val}%</span>
                    </div>
                    <input type="range" min={50} max={100} step={1} value={val}
                      onChange={(e) => handleSave(ch.code, Number(e.target.value))}
                      className="w-full accent-[#F47458]" />
                  </div>
                );
              })}
            </div>
          </div>
          {/* Breach check */}
          <div className="border-t border-gray-100 pt-3">
            <p className="text-xs font-semibold text-[#1B365D] mb-2">Breach Check</p>
            <Button size="sm" variant="outline" className="w-full gap-2 border-[#F47458] text-[#F47458] hover:bg-red-50"
              onClick={handleCheckBreaches} disabled={checkBreaches.isPending}>
              <BellRing className="h-3.5 w-3.5" />
              {checkBreaches.isPending ? "Checking…" : "Check Breaches Now"}
            </Button>
            {breachResult && (
              <p className="text-xs text-[#8C757D] mt-2 text-center">
                {breachResult.breachesFound} breach{breachResult.breachesFound !== 1 ? "es" : ""} found,{" "}
                {breachResult.alertsSent} alert{breachResult.alertsSent !== 1 ? "s" : ""} sent.
              </p>
            )}
          </div>
        </div>
        <div className="p-4 border-t border-gray-100">
          <Button size="sm" className="w-full bg-[#1B365D] hover:bg-[#2A4A7C] text-white" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}

// ── Schedule settings panel ─────────────────────────────────────────
function SchedulePanel({ onClose }: { onClose: () => void }) {
  const { data: schedule } = trpc.cfoReports.getSchedule.useQuery();
  const saveSchedule = trpc.cfoReports.saveSchedule.useMutation();
  const sendNow = trpc.cfoReports.sendNow.useMutation();
  const utils = trpc.useUtils();

  const [recipients, setRecipients] = useState<string[]>((schedule?.recipients as string[]) ?? []);
  const [emailInput, setEmailInput] = useState("");
  const [period, setPeriod] = useState<"7d" | "30d" | "mtd">((schedule?.reportPeriod as any) ?? "7d");
  const [isActive, setIsActive] = useState(schedule?.isActive ?? true);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const addEmail = () => {
    const email = emailInput.trim();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !recipients.includes(email)) {
      setRecipients((prev) => [...prev, email]);
      setEmailInput("");
    }
  };

  const handleSave = async () => {
    if (recipients.length === 0) return;
    await saveSchedule.mutateAsync({ recipients, reportPeriod: period, isActive });
    utils.cfoReports.getSchedule.invalidate();
  };

  const handleSendNow = async () => {
    const result = await sendNow.mutateAsync({ period });
    setSendResult(result.success ? `✅ Report sent (${result.channelsReported} channels)` : `❌ ${result.error}`);
  };

  const periodLabels = { "7d": "Last 7 Days", "30d": "Last 30 Days", mtd: "Month to Date" };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative z-10 h-full w-96 bg-white shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-[#1B365D]">Weekly Email Report Schedule</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Active toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-[#1B365D]">Weekly Report Active</p>
              <p className="text-xs text-[#8C757D]">Sends every Monday at 08:00 UTC</p>
            </div>
            <button
              onClick={() => setIsActive((v) => !v)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isActive ? "bg-[#1B365D]" : "bg-gray-200"}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isActive ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>

          {/* Report period */}
          <div>
            <label className="block text-xs font-semibold text-[#1B365D] mb-2">Report Period</label>
            <div className="flex gap-2">
              {(["7d", "30d", "mtd"] as const).map((p) => (
                <button key={p} onClick={() => setPeriod(p)}
                  className={`flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors ${period === p ? "bg-[#1B365D] text-white border-[#1B365D]" : "border-gray-200 text-[#8C757D] hover:border-[#1B365D]"}`}>
                  {periodLabels[p]}
                </button>
              ))}
            </div>
          </div>

          {/* Recipients */}
          <div>
            <label className="block text-xs font-semibold text-[#1B365D] mb-2">Recipients</label>
            <div className="flex gap-2 mb-2">
              <input type="email" placeholder="Add email address…" value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addEmail()}
                className="flex-1 px-2.5 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-[#1B365D]" />
              <Button size="sm" variant="outline" onClick={addEmail} className="text-xs border-[#1B365D] text-[#1B365D]">Add</Button>
            </div>
            <div className="space-y-1">
              {recipients.map((email) => (
                <div key={email} className="flex items-center justify-between px-2.5 py-1.5 bg-gray-50 rounded-md">
                  <span className="text-xs text-[#1B365D] truncate">{email}</span>
                  <button onClick={() => setRecipients((prev) => prev.filter((e) => e !== email))}
                    className="text-gray-400 hover:text-red-500 ml-2"><X className="h-3 w-3" /></button>
                </div>
              ))}
              {recipients.length === 0 && <p className="text-xs text-[#8C757D]">No recipients added yet.</p>}
            </div>
          </div>

          {/* Info */}
          <div className="bg-blue-50 rounded-lg p-3">
            <p className="text-xs text-blue-700">
              <strong>Note:</strong> The scheduled email requires the site to be deployed. After saving, deploy the site and the weekly report will fire every Monday at 08:00 UTC automatically.
            </p>
          </div>

          {/* Send now */}
          <div className="border-t border-gray-100 pt-3">
            <Button size="sm" variant="outline" className="w-full gap-2 border-[#1B365D] text-[#1B365D] hover:bg-[#EEF2F8]"
              onClick={handleSendNow} disabled={sendNow.isPending}>
              <Mail className="h-3.5 w-3.5" />
              {sendNow.isPending ? "Sending…" : "Send Report Now"}
            </Button>
            {sendResult && <p className="text-xs text-center mt-2 text-[#8C757D]">{sendResult}</p>}
          </div>
        </div>
        <div className="p-4 border-t border-gray-100 flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="flex-1 bg-[#1B365D] hover:bg-[#2A4A7C] text-white"
            onClick={handleSave} disabled={saveSchedule.isPending || recipients.length === 0}>
            {saveSchedule.isPending ? "Saving…" : "Save Schedule"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Channel Drill-Down Modal ────────────────────────────────────────
function DrillDownModal({ channelCode, channelName, onClose }: { channelCode: string; channelName: string; onClose: () => void }) {
  const { data, isLoading } = trpc.cfoReports.channelDrillDown.useQuery({ channelCode });

  const avgMatchRate = useMemo(() => {
    if (!data?.dailyTrend) return 0;
    const withData = data.dailyTrend.filter((d) => d.total > 0);
    if (withData.length === 0) return 0;
    return withData.reduce((s, d) => s + d.matchRate, 0) / withData.length;
  }, [data]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-3xl bg-white rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-bold text-[#1B365D]">{channelName}</h2>
            <p className="text-xs text-[#8C757D]">30-day channel drill-down</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center h-40">
              <RefreshCw className="h-6 w-6 animate-spin text-[#1B365D]" />
            </div>
          ) : !data ? (
            <p className="text-sm text-[#8C757D] text-center py-8">No data available for this channel.</p>
          ) : (
            <>
              {/* Summary stats */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-[#8C757D]">30-Day Avg Match Rate</p>
                  <p className={`text-2xl font-bold mt-1 ${avgMatchRate >= 95 ? "text-green-600" : avgMatchRate >= 85 ? "text-amber-600" : "text-red-600"}`}>
                    {avgMatchRate.toFixed(1)}%
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-[#8C757D]">Total Transactions</p>
                  <p className="text-2xl font-bold text-[#1B365D] mt-1">
                    {data.dailyTrend.reduce((s, d) => s + d.total, 0).toLocaleString()}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-[#8C757D]">Days with Data</p>
                  <p className="text-2xl font-bold text-[#1B365D] mt-1">
                    {data.dailyTrend.filter((d) => d.total > 0).length}
                  </p>
                </div>
              </div>

              {/* 30-day trend chart */}
              <div>
                <h3 className="text-sm font-semibold text-[#1B365D] mb-3">30-Day Match Rate Trend</h3>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.dailyTrend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="matchRateGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#1B365D" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#1B365D" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis dataKey="day" tick={{ fill: "#8C757D", fontSize: 10 }} interval={4} />
                      <YAxis domain={[0, 100]} tick={{ fill: "#8C757D", fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
                      <Tooltip formatter={(v: any) => [`${Number(v).toFixed(1)}%`, "Match Rate"]} />
                      <ReferenceLine y={95} stroke="#F47458" strokeDasharray="4 2" strokeWidth={1} />
                      <Area type="monotone" dataKey="matchRate" stroke="#1B365D" strokeWidth={2} fill="url(#matchRateGrad)" dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Top exception types */}
              {data.topExceptionTypes.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-[#1B365D] mb-3">Top Exception Types (Last 30 Days)</h3>
                  <div className="space-y-2">
                    {data.topExceptionTypes.map((exc) => (
                      <div key={exc.category} className="flex items-center justify-between py-1.5 border-b border-gray-100">
                        <div className="flex items-center gap-2">
                          <span className={`inline-block w-2 h-2 rounded-full ${exc.severity === "critical" ? "bg-red-500" : exc.severity === "high" ? "bg-orange-500" : exc.severity === "medium" ? "bg-amber-400" : "bg-green-400"}`} />
                          <span className="text-xs text-[#1B365D] capitalize">{exc.category.replace(/_/g, " ")}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{exc.severity}</Badge>
                          <span className="text-xs font-semibold text-[#1B365D]">{exc.count}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent jobs */}
              {data.recentJobs.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-[#1B365D] mb-3">Recent Reconciliation Jobs</h3>
                  <div className="space-y-2">
                    {data.recentJobs.map((job) => (
                      <div key={job.id} className="flex items-center justify-between py-2 border-b border-gray-100">
                        <div>
                          <p className="text-xs font-medium text-[#1B365D]">{job.name}</p>
                          <p className="text-[10px] text-[#8C757D]">{new Date(job.createdAt).toLocaleDateString("en-NG")}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {job.matchRate && (
                            <span className={`text-xs font-semibold ${parseFloat(job.matchRate) >= 95 ? "text-green-600" : parseFloat(job.matchRate) >= 85 ? "text-amber-600" : "text-red-600"}`}>
                              {parseFloat(job.matchRate).toFixed(1)}%
                            </span>
                          )}
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${job.status === "completed" ? "border-green-300 text-green-700" : job.status === "failed" ? "border-red-300 text-red-700" : "border-gray-300 text-gray-600"}`}>
                            {job.status}
                          </Badge>
                          <a href={`/reconciliation/${job.id}`} className="text-[#1B365D] hover:text-[#F47458]">
                            <ChevronRight className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────
export default function CfoDashboard() {
  const [isExporting, setIsExporting] = useState(false);
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [channelSearch, setChannelSearch] = useState("");
  const [showThresholdPanel, setShowThresholdPanel] = useState(false);
  const [showSchedulePanel, setShowSchedulePanel] = useState(false);
  const [globalThreshold, setGlobalThreshold] = useState(DEFAULT_THRESHOLD);
  const [channelThresholds, setChannelThresholds] = useState<Record<string, number>>({});
  const [drillDownChannel, setDrillDownChannel] = useState<{ code: string; name: string } | null>(null);

  const dateRange = useMemo(() => getDateRange(datePreset), [datePreset]);

  const { data: kpis, isLoading: kpisLoading } = trpc.dashboard.cfoKpis.useQuery();
  const { data: allChannelHealth, isLoading: channelLoading } = trpc.dashboard.cfoChannelHealth.useQuery(
    { dateFrom: dateRange.dateFrom, dateTo: dateRange.dateTo }
  );
  const { data: trendData } = trpc.dashboard.cfoChannelTrend.useQuery(undefined, { staleTime: 5 * 60 * 1000 });

  // Load persisted alert settings
  const { data: alertSettings } = trpc.cfoReports.getAlertSettings.useQuery();
  useMemo(() => {
    if (alertSettings) {
      const map: Record<string, number> = {};
      for (const s of alertSettings) {
        map[s.channelCode] = parseFloat(String(s.threshold));
      }
      setChannelThresholds((prev) => ({ ...map, ...prev }));
    }
  }, [alertSettings]);

  // Always filter out channels with zero transactions
  const activeChannelHealth = useMemo(() => {
    if (!allChannelHealth) return [];
    return allChannelHealth.filter((c) => c.volume > 0);
  }, [allChannelHealth]);

  const allChannelNames = useMemo(
    () => activeChannelHealth.map((c) => ({ name: c.channel, code: c.channelCode })),
    [activeChannelHealth]
  );

  const chartData = useMemo(() => {
    if (selectedChannels.length === 0) return activeChannelHealth;
    return activeChannelHealth.filter((c) => selectedChannels.includes(c.channelCode));
  }, [activeChannelHealth, selectedChannels]);

  const filteredSearch = useMemo(
    () => allChannelNames.filter((c) => c.name.toLowerCase().includes(channelSearch.toLowerCase())),
    [allChannelNames, channelSearch]
  );

  const toggleChannel = (code: string) =>
    setSelectedChannels((prev) => prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]);
  const clearChannels = () => setSelectedChannels([]);

  const getThreshold = useCallback(
    (code: string) => channelThresholds[code] ?? globalThreshold,
    [channelThresholds, globalThreshold]
  );

  const formatNumber = (num: number) => new Intl.NumberFormat("en-NG").format(num);
  const formatPercentage = (num: number) => `${num.toFixed(1)}%`;
  const formatTime = (hours: number) => hours < 1 ? `${Math.round(hours * 60)}min` : `${hours.toFixed(1)}hrs`;

  // CSV export (client-side, respects active filters)
  const exportToCSV = () => {
    const presetLabels: Record<DatePreset, string> = { "7d": "Last 7 Days", "30d": "Last 30 Days", mtd: "Month to Date", all: "All Time" };
    const header = ["Channel", "Total Transactions", "Matched", "Exceptions", "Match Rate (%)", "Status", "Period"];
    const rows = chartData.map((c) => {
      const matched = Math.round((c.volume * c.matchRate) / 100);
      const threshold = getThreshold(c.channelCode);
      const status = c.matchRate >= threshold ? "Excellent" : c.matchRate >= 85 ? "Good" : "Needs Attention";
      return [c.channel, c.volume, matched, c.exceptions, c.matchRate.toFixed(1), status, presetLabels[datePreset]];
    });
    const csv = [header, ...rows].map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `channel-metrics-${datePreset}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // PDF export
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
      pdf.setFontSize(24); pdf.setFont("helvetica", "bold");
      pdf.text("ReconcileAI", margin, 15);
      pdf.setFontSize(14); pdf.setFont("helvetica", "normal");
      pdf.text("CFO Dashboard Report", margin, 25);
      pdf.setFontSize(10);
      pdf.text(`Generated: ${new Date().toLocaleString("en-NG")}`, margin, 30);

      yPosition = 45;
      pdf.setTextColor(0, 0, 0);
      pdf.setFontSize(16); pdf.setFont("helvetica", "bold");
      pdf.text("Key Performance Indicators", margin, yPosition);
      yPosition += 10;

      pdf.setFontSize(11); pdf.setFont("helvetica", "normal");
      [
        ["Total Transactions", formatNumber(kpis?.totalTransactions || 0)],
        ["Match Rate", formatPercentage(kpis?.matchRate || 0)],
        ["Total Exceptions", String(kpis?.totalExceptions || 0)],
        ["Avg Processing Time", formatTime(kpis?.avgProcessingTime || 0)],
      ].forEach(([label, value]) => {
        pdf.setFont("helvetica", "bold"); pdf.text(label + ":", margin, yPosition);
        pdf.setFont("helvetica", "normal"); pdf.text(value, margin + 60, yPosition);
        yPosition += 7;
      });

      yPosition += 5;
      pdf.setFontSize(16); pdf.setFont("helvetica", "bold");
      pdf.text("Channel Health Metrics", margin, yPosition);
      yPosition += 10;

      pdf.setFillColor(240, 240, 240);
      pdf.rect(margin, yPosition - 5, pageWidth - 2 * margin, 8, "F");
      pdf.setFontSize(10); pdf.setFont("helvetica", "bold");
      pdf.text("Channel", margin + 2, yPosition);
      pdf.text("Volume", margin + 50, yPosition);
      pdf.text("Match Rate", margin + 90, yPosition);
      pdf.text("Exceptions", margin + 130, yPosition);
      pdf.text("Status", margin + 165, yPosition);
      yPosition += 8;

      pdf.setFont("helvetica", "normal");
      chartData.forEach((channel: any, index: number) => {
        if (yPosition > pageHeight - 20) { pdf.addPage(); yPosition = margin; }
        if (index % 2 === 0) { pdf.setFillColor(250, 250, 250); pdf.rect(margin, yPosition - 5, pageWidth - 2 * margin, 7, "F"); }
        const threshold = getThreshold(channel.channelCode);
        pdf.text(channel.channel, margin + 2, yPosition);
        pdf.text(formatNumber(channel.volume), margin + 50, yPosition);
        pdf.text(formatPercentage(channel.matchRate), margin + 90, yPosition);
        pdf.text(String(channel.exceptions), margin + 130, yPosition);
        const sc = channel.matchRate >= threshold ? [34, 197, 94] : channel.matchRate >= 85 ? [251, 146, 60] : [239, 68, 68];
        pdf.setTextColor(sc[0], sc[1], sc[2]);
        pdf.text(channel.matchRate >= threshold ? "Excellent" : channel.matchRate >= 85 ? "Good" : "Needs Attention", margin + 165, yPosition);
        pdf.setTextColor(0, 0, 0);
        yPosition += 7;
      });

      pdf.setFontSize(8); pdf.setTextColor(140, 117, 125);
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
              <CardHeader className="pb-2"><div className="h-4 bg-gray-200 rounded w-24"></div></CardHeader>
              <CardContent><div className="h-8 bg-gray-200 rounded w-16 mb-2"></div><div className="h-3 bg-gray-200 rounded w-32"></div></CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const presetLabels: Record<DatePreset, string> = { "7d": "Last 7 Days", "30d": "Last 30 Days", mtd: "Month to Date", all: "All Time" };

  return (
    <div className="space-y-6">
      {/* Panels */}
      {showThresholdPanel && (
        <ThresholdPanel channels={allChannelNames} thresholds={channelThresholds} globalThreshold={globalThreshold}
          onGlobalChange={setGlobalThreshold}
          onChannelChange={(code, v) => setChannelThresholds((prev) => ({ ...prev, [code]: v }))}
          onClose={() => setShowThresholdPanel(false)} />
      )}
      {showSchedulePanel && <SchedulePanel onClose={() => setShowSchedulePanel(false)} />}
      {drillDownChannel && (
        <DrillDownModal channelCode={drillDownChannel.code} channelName={drillDownChannel.name}
          onClose={() => setDrillDownChannel(null)} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-[#1B365D]">CFO Dashboard</h1>
          <p className="text-[#8C757D] mt-1">Executive financial reconciliation overview</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={exportToCSV}
            className="gap-2 border-[#1B365D] text-[#1B365D] bg-white hover:bg-[#EEF2F8]">
            <FileDown className="h-4 w-4" />Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowSchedulePanel(true)}
            className="gap-2 border-[#1B365D] text-[#1B365D] bg-white hover:bg-[#EEF2F8]">
            <Calendar className="h-4 w-4" />Schedule Report
          </Button>
          <Button onClick={exportToPDF} disabled={isExporting} className="gap-2 bg-[#1B365D] hover:bg-[#2A4A7C]">
            <Download className={`h-4 w-4 ${isExporting ? "animate-bounce" : ""}`} />
            {isExporting ? "Exporting..." : "Export PDF"}
          </Button>
        </div>
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
            <p className="text-xs text-[#8C757D] mt-1">{kpis?.matchRate && kpis.matchRate >= globalThreshold ? "Excellent performance" : "Needs attention"}</p>
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
              <p className="text-sm text-[#8C757D] mt-1">
                Match rates and exception counts by payment channel
                <span className="ml-2 text-xs text-[#F47458] font-medium">· Channels with no data are hidden</span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* Date presets */}
              <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                {(["7d", "30d", "mtd", "all"] as DatePreset[]).map((p) => (
                  <button key={p} onClick={() => setDatePreset(p)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${datePreset === p ? "bg-[#1B365D] text-white shadow-sm" : "text-[#8C757D] hover:text-[#1B365D]"}`}>
                    {presetLabels[p]}
                  </button>
                ))}
              </div>
              {/* Channel filter */}
              <div className="relative group">
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-xs font-medium text-[#1B365D] hover:border-[#1B365D] transition-colors">
                  <Filter className="h-3 w-3" />Channels
                  {selectedChannels.length > 0 && <Badge className="ml-1 h-4 px-1.5 text-[10px] bg-[#F47458] text-white">{selectedChannels.length}</Badge>}
                </button>
                <div className="absolute right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-20 hidden group-focus-within:block group-hover:block">
                  <div className="p-2 border-b border-gray-100">
                    <input type="text" placeholder="Search channels…" value={channelSearch}
                      onChange={(e) => setChannelSearch(e.target.value)}
                      className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-[#1B365D]" />
                  </div>
                  <div className="max-h-48 overflow-y-auto p-1">
                    {filteredSearch.map((c) => (
                      <label key={c.code} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                        <input type="checkbox" checked={selectedChannels.includes(c.code)} onChange={() => toggleChannel(c.code)} className="rounded border-gray-300 text-[#1B365D]" />
                        <span className="text-xs text-[#1B365D]">{c.name}</span>
                      </label>
                    ))}
                    {filteredSearch.length === 0 && <p className="text-xs text-gray-400 px-2 py-2">No channels found</p>}
                  </div>
                  {selectedChannels.length > 0 && (
                    <div className="p-2 border-t border-gray-100">
                      <button onClick={clearChannels} className="w-full text-xs text-[#F47458] hover:underline">Clear all filters</button>
                    </div>
                  )}
                </div>
              </div>
              {/* Threshold settings */}
              <button onClick={() => setShowThresholdPanel(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-xs font-medium text-[#1B365D] hover:border-[#1B365D] transition-colors">
                <Settings2 className="h-3 w-3" />Thresholds
                <span className="text-[#F47458] font-bold">{globalThreshold}%</span>
              </button>
            </div>
          </div>

          {/* Active filter chips */}
          {selectedChannels.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {selectedChannels.map((code) => {
                const ch = allChannelNames.find((c) => c.code === code);
                return (
                  <span key={code} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#EEF2F8] text-[#1B365D] rounded-full text-xs font-medium">
                    {ch?.name ?? code}
                    <button onClick={() => toggleChannel(code)} className="hover:text-[#F47458]"><X className="h-3 w-3" /></button>
                  </span>
                );
              })}
              <button onClick={clearChannels} className="text-xs text-[#8C757D] hover:text-[#F47458] ml-1">Clear all</button>
            </div>
          )}

          {/* Legend */}
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5 text-xs text-[#8C757D]">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#10B981]"></span>≥ {globalThreshold}% (Excellent)
            </div>
            <div className="flex items-center gap-1.5 text-xs text-[#8C757D]">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#F59E0B]"></span>85–{globalThreshold - 1}% (Good)
            </div>
            <div className="flex items-center gap-1.5 text-xs text-[#8C757D]">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#EF4444]"></span>&lt; 85% (Needs Attention)
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-sm text-[#8C757D]">No channels have transaction data for the selected period.</div>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                  <XAxis dataKey="channel" tick={{ fill: "#8C757D", fontSize: 11 }} angle={-45} textAnchor="end" height={80} />
                  <YAxis yAxisId="left" tick={{ fill: "#8C757D", fontSize: 12 }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fill: "#10B981", fontSize: 12 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                  <Tooltip contentStyle={{ backgroundColor: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: "8px" }}
                    formatter={(value: any, name: string) => name === "Match Rate" ? [`${Number(value).toFixed(1)}%`, "Match Rate"] : [formatNumber(value), "Exceptions"]} />
                  <Legend />
                  <ReferenceLine yAxisId="right" y={globalThreshold} stroke="#F47458" strokeDasharray="5 3" strokeWidth={1.5}
                    label={{ value: `${globalThreshold}% target`, position: "insideTopRight", fill: "#F47458", fontSize: 10 }} />
                  <Bar yAxisId="right" dataKey="matchRate" name="Match Rate"
                    shape={(props: any) => <ThresholdBar {...props} threshold={getThreshold(props?.payload?.channelCode)} />} />
                  <Bar yAxisId="left" dataKey="exceptions" fill="#F47458" name="Exceptions" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Channel Health Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-semibold text-[#1B365D]">Detailed Channel Metrics</CardTitle>
            <span className="text-xs text-[#8C757D]">
              Showing {chartData.length} channel{chartData.length !== 1 ? "s" : ""} with data
              {datePreset !== "all" && ` in ${presetLabels[datePreset]}`}
              {" · "}
              <span className="text-[#1B365D] font-medium">Click a row to drill down</span>
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="text-sm text-[#8C757D] py-6 text-center">No channel data available for the selected period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-4 text-sm font-semibold text-[#1B365D]">Channel</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-[#1B365D]">Total</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-[#1B365D]">Matched</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-[#1B365D]">Exceptions</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-[#1B365D]">Match Rate</th>
                    <th className="text-center py-3 px-4 text-sm font-semibold text-[#1B365D]">7-Day Trend</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-[#1B365D]">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {chartData.map((channel, idx) => {
                    const threshold = getThreshold(channel.channelCode);
                    const sparkData = trendData?.[channel.channelCode] ?? [];
                    return (
                      <tr key={idx}
                        className="border-b border-gray-100 hover:bg-[#EEF2F8] cursor-pointer transition-colors"
                        onClick={() => setDrillDownChannel({ code: channel.channelCode, name: channel.channel })}>
                        <td className="py-3 px-4 text-sm text-[#1B365D] font-medium flex items-center gap-1">
                          {channel.channel}
                          <ChevronRight className="h-3 w-3 text-[#8C757D] opacity-0 group-hover:opacity-100" />
                        </td>
                        <td className="py-3 px-4 text-sm text-[#8C757D] text-right">{formatNumber(channel.volume)}</td>
                        <td className="py-3 px-4 text-sm text-[#8C757D] text-right">{formatNumber(Math.round((channel.volume * channel.matchRate) / 100))}</td>
                        <td className="py-3 px-4 text-sm text-[#8C757D] text-right">{formatNumber(channel.exceptions)}</td>
                        <td className={`py-3 px-4 text-sm text-right font-semibold ${channel.matchRate >= threshold ? "text-green-600" : channel.matchRate >= 85 ? "text-amber-600" : "text-red-600"}`}>
                          {formatPercentage(channel.matchRate)}
                        </td>
                        <td className="py-3 px-4"><div className="flex justify-center"><Sparkline data={sparkData} threshold={threshold} /></div></td>
                        <td className="py-3 px-4 text-right">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${channel.matchRate >= threshold ? "bg-green-100 text-green-800" : channel.matchRate >= 85 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"}`}>
                            {channel.matchRate >= threshold ? "Excellent" : channel.matchRate >= 85 ? "Good" : "Needs Attention"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
