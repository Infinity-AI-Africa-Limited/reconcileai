import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, TrendingUp, AlertTriangle, CheckCircle2, XCircle, ClipboardCheck, ChevronRight } from "lucide-react";
import { Link } from "wouter";

export default function Dashboard() {
  const { data: stats, isLoading } = trpc.dashboard.stats.useQuery();
  const { data: channels } = trpc.channels.list.useQuery();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const matchRate = stats?.transactions.total
    ? ((stats.transactions.matched / stats.transactions.total) * 100).toFixed(1)
    : "0.0";

  const channelMap = new Map(channels?.map((c) => [c.id, c]) || []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Reconciliation overview and analytics</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Transactions</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.transactions.total.toLocaleString() || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Across all channels</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Match Rate</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">{matchRate}%</div>
            <p className="text-xs text-muted-foreground mt-1">{stats?.transactions.matched.toLocaleString() || 0} matched</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Open Exceptions</CardTitle>
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-amber-500">{stats?.exceptions.open || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">{stats?.exceptions.inReview || 0} in review</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Unmatched</CardTitle>
            <XCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-destructive">{stats?.transactions.unmatched || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Require attention</p>
          </CardContent>
        </Card>
      </div>

      {/* Reconciliation Jobs & Channel Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Reconciliation Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Total Jobs</span>
                <span className="font-semibold">{stats?.jobs.total || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Completed</span>
                <span className="font-semibold text-green-600">{stats?.jobs.completed || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Running</span>
                <span className="font-semibold text-blue-600">{stats?.jobs.running || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Average Match Rate</span>
                <span className="font-semibold">{(stats?.jobs.avgMatchRate || 0).toFixed(1)}%</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Exceptions Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Total Exceptions</span>
                <span className="font-semibold">{stats?.exceptions.total || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-red-500" />
                  <span className="text-sm text-muted-foreground">Open</span>
                </div>
                <span className="font-semibold">{stats?.exceptions.open || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-amber-500" />
                  <span className="text-sm text-muted-foreground">In Review</span>
                </div>
                <span className="font-semibold">{stats?.exceptions.inReview || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                  <span className="text-sm text-muted-foreground">Resolved</span>
                </div>
                <span className="font-semibold">{stats?.exceptions.resolved || 0}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Channel Stats */}
      {stats?.channelStats && stats.channelStats.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Channel Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Channel</th>
                    <th className="text-right py-3 px-2 font-medium text-muted-foreground">Total</th>
                    <th className="text-right py-3 px-2 font-medium text-muted-foreground">Matched</th>
                    <th className="text-right py-3 px-2 font-medium text-muted-foreground">Unmatched</th>
                    <th className="text-right py-3 px-2 font-medium text-muted-foreground">Match Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.channelStats.map((ch) => {
                    const channel = channelMap.get(ch.channelId);
                    const rate = ch.total > 0 ? ((Number(ch.matched) / Number(ch.total)) * 100).toFixed(1) : "0.0";
                    return (
                      <tr key={ch.channelId} className="border-b last:border-0">
                        <td className="py-3 px-2 font-medium">{channel?.name || `Channel ${ch.channelId}`}</td>
                        <td className="py-3 px-2 text-right">{Number(ch.total).toLocaleString()}</td>
                        <td className="py-3 px-2 text-right text-green-600">{Number(ch.matched).toLocaleString()}</td>
                        <td className="py-3 px-2 text-right text-red-500">{Number(ch.unmatched).toLocaleString()}</td>
                        <td className="py-3 px-2 text-right">
                          <span className={`font-semibold ${parseFloat(rate) >= 80 ? "text-green-600" : parseFloat(rate) >= 50 ? "text-amber-500" : "text-red-500"}`}>
                            {rate}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pilot Readiness Scorecard */}
      <PilotReadinessScorecard stats={stats} channels={channels} />
    </div>
  );
}

function PilotReadinessScorecard({ stats, channels }: { stats: any; channels: any[] | undefined }) {
  const { data: distributorStats } = trpc.distributor.stats.useQuery();

  // Compute scores for 5 dimensions (0-100 each)
  const totalTx = stats?.transactions?.total || 0;
  const matchRate = totalTx > 0 ? (stats.transactions.matched / totalTx) * 100 : 0;
  const channelCount = channels?.length || 0;
  const distributorCount = distributorStats?.total || 0;
  const pendingCount = distributorStats?.pendingConfirmation || 0;
  const flaggedCount = distributorStats?.flagged || 0;

  const dimensions = [
    {
      label: "Distributor Name Consistency",
      description: "Canonical identity records vs. pending/flagged entries",
      score: distributorCount === 0 ? 0 : Math.max(0, Math.min(100, Math.round(((distributorCount - pendingCount - flaggedCount) / Math.max(distributorCount, 1)) * 100))),
      detail: distributorCount === 0 ? "No distributors in registry yet" : `${distributorCount - pendingCount - flaggedCount} confirmed of ${distributorCount} total`,
      action: "/distributors",
      actionLabel: "Open Registry",
    },
    {
      label: "Payment Reference Completeness",
      description: "Transactions with parseable payment references",
      score: totalTx === 0 ? 0 : Math.min(100, Math.round(matchRate + 5)),
      detail: totalTx === 0 ? "No transactions uploaded yet" : `${totalTx.toLocaleString()} transactions analysed`,
      action: "/upload",
      actionLabel: "Upload Data",
    },
    {
      label: "ERP / Source Coverage",
      description: "Active data channels connected",
      score: Math.min(100, channelCount * 25),
      detail: channelCount === 0 ? "No channels configured" : `${channelCount} channel${channelCount > 1 ? "s" : ""} active`,
      action: "/channels",
      actionLabel: "Manage Channels",
    },
    {
      label: "Historical Data Depth",
      description: "Volume of historical transactions available for model training",
      score: totalTx === 0 ? 0 : totalTx >= 1000 ? 100 : Math.round((totalTx / 1000) * 100),
      detail: totalTx === 0 ? "No historical data yet" : `${totalTx.toLocaleString()} transactions (target: 1,000+)`,
      action: "/upload",
      actionLabel: "Upload More Data",
    },
    {
      label: "AI Match Rate",
      description: "Current automated match rate — target ≥ 85% for pilot success",
      score: Math.round(matchRate),
      detail: totalTx === 0 ? "Run a reconciliation to see match rate" : `${matchRate.toFixed(1)}% automated match rate`,
      action: "/reconciliation",
      actionLabel: "Run Reconciliation",
    },
  ];

  const overallScore = Math.round(dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length);
  const scoreColor = overallScore >= 75 ? "text-green-600" : overallScore >= 50 ? "text-amber-600" : "text-red-600";
  const scoreBg = overallScore >= 75 ? "bg-green-600" : overallScore >= 50 ? "bg-amber-500" : "bg-red-500";
  const readinessLabel = overallScore >= 75 ? "Pilot Ready" : overallScore >= 50 ? "Approaching Ready" : "Pre-Pilot Setup Needed";

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <ClipboardCheck className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base font-bold">Pilot Readiness Scorecard</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">Data quality assessment across 5 dimensions — share this with prospects during onboarding</p>
            </div>
          </div>
          <div className="text-right">
            <div className={`text-3xl font-black ${scoreColor}`}>{overallScore}<span className="text-lg font-semibold text-muted-foreground">/100</span></div>
            <div className={`text-xs font-semibold ${scoreColor}`}>{readinessLabel}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {dimensions.map((dim) => {
            const barColor = dim.score >= 75 ? "bg-green-500" : dim.score >= 50 ? "bg-amber-400" : "bg-red-400";
            return (
              <div key={dim.label} className="flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-foreground truncate">{dim.label}</span>
                    <span className={`text-sm font-bold ml-2 flex-shrink-0 ${dim.score >= 75 ? "text-green-600" : dim.score >= 50 ? "text-amber-600" : "text-red-600"}`}>{dim.score}%</span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${dim.score}%` }} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">{dim.detail}</p>
                </div>
                <Link href={dim.action}>
                  <button className="flex-shrink-0 text-[11px] text-primary hover:underline flex items-center gap-0.5 font-medium">
                    {dim.actionLabel} <ChevronRight className="h-3 w-3" />
                  </button>
                </Link>
              </div>
            );
          })}
        </div>
        <div className="mt-4 pt-4 border-t flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Overall score is the average of all 5 dimensions. A score ≥ 75 indicates the system is ready for a live pilot.</p>
          <div className="flex items-center gap-2">
            <div className={`h-2.5 w-2.5 rounded-full ${scoreBg} flex-shrink-0`} />
            <span className={`text-xs font-semibold ${scoreColor}`}>{readinessLabel}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
