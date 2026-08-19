import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { usePortalContext } from "@/contexts/PortalContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
  Activity,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Loader2,
  Webhook,
  AlertTriangle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

function formatTimeAgo(date: string | Date | null): string {
  if (!date) return "Never";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatDate(date: string | Date | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ShoplineSyncStatus() {
  const [triggering, setTriggering] = useState(false);
  const { viewAsOrg } = usePortalContext();
  const portalScope = useMemo(
    () => ({ organizationId: viewAsOrg?.id }),
    [viewAsOrg?.id],
  );

  const { data: stores, isLoading: storesLoading } = trpc.shoplineConnector.listStores.useQuery(portalScope);
  const { data: webhookEvents, isLoading: eventsLoading, refetch } = trpc.shoplineConnector.recentWebhookEvents.useQuery(
    { limit: 50, ...portalScope },
    { refetchInterval: 15000 },
  );

  const triggerSync = trpc.shoplineConnector.triggerManualSync.useMutation({
    onSuccess: (result) => {
      toast.success(`Sync triggered for ${result.storeHandle}`, {
        description: `${result.ordersIngested} orders, ${result.paymentsIngested} payments processed`,
      });
      refetch();
    },
    onError: (err) => {
      toast.error("Sync failed", { description: err.message });
    },
  });

  const isLoading = storesLoading || eventsLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const activeStores = stores?.filter((s: any) => s.status === "active") ?? [];
  const events = webhookEvents ?? [];
  const processedCount = events.filter((e: any) => e.status === "processed").length;
  const failedCount = events.filter((e: any) => e.status === "failed" || e.status === "dlq").length;
  const pendingCount = events.filter((e: any) => e.status === "pending").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">Sync Status</h1>
          <p className="text-muted-foreground mt-1">
            Monitor SHOPLINE data synchronisation health and webhook activity
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Sync Health Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Webhooks Processed</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{processedCount}</div>
            <p className="text-xs text-muted-foreground mt-1">Last 50 events</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
            <Clock className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{pendingCount}</div>
            <p className="text-xs text-muted-foreground mt-1">Awaiting processing</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed</CardTitle>
            <XCircle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{failedCount}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {failedCount > 0 ? "Needs investigation" : "All healthy"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Store Sync Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Store Sync Status</CardTitle>
          <CardDescription>Trigger manual sync or view last sync time per store</CardDescription>
        </CardHeader>
        <CardContent>
          {activeStores.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No active stores. Connect a SHOPLINE store first.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store</TableHead>
                  <TableHead>Last Sync</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeStores.map((store: any) => (
                  <TableRow key={store.id}>
                    <TableCell className="font-medium">{store.storeHandle}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimeAgo(store.lastSyncAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="default" className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                        <Zap className="h-3 w-3 mr-1" />
                        Active
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => triggerSync.mutate({ storeId: store.id, ...portalScope })}
                        disabled={triggerSync.isPending}
                      >
                        {triggerSync.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        ) : (
                          <RefreshCw className="h-3 w-3 mr-1" />
                        )}
                        Sync Now
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recent Webhook Events */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Webhook className="h-4 w-4" />
            Recent Webhook Events
          </CardTitle>
          <CardDescription>
            Incoming events from SHOPLINE (orders, payments, refunds)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No webhook events received yet. Events will appear here once your store is active.
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Topic</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event: any) => (
                    <TableRow key={event.id}>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDate(event.receivedAt)}
                      </TableCell>
                      <TableCell>
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                          {event.topic}
                        </code>
                      </TableCell>
                      <TableCell className="text-sm">{event.storeHandle || "—"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            event.status === "processed"
                              ? "default"
                              : event.status === "pending"
                                ? "secondary"
                                : "destructive"
                          }
                          className={
                            event.status === "processed"
                              ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100"
                              : ""
                          }
                        >
                          {event.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
