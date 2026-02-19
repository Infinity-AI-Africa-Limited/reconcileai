import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, DollarSign, AlertCircle, Clock, Activity, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from "recharts";

export default function CfoDashboard() {
  const [isExporting, setIsExporting] = useState(false);
  const { data: kpis, isLoading: kpisLoading } = trpc.dashboard.cfoKpis.useQuery();
  const { data: channelHealth, isLoading: channelLoading } = trpc.dashboard.cfoChannelHealth.useQuery();

  const exportToPDF = async () => {
    setIsExporting(true);
    try {
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 15;
      let yPosition = margin;

      // Header
      pdf.setFillColor(27, 54, 93); // #1B365D
      pdf.rect(0, 0, pageWidth, 35, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(24);
      pdf.setFont('helvetica', 'bold');
      pdf.text('ReconcileAI', margin, 15);
      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'normal');
      pdf.text('CFO Dashboard Report', margin, 25);
      pdf.setFontSize(10);
      pdf.text(`Generated: ${new Date().toLocaleString('en-NG')}`, margin, 30);

      yPosition = 45;
      pdf.setTextColor(0, 0, 0);

      // KPIs Section
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Key Performance Indicators', margin, yPosition);
      yPosition += 10;

      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'normal');
      const kpiData = [
        ['Total Transactions', `${formatNumber(kpis?.totalTransactions || 0)}`],
        ['Match Rate', `${formatPercentage(kpis?.matchRate || 0)}`],
        ['Total Exceptions', `${kpis?.totalExceptions || 0}`],
        ['Avg Processing Time', formatTime(kpis?.avgProcessingTime || 0)]
      ];

      kpiData.forEach(([label, value]) => {
        pdf.setFont('helvetica', 'bold');
        pdf.text(label + ':', margin, yPosition);
        pdf.setFont('helvetica', 'normal');
        pdf.text(value, margin + 60, yPosition);
        yPosition += 7;
      });

      yPosition += 5;

      // Channel Health Table
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Channel Health Metrics', margin, yPosition);
      yPosition += 10;

      // Table headers
      pdf.setFillColor(240, 240, 240);
      pdf.rect(margin, yPosition - 5, pageWidth - 2 * margin, 8, 'F');
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Channel', margin + 2, yPosition);
      pdf.text('Volume', margin + 50, yPosition);
      pdf.text('Match Rate', margin + 90, yPosition);
      pdf.text('Exceptions', margin + 130, yPosition);
      pdf.text('Status', margin + 165, yPosition);
      yPosition += 8;

      // Table rows
      pdf.setFont('helvetica', 'normal');
      channelHealth?.forEach((channel: any, index: number) => {
        if (yPosition > pageHeight - 20) {
          pdf.addPage();
          yPosition = margin;
        }

        if (index % 2 === 0) {
          pdf.setFillColor(250, 250, 250);
          pdf.rect(margin, yPosition - 5, pageWidth - 2 * margin, 7, 'F');
        }

        pdf.text(channel.name, margin + 2, yPosition);
        pdf.text(`₦${formatNumber(channel.volume)}`, margin + 50, yPosition);
        pdf.text(`${formatPercentage(channel.matchRate)}`, margin + 90, yPosition);
        pdf.text(`${channel.exceptions}`, margin + 130, yPosition);
        
        // Status with color
        const statusColor = channel.status === 'healthy' ? [34, 197, 94] : 
                           channel.status === 'warning' ? [251, 146, 60] : [239, 68, 68];
        pdf.setTextColor(statusColor[0], statusColor[1], statusColor[2]);
        pdf.text(channel.status.toUpperCase(), margin + 165, yPosition);
        pdf.setTextColor(0, 0, 0);
        
        yPosition += 7;
      });

      // Footer
      pdf.setFontSize(8);
      pdf.setTextColor(140, 117, 125);
      pdf.text('ReconcileAI - Confidential Report', margin, pageHeight - 10);
      pdf.text(`Page 1 of 1`, pageWidth - margin - 20, pageHeight - 10);

      pdf.save(`CFO-Dashboard-Report-${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (error) {
      console.error('PDF export failed:', error);
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
          <Download className={`h-4 w-4 ${isExporting ? 'animate-bounce' : ''}`} />
          {isExporting ? 'Exporting...' : 'Export PDF'}
        </Button>
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
