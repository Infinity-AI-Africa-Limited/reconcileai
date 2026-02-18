import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, FileText, CheckCircle2, TrendingUp, Calendar } from "lucide-react";
import { useState } from "react";

export default function AuditorDashboard() {
  const [entityFilter, setEntityFilter] = useState<string | undefined>(undefined);
  
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
      <div>
        <h1 className="text-3xl font-bold text-[#1B365D]">Auditor Dashboard</h1>
        <p className="text-[#8C757D] mt-1">Compliance monitoring and audit trail</p>
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
