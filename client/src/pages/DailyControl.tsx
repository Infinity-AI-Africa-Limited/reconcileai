import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { usePortalContext } from "@/contexts/PortalContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  dailyControlSourceStatusCopy,
  dailyControlStatusCopy,
  humanizeControlReason,
  localControlPeriod,
  type DailyControlSourceStatus,
  type DailyControlStatus,
} from "@/lib/dailyControl";

type Tone = "ready" | "waiting" | "attention" | "blocked";

const toneClass: Record<Tone, string> = {
  ready:
    "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  waiting:
    "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  attention:
    "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
  blocked:
    "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100",
};

const StatusIcon = ({ tone }: { tone: Tone }) => {
  const className = "h-5 w-5 shrink-0";
  if (tone === "ready") return <CheckCircle2 className={className} />;
  if (tone === "waiting") return <Clock3 className={className} />;
  if (tone === "attention") return <AlertTriangle className={className} />;
  return <CircleAlert className={className} />;
};

function ReasonList({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        No policy reasons recorded.
      </span>
    );
  }
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {reasons.map(reason => (
        <li key={reason} className="flex gap-2">
          <span aria-hidden="true">•</span>
          <span>{humanizeControlReason(reason)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function DailyControl() {
  const [, setLocation] = useLocation();
  const { viewAsOrg } = usePortalContext();
  const [controlPeriod, setControlPeriod] = useState(() =>
    localControlPeriod()
  );
  const input = useMemo(
    () => ({ organizationId: viewAsOrg?.id, controlPeriod }),
    [controlPeriod, viewAsOrg?.id]
  );
  const readiness = trpc.controlEvidence.assessReadiness.useQuery(input, {
    retry: false,
  });

  const assessment = readiness.data;
  const status = assessment?.status as DailyControlStatus | undefined;
  const presentation = status ? dailyControlStatusCopy(status) : null;

  if (readiness.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading daily-control
        evidence…
      </div>
    );
  }

  if (readiness.error) {
    return (
      <div className="space-y-3 p-6">
        <h1 className="text-2xl font-bold tracking-tight">Daily Control</h1>
        <p className="text-sm text-destructive">{readiness.error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
        <div>
          <p className="text-sm font-semibold text-primary">
            Governed control preflight
          </p>
          <h1 className="text-2xl font-bold tracking-tight">Daily Control</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Check whether approved source evidence is fit to interpret before a
            reconciliation run. This workspace does not start matching, create a
            job, publish a match rate, post funds, or resolve an exception.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setLocation("/control-fit")}
          className="shrink-0"
        >
          Open Control Fit Brief <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>

      <Card>
        <CardHeader className="gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <CardTitle>Control period</CardTitle>
            <CardDescription>
              Select the customer-defined business day to assess.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Control period"
              type="date"
              value={controlPeriod}
              onChange={event => setControlPeriod(event.target.value)}
              className="w-40"
            />
            <Button
              variant="outline"
              onClick={() => void readiness.refetch()}
              disabled={readiness.isFetching}
            >
              {readiness.isFetching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              <span className="sr-only">Refresh readiness</span>
            </Button>
          </div>
        </CardHeader>
      </Card>

      {assessment && presentation ? (
        <>
          <section
            className={`rounded-xl border p-5 ${toneClass[presentation.tone]}`}
            aria-live="polite"
          >
            <div className="flex gap-3">
              <StatusIcon tone={presentation.tone} />
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{presentation.label}</h2>
                  <Badge
                    variant="outline"
                    className="border-current bg-transparent text-current"
                  >
                    {assessment.controlPeriod}
                  </Badge>
                </div>
                <p className="max-w-3xl text-sm opacity-90">
                  {presentation.summary}
                </p>
              </div>
            </div>
          </section>

          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Approved source contracts</CardDescription>
                <CardTitle className="text-3xl tabular-nums">
                  {assessment.sourceContractCount}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Recorded batch manifests</CardDescription>
                <CardTitle className="text-3xl tabular-nums">
                  {assessment.batchManifestCount}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Policy conclusion</CardDescription>
                <CardTitle className="text-base">
                  {assessment.canReconcile
                    ? "Preflight permits reconciliation"
                    : "Reconciliation is withheld"}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          {(assessment.reasons.length > 0 ||
            assessment.persistenceReasons.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="h-4 w-4" /> Control-level evidence
                  issues
                </CardTitle>
                <CardDescription>
                  These machine-stable reasons are returned without source
                  payloads or customer transaction data.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5 md:grid-cols-2">
                <div>
                  <p className="mb-2 text-sm font-medium">
                    Completeness policy
                  </p>
                  <ReasonList reasons={assessment.reasons} />
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium">
                    Evidence persistence
                  </p>
                  <ReasonList reasons={assessment.persistenceReasons} />
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5 text-primary" /> Source evidence
                preflight
              </CardTitle>
              <CardDescription>
                Each row is evaluated from the approved source contract and its
                immutable batch manifest for the selected control period.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {assessment.sourceAssessments.length === 0 ? (
                <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                  No eligible source contracts are recorded for this tenant and
                  period. Define and approve the bounded workflow in the Control
                  Fit Brief before recording evidence.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-sm">
                    <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Source</th>
                        <th className="px-3 py-2 font-medium">Role</th>
                        <th className="px-3 py-2 font-medium">State</th>
                        <th className="px-3 py-2 font-medium">
                          Evidence observations
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {assessment.sourceAssessments.map((source, index) => {
                        const sourcePresentation = dailyControlSourceStatusCopy(
                          source.status as DailyControlSourceStatus
                        );
                        return (
                          <tr
                            key={`${source.sourceKey ?? "unnamed"}-${index}`}
                            className="border-b last:border-0"
                          >
                            <td className="px-3 py-3 font-medium">
                              {source.sourceKey ?? "Unnamed source"}
                            </td>
                            <td className="px-3 py-3 capitalize text-muted-foreground">
                              {source.role?.replaceAll("_", " ") ??
                                "Unclassified"}
                            </td>
                            <td className="px-3 py-3">
                              <Badge
                                variant="outline"
                                className={toneClass[sourcePresentation.tone]}
                              >
                                {sourcePresentation.label}
                              </Badge>
                            </td>
                            <td className="px-3 py-3">
                              <ReasonList
                                reasons={[
                                  ...source.reasons,
                                  ...source.warnings,
                                ]}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
