import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Clock, CheckCircle2, TrendingDown, Eye, ArrowRight, RefreshCw, UserPlus } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

export default function OperationsDashboard() {
  const [, navigate] = useLocation();
  const [priority, setPriority] = useState<"all" | "high" | "medium" | "low">("all");
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [newExceptionIds, setNewExceptionIds] = useState<Set<number>>(new Set());
  const [selectedExceptions, setSelectedExceptions] = useState<Set<number>>(new Set());
  const [bulkAssignUserId, setBulkAssignUserId] = useState<string>("");
  
  const { data: queue, isLoading: queueLoading, refetch: refetchQueue } = trpc.dashboard.operationsQueue.useQuery({ 
    priority,
    limit: 50 
  }, {
    refetchInterval: 10000, // Poll every 10 seconds
    refetchIntervalInBackground: true,
  });
  const { data: sla, isLoading: slaLoading, refetch: refetchSla } = trpc.dashboard.operationsSla.useQuery(undefined, {
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
  });
  const { data: teamMembers } = trpc.exceptions.getTeamMembers.useQuery();
  const { data: workload, isLoading: workloadLoading } = trpc.exceptions.getTeamWorkload.useQuery();
  const assignException = trpc.exceptions.assign.useMutation({
    onSuccess: () => {
      refetchQueue();
    },
  });
  const bulkAssignMutation = trpc.exceptions.bulkAssign.useMutation({
    onSuccess: (data) => {
      toast.success(`Successfully assigned ${data.count} exceptions`);
      setSelectedExceptions(new Set());
      setBulkAssignUserId("");
      refetchQueue();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // Track new exceptions
  useEffect(() => {
    if (queue?.exceptions) {
      const currentIds = new Set(queue.exceptions.map(e => e.id));
      const previousIds = newExceptionIds.size > 0 ? newExceptionIds : currentIds;
      const newIds = new Set(Array.from(currentIds).filter(id => !previousIds.has(id)));
      
      if (newIds.size > 0 && previousIds.size > 0) {
        setNewExceptionIds(newIds);
        // Clear highlights after 5 seconds
        setTimeout(() => setNewExceptionIds(new Set()), 5000);
      }
      setLastUpdate(new Date());
    }
  }, [queue]);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([refetchQueue(), refetchSla()]);
    setIsRefreshing(false);
  };

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[#1B365D]">Operations Dashboard</h1>
          <p className="text-[#8C757D] mt-1">Exception queue and resolution tracking</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-xs text-[#8C757D]">Last updated</p>
            <p className="text-sm font-medium text-[#1B365D]">
              {lastUpdate.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
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
          {selectedExceptions.size > 0 && (
            <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="font-semibold text-blue-900">
                  {selectedExceptions.size} exception{selectedExceptions.size !== 1 ? 's' : ''} selected
                </span>
                <Select value={bulkAssignUserId} onValueChange={setBulkAssignUserId}>
                  <SelectTrigger className="w-[200px] bg-white">
                    <SelectValue placeholder="Assign to..." />
                  </SelectTrigger>
                  <SelectContent>
                    {teamMembers?.map((member) => (
                      <SelectItem key={member.id} value={String(member.id)}>
                        {member.name || member.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={() => {
                    if (bulkAssignUserId) {
                      bulkAssignMutation.mutate({
                        exceptionIds: Array.from(selectedExceptions),
                        assignedTo: parseInt(bulkAssignUserId),
                      });
                    }
                  }}
                  disabled={!bulkAssignUserId || bulkAssignMutation.isPending}
                  size="sm"
                >
                  <UserPlus className="h-4 w-4 mr-2" />
                  Bulk Assign
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedExceptions(new Set())}
                >
                  Clear Selection
                </Button>
              </div>
            </div>
          )}
          <div className="space-y-3">
            {queue?.exceptions && queue.exceptions.length > 0 ? (
              queue.exceptions.map((exception) => {
                const isNew = newExceptionIds.has(exception.id);
                return (
                <div
                  key={exception.id}
                  className={`relative flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50 transition-all ${
                    isNew 
                      ? 'border-blue-500 bg-blue-50 shadow-md animate-pulse' 
                      : 'border-gray-200'
                  }`}
                >
                  {isNew && (
                    <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-xs px-2 py-0.5 rounded-full font-semibold">
                      NEW
                    </div>
                  )}
                  <div className="flex items-start gap-4 flex-1">
                    <input
                      type="checkbox"
                      checked={selectedExceptions.has(exception.id)}
                      onChange={(e) => {
                        const newSelection = new Set(selectedExceptions);
                        if (e.target.checked) {
                          newSelection.add(exception.id);
                        } else {
                          newSelection.delete(exception.id);
                        }
                        setSelectedExceptions(newSelection);
                      }}
                      className="mt-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
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
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
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
                        {exception.slaStatus && (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            exception.slaStatus === "green"
                              ? "bg-green-100 text-green-800"
                              : exception.slaStatus === "yellow"
                              ? "bg-yellow-100 text-yellow-800"
                              : "bg-red-100 text-red-800"
                          }`}>
                            <Clock className="h-3 w-3 mr-1" />
                            {exception.hoursOpen}h open
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-[#8C757D] mb-2">
                        Transaction ID: {exception.transactionId} • Status: {exception.status}
                      </p>
                      {exception.suggestedResolution && (
                        <p className="text-xs text-[#8C757D] bg-blue-50 p-2 rounded border border-blue-200">
                          <strong className="text-blue-700">AI Suggestion:</strong> {exception.suggestedResolution}
                        </p>
                      )}
                      {exception.assignedTo && (
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-xs text-[#8C757D]">Assigned to:</span>
                          <span className="text-xs font-medium text-[#1B365D] bg-blue-100 px-2 py-1 rounded">
                            {teamMembers?.find(u => u.id === exception.assignedTo)?.name || `User #${exception.assignedTo}`}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Select
                      value={exception.assignedTo?.toString() || ""}
                      onValueChange={(value) => {
                        if (value) {
                          assignException.mutate({
                            id: exception.id,
                            assignedTo: parseInt(value),
                          });
                        }
                      }}
                    >
                      <SelectTrigger className="w-[140px] h-9">
                        <UserPlus className="h-4 w-4 mr-2" />
                        <SelectValue placeholder="Assign" />
                      </SelectTrigger>
                      <SelectContent>
                        {teamMembers?.map((member) => (
                          <SelectItem key={member.id} value={member.id.toString()}>
                            {member.name || member.email || `User #${member.id}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate("/exceptions")}
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      Review
                    </Button>
                  </div>
                </div>
                );
              })
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

      {/* Team Workload Analytics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[#1B365D]">Team Workload Analytics</CardTitle>
          <p className="text-sm text-[#8C757D] mt-1">Current load and performance metrics per team member</p>
        </CardHeader>
        <CardContent>
          {workloadLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="p-4 border rounded-lg animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-32 mb-3"></div>
                  <div className="h-6 bg-gray-200 rounded w-16 mb-2"></div>
                  <div className="h-3 bg-gray-200 rounded w-24"></div>
                </div>
              ))}
            </div>
          ) : workload && workload.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {workload.map((member) => {
                const loadLevel = member.currentLoad > 10 ? 'high' : member.currentLoad > 5 ? 'medium' : 'low';
                const loadColor = loadLevel === 'high' ? 'bg-red-50 border-red-200' : loadLevel === 'medium' ? 'bg-yellow-50 border-yellow-200' : 'bg-green-50 border-green-200';
                const loadTextColor = loadLevel === 'high' ? 'text-red-700' : loadLevel === 'medium' ? 'text-yellow-700' : 'text-green-700';
                
                return (
                  <div key={member.userId} className={`p-4 border rounded-lg ${loadColor}`}>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-semibold text-[#1B365D]">{member.userName}</h3>
                      <span className={`text-2xl font-bold ${loadTextColor}`}>{member.currentLoad}</span>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-[#8C757D]">Current Load:</span>
                        <span className={`font-medium ${loadTextColor}`}>
                          {member.currentLoad} exception{member.currentLoad !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#8C757D]">Avg Resolution:</span>
                        <span className="font-medium text-[#1B365D]">{member.avgResolutionTime}hrs</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#8C757D]">SLA Compliance:</span>
                        <span className={`font-medium ${member.slaComplianceRate >= 90 ? 'text-green-600' : member.slaComplianceRate >= 70 ? 'text-yellow-600' : 'text-red-600'}`}>
                          {member.slaComplianceRate}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#8C757D]">Total Resolved:</span>
                        <span className="font-medium text-[#1B365D]">{member.totalResolved}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-[#8C757D]">No team workload data available</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
