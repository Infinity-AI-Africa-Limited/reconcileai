/**
 * Every webhook event names the tenant that owns what it is about — the job's,
 * the exception's, the upload's — and is not sent when there is none.
 *
 * The real procedures and the real reconciliation runner, with the database,
 * the queue and the dispatcher mocked. What is asserted is the tenant each
 * call site hands the dispatcher. The dispatcher's own scoping is pinned in
 * webhookDelivery.tenancy.test.ts; the chain on a real database, over real
 * HTTP, in webhookTenancy.db.test.ts.
 *
 * No path here may reach a real database: DATABASE_URL is blanked before any
 * module loads, and `getDb` is mocked to null. (The local .env names production.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

const runner = vi.hoisted(() => ({
  run: null as null | ((...args: unknown[]) => Promise<void>),
}));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: vi.fn(async () => null),
  // upload
  getChannelByCode: vi.fn(async () => ({ id: 5, code: "nibss", organizationId: null })),
  getChannelById: vi.fn(async () => ({ id: 5, code: "nibss" })),
  getUploadBatchByHash: vi.fn(async () => undefined),
  createUploadBatch: vi.fn(async () => 300),
  insertTransactions: vi.fn(async () => {}),
  incrementUploadBatchCounts: vi.fn(async () => {}),
  updateUploadBatch: vi.fn(async () => {}),
  getUploadBatchById: vi.fn(),
  // exceptions
  updateException: vi.fn(async () => 1),
  // webhooks
  createWebhook: vi.fn(async () => 900),
  getWebhooks: vi.fn(async () => []),
  // the runner
  updateReconciliationJob: vi.fn(async () => {}),
  getReconciliationJob: vi.fn(),
  getTransactionsForReconciliation: vi.fn(async () => []),
  touchReconciliationJobHeartbeat: vi.fn(async () => {}),
  insertMatchesBatch: vi.fn(async () => {}),
  updateTransactionStatusBulk: vi.fn(async () => {}),
  getTransactionsByIdsUnscoped: vi.fn(async () => []),
  insertExceptionsBatch: vi.fn(async () => {}),
  completeReconciliationJobClearingAbandonment: vi.fn(async () => ({ wasAbandoned: false })),
  invalidateDashboardStatsCache: vi.fn(async () => {}),
  getJobExceptionsNeedingAi: vi.fn(async () => []),
}));
vi.mock("./routers/shared", async importOriginal => ({
  ...(await importOriginal<typeof import("./routers/shared")>()),
  logAudit: vi.fn(async () => {}),
}));
// A plain factory, not importOriginal: with importOriginal, a later dynamic
// import("./webhookDelivery") (exceptionClosureEffects makes one) can resolve to
// the original module instead of this mock.
vi.mock("./webhookDelivery", () => ({
  dispatchWebhookEvent: vi.fn(async () => {}),
  activeWebhooksOfTenant: vi.fn(async () => []),
  listDeliveries: vi.fn(async () => []),
  deliveryStats: vi.fn(async () => ({})),
}));
vi.mock("./exceptionWorkflow", async importOriginal => ({
  ...(await importOriginal<typeof import("./exceptionWorkflow")>()),
  closeExceptionOutsideWorkflow: vi.fn(async () => {}),
  resolveExceptionWorkflow: vi.fn(async () => ({ status: "resolved" })),
}));
vi.mock("./reconciliationQueue", async importOriginal => ({
  ...(await importOriginal<typeof import("./reconciliationQueue")>()),
  registerReconciliationRunner: (fn: (...args: unknown[]) => Promise<void>) => {
    runner.run = fn;
  },
}));
vi.mock("./jobProgressService", async importOriginal => ({
  ...(await importOriginal<typeof import("./jobProgressService")>()),
  trackProgress: vi.fn(async () => {}),
}));
vi.mock("./emailReportService", async importOriginal => ({
  ...(await importOriginal<typeof import("./emailReportService")>()),
  checkAndSendAlerts: vi.fn(async () => {}),
}));

import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { closeExceptionOutsideWorkflow, resolveExceptionWorkflow } from "./exceptionWorkflow";
import { dispatchWebhookEvent } from "./webhookDelivery";
import { appRouter } from "./routers";

const TENANT = 42;
const OTHER_TENANT = 77;
const dispatched = vi.mocked(dispatchWebhookEvent);

const caller = (organizationId: number | null, role = "operations") =>
  appRouter.createCaller({
    user: {
      id: 7, role, organizationId, isGuest: false, isReadOnly: false,
      openId: "t", name: "t", email: "t@example.invalid", loginMethod: "email",
    },
    req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1", socket: {} },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as never);

/** Lets fire-and-forget work the procedure started finish before asserting on it. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const sent = () => dispatched.mock.calls.map(([tenant, event]) => [tenant, event]);

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations; a test that changes one must not leak it.
  vi.mocked(db.updateException).mockResolvedValue(1);
  // mockReset, not clear: a queued once-rejection one path never consumed must not leak.
  vi.mocked(closeExceptionOutsideWorkflow).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(resolveExceptionWorkflow).mockReset().mockResolvedValue({ status: "resolved" } as never);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const row = { amount: "10.00", transactionDate: "2026-09-15T10:00:00.000Z", currency: "NGN", debitCredit: "credit" as const };

describe("when a file is uploaded", () => {
  it("should file the batch under the uploader's organisation and announce it to that tenant", async () => {
    await caller(TENANT).upload.createBatch({ channelCode: "nibss", fileName: "f.csv", transactions: [row] });
    await settle();

    expect(vi.mocked(db.createUploadBatch).mock.calls[0][0]).toMatchObject({ organizationId: TENANT });
    expect(sent()).toEqual([[TENANT, "upload.completed"]]);
    expect(dispatched.mock.calls[0][2]).toMatchObject({ batchId: 300 });
  });

  it("should announce nothing for an uploader with no organisation", async () => {
    await caller(null).upload.createBatch({ channelCode: "nibss", fileName: "f.csv", transactions: [row] });
    await settle();

    expect(vi.mocked(db.createUploadBatch).mock.calls[0][0]).toMatchObject({ organizationId: null });
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("should announce a finalised batch to the batch's own tenant, not the caller's", async () => {
    vi.mocked(db.getUploadBatchById).mockResolvedValue({
      id: 300, userId: 7, organizationId: OTHER_TENANT, channelId: 5, status: "processing",
      validRows: 3, invalidRows: 0, totalRows: 3, fileName: "f.csv",
    } as never);
    await caller(TENANT).upload.finalizeBatch({ batchId: 300 });
    await settle();

    expect(sent()).toEqual([[OTHER_TENANT, "upload.completed"]]);
  });

  it("should announce nothing for a batch that records no tenant", async () => {
    vi.mocked(db.getUploadBatchById).mockResolvedValue({
      id: 301, userId: 7, organizationId: null, channelId: 5, status: "processing",
      validRows: 3, invalidRows: 0, totalRows: 3, fileName: "f.csv",
    } as never);
    await caller(TENANT).upload.finalizeBatch({ batchId: 301 });
    await settle();

    expect(dispatched).not.toHaveBeenCalled();
  });
});

describe("when an exception changes", () => {
  const actions = [
    ["escalate", "exception.escalated", (c: ReturnType<typeof caller>) => c.exceptions.escalate({ id: 11 })],
    ["moveToReview", "exception.in_review", (c: ReturnType<typeof caller>) => c.exceptions.moveToReview({ id: 11 })],
    ["ageTracker.escalate", "exception.escalated", (c: ReturnType<typeof caller>) => c.ageTracker.escalate({ id: 11 })],
  ] as const;

  it.each(actions)("%s should announce it to the tenant whose row it changed", async (_name, event, act) => {
    await act(caller(TENANT));
    await settle();

    expect(vi.mocked(db.updateException).mock.calls[0][1]).toBe(TENANT);
    expect(sent()).toEqual([[TENANT, event]]);
    expect(dispatched.mock.calls[0][2]).toMatchObject({ exceptionId: 11 });
  });

  it.each(actions)("%s should announce nothing when the id is not the caller's tenant's", async (_name, _event, act) => {
    // updateException is scoped to the caller's tenant, so another tenant's id
    // matches no row. It must not reach that row's owner as an event that never
    // happened, nor tell the caller's own webhook about a stranger's id.
    vi.mocked(db.updateException).mockResolvedValue(0);
    await act(caller(TENANT));
    await settle();

    expect(dispatched).not.toHaveBeenCalled();
  });

  it.each(actions)("%s should announce nothing for a caller with no organisation", async (_name, _event, act) => {
    // Even with a row reported changed, there is no tenant to announce it to.
    vi.mocked(db.updateException).mockResolvedValue(1);
    await act(caller(null));
    await settle();

    expect(dispatched).not.toHaveBeenCalled();
  });

  it("should announce an escalation made from a portal to the tenant on screen", async () => {
    await caller(1, "super_admin").ageTracker.escalate({ id: 11, viewAsOrgId: OTHER_TENANT });
    await settle();

    expect(vi.mocked(db.updateException).mock.calls[0][1]).toBe(OTHER_TENANT);
    expect(sent()).toEqual([[OTHER_TENANT, "exception.escalated"]]);
  });
});

describe("when an exception is closed", () => {
  // Both paths commit the close inside one tenant (the case is locked by tenant
  // and id; another tenant's id is NOT_FOUND), then hand that tenant to
  // afterExceptionClosed, which announces to it alone.
  const closes = [
    ["exceptions.resolve", (c: ReturnType<typeof caller>) => c.exceptions.resolve({ id: 11, status: "resolved" })],
    [
      "exceptionWorkflow.resolve",
      (c: ReturnType<typeof caller>) =>
        c.exceptionWorkflow.resolve({ exceptionId: 11, outcome: "resolved", resolutionNotes: "Reversed at bank" }),
    ],
  ] as const;

  it.each(closes)("%s should announce it to the closing tenant", async (_name, act) => {
    await act(caller(TENANT));
    await settle();

    expect(sent()).toEqual([[TENANT, "exception.resolved"]]);
    expect(dispatched.mock.calls[0][2]).toMatchObject({ exceptionId: 11, status: "resolved" });
  });

  it.each(closes)("%s should announce nothing when the id is another tenant's", async (_name, act) => {
    const notFound = new TRPCError({ code: "NOT_FOUND", message: "Exception not found" });
    vi.mocked(closeExceptionOutsideWorkflow).mockRejectedValueOnce(notFound);
    vi.mocked(resolveExceptionWorkflow).mockRejectedValueOnce(notFound);
    await expect(act(caller(TENANT))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await settle();

    expect(dispatched).not.toHaveBeenCalled();
  });

  it("should announce nothing when a legacy close has no tenant", async () => {
    await caller(null).exceptions.resolve({ id: 11, status: "resolved" });
    await settle();

    expect(dispatched).not.toHaveBeenCalled();
  });
});

describe("when a webhook is registered or listed", () => {
  it("should register it under the caller's organisation, subscribed by an array", async () => {
    await caller(TENANT).webhooks.create({ name: "ops", url: "https://hooks.example/a", events: ["exception.created"] });

    expect(vi.mocked(db.createWebhook).mock.calls[0][0]).toMatchObject({
      organizationId: TENANT,
      events: ["exception.created"],
    });
  });

  it.each([null, 0])("should refuse an account whose organisation is %s, storing nothing", async (organizationId) => {
    await expect(
      caller(organizationId).webhooks.create({ name: "x", url: "https://hooks.example/x", events: ["*"] }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(db.createWebhook).not.toHaveBeenCalled();
  });

  it("should list the organisation's webhooks, and nothing for an account with none", async () => {
    await caller(TENANT).webhooks.list();
    expect(db.getWebhooks).toHaveBeenCalledWith(TENANT);

    vi.mocked(db.getWebhooks).mockClear();
    await expect(caller(null).webhooks.list()).resolves.toEqual([]);
    expect(db.getWebhooks).not.toHaveBeenCalled();
  });
});

describe("when a reconciliation run ends", () => {
  const RUN = [500, 11, 12, new Date("2026-09-14"), new Date("2026-09-16"), { amountTolerance: 0.005, dateWindowDays: 1 }, 7] as const;
  const txn = (id: number, ref: string, amount: string) => ({
    id, transactionRef: ref, amount, currency: "NGN", debitCredit: "credit", status: "unmatched",
    transactionDate: new Date("2026-09-15T10:00:00Z"), valueDate: null, description: null,
    counterparty: null, externalRef: null, channelId: 11, organizationId: OTHER_TENANT,
  });

  it("should be registered with the queue, so these tests drive the real runner", () => {
    expect(runner.run).toBeTypeOf("function");
  });

  it("should announce a completed run's events to the job's own tenant", async () => {
    vi.mocked(db.getReconciliationJob).mockResolvedValue({ id: 500, organizationId: OTHER_TENANT, engineConfig: null } as never);
    // One pair that matches and one row that does not: completed, an
    // exception, and a match rate under the 85% floor.
    vi.mocked(db.getTransactionsForReconciliation)
      .mockResolvedValueOnce([txn(1, "R1", "100.00"), txn(3, "R2", "50.00")] as never)
      .mockResolvedValueOnce([txn(2, "R1", "100.00")] as never);
    vi.mocked(db.getTransactionsByIdsUnscoped).mockResolvedValue([txn(3, "R2", "50.00")] as never);

    await runner.run!(...RUN);
    await settle();

    expect(sent()).toEqual([
      [OTHER_TENANT, "reconciliation.completed"],
      [OTHER_TENANT, "exception.created"],
      [OTHER_TENANT, "kpi.threshold.breached"],
    ]);
  });

  it("should announce a run that failed before reading its job to that job's tenant", async () => {
    vi.mocked(db.updateReconciliationJob).mockRejectedValueOnce(new Error("lost the database for a moment"));
    vi.mocked(db.getReconciliationJob).mockResolvedValue({ id: 500, organizationId: OTHER_TENANT, engineConfig: null } as never);

    await runner.run!(...RUN);
    await settle();

    expect(sent()).toEqual([[OTHER_TENANT, "reconciliation.failed"]]);
  });

  it("should announce nothing for a job that has no tenant", async () => {
    vi.mocked(db.getReconciliationJob).mockResolvedValue({ id: 500, organizationId: null, engineConfig: null } as never);

    await runner.run!(...RUN);
    await settle();

    expect(db.updateReconciliationJob).toHaveBeenCalledWith(500, expect.objectContaining({ status: "failed" }));
    expect(dispatched).not.toHaveBeenCalled();
  });
});
