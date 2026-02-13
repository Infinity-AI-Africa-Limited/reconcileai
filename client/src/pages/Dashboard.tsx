import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, TrendingUp, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

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
    </div>
  );
}
