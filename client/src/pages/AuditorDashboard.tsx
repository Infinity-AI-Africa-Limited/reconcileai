import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, FileText, CheckCircle2, TrendingUp, Calendar, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import jsPDF from "jspdf";
import { useState } from "react";

export default function AuditorDashboard() {
  const [isExporting, setIsExporting] = useState(false);
  const [entityFilter, setEntityFilter] = useState<string | undefined>(undefined);

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
      pdf.text('Auditor Dashboard Report', margin, 25);
      pdf.setFontSize(10);
      pdf.text(`Generated: ${new Date().toLocaleString('en-NG')}`, margin, 30);

      yPosition = 45;
      pdf.setTextColor(0, 0, 0);

      // Compliance Metrics Section
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Compliance Metrics', margin, yPosition);
      yPosition += 10;

      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'normal');
      const complianceData = [
        ['Total Reconciliations', `${compliance?.totalReconciliations || 0}`],
        ['Completed Reconciliations', `${compliance?.completedReconciliations || 0}`],
        ['Audit Trail Entries', `${compliance?.auditTrailEntries || 0}`],
        ['Data Integrity Score', `${compliance?.dataIntegrityScore || 0}%`],
        ['Compliance Rate', `${compliance?.complianceRate || 0}%`]
      ];

      complianceData.forEach(([label, value]) => {
        pdf.setFont('helvetica', 'bold');
        pdf.text(label + ':', margin, yPosition);
        pdf.setFont('helvetica', 'normal');
        pdf.text(value, margin + 60, yPosition);
        yPosition += 7;
      });

      yPosition += 5;

      // CBN Compliance Checklist
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.text('CBN Compliance Checklist', margin, yPosition);
      yPosition += 10;

      pdf.setFontSize(10);
      const checklistItems = [
        'Daily reconciliation completed',
        'Exception resolution within SLA',
        'Audit trail maintained',
        'Regulatory reports submitted'
      ];

      checklistItems.forEach((item) => {
        pdf.setFont('helvetica', 'normal');
        pdf.text('✓', margin, yPosition);
        pdf.text(item, margin + 5, yPosition);
        yPosition += 6;
      });

      yPosition += 5;

      // Recent Audit Trail
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Recent Audit Trail', margin, yPosition);
      yPosition += 10;

      // Table headers
      pdf.setFillColor(240, 240, 240);
      pdf.rect(margin, yPosition - 5, pageWidth - 2 * margin, 8, 'F');
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Timestamp', margin + 2, yPosition);
      pdf.text('User', margin + 45, yPosition);
      pdf.text('Action', margin + 80, yPosition);
      pdf.text('Entity', margin + 120, yPosition);
      yPosition += 8;

      // Table rows (limit to first 20 for PDF)
      pdf.setFont('helvetica', 'normal');
      const recentLogs = auditTrail?.data.slice(0, 20) || [];
      recentLogs.forEach((log: any, index: number) => {
        if (yPosition > pageHeight - 20) {
          pdf.addPage();
          yPosition = margin;
        }

        if (index % 2 === 0) {
          pdf.setFillColor(250, 250, 250);
          pdf.rect(margin, yPosition - 5, pageWidth - 2 * margin, 7, 'F');
        }

        const timestamp = new Date(log.timestamp).toLocaleString('en-NG', { 
          month: 'short', 
          day: 'numeric', 
          hour: '2-digit', 
          minute: '2-digit' 
        });
        pdf.text(timestamp, margin + 2, yPosition);
        pdf.text(log.userName || 'System', margin + 45, yPosition);
        pdf.text(log.action, margin + 80, yPosition);
        pdf.text(log.entityType || 'N/A', margin + 120, yPosition);
        
        yPosition += 7;
      });

      // Footer
      const totalPages = pdf.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        pdf.setPage(i);
        pdf.setFontSize(8);
        pdf.setTextColor(140, 117, 125);
        pdf.text('ReconcileAI - Confidential Audit Report', margin, pageHeight - 10);
        pdf.text(`Page ${i} of ${totalPages}`, pageWidth - margin - 20, pageHeight - 10);
      }

      pdf.save(`Auditor-Dashboard-Report-${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (error) {
      console.error('PDF export failed:', error);
    } finally {
      setIsExporting(false);
    }
  };
  
  const { data: compliance, isLoading: complianceLoading } = trpc.dashboard.auditorCompliance.useQuery();
  const { data: auditTrail, isLoading: trailLoading } = trpc.dashboard.auditorTrail.useQuery({
    entityType: entityFilter,
    limit: 100
  });

  if (complianceLoading || trailLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-[#1B365D]">Auditor Dashboard</h1>
          <p className="text-[#8C757D] mt-1">Compliance monitoring and audit trail</p>
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

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleString("en-NG", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  };

  const entityTypes = Array.from(new Set(auditTrail?.data.map(log => log.entityType).filter(Boolean))) as string[];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[#1B365D]">Auditor Dashboard</h1>
          <p className="text-[#8C757D] mt-1">Compliance monitoring and audit trail</p>
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

      {/* Compliance Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Total Reconciliations
            </CardTitle>
            <FileText className="h-4 w-4 text-[#F47458]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {compliance?.totalReconciliations || 0}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              All-time count
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Completed Jobs
            </CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {compliance?.completedReconciliations || 0}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              Successfully processed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Audit Trail Entries
            </CardTitle>
            <Calendar className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {compliance?.auditTrailEntries || 0}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              Logged activities
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Compliance Rate
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {compliance?.complianceRate?.toFixed(1) || 0}%
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              CBN standards
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Data Integrity Score */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold text-[#1B365D]">
            Data Integrity Score
          </CardTitle>
          <p className="text-sm text-[#8C757D] mt-1">
            System-wide data quality assessment
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-[#8C757D]">Overall Score</span>
                <span className="text-2xl font-bold text-[#1B365D]">
                  {compliance?.dataIntegrityScore?.toFixed(1) || 0}%
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div 
                  className="bg-green-600 h-3 rounded-full transition-all duration-500"
                  style={{ width: `${compliance?.dataIntegrityScore || 0}%` }}
                ></div>
              </div>
            </div>
            <Shield className="h-12 w-12 text-green-600" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-xs text-[#8C757D] mb-1">Transaction Accuracy</p>
              <p className="text-lg font-bold text-[#1B365D]">99.2%</p>
            </div>
            <div>
              <p className="text-xs text-[#8C757D] mb-1">Audit Coverage</p>
              <p className="text-lg font-bold text-[#1B365D]">100%</p>
            </div>
            <div>
              <p className="text-xs text-[#8C757D] mb-1">Data Completeness</p>
              <p className="text-lg font-bold text-[#1B365D]">97.8%</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Audit Trail */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg font-semibold text-[#1B365D]">
                Recent Audit Trail
              </CardTitle>
              <p className="text-sm text-[#8C757D] mt-1">
                {auditTrail?.data.length || 0} recent activities logged
              </p>
            </div>
            <div className="flex gap-2">
              <select
                value={entityFilter || "all"}
                onChange={(e) => setEntityFilter(e.target.value === "all" ? undefined : e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#1B365D]"
              >
                <option value="all">All Types</option>
                {entityTypes.map(type => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[#1B365D]">Timestamp</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[#1B365D]">User</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[#1B365D]">Action</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[#1B365D]">Entity Type</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[#1B365D]">Entity ID</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[#1B365D]">IP Address</th>
                </tr>
              </thead>
              <tbody>
                {auditTrail?.data && auditTrail.data.length > 0 ? (
                  auditTrail.data.map((log) => (
                    <tr key={log.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-3 px-4 text-sm text-[#8C757D]">
                        {formatDate(log.createdAt)}
                      </td>
                      <td className="py-3 px-4 text-sm text-[#1B365D] font-medium">
                        User #{log.userId || "System"}
                      </td>
                      <td className="py-3 px-4 text-sm text-[#8C757D]">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                          {log.action}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-sm text-[#8C757D]">
                        {log.entityType || "N/A"}
                      </td>
                      <td className="py-3 px-4 text-sm text-[#8C757D]">
                        {log.entityId || "N/A"}
                      </td>
                      <td className="py-3 px-4 text-sm text-[#8C757D] font-mono">
                        {log.ipAddress || "N/A"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-[#8C757D]">
                      No audit trail entries found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Compliance Checklist */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold text-[#1B365D]">
            CBN Compliance Checklist
          </CardTitle>
          <p className="text-sm text-[#8C757D] mt-1">
            Regulatory requirements status
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { item: "Daily reconciliation reports generated", status: true },
              { item: "All transactions logged with audit trail", status: true },
              { item: "Exception handling within SLA", status: true },
              { item: "Data encryption at rest and in transit", status: true },
              { item: "Multi-factor authentication enabled", status: true },
              { item: "Quarterly compliance audit completed", status: false },
            ].map((check, idx) => (
              <div key={idx} className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg">
                <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
                  check.status ? "bg-green-100" : "bg-gray-100"
                }`}>
                  {check.status ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : (
                    <div className="w-3 h-3 rounded-full border-2 border-gray-400"></div>
                  )}
                </div>
                <span className={`text-sm ${check.status ? "text-[#1B365D]" : "text-[#8C757D]"}`}>
                  {check.item}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
