import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Loader2,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from "lucide-react";
import { toast } from "sonner";

function formatCurrency(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount / 100); // amounts stored in cents
}

function formatDate(date: string | Date | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTimeAgo(date: string | Date | null): string {
  if (!date) return "Never";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function SettlementMonitor() {
  const [refreshing, setRefreshing] = useState(false);

  const { data: stores, isLoading: storesLoading } = trpc.shoplineConnector.listStores.useQuery({});
  const { data: syncStatus, isLoading: syncLoading, refetch } = trpc.shoplineConnector.syncStatus.useQuery(undefined, {
    refetchInterval: 30000, // auto-refresh every 30s
  });

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
    toast.success("Settlement data refreshed");
  };

  const isLoading = storesLoading || syncLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const activeStores = stores?.filter((s: any) => s.status === "active") ?? [];
  const totalSettled = syncStatus?.totalSettled ?? 0;
  const totalPending = syncStatus?.totalPending ?? 0;
  const totalExceptions = syncStatus?.totalExceptions ?? 0;
  const matchRate = syncStatus?.matchRate ?? 0;
  const recentPayouts = syncStatus?.recentPayouts ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">Settlement Monitor</h1>
          <p className="text-muted-foreground mt-1">
            Real-time settlement tracking across your SHOPLINE stores
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          Refresh
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Settled</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalSettled)}</div>
            <p className="text-xs text-muted-foreground mt-1">Last 30 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Settlement</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalPending)}</div>
            <p className="text-xs text-muted-foreground mt-1">Awaiting payout</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Match Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{matchRate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground mt-1">
              {matchRate >= 95 ? (
                <span className="text-emerald-600">Healthy</span>
              ) : matchRate >= 85 ? (
                <span className="text-amber-600">Needs attention</span>
              ) : (
                <span className="text-red-600">Critical</span>
              )}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Open Exceptions</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalExceptions}</div>
            <p className="text-xs text-muted-foreground mt-1">Requires review</p>
          </CardContent>
        </Card>
      </div>

      {/* Connected Stores */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected Stores</CardTitle>
        </CardHeader>
        <CardContent>
          {activeStores.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No active SHOPLINE stores connected. Visit the SHOPLINE Connection page to get started.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Sync</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeStores.map((store: any) => (
                  <TableRow key={store.id}>
                    <TableCell className="font-medium">{store.storeHandle}</TableCell>
                    <TableCell>{store.currency || "—"}</TableCell>
                    <TableCell>
                      <Badge variant={store.status === "active" ? "default" : "secondary"}>
                        {store.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimeAgo(store.lastSyncAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recent Payouts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Payouts</CardTitle>
        </CardHeader>
        <CardContent>
          {recentPayouts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No payout data yet. Settlements will appear here once sync is active.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reconciled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentPayouts.map((payout: any, idx: number) => (
                  <TableRow key={payout.id || idx}>
                    <TableCell>{formatDate(payout.date)}</TableCell>
                    <TableCell className="font-medium">{payout.storeHandle}</TableCell>
                    <TableCell>{formatCurrency(payout.amount, payout.currency)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          payout.status === "paid"
                            ? "default"
                            : payout.status === "pending"
                              ? "secondary"
                              : "destructive"
                        }
                      >
                        {payout.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {payout.reconciled ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <Clock className="h-4 w-4 text-amber-500" />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Exception Resolution Intelligence — both learning layers */}
      <ResolutionIntelligenceCard />
    </div>
  );
}

// A merchant picks a retail exception category and sees both intelligence
// layers: their OWN past resolutions (intra-org, private) and the anonymised
// cross-merchant network recommendations (cross-org, k-anonymous).
const RETAIL_CATEGORY_CHOICES: Array<{ key: string; label: string }> = [
  { key: "retail_chargeback_not_posted", label: "Chargeback not posted" },
  { key: "retail_gateway_fee_variance", label: "Gateway fee variance" },
  { key: "retail_settlement_shortfall", label: "Settlement shortfall" },
  { key: "retail_refund_not_settled", label: "Refund not settled" },
  { key: "retail_fx_rate_mismatch", label: "FX rate mismatch" },
  { key: "retail_payout_bank_variance", label: "Payout vs bank variance" },
];

function ResolutionIntelligenceCard() {
  const [category, setCategory] = useState(RETAIL_CATEGORY_CHOICES[0].key);
  const { data, isLoading } = trpc.shoplineConnector.exceptionIntelligence.useQuery(
    { category },
    { staleTime: 60_000 },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Exception Resolution Intelligence</CardTitle>
        <p className="text-sm text-muted-foreground">
          How this exception has been resolved — by you, and (anonymously) across the merchant network.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {RETAIL_CATEGORY_CHOICES.map((c) => (
            <Button
              key={c.key}
              size="sm"
              variant={c.key === category ? "default" : "outline"}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
            </Button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading intelligence…
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Layer 1 — intra-org */}
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="secondary">Your history</Badge>
                <span className="text-xs text-muted-foreground">private to your store</span>
              </div>
              {data && data.ownHistory.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {data.ownHistory.map((h, i) => (
                    <li key={i} className="border-l-2 border-primary/40 pl-2">
                      <span className="font-medium">{h.resolutionActionClass}</span> → {h.outcome}
                      <p className="text-muted-foreground text-xs">{h.resolution}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No past resolutions yet — your first resolution of this exception starts building your history.
                </p>
              )}
            </div>

            {/* Layer 2 — cross-org */}
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-2 mb-2">
                <Badge>Network</Badge>
                <span className="text-xs text-muted-foreground">anonymised · k-anonymous</span>
              </div>
              {data && data.network.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {data.network.map((n, i) => (
                    <li key={i} className="border-l-2 border-emerald-400/50 pl-2">
                      <span className="font-medium">{n.resolutionActionClass}</span> → {n.outcome}
                      <p className="text-muted-foreground text-xs">
                        used by {n.contributorCount} merchants · {n.observationCount} times
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No network recommendations yet. Enable exception-intelligence sharing (Settings) to
                  benefit from and contribute to anonymised cross-merchant patterns.
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
