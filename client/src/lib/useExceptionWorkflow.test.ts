/**
 * The optimistic updates of the governed-workflow hook (Greptile #194: list
 * mutations must use onMutate / onError / onSettled). The hook is rendered once
 * with a stand-in tRPC client that captures the options each mutation was
 * given; those callbacks are then driven directly against spy caches.
 * Lives in client/src/lib because that is the client path vitest collects.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Options = {
  onMutate?: (vars: Record<string, unknown>) => Promise<unknown>;
  onError?: (error: unknown, vars: Record<string, unknown>, snapshot: unknown) => void;
  onSettled?: (data: unknown, error: unknown, vars: Record<string, unknown>) => Promise<unknown> | void;
};

const harness = vi.hoisted(() => {
  const cache = () => ({ cancel: vi.fn(async () => {}), getData: vi.fn(), setData: vi.fn(), invalidate: vi.fn(async () => {}) });
  const utils = { exceptions: { list: cache() }, exceptionWorkflow: { get: cache() } };
  const captured: Record<string, Options> = {};
  const mutation = (name: string) => ({
    useMutation: (options: Options) => {
      captured[name] = options;
      return { mutateAsync: vi.fn(), isPending: false };
    },
  });
  return { utils, captured, mutation };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => harness.utils,
    exceptionWorkflow: {
      get: { useQuery: () => ({ data: undefined, isLoading: false }) },
      owners: { useQuery: () => ({ data: [], isLoading: false }) },
      start: harness.mutation("start"),
      escalate: harness.mutation("escalate"),
      resolve: harness.mutation("resolve"),
      updateOwnership: harness.mutation("updateOwnership"),
      recordDecision: harness.mutation("recordDecision"),
      approveDecision: harness.mutation("approveDecision"),
    },
  },
}));

import { useExceptionWorkflow } from "@/hooks/useExceptionWorkflow";

const listInput = { status: "open", limit: 200, offset: 0 } as never;
const viewKey = { exceptionId: 5, viewAsOrgId: undefined };
const page = { total: 2, data: [{ id: 5, status: "open", assignedTo: null }, { id: 6, status: "open", assignedTo: null }] };
const view = { exceptionStatus: "in_review", workflow: { id: 91, status: "active" }, history: [], people: [] };

function Probe() {
  useExceptionWorkflow({ exceptionId: 5, listInput, viewAsOrgId: undefined, canManage: true, currentUserId: 71, onClosed: () => {} });
  return null;
}

const { utils, captured } = harness;
const listUpdater = () => utils.exceptions.list.setData.mock.calls[0][1] as (p: typeof page) => typeof page;
const viewUpdater = () => utils.exceptionWorkflow.get.setData.mock.calls[0][1] as (v: typeof view) => typeof view;

beforeEach(() => {
  for (const c of [utils.exceptions.list, utils.exceptionWorkflow.get]) for (const fn of Object.values(c)) fn.mockClear();
  utils.exceptions.list.getData.mockReturnValue(page);
  utils.exceptionWorkflow.get.getData.mockReturnValue(view);
  renderToStaticMarkup(createElement(Probe));
});

describe.each([
  ["start", { exceptionId: 5, ownerUserId: 8 }, { status: "in_review", assignedTo: 8 }, { exceptionStatus: "in_review", workflowStatus: "active" }],
  ["escalate", { exceptionId: 5, note: "Overdue" }, { status: "escalated" }, { exceptionStatus: "escalated", workflowStatus: "escalated" }],
  ["resolve", { exceptionId: 5, outcome: "dismissed", resolutionNotes: "Dup" }, { status: "dismissed" }, { exceptionStatus: "dismissed", workflowStatus: "closed" }],
] as const)("when %s is called", (name, vars, rowPatch, viewAfter) => {
  it("should cancel in-flight reads, then show the change in the list and the workflow at once", async () => {
    await captured[name].onMutate!(vars);

    expect(utils.exceptions.list.cancel).toHaveBeenCalledWith(listInput);
    expect(utils.exceptionWorkflow.get.cancel).toHaveBeenCalledWith(viewKey);
    expect(utils.exceptions.list.setData.mock.calls[0][0]).toBe(listInput);
    const patched = listUpdater()(page);
    expect(patched.data[0]).toEqual({ ...page.data[0], ...rowPatch });
    expect(patched.data[1]).toBe(page.data[1]);
    expect(utils.exceptionWorkflow.get.setData.mock.calls[0][0]).toEqual(viewKey);
    const nextView = viewUpdater()(view);
    expect(nextView.exceptionStatus).toBe(viewAfter.exceptionStatus);
    expect(nextView.workflow?.status).toBe(viewAfter.workflowStatus);
  });

  it("should put both caches back exactly as they were when the server refuses", async () => {
    const snapshot = await captured[name].onMutate!(vars);
    utils.exceptions.list.setData.mockClear();
    utils.exceptionWorkflow.get.setData.mockClear();

    captured[name].onError!(new Error("refused"), vars, snapshot);

    expect(utils.exceptions.list.setData).toHaveBeenCalledWith(listInput, page);
    expect(utils.exceptionWorkflow.get.setData).toHaveBeenCalledWith(viewKey, view);
  });

  it("should refetch the list and the workflow whatever the outcome", async () => {
    await captured[name].onSettled!(undefined, null, vars);
    expect(utils.exceptions.list.invalidate).toHaveBeenCalledWith(listInput);
    expect(utils.exceptionWorkflow.get.invalidate).toHaveBeenCalledWith(viewKey);
  });
});

describe("when a step changes the workflow but not the list", () => {
  it.each(["updateOwnership", "recordDecision", "approveDecision"])("should refetch only the workflow after %s", async name => {
    expect(captured[name].onMutate).toBeUndefined();
    await captured[name].onSettled!(undefined, null, { exceptionId: 5 });
    expect(utils.exceptionWorkflow.get.invalidate).toHaveBeenCalledWith(viewKey);
    expect(utils.exceptions.list.invalidate).not.toHaveBeenCalled();
  });
});
