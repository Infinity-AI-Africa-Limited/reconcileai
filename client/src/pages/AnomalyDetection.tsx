import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, XCircle, Eye, Flag } from "lucide-react";

export default function AnomalyDetection() {
  const [reviewStatus, setReviewStatus] = useState<string>("pending");
  
  const { data: flaggedTxns, refetch, isLoading } = trpc.anomalies.getFlagged.useQuery({
    reviewStatus: reviewStatus as any,
    minScore: 0.6,
    limit: 50,
  });
  
  const updateReviewMutation = trpc.anomalies.updateReview.useMutation();
  
  const handleReview = async (id: number, status: string) => {
    try {
      await updateReviewMutation.mutateAsync({
        id,
        reviewStatus: status as any,
      });
      toast.success(`Anomaly marked as ${status}`);
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to update review");
    }
  };
  
  const getSeverityBadge = (score: number) => {
    if (score >= 0.9) return <Badge variant="destructive">Critical</Badge>;
    if (score >= 0.75) return <Badge className="bg-orange-600">High</Badge>;
    if (score >= 0.6) return <Badge className="bg-yellow-600">Medium</Badge>;
    return <Badge variant="secondary">Low</Badge>;
  };
  
  return (
    <div className="container mx-auto py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <AlertTriangle className="w-8 h-8 text-orange-600" />
            Anomaly Detection
          </h1>
          <p className="text-muted-foreground mt-2">
            AI-powered suspicious transaction detection
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Select value={reviewStatus} onValueChange={setReviewStatus}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending Review</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="false_positive">False Positive</SelectItem>
              <SelectItem value="escalated">Escalated</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Loading flagged transactions...</p>
          </CardContent>
        </Card>
      ) : !flaggedTxns || flaggedTxns.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <CheckCircle2 className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No anomalies detected with status: {reviewStatus}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {flaggedTxns.map((item: any) => {
            const { anomaly, transaction } = item;
            const score = parseFloat(anomaly.anomalyScore);
            
            return (
              <Card key={anomaly.id} className="border-l-4 border-l-orange-600">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="flex items-center gap-2">
                        <Flag className="w-5 h-5 text-orange-600" />
                        Transaction #{transaction.id}
                      </CardTitle>
                      <CardDescription>
                        {transaction.description || "No description"}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      {getSeverityBadge(score)}
                      <Badge variant="outline">
                        Score: {score.toFixed(3)}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Amount:</span>
                      <span className="ml-2 font-medium">
                        {transaction.currency} {parseFloat(transaction.amount).toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Date:</span>
                      <span className="ml-2 font-medium">
                        {new Date(transaction.transactionDate).toLocaleDateString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Counterparty:</span>
                      <span className="ml-2 font-medium">
                        {transaction.counterparty || "Unknown"}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Detection Method:</span>
                      <span className="ml-2 font-mono text-xs">
                        {anomaly.detectionMethod}
                      </span>
                    </div>
                  </div>
                  
                  <div className="bg-muted p-4 rounded-lg">
                    <p className="text-sm font-medium mb-2">Detection Reason:</p>
                    <p className="text-sm text-muted-foreground">
                      {anomaly.detectionReason}
                    </p>
                  </div>
                  
                  {anomaly.reviewStatus === "pending" && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleReview(anomaly.id, "false_positive")}
                        disabled={updateReviewMutation.isPending}
                      >
                        <XCircle className="w-4 h-4 mr-2" />
                        False Positive
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleReview(anomaly.id, "confirmed")}
                        disabled={updateReviewMutation.isPending}
                      >
                        <CheckCircle2 className="w-4 h-4 mr-2" />
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleReview(anomaly.id, "escalated")}
                        disabled={updateReviewMutation.isPending}
                      >
                        <AlertTriangle className="w-4 h-4 mr-2" />
                        Escalate
                      </Button>
                    </div>
                  )}
                  
                  {anomaly.reviewStatus !== "pending" && anomaly.reviewedAt && (
                    <div className="text-sm text-muted-foreground">
                      Reviewed on {new Date(anomaly.reviewedAt).toLocaleString()}
                      {anomaly.reviewNotes && ` - ${anomaly.reviewNotes}`}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
