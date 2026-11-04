import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No real database, queue, transport, notification or provider can be reached.
const deps = vi.hoisted(() => ({
  getDb: vi.fn<() => Promise<null>>(),
  getDueScheduledTasks: vi.fn<() => Promise<never[]>>(),
  resetDb: vi.fn(),
  dispatch: vi.fn<() => Promise<void>>(),
  cleanup: vi.fn<() => Promise<void>>(),
  deadlines: vi.fn<() => Promise<void>>(),
  retention: vi.fn<() => Promise<void>>(),
}));
vi.mock("../db", () => ({
  getDb: deps.getDb,
  getDueScheduledTasks: deps.getDueScheduledTasks,
  resetDb: deps.resetDb,
  getAllUsers: vi.fn(async () => []),
  createAuditLog: vi.fn(async () => {}),
}));
vi.mock("../_core/env", () => ({
  ENV: { appUrl: "", shopifyClientId: "test-only-id", shopifyClientSecret: "test-only-secret" },
}));
vi.mock("../_core/notification", () => ({ notifyOwner: vi.fn(async () => {}) }));
vi.mock("../emailReportService", () => ({ sendReconciliationReport: vi.fn(async () => {}) }));
vi.mock("../apiIngestionService", () => ({
  validateParsedRows: vi.fn(), storeTransactions: vi.fn(), calculateFileHash: vi.fn(),
}));
vi.mock("../exceptionWorkflowDeadline", () => ({
  DUE_DATE_ELAPSED_NOTE: "test-only-note", recordElapsedDeadline: vi.fn(),
}));
vi.mock("../demoReportSeed", () => ({
  DEMO_REPORT_MARKER: "test-only-marker", isSeededReportSummary: vi.fn(() => false),
}));
vi.mock("../reportSummary", () => ({ buildReportSummary: vi.fn() }));
vi.mock("../jobQueue", () => ({ createQueue: vi.fn() }));
vi.mock("../connectors/shopify/privacyCompletion", () => ({
  cleanupExpiredShopifyPrivacyArtifacts: deps.cleanup,
  dispatchShopifyPrivacyOutbox: deps.dispatch,
  handleShopifyPrivacyJob: vi.fn(),
}));
vi.mock("../connectors/shopify/customerRedaction", () => ({ handleShopifyCustomerRedactionJob: vi.fn() }));
vi.mock("../connectors/shopify/shopRedaction", () => ({ handleShopifyShopRedactionJob: vi.fn() }));
vi.mock("../connectors/shopify/privacyDeadlines", () => ({ runShopifyPrivacyDeadlineCheck: deps.deadlines }));
vi.mock("../connectors/shopify/evidenceRetention", () => ({ runShopifyScopeAEvidenceRetentionIfDue: deps.retention }));
vi.mock("../connectors/shopify/syncOrchestrator", () => ({ runShopifyOrderSyncToNow: vi.fn() }));
vi.mock("../connectors/shopify/storeClassification", () => ({ recheckShopifyStoreClassifications: vi.fn() }));

const PRODUCTION = { NODE_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "production" };

async function loadProducers() {
  const lifecycle = await import("./lifecycle");
  const scheduler = await import("../schedulingEngine");
  const sftp = await import("../sftpService");
  const bucket = await import("../bucketIngestionService");
  const sla = await import("../slaMonitoringService");
  const due = await import("../exceptionWorkflowDueMonitor");
  const demo = await import("../demoTimelineRoll");
  const privacy = await import("../connectors/shopify/privacyQueue");
  const backstop = await import("../connectors/shopify/orderBackstop");
  return { ...lifecycle, scheduler, sftp, bucket, sla, due, demo, privacy, backstop };
}
type Producers = Awaited<ReturnType<typeof loadProducers>>;
type ProducerName = "scheduler" | "sftp" | "bucket" | "sla" | "due" | "demo" | "privacy" | "backstop";

function start(producers: Producers, name: ProducerName, run: () => Promise<unknown> = async () => {}) {
  switch (name) {
    case "scheduler": return producers.scheduler.startScheduler(1_000);
    case "sftp": return producers.sftp.startSftpPolling();
    case "bucket": return producers.bucket.startBucketPolling();
    case "sla": return producers.sla.startSLAMonitoring(1);
    case "due": return producers.due.startExceptionWorkflowDueMonitor(PRODUCTION, 1_000);
    case "demo": return producers.demo.startDemoTimelineRoll(PRODUCTION);
    case "privacy": return producers.privacy.startShopifyPrivacyRecoveryLoop(1_000);
    case "backstop": return producers.backstop.startShopifyOrderBackstopLoop({ run, firstDelayMs: 1_000, intervalMs: 1_000 });
  }
}

const producers: ProducerName[] = ["scheduler", "sftp", "bucket", "sla", "due", "demo", "privacy", "backstop"];
const immediateProducers: ProducerName[] = ["scheduler", "sftp", "sla", "due", "privacy"];
const triggerMs: Record<ProducerName, number> = {
  scheduler: 1_000, sftp: 60_000, bucket: 60_000, sla: 60_000,
  due: 1_000, demo: 60_000, privacy: 1_000, backstop: 1_000,
};

function controlled() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function holdNextCallback(name: ProducerName, pending: Promise<void>) {
  if (name === "scheduler") deps.getDueScheduledTasks.mockImplementationOnce(async () => { await pending; return []; });
  else if (name === "privacy") deps.dispatch.mockImplementationOnce(() => pending);
  else if (name !== "backstop") deps.getDb.mockImplementationOnce(async () => { await pending; return null; });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production");
  vi.stubEnv("VITEST", "");
  vi.stubEnv("DEPLOYMENT_MODE", "cloud");
  vi.stubEnv("DEMO_TIMELINE_ROLL_MINUTES", "60");
  // Never consume an inherited encryption credential when importing the SFTP module.
  vi.stubEnv("SFTP_ENCRYPTION_KEY", "0".repeat(64));
  deps.getDb.mockReset().mockResolvedValue(null);
  deps.getDueScheduledTasks.mockReset().mockResolvedValue([]);
  deps.resetDb.mockReset();
  for (const work of [deps.dispatch, deps.cleanup, deps.deadlines, deps.retention]) work.mockReset().mockResolvedValue(undefined);
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("when producer modules are imported", () => {
  it("should register one stop per module without querying databases or starting timers", async () => {
    const lifecycle = await import("./lifecycle");
    const register = vi.spyOn(lifecycle.applicationLifecycle, "registerStop");
    const loaded = await loadProducers();
    expect(register).toHaveBeenCalledTimes(producers.length);
    expect(deps.getDb).not.toHaveBeenCalled();
    expect(deps.getDueScheduledTasks).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    loaded.privacy.startShopifyPrivacyRecoveryLoop();
    loaded.privacy.startShopifyPrivacyRecoveryLoop();
    loaded.privacy.stopShopifyPrivacyRecoveryLoop();
    loaded.privacy.stopShopifyPrivacyRecoveryLoop();
    await vi.advanceTimersByTimeAsync(0);
    loaded.privacy.startShopifyPrivacyRecoveryLoop();
    loaded.privacy.stopShopifyPrivacyRecoveryLoop();
    expect(register).toHaveBeenCalledTimes(producers.length);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("when producer startup arrives after the maintenance fence", () => {
  it("should refuse all eight hooks even when their stop registration arrives late", async () => {
    const lifecycle = await import("./lifecycle");
    lifecycle.applicationLifecycle.beginDrain();
    const loaded = await loadProducers();
    const run = vi.fn(async () => {});
    for (const name of producers) start(loaded, name, run);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(deps.getDb).not.toHaveBeenCalled();
    expect(deps.getDueScheduledTasks).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await expect(loaded.applicationLifecycle.drain(1_000)).resolves.toMatchObject({ status: "drained", active: 0 });
  });
});

describe("when all producers are stopped for maintenance", () => {
  it("should clear every recurring timer and all initial demo/backstop delays, including repeated starts", async () => {
    const loaded = await loadProducers();
    const run = vi.fn(async () => {});
    for (const name of producers) start(loaded, name, run);
    // SLA/demo intentionally retain their existing multiple-start behaviour.
    start(loaded, "sla");
    start(loaded, "demo");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    loaded.applicationLifecycle.beginDrain();
    expect(vi.getTimerCount()).toBe(0);
    await expect(loaded.applicationLifecycle.drain(1_000)).resolves.toMatchObject({ status: "drained", active: 0 });
    const calls = [deps.getDb.mock.calls.length, deps.getDueScheduledTasks.mock.calls.length, deps.dispatch.mock.calls.length];
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect([deps.getDb.mock.calls.length, deps.getDueScheduledTasks.mock.calls.length, deps.dispatch.mock.calls.length]).toEqual(calls);
    expect(run).not.toHaveBeenCalled();
  });
});

describe.each(producers)("when a queued %s trigger fires after the maintenance fence", name => {
  it("should suppress maintenance admission without launching work or rearming a timer", async () => {
    const loaded = await loadProducers();
    const intervals = vi.spyOn(globalThis, "setInterval");
    const delays = vi.spyOn(globalThis, "setTimeout");
    const run = vi.fn(async () => {});
    start(loaded, name, run);
    await vi.advanceTimersByTimeAsync(0);
    const callback = name === "demo" || name === "backstop"
      ? delays.mock.calls[0]?.[0]
      : intervals.mock.calls[0]?.[0];
    expect(typeof callback).toBe("function");
    const calls = [deps.getDb.mock.calls.length, deps.getDueScheduledTasks.mock.calls.length, deps.dispatch.mock.calls.length];
    vi.mocked(console.error).mockClear();
    loaded.applicationLifecycle.beginDrain();
    expect(vi.getTimerCount()).toBe(0);
    // Clearing a timer cannot undo a callback already handed to the event loop.
    if (typeof callback === "function") callback();
    await vi.advanceTimersByTimeAsync(0);
    expect([deps.getDb.mock.calls.length, deps.getDueScheduledTasks.mock.calls.length, deps.dispatch.mock.calls.length]).toEqual(calls);
    expect(run).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(loaded.applicationLifecycle.drain(1_000)).resolves.toMatchObject({ status: "drained", active: 0 });
  });
});

describe.each(immediateProducers)("when the %s startup sweep is still active", name => {
  it("should clear its future timer and await the admitted startup promise during drain", async () => {
    const loaded = await loadProducers();
    const work = controlled();
    holdNextCallback(name, work.promise);
    start(loaded, name);
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded.applicationLifecycle.snapshot().active).toBeGreaterThan(0);
    loaded.applicationLifecycle.beginDrain();
    expect(vi.getTimerCount()).toBe(0);
    let drained = false;
    const drain = loaded.applicationLifecycle.drain(100_000).then(result => { drained = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    work.release();
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(producers)("when the %s timer callback is still active", name => {
  it("should stop future callbacks without cancelling the admitted promise and await it during drain", async () => {
    const loaded = await loadProducers();
    const work = controlled();
    const run = vi.fn(() => work.promise);
    start(loaded, name, run);
    await vi.advanceTimersByTimeAsync(0); // finish any immediate startup sweep
    holdNextCallback(name, work.promise);
    await vi.advanceTimersByTimeAsync(triggerMs[name]);
    expect(loaded.applicationLifecycle.snapshot().active).toBeGreaterThan(0);
    loaded.applicationLifecycle.beginDrain();
    expect(vi.getTimerCount()).toBe(0);
    let drained = false;
    const drain = loaded.applicationLifecycle.drain(100_000).then(result => { drained = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    expect(loaded.applicationLifecycle.snapshot().active).toBeGreaterThan(0);
    work.release();
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("when an admitted scheduler tick is waiting to retry", () => {
  it("should preserve its retry delay and await the retry while stopping future producer ticks", async () => {
    const loaded = await loadProducers();
    deps.getDueScheduledTasks.mockRejectedValueOnce(Object.assign(new Error("test-only-transient"), { code: "ECONNRESET" }));
    loaded.scheduler.startScheduler(1_000);
    await vi.advanceTimersByTimeAsync(0);
    loaded.applicationLifecycle.beginDrain();
    // This timer belongs to the admitted tick, not to a future producer run.
    expect(vi.getTimerCount()).toBe(1);
    let drained = false;
    const drain = loaded.applicationLifecycle.drain(100_000).then(result => { drained = true; return result; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(drained).toBe(false);
    expect(deps.getDueScheduledTasks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(drain).resolves.toMatchObject({ status: "drained", active: 0 });
    expect(deps.getDueScheduledTasks).toHaveBeenCalledTimes(2);
    expect(deps.resetDb).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("when the first Shopify backstop callback initiates drain", () => {
  it("should not create its recurring interval after the stop callback has already run", async () => {
    const loaded = await loadProducers();
    const run = vi.fn(async () => { loaded.applicationLifecycle.beginDrain(); });
    start(loaded, "backstop", run);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(loaded.applicationLifecycle.drain(1_000)).resolves.toMatchObject({ status: "drained", active: 0 });
  });
});
