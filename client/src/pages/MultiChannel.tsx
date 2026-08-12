import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Layers, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";

export default function MultiChannelPage() {
  const { data: channels, isLoading: chLoading } = trpc.channels.list.useQuery();
  const { data: stats, isLoading: stLoading } = trpc.dashboard.stats.useQuery();

  const isLoading = chLoading || stLoading;

  const channelIcons: Record<string, string> = {
    NIBSS: "🏦", POS: "💳", ATM: "🏧", MOBILE_MONEY: "📱",
    BANK_STATEMENT: "📄", FINTECH_API: "⚡", USSD: "📞",
    // Card scheme channels
    CARD_MASTERCARD_ISW: "💳", CARD_VISA_ISW: "💳", CARD_VERVE_ISW: "💳",
    CARD_MASTERCARD_UP: "💳", CARD_VISA_UP: "💳",
    CARD_PAYMENT: "💳", CARD_PAYMENTS: "💳",
  };

  const channelTypeBadge: Record<string, { label: string; color: string }> = {
    card_payments: { label: "Card Scheme", color: "bg-purple-100 text-purple-700" },
    nibss: { label: "NIBSS", color: "bg-blue-100 text-blue-700" },
    pos: { label: "POS", color: "bg-green-100 text-green-700" },
    atm: { label: "ATM", color: "bg-amber-100 text-amber-700" },
    mobile_money: { label: "Mobile", color: "bg-sky-100 text-sky-700" },
    bank_core: { label: "Core Banking", color: "bg-slate-100 text-slate-700" },
    agent_banking: { label: "Agent", color: "bg-orange-100 text-orange-700" },
    ussd: { label: "USSD", color: "bg-teal-100 text-teal-700" },
    fintech_api: { label: "API", color: "bg-indigo-100 text-indigo-700" },
    mobile_banking: { label: "Mobile Banking", color: "bg-cyan-100 text-cyan-700" },
    bank_transfer: { label: "Bank Transfer", color: "bg-gray-100 text-gray-700" },
  };

  const channelStats = stats?.channelStats || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">Multi-Channel View</h1>
        <p className="text-muted-foreground mt-1">Reconciliation status across all payment channels</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : (
        <>
          {/* Channel Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {channels?.map((ch) => {
              const chStat = channelStats.find((s) => s.channelId === ch.id);
              const total = chStat?.total || 0;
              const matched = chStat?.matched || 0;
              const unmatched = chStat?.unmatched || 0;
              const exceptions = chStat?.exceptions || 0;
              const matchRate = total > 0 ? ((matched / total) * 100) : 0;

              return (
                <Card key={ch.id} className="hover:shadow-md transition-shadow">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{channelIcons[ch.code] || "📊"}</span>
                        <div>
                          <CardTitle className="text-base">{ch.name}</CardTitle>
                          <div className="flex items-center gap-1 mt-0.5">
                            <p className="text-xs text-muted-foreground">{ch.code}</p>
                            {ch.channelType && (() => {
                              const badge = channelTypeBadge[ch.channelType];
                              return badge ? (
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${badge.color}`}>{badge.label}</span>
                              ) : null;
                            })()}
                          </div>
                        </div>
                      </div>
                      <div className={`w-3 h-3 rounded-full ${ch.isActive ? "bg-green-500" : "bg-gray-300"}`} />
                    </div>
                  </CardHeader>
                  <CardContent>
                    {total > 0 ? (
                      <div className="space-y-3">
                        {/* Match Rate Bar */}
                        <div>
                          <div className="flex items-center justify-between text-sm mb-1">
                            <span className="text-muted-foreground">Match Rate</span>
                            <span className={`font-bold ${matchRate >= 80 ? "text-green-600" : matchRate >= 50 ? "text-amber-500" : "text-red-500"}`}>
                              {matchRate.toFixed(1)}%
                            </span>
                          </div>
                          <div className="w-full bg-muted rounded-full h-2.5">
                            <div
                              className={`h-2.5 rounded-full transition-all ${matchRate >= 80 ? "bg-green-500" : matchRate >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                              style={{ width: `${matchRate}%` }}
                            />
                          </div>
                        </div>

                        {/* Stats */}
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="p-2 bg-green-50 rounded">
                            <CheckCircle2 className="h-3 w-3 text-green-600 mx-auto mb-1" />
                            <p className="text-xs text-muted-foreground">Matched</p>
                            <p className="font-bold text-sm text-green-700">{matched.toLocaleString()}</p>
                          </div>
                          <div className="p-2 bg-amber-50 rounded">
                            <AlertTriangle className="h-3 w-3 text-amber-600 mx-auto mb-1" />
                            <p className="text-xs text-muted-foreground">Exceptions</p>
                            <p className="font-bold text-sm text-amber-700">{exceptions.toLocaleString()}</p>
                          </div>
                          <div className="p-2 bg-gray-50 rounded">
                            <XCircle className="h-3 w-3 text-gray-500 mx-auto mb-1" />
                            <p className="text-xs text-muted-foreground">Unmatched</p>
                            <p className="font-bold text-sm text-gray-700">{unmatched.toLocaleString()}</p>
                          </div>
                        </div>

                        <p className="text-xs text-muted-foreground text-center">{total.toLocaleString()} total transactions</p>
                      </div>
                    ) : (
                      <div className="text-center py-4">
                        <p className="text-sm text-muted-foreground">No transactions uploaded</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Cross-Channel Summary */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                Cross-Channel Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-3 font-medium text-muted-foreground">Channel</th>
                      <th className="text-right py-3 px-3 font-medium text-muted-foreground">Total Txns</th>
                      <th className="text-right py-3 px-3 font-medium text-muted-foreground">Matched</th>
                      <th className="text-right py-3 px-3 font-medium text-muted-foreground">Exceptions</th>
                      <th className="text-right py-3 px-3 font-medium text-muted-foreground">Unmatched</th>
                      <th className="text-right py-3 px-3 font-medium text-muted-foreground">Match Rate</th>
                      <th className="text-left py-3 px-3 font-medium text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels?.map((ch) => {
                      const chStat = channelStats.find((s) => s.channelId === ch.id);
                      const total = chStat?.total || 0;
                      const matched = chStat?.matched || 0;
                      const unmatched = chStat?.unmatched || 0;
                      const exceptions = chStat?.exceptions || 0;
                      const matchRate = total > 0 ? ((matched / total) * 100) : 0;

                      return (
                        <tr key={ch.id} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="py-3 px-3 font-medium">
                            <span className="mr-2">{channelIcons[ch.code] || "📊"}</span>{ch.name}
                          </td>
                          <td className="py-3 px-3 text-right font-mono">{total.toLocaleString()}</td>
                          <td className="py-3 px-3 text-right font-mono text-green-600">{matched.toLocaleString()}</td>
                          <td className="py-3 px-3 text-right font-mono text-amber-500">{exceptions.toLocaleString()}</td>
                          <td className="py-3 px-3 text-right font-mono text-red-500">{unmatched.toLocaleString()}</td>
                          <td className="py-3 px-3 text-right">
                            <span className={`font-bold ${matchRate >= 80 ? "text-green-600" : matchRate >= 50 ? "text-amber-500" : "text-red-500"}`}>
                              {total > 0 ? `${matchRate.toFixed(1)}%` : "-"}
                            </span>
                          </td>
                          <td className="py-3 px-3">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${ch.isActive ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                              {ch.isActive ? "Active" : "Inactive"}
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
        </>
      )}
    </div>
  );
}
