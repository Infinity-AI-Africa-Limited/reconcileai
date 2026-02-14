import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Mail,
  Bell,
  AlertTriangle,
  CheckCircle2,
  Save,
  Loader2,
  Send,
  FileText,
  BarChart3,
  TrendingUp,
  Shield,
  X,
} from "lucide-react";

export default function EmailSettings() {
  const { data: prefs, isLoading, refetch } = trpc.emailPreferences.get.useQuery();
  const updateMutation = trpc.emailPreferences.update.useMutation({
    onSuccess: () => {
      toast.success("Email preferences saved");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const [emailEnabled, setEmailEnabled] = useState(true);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [newRecipient, setNewRecipient] = useState("");
  const [includeMatchBreakdown, setIncludeMatchBreakdown] = useState(true);
  const [includeExceptionDetails, setIncludeExceptionDetails] = useState(true);
  const [includeChannelPerformance, setIncludeChannelPerformance] = useState(true);
  const [includeTrendAnalysis, setIncludeTrendAnalysis] = useState(false);
  const [notifyOnCompletion, setNotifyOnCompletion] = useState(true);
  const [notifyOnFailure, setNotifyOnFailure] = useState(true);
  const [notifyOnHighExceptions, setNotifyOnHighExceptions] = useState(true);
  const [highExceptionThreshold, setHighExceptionThreshold] = useState("10");
  const [lowMatchRateThreshold, setLowMatchRateThreshold] = useState("80");

  useEffect(() => {
    if (prefs) {
      setEmailEnabled(prefs.emailEnabled);
      setRecipients(
        Array.isArray(prefs.defaultRecipients)
          ? prefs.defaultRecipients
          : typeof prefs.defaultRecipients === "string"
          ? JSON.parse(prefs.defaultRecipients || "[]")
          : []
      );
      setIncludeMatchBreakdown(prefs.includeMatchBreakdown);
      setIncludeExceptionDetails(prefs.includeExceptionDetails);
      setIncludeChannelPerformance(prefs.includeChannelPerformance);
      setIncludeTrendAnalysis(prefs.includeTrendAnalysis);
      setNotifyOnCompletion(prefs.notifyOnCompletion);
      setNotifyOnFailure(prefs.notifyOnFailure);
      setNotifyOnHighExceptions(prefs.notifyOnHighExceptions);
      setHighExceptionThreshold(String(prefs.highExceptionThreshold));
      setLowMatchRateThreshold(String(prefs.lowMatchRateThreshold));
    }
  }, [prefs]);

  const addRecipient = () => {
    const email = newRecipient.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("Invalid email address");
      return;
    }
    if (recipients.includes(email)) {
      toast.error("Email already added");
      return;
    }
    if (recipients.length >= 20) {
      toast.error("Maximum 20 recipients allowed");
      return;
    }
    setRecipients([...recipients, email]);
    setNewRecipient("");
  };

  const removeRecipient = (email: string) => {
    setRecipients(recipients.filter((r) => r !== email));
  };

  const handleSave = () => {
    updateMutation.mutate({
      emailEnabled,
      defaultRecipients: recipients,
      includeMatchBreakdown,
      includeExceptionDetails,
      includeChannelPerformance,
      includeTrendAnalysis,
      notifyOnCompletion,
      notifyOnFailure,
      notifyOnHighExceptions,
      highExceptionThreshold: parseInt(highExceptionThreshold) || 10,
      lowMatchRateThreshold: parseFloat(lowMatchRateThreshold) || 80,
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Email & Notification Settings</h1>
        <p className="text-muted-foreground mt-1">
          Configure how and when you receive reconciliation reports and alerts
        </p>
      </div>

      {/* Master Toggle */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Mail className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium">Email Notifications</p>
                <p className="text-sm text-muted-foreground">
                  Enable or disable all email notifications
                </p>
              </div>
            </div>
            <Switch checked={emailEnabled} onCheckedChange={setEmailEnabled} />
          </div>
        </CardContent>
      </Card>

      {emailEnabled && (
        <>
          {/* Recipients */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Send className="h-4 w-4" />
                Default Recipients
              </CardTitle>
              <CardDescription>
                Email addresses that receive reports by default. Individual schedules can override this.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  value={newRecipient}
                  onChange={(e) => setNewRecipient(e.target.value)}
                  placeholder="email@bank.com"
                  onKeyDown={(e) => e.key === "Enter" && addRecipient()}
                  className="flex-1"
                />
                <Button variant="outline" onClick={addRecipient}>
                  Add
                </Button>
              </div>
              {recipients.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {recipients.map((email) => (
                    <Badge key={email} variant="secondary" className="pl-3 pr-1 py-1.5 gap-1">
                      {email}
                      <button
                        onClick={() => removeRecipient(email)}
                        className="ml-1 hover:bg-muted rounded-full p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No recipients added. Reports will be sent to the project owner.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Report Content */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Report Content
              </CardTitle>
              <CardDescription>
                Choose what information to include in reconciliation reports
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ToggleRow
                icon={<BarChart3 className="h-4 w-4 text-blue-500" />}
                label="Match Breakdown"
                description="Include detailed breakdown of match types (exact, fuzzy, tolerance)"
                checked={includeMatchBreakdown}
                onChange={setIncludeMatchBreakdown}
              />
              <Separator />
              <ToggleRow
                icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
                label="Exception Details"
                description="Include exception categories, severity distribution, and top issues"
                checked={includeExceptionDetails}
                onChange={setIncludeExceptionDetails}
              />
              <Separator />
              <ToggleRow
                icon={<Shield className="h-4 w-4 text-green-500" />}
                label="Channel Performance"
                description="Include per-channel match rates and transaction volumes"
                checked={includeChannelPerformance}
                onChange={setIncludeChannelPerformance}
              />
              <Separator />
              <ToggleRow
                icon={<TrendingUp className="h-4 w-4 text-purple-500" />}
                label="Trend Analysis"
                description="Include historical trend comparison with previous reconciliation runs"
                checked={includeTrendAnalysis}
                onChange={setIncludeTrendAnalysis}
              />
            </CardContent>
          </Card>

          {/* Alert Triggers */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Bell className="h-4 w-4" />
                Alert Triggers
              </CardTitle>
              <CardDescription>
                Configure when to receive immediate notifications
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ToggleRow
                icon={<CheckCircle2 className="h-4 w-4 text-green-500" />}
                label="Job Completion"
                description="Send a full report when a reconciliation job completes successfully"
                checked={notifyOnCompletion}
                onChange={setNotifyOnCompletion}
              />
              <Separator />
              <ToggleRow
                icon={<AlertTriangle className="h-4 w-4 text-red-500" />}
                label="Job Failure"
                description="Send an alert when a reconciliation job fails"
                checked={notifyOnFailure}
                onChange={setNotifyOnFailure}
              />
              <Separator />
              <div className="space-y-3">
                <ToggleRow
                  icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
                  label="High Exception Count"
                  description="Alert when exceptions exceed a threshold"
                  checked={notifyOnHighExceptions}
                  onChange={setNotifyOnHighExceptions}
                />
                {notifyOnHighExceptions && (
                  <div className="ml-10 grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-sm">Exception Threshold</Label>
                      <Input
                        type="number"
                        min="1"
                        max="1000"
                        value={highExceptionThreshold}
                        onChange={(e) => setHighExceptionThreshold(e.target.value)}
                        className="mt-1"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Alert if exceptions exceed this count
                      </p>
                    </div>
                    <div>
                      <Label className="text-sm">Low Match Rate (%)</Label>
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={lowMatchRateThreshold}
                        onChange={(e) => setLowMatchRateThreshold(e.target.value)}
                        className="mt-1"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Alert if match rate falls below this
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Save Button */}
      <div className="flex justify-end pb-6">
        <Button onClick={handleSave} disabled={updateMutation.isPending} size="lg">
          {updateMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-2" />
          )}
          Save Preferences
        </Button>
      </div>
    </div>
  );
}

// ─── Toggle Row Component ───────────────────────────────────────────

function ToggleRow({
  icon,
  label,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onChange: (val: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{icon}</div>
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
