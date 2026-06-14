import { useState, useEffect, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Activity,
  Zap,
  Clock,
  CheckCircle2,
  XCircle,
  TrendingUp,
  BarChart3,
  RefreshCw,
  Loader2,
  Timer,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Calendar,
} from "lucide-react";

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatTimeAgo(date: string | Date | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function Monitor() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const utils = trpc.useUtils();

  // Real-time updates now come from the SSE stream (see effect below); these
  // intervals are a slow fallback in case the stream drops.
  const {
    data: stats,
    isLoading: statsLoading,
    refetch: refetchStats,
  } = trpc.monitoring.stats.useQuery(undefined, {
    refetchInterval: autoRefresh ? 15000 : false,
  });

  const {
    data: activeJobs,
    refetch: refetchActive,
  } = trpc.monitoring.activeJobs.useQuery(undefined, {
    refetchInterval: autoRefresh ? 15000 : false,
  });

  const {
    data: recentActivity,
    refetch: refetchRecent,
  } = trpc.monitoring.recentActivity.useQuery(
    { limit: 15 },
    { refetchInterval: autoRefresh ? 30000 : false }
  );

  // Live job-progress stream — refetch immediately on each server event so the
  // dashboard updates in real time instead of waiting on a timer. EventSource
  // auto-reconnects on error; the fallback intervals above cover any gap.
  useEffect(() => {
    if (!autoRefresh) return;
    const es = new EventSource("/api/monitoring/stream");
    es.onmessage = () => {
      utils.monitoring.stats.invalidate();
      utils.monitoring.activeJobs.invalidate();
      utils.monitoring.recentActivity.invalidate();
    };
    return () => es.close();
  }, [autoRefresh, utils]);

  const refreshAll = () => {
    refetchStats();
    refetchActive();
    refetchRecent();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Real-Time Monitor</h1>
          <p className="text-muted-foreground mt-1">
            Live view of reconciliation jobs, performance metrics, and system health
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${autoRefresh ? "bg-green-500 animate-pulse" : "bg-muted-foreground/30"}`} />
            <span className="text-sm text-muted-foreground">
              {autoRefresh ? "Live" : "Paused"}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? "Pause" : "Resume"}
          </Button>
          <Button variant="ghost" size="sm" onClick={refreshAll}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Key Metrics */}
      {statsLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : stats ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <MetricCard
              icon={<Activity className="h-5 w-5 text-blue-500" />}
              label="Running Jobs"
              value={stats.activeJobs.running}
              accent="blue"
            />
            <MetricCard
              icon={<Clock className="h-5 w-5 text-amber-500" />}
              label="Pending Jobs"
              value={stats.activeJobs.pending}
              accent="amber"
            />
            <MetricCard
              icon={<CheckCircle2 className="h-5 w-5 text-green-500" />}
              label="Completed (7d)"
              value={stats.performance.totalCompleted}
              accent="green"
            />
            <MetricCard
              icon={<XCircle className="h-5 w-5 text-red-500" />}
              label="Failed (7d)"
              value={stats.performance.totalFailed}
              accent="red"
            />
            <MetricCard
              icon={<TrendingUp className="h-5 w-5 text-primary" />}
              label="Avg Match Rate"
              value={`${stats.performance.avgMatchRate.toFixed(1)}%`}
              accent="primary"
            />
            <MetricCard
              icon={<Timer className="h-5 w-5 text-purple-500" />}
              label="Avg Processing"
              value={formatDuration(stats.performance.avgProcessingTimeMs)}
              accent="purple"
            />
          </div>

          {/* Performance Summary Bar */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">7-Day Performance</span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-muted-foreground">
                    Success Rate:{" "}
                    <span className="font-medium text-foreground">
                      {stats.performance.successRate}%
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    Total Txns:{" "}
                    <span className="font-medium text-foreground">
                      {stats.performance.totalTransactions.toLocaleString()}
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    Schedules:{" "}
                    <span className="font-medium text-foreground">
                      {stats.schedules.active}/{stats.schedules.total}
                    </span>
                  </span>
                </div>
              </div>
              <Progress
                value={stats.performance.successRate}
                className="h-2"
              />
              <div className="flex justify-between mt-1 text-xs text-muted-foreground">
                <span>0%</span>
                <span>Success Rate Target: 95%</span>
                <span>100%</span>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      {/* Active Jobs */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-amber-500" />
              Active Jobs
            </CardTitle>
            {activeJobs && activeJobs.length > 0 && (
              <Badge variant="secondary">{activeJobs.length} active</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!activeJobs || activeJobs.length === 0 ? (
            <div className="text-center py-8">
              <Activity className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">No active jobs</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Jobs will appear here when running
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {activeJobs.map((job) => (
                <ActiveJobCard key={job.jobId} job={job} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-muted-foreground" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!recentActivity || recentActivity.length === 0 ? (
            <div className="text-center py-8">
              <Calendar className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">No recent activity</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Match Rate</TableHead>
                  <TableHead>Matched</TableHead>
                  <TableHead>Exceptions</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentActivity.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-medium max-w-[200px] truncate">
                      {job.name}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={job.status} />
                    </TableCell>
                    <TableCell>
                      {job.matchRate ? (
                        <span className="flex items-center gap-1">
                          {parseFloat(job.matchRate) >= 90 ? (
                            <ArrowUpRight className="h-3 w-3 text-green-500" />
                          ) : parseFloat(job.matchRate) >= 70 ? (
                            <Minus className="h-3 w-3 text-amber-500" />
                          ) : (
                            <ArrowDownRight className="h-3 w-3 text-red-500" />
                          )}
                          {parseFloat(job.matchRate).toFixed(1)}%
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>{job.matchedCount}</TableCell>
                    <TableCell>
                      {job.exceptionCount > 0 ? (
                        <span className="text-amber-600 font-medium">{job.exceptionCount}</span>
                      ) : (
                        job.exceptionCount
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDuration(job.processingTimeMs)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatTimeAgo(job.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function MetricCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  accent: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg bg-${accent}-500/10`}>
            {icon}
          </div>
          <div className="min-w-0">
            <p className="text-xl font-bold truncate">{value}</p>
            <p className="text-xs text-muted-foreground truncate">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ActiveJobCard({ job }: { job: any }) {
  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{job.jobName}</span>
            <Badge variant="secondary" className="text-xs shrink-0">
              Job #{job.jobId}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {job.sourceChannel} → {job.targetChannel}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-medium">{job.progress}%</p>
          <p className="text-xs text-muted-foreground">
            {job.estimatedRemainingMs
              ? `~${formatDuration(job.estimatedRemainingMs)} remaining`
              : formatDuration(job.elapsedMs)}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Progress value={job.progress} className="h-2" />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {job.phaseLabel}
          </span>
          {job.processedCount > 0 && (
            <span>
              {job.processedCount.toLocaleString()} / {job.totalCount.toLocaleString()} processed
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <Badge variant="default" className="text-xs bg-green-600">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          Completed
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary" className="text-xs">
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          Running
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="text-xs">
          <XCircle className="h-3 w-3 mr-1" />
          Failed
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="text-xs">
          <Clock className="h-3 w-3 mr-1" />
          Pending
        </Badge>
      );
    default:
      return <Badge variant="outline" className="text-xs">{status}</Badge>;
  }
}
