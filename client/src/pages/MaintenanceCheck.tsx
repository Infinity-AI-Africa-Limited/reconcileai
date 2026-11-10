import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useMaintenanceCheck, type WorkloadReport } from "@/hooks/useMaintenanceCheck";
import type { CheckSession, Evidence } from "@/lib/maintenanceCheckSession";
import {
  describeError,
  describeNotCollected,
  describeSurface,
  formatAge,
  formatCount,
  presentVerdict,
  type Tone,
} from "@/lib/maintenanceCheck";

/**
 * Maintenance check: a super-admin reading of the work in flight.
 *
 * The page only renders. One press of "Run check" asks the server for one
 * reading, now or not at all; the hook keeps this visit's readings, and the
 * rules in lib/maintenanceCheckSession decide what is current and what is
 * history. Nothing is stored, and nothing here is permission to change
 * production.
 */
const TONE_CLASSES: Record<Tone, string> = {
  critical: "border-red-500/40 bg-red-500/10",
  warning: "border-amber-500/40 bg-amber-500/10",
  neutral: "border-slate-500/40 bg-slate-500/10",
};
const RUNNABLE = new Set(["wait", "paused", "active", "delayed", "prioritized", "waiting-children"]);
const STATE_LABELS: Record<string, string> = {
  wait: "Waiting",
  paused: "Paused",
  active: "Active",
  delayed: "Delayed",
  prioritized: "Prioritised",
  "waiting-children": "Waiting on children",
  failed: "Failed",
  repeat: "Repeat schedules",
};

const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString("en-GB");

function Verdict({ report, historical }: { report: WorkloadReport; historical: boolean }) {
  const verdict = presentVerdict(report.verdict);
  return (
    <div className={`rounded-lg border p-4 ${historical ? "border-dashed opacity-70 " + TONE_CLASSES.neutral : TONE_CLASSES[verdict.tone]}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{historical ? `${verdict.title} (history)` : verdict.title}</h2>
        <span className="text-xs text-muted-foreground">
          {new Date(report.checkedAt).toLocaleString("en-GB", { timeZoneName: "short" })} · {report.elapsedMs} ms
        </span>
      </div>
      <p className="mt-1 text-sm">{verdict.message}</p>
    </div>
  );
}

function Problems({ errors }: { errors: readonly string[] }) {
  if (errors.length === 0) return null;
  return (
    <Alert>
      <AlertTitle>What limited this reading</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-5">
          {errors.map(code => (
            <li key={code}>{describeError(code)}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function Surfaces({ report }: { report: WorkloadReport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Work recorded in the database</CardTitle>
        <CardDescription>
          {report.database.snapshot === "consistent_snapshot"
            ? "Counted in one consistent snapshot."
            : "No consistent snapshot could be read, so these counts are unknown."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>What</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Oldest</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.database.surfaces.map(surface => (
              <TableRow key={surface.id}>
                <TableCell>
                  {describeSurface(surface.id)}
                  {surface.kind === "parked" ? (
                    <Badge variant="outline" className="ml-2">
                      waits on a person
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className={`text-right tabular-nums ${surface.count !== null && surface.count > 0 && surface.kind !== "parked" ? "font-semibold text-red-600 dark:text-red-400" : ""}`}>
                  {formatCount(surface.count)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatAge(surface.oldestAgeSeconds)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Intake({ report }: { report: WorkloadReport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>New work in the last six minutes</CardTitle>
        <CardDescription>Any new row means the app is still taking in work.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Table</TableHead>
              <TableHead className="text-right">New rows</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.database.intake.map(source => (
              <TableRow key={source.id}>
                <TableCell className="font-mono text-xs">{source.id}</TableCell>
                <TableCell
                  className={`text-right tabular-nums ${source.count !== null && source.count > 0 ? "font-semibold text-amber-600 dark:text-amber-400" : ""}`}
                >
                  {formatCount(source.count)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Queues({ report }: { report: WorkloadReport }) {
  const states = Object.keys(STATE_LABELS);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Queued jobs</CardTitle>
        <CardDescription>
          {report.redis.backend === "redis"
            ? `Search for other queues: ${report.redis.discovery === "complete" ? "complete" : "did not finish"}. Queues this check does not know: ${formatCount(report.redis.unknownQueues)}. Failed jobs and repeat schedules are shown but are not running work.`
            : report.redis.backend === "not_configured"
              ? "This app has no Redis: its queued work lives only in memory and cannot be read."
              : "Redis could not be read, so these counts are unknown."}
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Queue</TableHead>
              {states.map(state => (
                <TableHead key={state} className="text-right">
                  {STATE_LABELS[state]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.redis.queues.map(queue => (
              <TableRow key={queue.id}>
                <TableCell className="font-mono text-xs">{queue.id}</TableCell>
                {states.map(state => {
                  const count = queue.states[state as keyof typeof queue.states];
                  const running = RUNNABLE.has(state) && count !== null && count > 0;
                  return (
                    <TableCell
                      key={state}
                      className={`text-right tabular-nums ${running ? "font-semibold text-red-600 dark:text-red-400" : RUNNABLE.has(state) ? "" : "text-muted-foreground"}`}
                    >
                      {formatCount(count)}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ThisServer({ report }: { report: WorkloadReport }) {
  const { replica } = report;
  const rows: [string, string][] = [
    ["Build commit (Railway's report)", replica.commit ? replica.commit.slice(0, 12) : "Not reported"],
    ["Deployment", replica.deploymentId ?? "Not reported"],
    ["Replica", replica.replicaId ?? "Not reported"],
    ["State", replica.lifecycle],
    ["Operations in progress on this server, this check included", formatCount(replica.trackedOperations)],
    ["Up for", formatAge(replica.uptimeSeconds)],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>The server that answered</CardTitle>
        <CardDescription>Only this server's memory is visible. Other servers, if any, are not.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono text-xs break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function Blind({ report }: { report: WorkloadReport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What this reading cannot see</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {report.notCollected.map(code => (
            <li key={code}>{describeNotCollected(code)}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function AttemptLine({ session }: { session: CheckSession<WorkloadReport> }) {
  const attempt = session.attempt;
  if (attempt.kind === "none") return null;
  if (attempt.kind === "running") return <p className="text-sm">Reading… started {timeOf(attempt.startedAt)}.</p>;
  if (attempt.kind === "failed")
    return (
      <Alert variant="destructive">
        <AlertTitle>The last attempt did not complete</AlertTitle>
        <AlertDescription>
          {timeOf(attempt.at)}: {attempt.message}
        </AlertDescription>
      </Alert>
    );
  return <p className="text-sm text-muted-foreground">Last reading received at {timeOf(attempt.at)}.</p>;
}

function HistoryNote({ evidence }: { evidence: Evidence<WorkloadReport> }) {
  if (evidence.kind === "none" || evidence.kind === "current" || !evidence.last) return null;
  const reason =
    evidence.kind === "pending"
      ? "A new reading is in progress."
      : evidence.kind === "failed"
        ? "The attempt after it did not complete."
        : "It is five minutes or more since it was requested, or its timing could not be trusted.";
  return (
    <Alert>
      <AlertTitle>History, not the current state</AlertTitle>
      <AlertDescription>
        This reading was received at {timeOf(evidence.last.receivedAt)}. {reason}
      </AlertDescription>
    </Alert>
  );
}

export default function MaintenanceCheck() {
  const { session, evidence, summary, running, run, clear } = useMaintenanceCheck();
  const shown = evidence.kind === "none" ? null : evidence.last;
  const current = evidence.kind === "current";
  const newestId = session.readings.at(-1)?.attemptId;
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Maintenance check</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Reads the work the platform has in flight, for deciding whether maintenance can start. It only reads, and it
          changes no business data. No result is permission to deploy, back up or change production.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Readings</CardTitle>
          <CardDescription>{summary}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={run} disabled={running}>
              {running ? "Reading…" : "Run check"}
            </Button>
            <Button variant="outline" onClick={clear} disabled={session.readings.length === 0 && session.attempt.kind === "none"}>
              Clear readings
            </Button>
            <span className="text-xs text-muted-foreground">
              One reading per press, sent now or not at all. Take three, each at least a minute after the last.
            </span>
          </div>
          <AttemptLine session={session} />
          {session.readings.length > 0 ? (
            <ol className="space-y-1 text-sm">
              {session.readings
                .slice()
                .reverse()
                .map(reading => (
                  <li key={reading.attemptId} className="flex flex-wrap gap-x-3">
                    <span className="tabular-nums text-muted-foreground">{timeOf(reading.receivedAt)}</span>
                    <span>{presentVerdict(reading.report.verdict).title}</span>
                    {current && reading.attemptId === newestId ? null : <span className="text-muted-foreground">(history)</span>}
                  </li>
                ))}
            </ol>
          ) : null}
        </CardContent>
      </Card>

      {shown ? (
        <section className="space-y-6" aria-label={current ? "Current reading" : "Earlier reading"}>
          <HistoryNote evidence={evidence} />
          <Verdict report={shown.report} historical={!current} />
          <Problems errors={shown.report.errors} />
          <Surfaces report={shown.report} />
          <Queues report={shown.report} />
          <Intake report={shown.report} />
          <ThisServer report={shown.report} />
          <Blind report={shown.report} />
        </section>
      ) : null}
    </div>
  );
}
