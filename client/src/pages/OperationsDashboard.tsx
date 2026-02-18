import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Clock, CheckCircle2, TrendingDown, Eye, ArrowRight } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";

export default function OperationsDashboard() {
  const [, navigate] = useLocation();
  const [priority, setPriority] = useState<"all" | "high" | "medium" | "low">("all");
  
  const { data: queue, isLoading: queueLoading } = trpc.dashboard.operationsQueue.useQuery({ 
    priority,
    limit: 50 
  });
  const { data: sla, isLoading: slaLoading } = trpc.dashboard.operationsSla.useQuery();

  if (queueLoading || slaLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-[#1B365D]">Operations Dashboard</h1>
          <p className="text-[#8C757D] mt-1">Exception queue and resolution tracking</p>
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

  const formatTime = (hours: number) => {
    if (hours < 1) return `${Math.round(hours * 60)}min`;
    if (hours < 24) return `${hours.toFixed(1)}hrs`;
    return `${(hours / 24).toFixed(1)} days`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-[#1B365D]">Operations Dashboard</h1>
        <p className="text-[#8C757D] mt-1">Exception queue and resolution tracking</p>
      </div>

      {/* SLA Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Total Backlog
            </CardTitle>
            <AlertTriangle className="h-4 w-4 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {sla?.backlogSize || 0}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              Pending exceptions
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Avg Resolution Time
            </CardTitle>
            <Clock className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {formatTime(sla?.avgResolutionTimeHours || 0)}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              Per exception
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              Resolved Today
            </CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {sla?.resolvedWithin24h || 0}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              Completed resolutions
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-[#8C757D]">
              SLA Compliance
            </CardTitle>
            <TrendingDown className={`h-4 w-4 ${sla?.slaCompliance === "On Track" ? "text-green-600" : "text-red-600"}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#1B365D]">
              {sla?.slaCompliance || "N/A"}
            </div>
            <p className="text-xs text-[#8C757D] mt-1">
              24-hour target
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Priority Filter */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg font-semibold text-[#1B365D]">
                Exception Queue
              </CardTitle>
              <p className="text-sm text-[#8C757D] mt-1">
                {queue?.total || 0} exceptions requiring attention
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant={priority === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => setPriority("all")}
                className={priority === "all" ? "bg-[#1B365D] hover:bg-[#152B4A]" : ""}
              >
                All ({queue?.total || 0})
              </Button>
              <Button
                variant={priority === "high" ? "default" : "outline"}
                size="sm"
                onClick={() => setPriority("high")}
                className={priority === "high" ? "bg-red-600 hover:bg-red-700" : ""}
              >
                High ({queue?.highPriority || 0})
              </Button>
              <Button
                variant={priority === "medium" ? "default" : "outline"}
                size="sm"
                onClick={() => setPriority("medium")}
                className={priority === "medium" ? "bg-orange-600 hover:bg-orange-700" : ""}
              >
                Medium ({queue?.mediumPriority || 0})
              </Button>
              <Button
                variant={priority === "low" ? "default" : "outline"}
                size="sm"
                onClick={() => setPriority("low")}
                className={priority === "low" ? "bg-yellow-600 hover:bg-yellow-700" : ""}
              >
                Low ({queue?.lowPriority || 0})
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {queue?.exceptions && queue.exceptions.length > 0 ? (
              queue.exceptions.map((exception) => (
                <div
                  key={exception.id}
                  className="flex items-center justify-between p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-start gap-4 flex-1">
                    <div className={`mt-1 p-2 rounded-full ${
                      exception.severity === "high" 
                        ? "bg-red-100" 
                        : exception.severity === "medium" 
                        ? "bg-orange-100" 
                        : "bg-yellow-100"
                    }`}>
                      <AlertTriangle className={`h-4 w-4 ${
                        exception.severity === "high" 
                          ? "text-red-600" 
                          : exception.severity === "medium" 
                          ? "text-orange-600" 
                          : "text-yellow-600"
                      }`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          exception.severity === "high" 
                            ? "bg-red-100 text-red-800" 
                            : exception.severity === "medium" 
                            ? "bg-orange-100 text-orange-800" 
                            : "bg-yellow-100 text-yellow-800"
                        }`}>
                          {exception.severity?.toUpperCase()}
                        </span>
                        <span className="text-sm font-medium text-[#1B365D]">
                          {exception.category}
                        </span>
                      </div>
                      <p className="text-sm text-[#8C757D] mb-2">
                        Transaction ID: {exception.transactionId} • Status: {exception.status}
                      </p>
                      {exception.suggestedResolution && (
                        <p className="text-xs text-[#8C757D] bg-blue-50 p-2 rounded border border-blue-200">
                          <strong className="text-blue-700">AI Suggestion:</strong> {exception.suggestedResolution}
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate("/exceptions")}
                    className="ml-4"
                  >
                    <Eye className="h-4 w-4 mr-1" />
                    Review
                  </Button>
                </div>
              ))
            ) : (
              <div className="text-center py-12">
                <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-3" />
                <p className="text-[#8C757D] font-medium">No exceptions in queue</p>
                <p className="text-sm text-[#8C757D] mt-1">All transactions are reconciled</p>
              </div>
            )}
          </div>

          {queue?.exceptions && queue.exceptions.length > 0 && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="outline"
                onClick={() => navigate("/exceptions")}
                className="gap-2"
              >
                View All Exceptions
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
