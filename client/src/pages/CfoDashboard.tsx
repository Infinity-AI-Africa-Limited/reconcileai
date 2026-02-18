import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, DollarSign, AlertCircle, Clock, Activity } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from "recharts";

export default function CfoDashboard() {
  const { data: kpis, isLoading: kpisLoading } = trpc.dashboard.cfoKpis.useQuery();
  const { data: channelHealth, isLoading: channelLoading } = trpc.dashboard.cfoChannelHealth.useQuery();

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

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat("en-NG").format(num);
  };

  const formatPercentage = (num: number) => {
    return `${num.toFixed(1)}%`;
  };

  const formatTime = (hours: number) => {
    if (hours < 1) return `${Math.round(hours * 60)}min`;
    return `${hours.toFixed(1)}hrs`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-[#1B365D]">CFO Dashboard</h1>
        <p className="text-[#8C757D] mt-1">Executive financial reconciliation overview</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Total Transactions
            </CardTitle>
            <Activity className="h-4 w-4 text-[#F47458]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {formatNumber(kpis?.totalTransactions || 0)}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              Across all channels
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Match Rate
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {formatPercentage(kpis?.matchRate || 0)}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              {kpis?.matchRate && kpis.matchRate >= 95 ? "Excellent performance" : "Needs attention"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Open Exceptions
            </CardTitle>
            <AlertCircle className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {formatNumber(kpis?.totalExceptions || 0)}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              Requiring review
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Avg Processing Time
            </CardTitle>
            <Clock className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {formatTime(kpis?.avgProcessingTime || 0)}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              Per reconciliation job
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Channel Health Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold text-[#1B365D]">
            Channel Performance Overview
          </CardTitle>
          <p className="text-sm text-[#8C757D] mt-1">
            Match rates and exception counts by payment channel
          </p>
        </CardHeader>
        <CardContent>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={channelHealth || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                <XAxis 
                  dataKey="channel" 
                  tick={{ fill: "#8C757D", fontSize: 12 }}
                  angle={-45}
                  textAnchor="end"
                  height={80}
                />
                <YAxis tick={{ fill: "#8C757D", fontSize: 12 }} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: "#FFFFFF", 
                    border: "1px solid #E5E7EB",
                    borderRadius: "8px"
                  }}
                  formatter={(value: any, name: string) => {
                    if (name === "matchRate") return [formatPercentage(value), "Match Rate"];
                    return [formatNumber(value), name === "total" ? "Total Transactions" : "Exceptions"];
                  }}
                />
                <Bar dataKey="matchRate" fill="#10B981" name="Match Rate (%)" />
                <Bar dataKey="exceptions" fill="#F47458" name="Exceptions" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Channel Health Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold text-[#1B365D]">
            Detailed Channel Metrics
          </CardTitle>
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
                {channelHealth?.map((channel, idx) => (
                  <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-3 px-4 text-sm text-[#1B365D] font-medium">{channel.channel}</td>
                    <td className="py-3 px-4 text-sm text-[#8C757D] text-right">{formatNumber(channel.volume)}</td>
                    <td className="py-3 px-4 text-sm text-[#8C757D] text-right">{formatNumber(Math.round(channel.volume * channel.matchRate / 100))}</td>
                    <td className="py-3 px-4 text-sm text-[#8C757D] text-right">{formatNumber(channel.exceptions)}</td>
                    <td className="py-3 px-4 text-sm text-[#8C757D] text-right font-semibold">
                      {formatPercentage(channel.matchRate)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        channel.matchRate >= 95 
                          ? "bg-green-100 text-green-800" 
                          : channel.matchRate >= 85 
                          ? "bg-yellow-100 text-yellow-800" 
                          : "bg-red-100 text-red-800"
                      }`}>
                        {channel.matchRate >= 95 ? "Excellent" : channel.matchRate >= 85 ? "Good" : "Needs Attention"}
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
