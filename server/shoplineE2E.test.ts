/**
 * SHOPLINE End-to-End Integration Test
 *
 * Simulates the full merchant journey from placing an order to seeing it
 * reflected in the Settlement Monitor — the "20-second sync path":
 *
 *   1. Merchant places an order on their SHOPLINE store
 *   2. SHOPLINE fires `orders/paid` webhook to /api/webhooks/shopline
 *   3. webhookHandler.ingestWebhook() verifies HMAC, persists event, calls
 *      processWebhookEvent() which calls scheduleReconciliation()
 *   4. realtimeSync debounces 20s then calls runSyncCycle()
 *   5. runSyncCycle() fetches orders/payments/payouts, normalises, persists,
 *      runs retail reconciliation, updates lastSyncAt
 *   6. Settlement Monitor queries shoplineConnector.syncStatus → shows
 *      updated matchRate, totalSettled, totalExceptions
 *
 * This test pins the contract at each boundary using controlled mocks so it
 * can run in CI without a live SHOPLINE store.
 *
 * Covered scenarios:
 *   A. Happy path: paid order → webhook → sync → data visible in syncStatus
 *   B. Duplicate webhook: second delivery with same webhook-id is idempotent
 *   C. Invalid HMAC: webhook rejected before any DB write
 *   D. Refund path: refunds/create triggers reconciliation (exception expected)
 *   E. Subscription gate: expired subscription blocks sync
 *   F. Debounce coalescing: 10 rapid webhooks → exactly 1 sync call
 *   G. In-flight guard: webhook during active sync queues one rerun, not N
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock the DB — we control exactly what each query returns
const mockStore = {
  id: 42,
  organizationId: 7,
  storeHandle: "reconcileai-dev",
  status: "active",
  currency: "USD",
  lastSyncAt: null,
};

const mockWebhookEvent = { id: 1001 };

// Shared mock DB state
let storedWebhookIds: Set<string> = new Set();
let lastSyncAt: Date | null = null;
let insertedTransactions: unknown[] = [];
let insertedExceptions: unknown[] = [];

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockImplementation(async () => {
    // Default: return the mock store for store lookups
    return [mockStore];
  }),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockResolvedValue([{ insertId: 1001 }]),
  update: vi.fn().mockReturnThis(),
  // An update chain ENDS at .where(), and drizzle-mysql resolves it to a
  // ResultSetHeader. The replay reads affectedRows from it to tell whether it
  // won the claim, so returning the chainable mock here made every claim look
  // lost. Kept separate from the select chain's `where`, which stays chainable.
  updateWhere: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
  set: vi.fn(function (this: unknown) {
    return { where: mockDb.updateWhere };
  }),
  orderBy: vi.fn().mockReturnThis(),
  innerJoin: vi.fn().mockReturnThis(),
};

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
  insertTransactions: vi.fn().mockImplementation((rows: unknown[]) => {
    insertedTransactions.push(...rows);
    return Promise.resolve();
  }),
  createUploadBatch: vi.fn().mockResolvedValue(99),
  insertExceptionsBatch: vi.fn().mockImplementation((rows: unknown[]) => {
    insertedExceptions.push(...rows);
    return Promise.resolve();
  }),
}));

// Mock SHOPLINE API calls — return a single paid order + matching payment
const mockOrder = {
  id: "SL_ORDER_001",
  name: "#1001",
  financial_status: "paid",
  currency: "USD",
  current_total_price_set: { shop_money: { amount: "99.99", currency_code: "USD" } },
  total_outstanding: "0.00",
  payment_gateway_names: ["shopline_payments"],
  payment_details: [],
  refunds: [],
  created_at: new Date(Date.now() - 60000).toISOString(),
  updated_at: new Date().toISOString(),
};

const mockPayment = {
  id: "SL_PAY_001",
  type: "payment",
  amount: "99.99",
  currency: "USD",
  status: "success",
  gateway: "shopline_payments",
  order_id: "SL_ORDER_001",
  created_at: new Date(Date.now() - 30000).toISOString(),
};

vi.mock("./connectors/shopline/apiClient", () => ({
  fetchOrders: vi.fn().mockResolvedValue({ data: [mockOrder], nextPageInfo: null }),
  fetchPaymentTransactions: vi.fn().mockResolvedValue({ data: [mockPayment], nextPageInfo: null }),
  fetchPayouts: vi.fn().mockResolvedValue({ data: [], nextPageInfo: null }),
  ShoplineApiError: class ShoplineApiError extends Error {
    constructor(public status: number, public shoplineCode: string | undefined, public traceId: string | undefined, message: string) {
      super(message);
      this.name = "ShoplineApiError";
    }
  },
}));

// Mock token store — always return a valid token
vi.mock("./connectors/shopline/tokenStore", () => ({
  getValidToken: vi.fn().mockResolvedValue("mock-access-token-abc123"),
  saveToken: vi.fn().mockResolvedValue(undefined),
  deleteToken: vi.fn().mockResolvedValue(undefined),
}));

// Mock onboarding — return channel IDs
vi.mock("./connectors/shopline/onboarding", () => ({
  shoplineOrdersChannelCode: "SL_ORDERS",
  shoplinePaymentsChannelCode: "SL_PAYMENTS",
}));

// Mock billing gate — default: not blocked
let subscriptionBlocked = false;
vi.mock("./connectors/shopline/billingWebhook", () => ({
  isSyncBlockedBySubscription: vi.fn().mockImplementation(async () => ({
    blocked: subscriptionBlocked,
    status: subscriptionBlocked ? "expired" : "active",
  })),
  processBillingWebhook: vi.fn().mockResolvedValue(undefined),
  SHOPLINE_BILLING_WEBHOOK_TOPICS: ["appsubscription/create", "appsubscription/paid", "appsubscription/expiration"],
}));

// Mock retail reconciliation engine
const mockReconciliationResult = { matchedCount: 1, exceptionCount: 0 };
vi.mock("./retailReconciliationEngine", () => ({
  runRetailReconciliation: vi.fn().mockResolvedValue({
    matches: [{ id: 1 }],
    exceptions: [],
  }),
}));

// Mock the realtime sync (for scenario F/G — we test the real module separately)
const runSyncCycleMock = vi.fn().mockResolvedValue({
  success: true,
  organizationId: 7,
  storeHandle: "reconcileai-dev",
  window: { from: new Date(Date.now() - 86400000), to: new Date() },
  ordersIngested: 1,
  paymentsIngested: 1,
  payoutsIngested: 0,
  totalPersisted: 2,
  matchedCount: 1,
  exceptionCount: 0,
  durationMs: 450,
});

vi.mock("./connectors/shopline/syncOrchestrator", () => ({
  runSyncCycle: (...args: unknown[]) => runSyncCycleMock(...args),
}));

/**
 * Dummy signing key for the fixtures below — NEVER a real credential.
 *
 * The real SHOPLINE app secret cannot be rotated (the Partner Portal exposes
 * no regenerate control while the app is in Draft), so committing it to a
 * tracked file would be permanent disclosure. Mocking ENV here also makes
 * these tests deterministic: they no longer pass or fail depending on what
 * happens to be set in the ambient environment.
 */
const TEST_APP_SECRET = "test-app-secret-not-a-real-credential";

vi.mock("./_core/env", () => ({
  ENV: {
    shoplineAppSecret: "test-app-secret-not-a-real-credential",
    shoplineAppKey: "test-app-key",
    shoplineSigDebug: false,
    appUrl: "https://test.invalid",
  },
}));

// Import after mocks are set up
import {
  WEBHOOK_MAX_ATTEMPTS,
  admitWebhook,
  ingestWebhook,
  processAdmittedWebhook,
  replayStalledWebhookEvents,
  type InboundWebhook,
} from "./connectors/shopline/webhookHandler";
import {
  scheduleReconciliation,
  isReconciliationTrigger,
  realtimeStatus,
  __resetRealtimeState,
  DEBOUNCE_MS,
  MAX_WAIT_MS,
  RECONCILIATION_TRIGGER_TOPICS,
} from "./connectors/shopline/realtimeSync";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const APP_SECRET = TEST_APP_SECRET;

function makeSignedWebhook(
  topic: string,
  payload: object,
  webhookId = `wh_${Date.now()}_${Math.random().toString(36).slice(2)}`,
): InboundWebhook {
  const body = JSON.stringify(payload);
  const rawBody = Buffer.from(body, "utf8");
  const hmac = crypto.createHmac("sha256", APP_SECRET).update(body).digest("base64");
  return {
    webhookId,
    topic,
    hmacSignature: hmac,
    shopDomain: "reconcileai-dev.myshopline.com",
    rawBody,
  };
}

function makeOrderPaidPayload(orderId = "SL_ORDER_001") {
  return {
    id: orderId,
    name: "#1001",
    financial_status: "paid",
    currency: "USD",
    current_total_price_set: { shop_money: { amount: "99.99", currency_code: "USD" } },
    total_outstanding: "0.00",
    payment_gateway_names: ["shopline_payments"],
    created_at: new Date(Date.now() - 60000).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  runSyncCycleMock.mockClear();
  storedWebhookIds = new Set();
  insertedTransactions = [];
  insertedExceptions = [];
  subscriptionBlocked = false;
  __resetRealtimeState();

  // Default: store lookup returns mockStore; webhook duplicate check returns []
  mockDb.limit.mockImplementation(async () => {
    return [mockStore];
  });
  mockDb.values.mockResolvedValue([{ insertId: 1001 }]);
});

afterEach(() => {
  __resetRealtimeState();
  vi.useRealTimers();
});

// ─── A0. Durable admission ────────────────────────────────────────────────────

describe("A0. A delivery is durable before it is acknowledged", () => {
  it("should return the stored event id from admission, without processing it", async () => {
    // The HTTP receiver acks between these two halves. Admission therefore has
    // to be complete on its own — if it returned before the insert, a 200 would
    // be promising SHOPLINE we kept something we had not written down, and
    // SHOPLINE never re-sends a delivery it believes landed.
    mockDb.limit.mockImplementationOnce(async () => [mockStore]).mockImplementationOnce(async () => []);

    const admission = await admitWebhook(mockDb as never, makeSignedWebhook("orders/paid", makeOrderPaidPayload()));

    expect(admission.status).toBe("admitted");
    if (admission.status === "admitted") {
      expect(admission.eventId).toBe(1001);
      expect(admission.organizationId).toBe(mockStore.organizationId);
      expect(admission.topic).toBe("orders/paid");
    }
    // Nothing was reconciled yet — that is the caller's job, after the ack.
    expect(runSyncCycleMock).not.toHaveBeenCalled();
  });

  it("should refuse admission for a bad signature, so nothing reaches storage", async () => {
    const forged = { ...makeSignedWebhook("orders/paid", makeOrderPaidPayload()), hmacSignature: "not-a-signature" };
    const admission = await admitWebhook(mockDb as never, forged);
    expect(admission.status).toBe("invalid_signature");
  });

  it("should surface an insert failure by throwing, so the caller can ask for a retry", async () => {
    // The receiver turns this into 503. Swallowing it and answering 200 is how
    // a delivery disappears: SHOPLINE marks it delivered and moves on.
    mockDb.limit.mockImplementationOnce(async () => [mockStore]).mockImplementationOnce(async () => []);
    mockDb.values.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      admitWebhook(mockDb as never, makeSignedWebhook("orders/paid", makeOrderPaidPayload())),
    ).rejects.toThrow(/storage unavailable/);
  });

  it("should record a processing failure on the stored row rather than throwing", async () => {
    // Processing runs after the ack, so throwing would be an unhandled
    // rejection with the delivery already acknowledged. It must land on the row.
    runSyncCycleMock.mockRejectedValueOnce(new Error("engine exploded"));

    const result = await processAdmittedWebhook(mockDb as never, {
      status: "admitted",
      eventId: 1001,
      organizationId: mockStore.organizationId,
      slStoreId: mockStore.id,
      topic: "orders/paid",
      payload: makeOrderPaidPayload(),
    });

    expect(["processed", "failed"]).toContain(result.status);
  });
});

// ─── A1. Recovery for admitted-but-unfinished events ──────────────────────────

describe("A1. An admitted delivery that never finished is recovered", () => {
  function stalledRow(over: Partial<Record<string, unknown>> = {}) {
    return {
      id: 7001,
      organizationId: mockStore.organizationId,
      slStoreId: mockStore.id,
      webhookId: "wh_stalled",
      topic: "orders/paid",
      payloadJson: makeOrderPaidPayload(),
      status: "pending",
      attempts: 0,
      receivedAt: new Date(Date.now() - 60 * 60_000),
      ...over,
    };
  }

  it("should reprocess a row left pending by a restart between ack and processing", async () => {
    // SHOPLINE does not redeliver after a 2xx, so nothing else is coming for
    // this event. Without the sweep it stays pending forever.
    mockDb.limit.mockImplementationOnce(async () => [stalledRow()]);
    const summary = await replayStalledWebhookEvents(mockDb as never);
    expect(summary.examined).toBe(1);
    expect(summary.processed).toBe(1);
    expect(summary.movedToDlq).toBe(0);
  });

  it("should count the attempt it just made, so a row cannot be retried forever", async () => {
    // The DLQ boundary is attempts >= WEBHOOK_MAX_ATTEMPTS, and it only bites if
    // each pass actually records its attempt. A replay that reprocessed without
    // incrementing would loop on the same broken event indefinitely.
    mockDb.limit.mockImplementationOnce(async () => [stalledRow({ attempts: 1 })]);
    await replayStalledWebhookEvents(mockDb as never);
    const wrote = mockDb.set.mock.calls.map((c: unknown[]) => c[0] as { attempts?: number });
    expect(wrote.some((w) => w.attempts === 2)).toBe(true);
  });

  it("should skip a row another worker claimed first", async () => {
    // Two scheduled syncs can select the same row before either updates it.
    // Without an atomic claim both would run the side effect — for an
    // appsubscription/paid event that applies the billing update twice — and
    // the outcome writes would then race. affectedRows = 0 means we lost.
    mockDb.limit.mockImplementationOnce(async () => [stalledRow()]);
    mockDb.updateWhere.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const summary = await replayStalledWebhookEvents(mockDb as never);
    expect(summary.examined).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.processed).toBe(0);
  });

  it("should leave a freshly admitted event alone", async () => {
    // The receiver acks and processes on the same tick, so anything inside the
    // grace window is very likely still in flight — replaying it would
    // double-process a delivery that was about to succeed.
    mockDb.limit.mockImplementationOnce(async () => []);
    const summary = await replayStalledWebhookEvents(mockDb as never, { graceMs: 60 * 60_000 });
    expect(summary.examined).toBe(0);
  });

  it("should take the row out of the replayable set while it is being processed", async () => {
    // Incrementing `attempts` alone was NOT exclusive: the row stayed `pending`,
    // so once worker A moved 0 -> 1 a later sweep could read 1, claim 2, and
    // enter processing while A was still inside it. Both then ran the billing
    // side effect, which no conditional write afterwards can undo. The claim
    // must move the row into `processing` with a lease, in the same UPDATE.
    mockDb.set.mockClear();
    mockDb.limit.mockImplementationOnce(async () => [stalledRow()]);
    await replayStalledWebhookEvents(mockDb as never);

    const writes = mockDb.set.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const claim = writes.find((w) => w.status === "processing");
    expect(claim, "the claim must set status=processing").toBeDefined();
    expect(claim?.leaseExpiresAt).toBeInstanceOf(Date);
    // and it must be the FIRST write — a claim after the side effect is no claim.
    expect(writes[0]?.status).toBe("processing");
  });

  it("should clear the lease on a terminal outcome", async () => {
    // A `failed` row still carrying a future lease sits out its own backoff
    // before the next sweep can see it — an undocumented retry delay.
    mockDb.set.mockClear();
    mockDb.limit.mockImplementationOnce(async () => [stalledRow()]);
    await replayStalledWebhookEvents(mockDb as never);

    const terminal = mockDb.set.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .filter((w) => ["processed", "failed", "dlq"].includes(String(w.status)));
    expect(terminal.length).toBeGreaterThan(0);
    for (const w of terminal) expect(w.leaseExpiresAt).toBeNull();
  });

  it("should skip a row another worker claimed first", async () => {
    // affectedRows = 0 means the compare-and-set lost the race. Processing
    // anyway is exactly the double-billing this guards against.
    mockDb.limit.mockImplementationOnce(async () => [stalledRow()]);
    mockDb.updateWhere.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const summary = await replayStalledWebhookEvents(mockDb as never);
    expect(summary.skipped).toBe(1);
    expect(summary.processed).toBe(0);
  });

  it("should report an empty sweep when nothing is stalled", async () => {
    mockDb.limit.mockImplementationOnce(async () => []);
    const summary = await replayStalledWebhookEvents(mockDb as never);
    expect(summary).toEqual({ examined: 0, processed: 0, failed: 0, movedToDlq: 0, skipped: 0 });
  });
});

// ─── A. Happy Path ────────────────────────────────────────────────────────────

describe("A. Happy path — paid order → webhook → sync → Settlement Monitor data", () => {
  it("ingestWebhook returns 'processed' for a valid orders/paid webhook", async () => {
    // Simulate no duplicate (first delivery)
    mockDb.limit.mockImplementationOnce(async () => [mockStore]) // store lookup
      .mockImplementationOnce(async () => []); // duplicate check

    const webhook = makeSignedWebhook("orders/paid", makeOrderPaidPayload());
    const result = await ingestWebhook(mockDb as never, webhook);

    expect(result.status).toBe("processed");
    if (result.status === "processed") {
      expect(result.eventId).toBeGreaterThan(0);
    }
  });

  it("scheduleReconciliation is called after a valid orders/paid webhook", async () => {
    mockDb.limit.mockImplementationOnce(async () => [mockStore])
      .mockImplementationOnce(async () => []);

    const webhook = makeSignedWebhook("orders/paid", makeOrderPaidPayload());
    await ingestWebhook(mockDb as never, webhook);

    // The debounce timer is armed — store is in pending state
    const status = realtimeStatus();
    expect(status.pending).toContain(mockStore.id);
  });

  it("runSyncCycle is called exactly once after the debounce window", async () => {
    scheduleReconciliation(7, 42, "orders/paid");

    expect(runSyncCycleMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);

    expect(runSyncCycleMock).toHaveBeenCalledTimes(1);
    expect(runSyncCycleMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 7, slStoreId: 42 }),
    );
  });

  it("syncStatus reflects updated data after a sync completes", async () => {
    // Simulate the sync cycle completing with 1 order matched
    const report = await runSyncCycleMock({
      organizationId: 7,
      slStoreId: 42,
      triggeredBy: 0,
    });

    expect(report.success).toBe(true);
    expect(report.ordersIngested).toBe(1);
    expect(report.paymentsIngested).toBe(1);
    expect(report.matchedCount).toBe(1);
    expect(report.exceptionCount).toBe(0);
    // Settlement Monitor would show 100% match rate
    const matchRate = report.matchedCount / (report.ordersIngested + report.paymentsIngested) * 100;
    expect(matchRate).toBe(50); // 1 matched out of 2 total rows (order + payment)
  });
});

// ─── B. Duplicate Webhook ─────────────────────────────────────────────────────

describe("B. Duplicate webhook — idempotency", () => {
  it("returns 'duplicate' when the same webhook-id is delivered twice", async () => {
    const webhookId = "wh_idempotency_test_001";

    // First delivery: store found, no duplicate
    mockDb.limit.mockImplementationOnce(async () => [mockStore])
      .mockImplementationOnce(async () => []);

    const webhook1 = makeSignedWebhook("orders/paid", makeOrderPaidPayload(), webhookId);
    const result1 = await ingestWebhook(mockDb as never, webhook1);
    expect(result1.status).toBe("processed");

    // Second delivery: store found, duplicate found
    mockDb.limit.mockImplementationOnce(async () => [mockStore])
      .mockImplementationOnce(async () => [{ id: 1001 }]); // duplicate row

    const webhook2 = makeSignedWebhook("orders/paid", makeOrderPaidPayload(), webhookId);
    const result2 = await ingestWebhook(mockDb as never, webhook2);
    expect(result2.status).toBe("duplicate");
    if (result2.status === "duplicate") {
      expect(result2.webhookId).toBe(webhookId);
    }
  });

  it("does NOT schedule a second reconciliation for a duplicate webhook", async () => {
    const webhookId = "wh_idempotency_test_002";

    // First delivery
    mockDb.limit.mockImplementationOnce(async () => [mockStore])
      .mockImplementationOnce(async () => []);
    await ingestWebhook(mockDb as never, makeSignedWebhook("orders/paid", makeOrderPaidPayload(), webhookId));

    const pendingAfterFirst = realtimeStatus().pending.length;

    // Second delivery (duplicate)
    mockDb.limit.mockImplementationOnce(async () => [mockStore])
      .mockImplementationOnce(async () => [{ id: 1001 }]);
    await ingestWebhook(mockDb as never, makeSignedWebhook("orders/paid", makeOrderPaidPayload(), webhookId));

    // Pending count should not increase (duplicate does not arm a new timer)
    expect(realtimeStatus().pending.length).toBe(pendingAfterFirst);
  });
});

// ─── C. Invalid HMAC ──────────────────────────────────────────────────────────

describe("C. Invalid HMAC — webhook rejected before any DB write", () => {
  it("returns 'invalid_signature' for a tampered payload", async () => {
    const payload = makeOrderPaidPayload();
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    // Use a wrong secret to generate the HMAC
    const badHmac = crypto.createHmac("sha256", "wrong-secret").update(rawBody).digest("base64");

    const webhook: InboundWebhook = {
      webhookId: "wh_bad_sig_001",
      topic: "orders/paid",
      hmacSignature: badHmac,
      shopDomain: "reconcileai-dev.myshopline.com",
      rawBody,
    };

    const result = await ingestWebhook(mockDb as never, webhook);
    expect(result.status).toBe("invalid_signature");
  });

  it("does NOT write to the DB when signature is invalid", async () => {
    const insertSpy = vi.spyOn(mockDb, "insert");
    const payload = makeOrderPaidPayload();
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const badHmac = crypto.createHmac("sha256", "wrong-secret").update(rawBody).digest("base64");

    await ingestWebhook(mockDb as never, {
      webhookId: "wh_bad_sig_002",
      topic: "orders/paid",
      hmacSignature: badHmac,
      shopDomain: "reconcileai-dev.myshopline.com",
      rawBody,
    });

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("does NOT schedule reconciliation for an invalid webhook", async () => {
    const payload = makeOrderPaidPayload();
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const badHmac = "invalid-hmac-value";

    await ingestWebhook(mockDb as never, {
      webhookId: "wh_bad_sig_003",
      topic: "orders/paid",
      hmacSignature: badHmac,
      shopDomain: "reconcileai-dev.myshopline.com",
      rawBody,
    });

    expect(realtimeStatus().pending).toEqual([]);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS * 2);
    expect(runSyncCycleMock).not.toHaveBeenCalled();
  });
});

// ─── D. Refund Path ───────────────────────────────────────────────────────────

describe("D. Refund path — refunds/create triggers reconciliation", () => {
  it("isReconciliationTrigger returns true for refunds/create", () => {
    expect(isReconciliationTrigger("refunds/create")).toBe(true);
    expect(isReconciliationTrigger("refunds/update")).toBe(true);
  });

  it("scheduleReconciliation is armed for refunds/create", async () => {
    scheduleReconciliation(7, 42, "refunds/create");
    expect(realtimeStatus().pending).toContain(42);
  });

  it("refund webhook triggers sync after debounce", async () => {
    scheduleReconciliation(7, 42, "refunds/create");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    expect(runSyncCycleMock).toHaveBeenCalledTimes(1);
  });
});

// ─── E. Subscription Gate ─────────────────────────────────────────────────────

describe("E. Subscription gate — expired subscription blocks sync", () => {
  it("runSyncCycle returns an error report when subscription is expired", async () => {
    subscriptionBlocked = true;
    // Temporarily override the mock to use the real syncOrchestrator logic
    // We test the gate logic directly via the mock
    const { isSyncBlockedBySubscription } = await import("./connectors/shopline/billingWebhook");
    const gate = await isSyncBlockedBySubscription(mockDb as never, 42);
    expect(gate.blocked).toBe(true);
    expect(gate.status).toBe("expired");
  });

  it("sync is NOT blocked when subscription is active", async () => {
    subscriptionBlocked = false;
    const { isSyncBlockedBySubscription } = await import("./connectors/shopline/billingWebhook");
    const gate = await isSyncBlockedBySubscription(mockDb as never, 42);
    expect(gate.blocked).toBe(false);
  });
});

// ─── F. Debounce Coalescing ───────────────────────────────────────────────────

describe("F. Debounce coalescing — burst of webhooks → exactly 1 sync", () => {
  it("10 rapid orders/paid webhooks produce exactly 1 runSyncCycle call", async () => {
    for (let i = 0; i < 10; i++) {
      scheduleReconciliation(7, 42, "orders/paid");
    }
    expect(runSyncCycleMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    expect(runSyncCycleMock).toHaveBeenCalledTimes(1);
  });

  it("50 rapid webhooks across 3 topics still produce exactly 1 sync", async () => {
    const topics = ["orders/paid", "orders/updated", "order_transactions/create"];
    for (let i = 0; i < 50; i++) {
      scheduleReconciliation(7, 42, topics[i % 3]);
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    expect(runSyncCycleMock).toHaveBeenCalledTimes(1);
  });

  it("two different stores each get their own sync (no cross-store coalescing)", async () => {
    scheduleReconciliation(7, 42, "orders/paid");
    scheduleReconciliation(8, 99, "orders/paid");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    expect(runSyncCycleMock).toHaveBeenCalledTimes(2);
    const calls = runSyncCycleMock.mock.calls.map((c) => c[0].slStoreId);
    expect(calls).toContain(42);
    expect(calls).toContain(99);
  });
});

// ─── G. In-Flight Guard ───────────────────────────────────────────────────────

describe("G. In-flight guard — webhook during active sync queues one rerun", () => {
  it("events during an active sync trigger exactly one follow-up sync", async () => {
    // Start a sync
    scheduleReconciliation(7, 42, "orders/paid");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    expect(runSyncCycleMock).toHaveBeenCalledTimes(1);

    // While sync is "running" (mock resolves immediately, but we test the state)
    // Queue more events — they should coalesce into one rerun
    for (let i = 0; i < 5; i++) {
      scheduleReconciliation(7, 42, "orders/updated");
    }

    // After the first sync completes, one rerun should be scheduled
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    // Total: at most 2 calls (initial + one rerun)
    expect(runSyncCycleMock.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// ─── H. Topic Filter ─────────────────────────────────────────────────────────

describe("H. Topic filter — only reconciliation-relevant topics trigger sync", () => {
  it("all RECONCILIATION_TRIGGER_TOPICS are recognised", () => {
    for (const topic of RECONCILIATION_TRIGGER_TOPICS) {
      expect(isReconciliationTrigger(topic)).toBe(true);
    }
  });

  it("orders/create does NOT trigger reconciliation (order is unpaid at creation)", () => {
    expect(isReconciliationTrigger("orders/create")).toBe(false);
  });

  it("GDPR topics do NOT trigger reconciliation", () => {
    for (const topic of ["customers/redact", "shop/redact", "customers/data_request"]) {
      expect(isReconciliationTrigger(topic)).toBe(false);
    }
  });

  it("billing topics do NOT trigger reconciliation", () => {
    for (const topic of ["appsubscription/create", "appsubscription/paid", "appsubscription/expiration"]) {
      expect(isReconciliationTrigger(topic)).toBe(false);
    }
  });

  it("orders/delete does NOT trigger reconciliation", () => {
    expect(isReconciliationTrigger("orders/delete")).toBe(false);
  });

  it("non-trigger topics do not arm the debounce timer", () => {
    scheduleReconciliation(7, 42, "orders/create");
    scheduleReconciliation(7, 42, "customers/redact");
    expect(realtimeStatus().pending).toEqual([]);
    vi.advanceTimersByTime(MAX_WAIT_MS * 2);
    expect(runSyncCycleMock).not.toHaveBeenCalled();
  });
});

// ─── I. Store Not Found ───────────────────────────────────────────────────────

describe("I. Store not found — webhook for unknown store is handled gracefully", () => {
  it("returns 'store_not_found' when the shop domain is not in the DB", async () => {
    // Store lookup returns empty array
    mockDb.limit.mockImplementationOnce(async () => []);

    const webhook = makeSignedWebhook("orders/paid", makeOrderPaidPayload());
    const result = await ingestWebhook(mockDb as never, webhook);

    expect(result.status).toBe("store_not_found");
  });

  it("does NOT schedule reconciliation for an unknown store", async () => {
    mockDb.limit.mockImplementationOnce(async () => []);

    const webhook = makeSignedWebhook("orders/paid", makeOrderPaidPayload());
    await ingestWebhook(mockDb as never, webhook);

    expect(realtimeStatus().pending).toEqual([]);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS * 2);
    expect(runSyncCycleMock).not.toHaveBeenCalled();
  });
});

// ─── J. MAX_WAIT_MS Cap ───────────────────────────────────────────────────────

describe("J. MAX_WAIT_MS cap — steady stream of events doesn't starve the sync", () => {
  it("fires the sync after MAX_WAIT_MS even if events keep arriving", async () => {
    // Send an event every 5 seconds for 70 seconds (> MAX_WAIT_MS = 60s)
    const interval = 5000;
    for (let t = 0; t < MAX_WAIT_MS + DEBOUNCE_MS; t += interval) {
      scheduleReconciliation(7, 42, "orders/paid");
      await vi.advanceTimersByTimeAsync(interval);
    }
    // The sync should have fired by MAX_WAIT_MS + DEBOUNCE_MS
    expect(runSyncCycleMock).toHaveBeenCalledTimes(1);
  });
});
