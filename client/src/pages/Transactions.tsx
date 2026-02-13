import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Search, ChevronLeft, ChevronRight } from "lucide-react";

export default function TransactionsPage() {
  const { data: channels } = trpc.channels.list.useQuery();
  const [filters, setFilters] = useState({
    channelId: "",
    status: "",
    dateFrom: "",
    dateTo: "",
    amountMin: "",
    amountMax: "",
    search: "",
  });
  const [page, setPage] = useState(0);
  const limit = 50;

  const queryInput = useMemo(() => ({
    channelId: filters.channelId ? parseInt(filters.channelId) : undefined,
    status: filters.status || undefined,
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    amountMin: filters.amountMin ? parseFloat(filters.amountMin) : undefined,
    amountMax: filters.amountMax ? parseFloat(filters.amountMax) : undefined,
    search: filters.search || undefined,
    limit,
    offset: page * limit,
  }), [filters, page]);

  const { data, isLoading } = trpc.transactions.list.useQuery(queryInput);
  const channelMap = useMemo(() => new Map(channels?.map((c) => [c.id, c]) || []), [channels]);

  const statusColor = (s: string) => {
    switch (s) {
      case "matched": return "bg-green-100 text-green-700";
      case "unmatched": return "bg-gray-100 text-gray-700";
      case "exception": return "bg-amber-100 text-amber-700";
      case "pending": return "bg-blue-100 text-blue-700";
      default: return "bg-gray-100 text-gray-700";
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">Transactions</h1>
        <p className="text-muted-foreground mt-1">Search and filter transactions across all channels</p>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search reference, description..." value={filters.search} onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(0); }} />
            </div>
            <Select value={filters.channelId} onValueChange={(v) => { setFilters({ ...filters, channelId: v === "all" ? "" : v }); setPage(0); }}>
              <SelectTrigger><SelectValue placeholder="All Channels" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Channels</SelectItem>
                {channels?.map((ch) => (
                  <SelectItem key={ch.id} value={String(ch.id)}>{ch.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filters.status} onValueChange={(v) => { setFilters({ ...filters, status: v === "all" ? "" : v }); setPage(0); }}>
              <SelectTrigger><SelectValue placeholder="All Statuses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="matched">Matched</SelectItem>
                <SelectItem value="unmatched">Unmatched</SelectItem>
                <SelectItem value="exception">Exception</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Input type="date" placeholder="From" value={filters.dateFrom} onChange={(e) => { setFilters({ ...filters, dateFrom: e.target.value }); setPage(0); }} />
              <Input type="date" placeholder="To" value={filters.dateTo} onChange={(e) => { setFilters({ ...filters, dateTo: e.target.value }); setPage(0); }} />
            </div>
          </div>
          <div className="flex gap-3 mt-3">
            <Input type="number" placeholder="Min Amount" value={filters.amountMin} onChange={(e) => { setFilters({ ...filters, amountMin: e.target.value }); setPage(0); }} className="w-36" />
            <Input type="number" placeholder="Max Amount" value={filters.amountMax} onChange={(e) => { setFilters({ ...filters, amountMax: e.target.value }); setPage(0); }} className="w-36" />
            <Button variant="outline" onClick={() => { setFilters({ channelId: "", status: "", dateFrom: "", dateTo: "", amountMin: "", amountMax: "", search: "" }); setPage(0); }}>
              Clear Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Transactions Table */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Reference</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Channel</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Date</th>
                    <th className="text-right py-3 px-2 font-medium text-muted-foreground">Amount</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Type</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Description</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.data?.map((txn) => (
                    <tr key={txn.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-3 px-2 font-mono text-xs">{txn.transactionRef || "-"}</td>
                      <td className="py-3 px-2 text-xs">{channelMap.get(txn.channelId)?.name || "-"}</td>
                      <td className="py-3 px-2 text-xs">{new Date(txn.transactionDate).toLocaleDateString()}</td>
                      <td className="py-3 px-2 text-right font-mono">
                        <span className={txn.debitCredit === "credit" ? "text-green-600" : "text-red-500"}>
                          {txn.debitCredit === "credit" ? "+" : "-"}{parseFloat(txn.amount).toLocaleString()} {txn.currency}
                        </span>
                      </td>
                      <td className="py-3 px-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${txn.debitCredit === "credit" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                          {txn.debitCredit?.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-3 px-2 max-w-[200px] truncate text-muted-foreground text-xs">{txn.description || "-"}</td>
                      <td className="py-3 px-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${statusColor(txn.status || "unmatched")}`}>
                          {txn.status || "unmatched"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <p className="text-xs text-muted-foreground">
                Showing {page * limit + 1}-{Math.min((page + 1) * limit, data?.total || 0)} of {data?.total || 0}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={(page + 1) * limit >= (data?.total || 0)} onClick={() => setPage(page + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
