import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { statusAfterEscalation } from "@shared/exceptionWorkflowRules";
import { trpc } from "@/lib/trpc";
import {
  clearIfStill,
  closureState,
  defaultWorkflowDueAt,
  errorMessageOf,
  fromDateTimeLocalValue,
  patchExceptionInList,
  toDateTimeLocalValue,
  workflowFormKey,
} from "@/lib/exceptionWorkflowPresentation";

export type ExceptionListInput = inferRouterInputs<AppRouter>["exceptions"]["list"];
export type ExceptionWorkflowView = inferRouterOutputs<AppRouter>["exceptionWorkflow"]["get"];
type ExceptionListPage = inferRouterOutputs<AppRouter>["exceptions"]["list"];
type ExceptionRow = ExceptionListPage["data"][number];
type Snapshot = { list: ExceptionListPage | undefined; view: ExceptionWorkflowView | undefined };

/**
 * Everything the governed-workflow panel and the page's close buttons need:
 * the workflow view, the owner list, the form, the actions, and the decisions
 * (how this exception may close, whether it may move to review). The page
 * renders them; the rules live in shared/exceptionWorkflowRules.ts and
 * client/src/lib/exceptionWorkflowPresentation.ts.
 *
 * Start, escalation and closure change the exceptions list, so they update
 * the cached list (and the workflow view) at once, restore both if the server
 * refuses, and refetch both either way.
 */
export function useExceptionWorkflow(params: {
  exceptionId: number | null;
  listInput: ExceptionListInput;
  viewAsOrgId: number | undefined;
  canManage: boolean;
  currentUserId: number | undefined;
  onClosed: () => void;
  /** The ordinary resolve, for an exception that was never governed. */
  closeDirect: (outcome: "resolved" | "dismissed") => Promise<void>;
}) {
  const { exceptionId, listInput, viewAsOrgId, canManage, currentUserId, onClosed, closeDirect } = params;
  const utils = trpc.useUtils();
  const scope = viewAsOrgId ? { viewAsOrgId } : {};
  const viewInput = (id: number) => ({ exceptionId: id, viewAsOrgId });

  const workflowQuery = trpc.exceptionWorkflow.get.useQuery(viewInput(exceptionId ?? 0), {
    enabled: exceptionId !== null,
  });
  const ownersQuery = trpc.exceptionWorkflow.owners.useQuery(scope, {
    enabled: exceptionId !== null && canManage,
  });

  const beginOptimistic = async (
    id: number,
    rowPatch: Partial<ExceptionRow>,
    viewPatch: (view: ExceptionWorkflowView) => ExceptionWorkflowView
  ): Promise<Snapshot> => {
    await Promise.all([utils.exceptions.list.cancel(listInput), utils.exceptionWorkflow.get.cancel(viewInput(id))]);
    const snapshot: Snapshot = {
      list: utils.exceptions.list.getData(listInput),
      view: utils.exceptionWorkflow.get.getData(viewInput(id)),
    };
    utils.exceptions.list.setData(listInput, page => patchExceptionInList(page, id, rowPatch));
    utils.exceptionWorkflow.get.setData(viewInput(id), view => (view ? viewPatch(view) : view));
    return snapshot;
  };
  const rollback = (id: number, snapshot: Snapshot | undefined) => {
    if (!snapshot) return;
    utils.exceptions.list.setData(listInput, snapshot.list);
    utils.exceptionWorkflow.get.setData(viewInput(id), snapshot.view);
  };
  const settle = (id: number) =>
    Promise.all([utils.exceptions.list.invalidate(listInput), utils.exceptionWorkflow.get.invalidate(viewInput(id))]);
  const refreshView = (id: number) => utils.exceptionWorkflow.get.invalidate(viewInput(id));

  const startMutation = trpc.exceptionWorkflow.start.useMutation({
    onMutate: vars =>
      beginOptimistic(vars.exceptionId, { status: "in_review", assignedTo: vars.ownerUserId }, view => ({
        ...view,
        exceptionStatus: "in_review",
      })),
    onError: (_error, vars, snapshot) => rollback(vars.exceptionId, snapshot),
    onSettled: (_data, _error, vars) => settle(vars.exceptionId),
  });
  const escalateMutation = trpc.exceptionWorkflow.escalate.useMutation({
    onMutate: vars =>
      beginOptimistic(vars.exceptionId, { status: "escalated" }, view => ({
        ...view,
        exceptionStatus: "escalated",
        workflow: view.workflow ? { ...view.workflow, status: statusAfterEscalation(view.workflow.status) } : null,
      })),
    onError: (_error, vars, snapshot) => rollback(vars.exceptionId, snapshot),
    onSettled: (_data, _error, vars) => settle(vars.exceptionId),
  });
  const closeMutation = trpc.exceptionWorkflow.resolve.useMutation({
    onMutate: vars =>
      beginOptimistic(vars.exceptionId, { status: vars.outcome }, view => ({
        ...view,
        exceptionStatus: vars.outcome,
        workflow: view.workflow ? { ...view.workflow, status: "closed" as const } : null,
      })),
    onError: (_error, vars, snapshot) => rollback(vars.exceptionId, snapshot),
    onSettled: (_data, _error, vars) => settle(vars.exceptionId),
  });
  // These change the workflow, not the list: refetch the workflow when they finish.
  const ownershipMutation = trpc.exceptionWorkflow.updateOwnership.useMutation({
    onSettled: (_data, _error, vars) => refreshView(vars.exceptionId),
  });
  const decisionMutation = trpc.exceptionWorkflow.recordDecision.useMutation({
    onSettled: (_data, _error, vars) => refreshView(vars.exceptionId),
  });
  const approvalMutation = trpc.exceptionWorkflow.approveDecision.useMutation({
    onSettled: (_data, _error, vars) => refreshView(vars.exceptionId),
  });

  const [ownerId, setOwnerId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [approvalRequired, setApprovalRequired] = useState(true);
  const [rationale, setRationale] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [escalationNote, setEscalationNote] = useState("");
  const [approvalNote, setApprovalNote] = useState("");

  // Refill the form when the case or its attempt changes — never on a stage
  // change or a refetch, which would overwrite what the operator is drafting
  // (an optimistic escalation used to wipe a half-written decision). The
  // narrative boxes start empty: an earlier escalation or approval is history,
  // not a draft for the next one; each also clears after its own action.
  const workflow = workflowQuery.data?.workflow ?? null;
  const prefillKey = workflowFormKey(exceptionId, workflow);
  useEffect(() => {
    if (exceptionId === null) return;
    if (workflow && workflow.status !== "closed") {
      setOwnerId(String(workflow.ownerUserId));
      setDueAt(toDateTimeLocalValue(new Date(workflow.dueAt)));
      setApprovalRequired(workflow.approvalRequired);
      setRationale(workflow.decisionRationale ?? "");
      setEvidenceReference(workflow.decisionEvidenceReference ?? "");
    } else {
      setOwnerId(currentUserId ? String(currentUserId) : "");
      setDueAt(toDateTimeLocalValue(defaultWorkflowDueAt(new Date())));
      setApprovalRequired(true);
      setRationale("");
      setEvidenceReference("");
    }
    setEscalationNote("");
    setApprovalNote("");
  }, [prefillKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (action: () => Promise<unknown>, success: string, failure: string): Promise<boolean> => {
    try {
      await action();
      toast.success(success);
      return true;
    } catch (error) {
      toast.error(errorMessageOf(error, failure));
      return false;
    }
  };
  const ownerAndDue = (): { ownerUserId: number; dueAt: Date } | null => {
    const due = fromDateTimeLocalValue(dueAt);
    if (!ownerId || !due) {
      toast.error("Choose an owner and a valid future due date");
      return null;
    }
    return { ownerUserId: Number(ownerId), dueAt: due };
  };

  const actions = {
    start: async () => {
      const assignment = exceptionId === null ? null : ownerAndDue();
      if (exceptionId === null || !assignment) return;
      await run(
        () => startMutation.mutateAsync({ exceptionId, ...scope, ...assignment, approvalRequired }),
        "Governed workflow started and assigned",
        "Failed to start governed workflow"
      );
    },
    updateOwnership: async () => {
      const assignment = exceptionId === null ? null : ownerAndDue();
      if (exceptionId === null || !assignment) return;
      await run(
        () => ownershipMutation.mutateAsync({ exceptionId, ...scope, ...assignment }),
        "Workflow owner and due date updated",
        "Failed to update workflow ownership"
      );
    },
    escalate: async () => {
      if (exceptionId === null) return;
      if (!escalationNote.trim()) return void toast.error("Enter the escalation reason before escalating");
      const escalated = await run(
        () => escalateMutation.mutateAsync({ exceptionId, ...scope, note: escalationNote }),
        "Workflow escalated with its reason recorded",
        "Failed to escalate workflow"
      );
      if (escalated) setEscalationNote(clearIfStill(escalationNote));
    },
    recordDecision: async () => {
      if (exceptionId === null) return;
      if (!rationale.trim() || !evidenceReference.trim()) {
        return void toast.error("Record both the decision rationale and its evidence reference");
      }
      await run(
        () => decisionMutation.mutateAsync({ exceptionId, ...scope, rationale, evidenceReference }),
        workflow?.approvalRequired ? "Decision submitted for separate approval" : "Decision evidence recorded",
        "Failed to record decision evidence"
      );
    },
    approve: async () => {
      if (exceptionId === null) return;
      if (!approvalNote.trim()) return void toast.error("Enter the approval note before approving the decision");
      const approved = await run(
        () => approvalMutation.mutateAsync({ exceptionId, ...scope, approvalNote }),
        "Decision approved",
        "Failed to approve decision"
      );
      if (approved) setApprovalNote(clearIfStill(approvalNote));
    },
    close: async (outcome: "resolved" | "dismissed", resolutionNotes: string) => {
      if (exceptionId === null) return;
      if (!resolutionNotes.trim()) return void toast.error("Record closure notes before closing the workflow");
      const closed = await run(
        () => closeMutation.mutateAsync({ exceptionId, ...scope, outcome, resolutionNotes }),
        `Exception ${outcome} through its governed workflow`,
        "The governed workflow is not ready to close"
      );
      if (closed) onClosed();
    },
  };

  // The decisions the page's own buttons follow, made here so the page only renders them.
  const closure = closureState(workflowQuery.data);
  const workflowInProgress = workflow !== null && workflow.status !== "closed";
  /** Resolve or dismiss by whichever path this exception allows; a blocked one says why. */
  const closeException = async (outcome: "resolved" | "dismissed", resolutionNotes: string) => {
    if (closure.mode === "blocked") return void toast.error(closure.reason);
    if (closure.mode === "governed") return actions.close(outcome, resolutionNotes);
    return closeDirect(outcome);
  };

  return {
    closure,
    /** A workflow in progress owns the case: it does not also go to the review queue. */
    moveToReviewBlocked: workflowInProgress,
    closeException,
    view: workflowQuery.data ?? null,
    isLoading: exceptionId !== null && workflowQuery.isLoading,
    owners: ownersQuery.data ?? [],
    ownersLoading: ownersQuery.isLoading,
    currentUserId,
    form: {
      ownerId, setOwnerId,
      dueAt, setDueAt,
      approvalRequired, setApprovalRequired,
      rationale, setRationale,
      evidenceReference, setEvidenceReference,
      escalationNote, setEscalationNote,
      approvalNote, setApprovalNote,
    },
    pending: {
      start: startMutation.isPending,
      updateOwnership: ownershipMutation.isPending,
      escalate: escalateMutation.isPending,
      recordDecision: decisionMutation.isPending,
      approve: approvalMutation.isPending,
      close: closeMutation.isPending,
    },
    actions,
  };
}

export type ExceptionWorkflowState = ReturnType<typeof useExceptionWorkflow>;
