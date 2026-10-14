import { Loader2 } from "lucide-react";
import { canStartExceptionWorkflow } from "@shared/exceptionWorkflowRules";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ExceptionWorkflowState, ExceptionWorkflowView } from "@/hooks/useExceptionWorkflow";
import {
  exceptionWorkflowEventLabel,
  exceptionWorkflowStatusLabel,
} from "@/lib/exceptionWorkflowPresentation";

type View = NonNullable<ExceptionWorkflowView>;
type Workflow = NonNullable<View["workflow"]>;

function personName(view: View, id: number | null | undefined): string {
  if (id == null) return "System control";
  return view.people.find(person => person.id === id)?.name || `User ${id}`;
}

const when = (value: Date | string | null | undefined) => (value ? new Date(value).toLocaleString() : "—");

/**
 * The governed workflow for one exception. Renders what useExceptionWorkflow
 * decided; every rule it shows comes from shared/exceptionWorkflowRules.ts,
 * which the server enforces.
 */
export function ExceptionWorkflowPanel({ state, canManage }: { state: ExceptionWorkflowState; canManage: boolean }) {
  const { view, isLoading } = state;
  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Loading governed workflow…</p>;
  }
  if (!view) return null;
  const workflow = view.workflow;

  if (!canManage) {
    // Read-only roles and reviewer sessions: the evidence, never a control.
    return workflow ? (
      <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3 text-sm space-y-1">
        <p className="font-semibold text-primary">Governed workflow: {exceptionWorkflowStatusLabel(workflow.status)}</p>
        <WorkflowFacts view={view} workflow={workflow} />
        <WorkflowHistory view={view} />
      </div>
    ) : null;
  }

  const canStart = canStartExceptionWorkflow(view.exceptionStatus, workflow?.status);
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-primary">Governed workflow</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Assign material exceptions, set a due date, preserve a decision reference, and require separate human approval where needed.
          </p>
        </div>
        {workflow ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
            Attempt {workflow.attemptNumber} · {exceptionWorkflowStatusLabel(workflow.status)}
          </span>
        ) : null}
      </div>
      {workflow ? <WorkflowFacts view={view} workflow={workflow} /> : null}
      {canStart ? (
        <StartControls state={state} previousAttempt={workflow?.attemptNumber ?? null} />
      ) : workflow && workflow.status !== "closed" ? (
        <OpenWorkflowControls state={state} view={view} workflow={workflow} />
      ) : (
        <p className="text-xs text-muted-foreground">
          This governed workflow is closed. Its ownership, decision and approval evidence remain below and in the audit trail.
        </p>
      )}
      {workflow ? <WorkflowHistory view={view} /> : null}
    </div>
  );
}

function OwnerAndDueFields({ state }: { state: ExceptionWorkflowState }) {
  const { form, owners } = state;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div>
        <label className="text-xs font-medium">Accountable owner</label>
        <Select value={form.ownerId} onValueChange={form.setOwnerId}>
          <SelectTrigger className="w-full mt-1"><SelectValue placeholder="Choose owner" /></SelectTrigger>
          <SelectContent>
            {owners.map(owner => (
              <SelectItem key={owner.id} value={String(owner.id)}>{owner.name || owner.email || `User ${owner.id}`}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="text-xs font-medium">Due by (your local time)</label>
        <Input className="mt-1" type="datetime-local" value={form.dueAt} onChange={event => form.setDueAt(event.target.value)} />
      </div>
    </div>
  );
}

function StartControls({ state, previousAttempt }: { state: ExceptionWorkflowState; previousAttempt: number | null }) {
  const { form, pending, actions, ownersLoading } = state;
  return (
    <div className="space-y-2">
      {previousAttempt !== null ? (
        <p className="rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          Attempt {previousAttempt} closed and the exception was reopened. Start the next governed review to work and close it.
        </p>
      ) : null}
      <OwnerAndDueFields state={state} />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox checked={form.approvalRequired} onCheckedChange={checked => form.setApprovalRequired(checked === true)} />
        Require a second person to approve the decision before closure
      </label>
      <Button size="sm" onClick={actions.start} disabled={pending.start || ownersLoading}>
        {pending.start ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
        {previousAttempt !== null ? "Start next governed review" : "Start governed workflow"}
      </Button>
    </div>
  );
}

function OpenWorkflowControls({ state, view, workflow }: { state: ExceptionWorkflowState; view: View; workflow: Workflow }) {
  const { form, pending, actions, currentUserId } = state;
  const hasDecision = workflow.decisionSubmittedByUserId !== null;
  const ownDecision = currentUserId !== undefined && workflow.decisionSubmittedByUserId === currentUserId;
  return (
    <div className="space-y-3">
      <OwnerAndDueFields state={state} />
      <Button size="sm" variant="outline" onClick={actions.updateOwnership} disabled={pending.updateOwnership}>
        Update owner / due date
      </Button>

      <div className="space-y-2 border-t pt-3">
        <label className="text-xs font-medium">Escalation reason</label>
        <Textarea value={form.escalationNote} onChange={event => form.setEscalationNote(event.target.value)} placeholder="Why this case needs escalation..." rows={2} />
        <Button size="sm" variant="outline" onClick={actions.escalate} disabled={pending.escalate}>Escalate with reason</Button>
      </div>

      <div className="space-y-2 border-t pt-3">
        {hasDecision ? (
          <p className="text-xs text-muted-foreground">
            Current decision by {personName(view, workflow.decisionSubmittedByUserId)} · {when(workflow.decisionSubmittedAt)}. Revising it
            {workflow.approvalRequired ? " withdraws any approval and needs a new one" : " replaces it"}; the earlier decision stays in the history.
          </p>
        ) : null}
        <label className="text-xs font-medium">Decision rationale</label>
        <Textarea value={form.rationale} onChange={event => form.setRationale(event.target.value)} placeholder="What is the human decision and why?" rows={3} />
        <label className="text-xs font-medium">Evidence reference</label>
        <Input value={form.evidenceReference} onChange={event => form.setEvidenceReference(event.target.value)} placeholder="Case, report, control or source-evidence reference" />
        <Button size="sm" onClick={actions.recordDecision} disabled={pending.recordDecision}>
          {hasDecision ? "Revise decision" : "Record decision evidence"}
        </Button>
      </div>

      {workflow.status === "decision_submitted" ? (
        <div className="space-y-2 border-t pt-3">
          {ownDecision ? (
            <p className="text-xs text-amber-700">You submitted this decision, so a different person must approve it.</p>
          ) : (
            <>
              <p className="text-xs text-amber-700">A different person from the one who submitted the decision must approve it before closure.</p>
              <label className="text-xs font-medium">Approval note</label>
              <Textarea value={form.approvalNote} onChange={event => form.setApprovalNote(event.target.value)} placeholder="Independent review evidence..." rows={2} />
              <Button size="sm" onClick={actions.approve} disabled={pending.approve}>Approve decision</Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowFacts({ view, workflow }: { view: View; workflow: Workflow }) {
  return (
    <div className="text-xs text-muted-foreground space-y-0.5">
      <p>Owner: {personName(view, workflow.ownerUserId)} · Due: {when(workflow.dueAt)}</p>
      {workflow.overdueAt ? <p className="font-medium text-amber-800">Overdue since: {when(workflow.overdueAt)} · System escalation recorded</p> : null}
      {workflow.decisionEvidenceReference ? <p>Decision evidence: {workflow.decisionEvidenceReference}</p> : null}
      {workflow.approvedByUserId !== null ? (
        <p>Approved by {personName(view, workflow.approvedByUserId)} · {when(workflow.approvedAt)}</p>
      ) : null}
      {workflow.lateResolutionReason ? <p>Late-resolution reason: {workflow.lateResolutionReason}</p> : null}
    </div>
  );
}

/**
 * Every step of every attempt, oldest first, with a heading where an attempt
 * begins — a reopened case's earlier reviews stay readable. Assignment steps
 * show who received the case and the deadline they were given.
 */
function WorkflowHistory({ view }: { view: View }) {
  if (view.history.length === 0) return null;
  const severalAttempts = view.attempts.length > 1;
  return (
    <div className="border-t pt-2">
      <p className="text-xs font-medium mb-1">History</p>
      <ol className="space-y-1">
        {view.history.map((event, index) => (
          <li key={event.id} className="text-xs text-muted-foreground">
            {severalAttempts && event.attemptNumber !== view.history[index - 1]?.attemptNumber ? (
              <span className="block font-semibold text-foreground pt-1">Attempt {event.attemptNumber}</span>
            ) : null}
            <span className="font-medium text-foreground">{exceptionWorkflowEventLabel(event.eventType)}</span>
            {" · "}{personName(view, event.actorUserId)}{" · "}{when(event.createdAt)}
            {event.ownerUserId !== null ? (
              <span className="block pl-2">Owner: {personName(view, event.ownerUserId)} · Due: {when(event.dueAt)}</span>
            ) : null}
            {event.note ? <span className="block whitespace-pre-wrap pl-2">{event.note}</span> : null}
            {event.decisionEvidenceReference ? <span className="block pl-2">Evidence: {event.decisionEvidenceReference}</span> : null}
            {event.lateResolutionReason ? <span className="block whitespace-pre-wrap pl-2">Late-resolution reason: {event.lateResolutionReason}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
