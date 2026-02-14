import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Calendar,
  Clock,
  Plus,
  Play,
  Pause,
  Trash2,
  History,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function Schedules() {
  const [showCreate, setShowCreate] = useState(false);
  const [expandedTask, setExpandedTask] = useState<number | null>(null);

  const { data: tasks, isLoading, refetch } = trpc.schedules.list.useQuery();
  const { data: channels } = trpc.channels.list.useQuery();

  const createMutation = trpc.schedules.create.useMutation({
    onSuccess: () => {
      toast.success("Schedule created successfully");
      setShowCreate(false);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const updateMutation = trpc.schedules.update.useMutation({
    onSuccess: () => {
      toast.success("Schedule updated");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.schedules.delete.useMutation({
    onSuccess: () => {
      toast.success("Schedule deactivated");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const runNowMutation = trpc.schedules.runNow.useMutation({
    onSuccess: (data) => {
      toast.success(`Job #${data.jobId} started`);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const activeCount = useMemo(() => tasks?.filter((t) => t.isActive).length || 0, [tasks]);
  const totalRuns = useMemo(() => tasks?.reduce((sum, t) => sum + t.totalRuns, 0) || 0, [tasks]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Scheduled Reconciliation</h1>
          <p className="text-muted-foreground mt-1">
            Automate your reconciliation tasks with configurable schedules
          </p>
        </div>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Schedule
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <CreateScheduleForm
              channels={channels || []}
              onSubmit={(data) => createMutation.mutate(data)}
              isLoading={createMutation.isPending}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Calendar className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{tasks?.length || 0}</p>
                <p className="text-xs text-muted-foreground">Total Schedules</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{activeCount}</p>
                <p className="text-xs text-muted-foreground">Active</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <History className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{totalRuns}</p>
                <p className="text-xs text-muted-foreground">Total Runs</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <Clock className="h-5 w-5 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {tasks?.filter((t) => t.isActive && t.nextRunAt).length || 0}
                </p>
                <p className="text-xs text-muted-foreground">Pending Runs</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Schedule List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Schedules</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !tasks || tasks.length === 0 ? (
            <div className="text-center py-12">
              <Calendar className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground">No schedules configured yet</p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Create your first automated reconciliation schedule
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {tasks.map((task) => (
                <ScheduleRow
                  key={task.id}
                  task={task}
                  expanded={expandedTask === task.id}
                  onToggle={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
                  onToggleActive={() =>
                    updateMutation.mutate({ id: task.id, isActive: !task.isActive })
                  }
                  onRunNow={() => runNowMutation.mutate({ id: task.id })}
                  onDelete={() => deleteMutation.mutate({ id: task.id })}
                  isRunning={runNowMutation.isPending}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Schedule Row ───────────────────────────────────────────────────

function ScheduleRow({
  task,
  expanded,
  onToggle,
  onToggleActive,
  onRunNow,
  onDelete,
  isRunning,
}: {
  task: any;
  expanded: boolean;
  onToggle: () => void;
  onToggleActive: () => void;
  onRunNow: () => void;
  onDelete: () => void;
  isRunning: boolean;
}) {
  const { data: detail } = trpc.schedules.get.useQuery(
    { id: task.id },
    { enabled: expanded }
  );

  return (
    <div className="border rounded-lg overflow-hidden">
      <div
        className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-4 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${task.isActive ? "bg-green-500" : "bg-muted-foreground/30"}`} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{task.name}</span>
              <Badge variant={task.isActive ? "default" : "secondary"} className="text-xs">
                {task.isActive ? "Active" : "Paused"}
              </Badge>
              <Badge variant="outline" className="text-xs capitalize">
                {task.frequency}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {task.frequencyDescription} &middot; {task.timezone}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {task.lastRunStatus && (
            <Badge
              variant={task.lastRunStatus === "success" ? "default" : "destructive"}
              className="text-xs"
            >
              Last: {task.lastRunStatus}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {task.totalRuns} runs
          </span>
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t p-4 bg-muted/20 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Next Run</span>
              <p className="font-medium">
                {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "Not scheduled"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Last Run</span>
              <p className="font-medium">
                {task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : "Never"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Success Rate</span>
              <p className="font-medium">
                {task.totalRuns > 0
                  ? `${Math.round((task.successfulRuns / task.totalRuns) * 100)}%`
                  : "N/A"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Email Reports</span>
              <p className="font-medium">{task.sendEmailReport ? "Enabled" : "Disabled"}</p>
            </div>
          </div>

          {/* Run History */}
          {detail?.history && detail.history.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">Recent Run History</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Matched</TableHead>
                    <TableHead>Exceptions</TableHead>
                    <TableHead>Match Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.history.slice(0, 5).map((run: any) => (
                    <TableRow key={run.id}>
                      <TableCell className="text-sm">
                        {new Date(run.startedAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            run.status === "success"
                              ? "default"
                              : run.status === "failed"
                              ? "destructive"
                              : "secondary"
                          }
                          className="text-xs"
                        >
                          {run.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{run.matchedCount ?? "—"}</TableCell>
                      <TableCell>{run.exceptionCount ?? "—"}</TableCell>
                      <TableCell>{run.matchRate ? `${run.matchRate}%` : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2 border-t">
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                onRunNow();
              }}
              disabled={isRunning || !task.isActive}
            >
              {isRunning ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Play className="h-3 w-3 mr-1" />
              )}
              Run Now
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                onToggleActive();
              }}
            >
              {task.isActive ? (
                <>
                  <Pause className="h-3 w-3 mr-1" />
                  Pause
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 mr-1" />
                  Resume
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Deactivate
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Create Schedule Form ───────────────────────────────────────────

function CreateScheduleForm({
  channels,
  onSubmit,
  isLoading,
}: {
  channels: any[];
  onSubmit: (data: any) => void;
  isLoading: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceChannelId, setSourceChannelId] = useState<string>("");
  const [targetChannelId, setTargetChannelId] = useState<string>("");
  const [frequency, setFrequency] = useState<string>("daily");
  const [scheduledTime, setScheduledTime] = useState("02:00");
  const [dayOfWeek, setDayOfWeek] = useState<string>("1");
  const [dayOfMonth, setDayOfMonth] = useState<string>("1");
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [lookbackDays, setLookbackDays] = useState("1");
  const [sendEmailReport, setSendEmailReport] = useState(true);
  const [emailRecipients, setEmailRecipients] = useState("");

  const handleSubmit = () => {
    if (!name.trim()) {
      toast.error("Schedule name is required");
      return;
    }
    if (!sourceChannelId || !targetChannelId) {
      toast.error("Please select source and target channels");
      return;
    }

    const data: any = {
      name: name.trim(),
      sourceChannelId: parseInt(sourceChannelId),
      targetChannelId: parseInt(targetChannelId),
      frequency,
      scheduledTime,
      timezone,
      lookbackDays: parseInt(lookbackDays),
      sendEmailReport,
    };

    if (description.trim()) data.description = description.trim();
    if (frequency === "weekly" || frequency === "biweekly") {
      data.scheduledDayOfWeek = parseInt(dayOfWeek);
    }
    if (frequency === "monthly") {
      data.scheduledDayOfMonth = parseInt(dayOfMonth);
    }
    if (emailRecipients.trim()) {
      data.emailRecipients = emailRecipients
        .split(",")
        .map((e: string) => e.trim())
        .filter(Boolean);
    }

    onSubmit(data);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create Reconciliation Schedule</DialogTitle>
        <DialogDescription>
          Set up an automated reconciliation task that runs on your chosen schedule
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-4">
        {/* Basic Info */}
        <div className="space-y-3">
          <div>
            <Label>Schedule Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Daily POS vs Bank Settlement"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this schedule reconciles..."
              className="mt-1"
              rows={2}
            />
          </div>
        </div>

        {/* Channel Selection */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Source Channel</Label>
            <Select value={sourceChannelId} onValueChange={setSourceChannelId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select source" />
              </SelectTrigger>
              <SelectContent>
                {channels.map((ch) => (
                  <SelectItem key={ch.id} value={String(ch.id)}>
                    {ch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Target Channel</Label>
            <Select value={targetChannelId} onValueChange={setTargetChannelId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select target" />
              </SelectTrigger>
              <SelectContent>
                {channels.map((ch) => (
                  <SelectItem key={ch.id} value={String(ch.id)}>
                    {ch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Schedule Configuration */}
        <div className="space-y-3">
          <Label className="text-base font-medium">Schedule</Label>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm">Frequency</Label>
              <Select value={frequency} onValueChange={setFrequency}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Bi-weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm">Time</Label>
              <Input
                type="time"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          {(frequency === "weekly" || frequency === "biweekly") && (
            <div>
              <Label className="text-sm">Day of Week</Label>
              <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_NAMES.map((day, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {day}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {frequency === "monthly" && (
            <div>
              <Label className="text-sm">Day of Month</Label>
              <Select value={dayOfMonth} onValueChange={setDayOfMonth}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm">Timezone</Label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Africa/Lagos">Africa/Lagos (WAT)</SelectItem>
                  <SelectItem value="Africa/Nairobi">Africa/Nairobi (EAT)</SelectItem>
                  <SelectItem value="Africa/Johannesburg">Africa/Johannesburg (SAST)</SelectItem>
                  <SelectItem value="Africa/Cairo">Africa/Cairo (EET)</SelectItem>
                  <SelectItem value="Africa/Accra">Africa/Accra (GMT)</SelectItem>
                  <SelectItem value="UTC">UTC</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm">Lookback Days</Label>
              <Input
                type="number"
                min="1"
                max="90"
                value={lookbackDays}
                onChange={(e) => setLookbackDays(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
        </div>

        {/* Email Settings */}
        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Send Email Report</Label>
              <p className="text-xs text-muted-foreground">
                Receive a detailed report after each run
              </p>
            </div>
            <Switch checked={sendEmailReport} onCheckedChange={setSendEmailReport} />
          </div>
          {sendEmailReport && (
            <div>
              <Label className="text-sm">Recipients (comma-separated)</Label>
              <Input
                value={emailRecipients}
                onChange={(e) => setEmailRecipients(e.target.value)}
                placeholder="cfo@bank.com, ops@bank.com"
                className="mt-1"
              />
            </div>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button onClick={handleSubmit} disabled={isLoading}>
          {isLoading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Calendar className="h-4 w-4 mr-2" />
          )}
          Create Schedule
        </Button>
      </DialogFooter>
    </>
  );
}
