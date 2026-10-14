/**
 * Outbound webhook fan-out when the delivery queue refuses an enqueue.
 *
 * Each subscriber gets a tracked delivery row, then an enqueue. Before this,
 * the first enqueue to fail ended the whole fan-out: later subscribers got no
 * delivery at all, and the failed one's row sat `pending` for ever with nothing
 * left to send it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { SQL } from "drizzle-orm";

const state = vi.hoisted(() => ({
  webhooks: [] as Array<Record<string, unknown>>,
  nextId: 100,
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  /** Rows written straight to webhook_deliveries (a refused destination's record). */
  inserted: [] as Array<Record<string, unknown>>,
}));

/** `.where()` answers like a drizzle query: awaitable, and `.limit()`-able. */
function answer<T>(rows: T) {
  const result = Promise.resolve(rows);
  return Object.assign(result, { limit: () => result });
}

const fakeDb = {
  select: () => ({ from: () => ({ where: () => answer(state.webhooks) }) }),
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      state.inserted.push(values);
      return Object.assign(Promise.resolve([{ insertId: state.nextId }]), {
        $returningId: async () => [{ id: state.nextId++ }],
      });
    },
  }),
  update: () => ({
    set: (set: Record<string, unknown>) => ({
      where: async (where: unknown) => {
        state.updates.push({ set, where });
        return [{ affectedRows: 1 }];
      },
    }),
  }),
};

vi.mock("./db", () => ({ getDb: async () => fakeDb }));
vi.mock("./_core/egress", () => ({ isEgressAllowed: () => true, isOnPremise: () => false }));
const transport = vi.hoisted(() => ({ post: null as unknown as ReturnType<typeof vi.fn> }));
vi.mock("./outboundDestination", async importOriginal => ({
  ...(await importOriginal<typeof import("./outboundDestination")>()),
  postToDestination: (...args: unknown[]) => transport.post(...args),
}));
const queue = vi.hoisted(() => ({
  enqueue: null as unknown as ReturnType<typeof vi.fn>,
  /** The delivery handler, captured as the queue is built (once per module). */
  handler: null as null | ((job: unknown) => Promise<void>),
}));
vi.mock("./jobQueue", async importOriginal => ({
  ...(await importOriginal<typeof import("./jobQueue")>()),
  createQueue: vi.fn(async (_name: string, handler: (job: unknown) => Promise<void>) => {
    queue.handler = handler;
    return {
    backend: "bullmq",
    enqueue: (...args: unknown[]) => queue.enqueue(...args),
    stats: async () => ({ backend: "bullmq", durable: true }),
    close: async () => {},
    };
  }),
}));

import { QueueOperationTimeoutError } from "./jobQueue";
import { DestinationRefusedError } from "./outboundDestination";
import { dispatchWebhookEvent } from "./webhookDelivery";

const EVENT = "reconciliation.completed";
const TENANT = 42;
const subscriber = (id: number) => ({
  id,
  organizationId: TENANT,
  url: `https://hooks.example/${id}`,
  secret: "s",
  isActive: true,
  events: [EVENT],
});
const notQueued = () =>
  state.updates.filter(u => u.set.status === "failed" && String(u.set.lastError).startsWith("Not queued: "));
const rendered = (where: unknown) =>
  where instanceof SQL ? new MySqlDialect().sqlToQuery(where) : null;

afterEach(() => {
  state.webhooks = [];
  state.updates.length = 0;
  state.inserted.length = 0;
  vi.restoreAllMocks();
});

describe("when an enqueue times out mid fan-out", () => {
  it("should record that subscriber and every later one as not queued, without waiting on each", async () => {
    state.webhooks = [subscriber(1), subscriber(2), subscriber(3)];
    queue.enqueue = vi.fn(async () => {
      throw new QueueOperationTimeoutError("webhook-delivery", "enqueue", 3_000);
    });

    await expect(dispatchWebhookEvent(TENANT, EVENT, { jobId: 9 })).resolves.toBeUndefined();

    // Only the first waited out the deadline; the rest were settled at once.
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(notQueued()).toHaveLength(3);
  });
});

describe("when one subscriber's enqueue fails for another reason", () => {
  it("should still enqueue the rest, and record only the one that failed", async () => {
    state.webhooks = [subscriber(1), subscriber(2), subscriber(3)];
    queue.enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error("ERR this entry was refused"))
      .mockResolvedValue(undefined);

    await dispatchWebhookEvent(TENANT, EVENT, { jobId: 9 });

    expect(queue.enqueue).toHaveBeenCalledTimes(3);
    expect(notQueued()).toHaveLength(1);
  });
});

describe("when a delivery that timed out is later sent after all", () => {
  it("should only ever settle a row no attempt has touched, so a real outcome stands", async () => {
    state.webhooks = [subscriber(1)];
    queue.enqueue = vi.fn(async () => {
      throw new QueueOperationTimeoutError("webhook-delivery", "enqueue", 3_000);
    });

    await dispatchWebhookEvent(TENANT, EVENT, { jobId: 9 });

    const where = rendered(notQueued()[0]?.where);
    expect(where?.sql).toMatch(/`status` = \?/);
    expect(where?.sql).toMatch(/`attempts` = \?/);
    expect(where?.params).toEqual(expect.arrayContaining(["pending", 0]));
  });
});

describe("when an error message is longer than the delivery row can hold", () => {
  // `lastError` is varchar(500); a longer write would fail and leave the row
  // as it was. The bound comes from errorSummary, which caps a message at 200
  // characters. These pin that the text each write composes still fits.
  it("should store a not-queued reason that fits the column", async () => {
    state.webhooks = [subscriber(1)];
    queue.enqueue = vi.fn(async () => {
      throw new Error("x".repeat(2_000));
    });

    await dispatchWebhookEvent(TENANT, EVENT, { jobId: 9 });

    expect(String(notQueued()[0]?.set.lastError).length).toBeLessThanOrEqual(500);
  });

  it("should store a delivery attempt's error that fits the column", async () => {
    const attemptDelivery = await deliveryHandler();
    transport.post = vi.fn().mockRejectedValue(new Error("y".repeat(2_000)));
    state.webhooks = [subscriber(1)];
    state.updates.length = 0;

    // The final attempt, so a failure is recorded rather than retried.
    await attemptDelivery({ data: job(), attempt: 6 });

    const attempt = state.updates.find(u => "attempts" in u.set);
    expect(String(attempt?.set.lastError).length).toBeLessThanOrEqual(500);
  });
});

/** The queue's delivery handler, built on the first dispatch. */
async function deliveryHandler() {
  if (!queue.handler) {
    state.webhooks = [subscriber(1)];
    queue.enqueue = vi.fn(async () => {});
    await dispatchWebhookEvent(TENANT, EVENT, { jobId: 9 });
  }
  state.updates.length = 0;
  return queue.handler!;
}
const job = () => ({ deliveryId: 1, webhookId: 1, organizationId: TENANT, event: EVENT, body: "{}" });
const attemptRecord = () => state.updates.find(u => "attempts" in u.set)?.set;

describe("when a delivery is queued", () => {
  it("should carry ids and the signed body, never the URL or the signing secret", async () => {
    state.webhooks = [subscriber(1)];
    queue.enqueue = vi.fn(async () => {});
    await dispatchWebhookEvent(TENANT, EVENT, { jobId: 9 });

    const queued = (queue.enqueue.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(Object.keys(queued).sort()).toEqual(["body", "deliveryId", "event", "organizationId", "webhookId"]);
    expect(queued.organizationId).toBe(TENANT);
  });

  it("should record a refused destination as failed with its reason, and queue nothing", async () => {
    state.webhooks = [{ ...subscriber(1), url: "https://127.0.0.1/hook?token=secret-in-the-url" }];
    queue.enqueue = vi.fn(async () => {});
    await dispatchWebhookEvent(TENANT, EVENT, { jobId: 9 });

    expect(queue.enqueue).not.toHaveBeenCalled();
    const record = state.inserted.find(row => row.status === "failed");
    expect(String(record?.lastError)).toMatch(/^Destination refused: 127\.0\.0\.1 is a private or internal address$/);
    expect(String(record?.lastError)).not.toContain("secret-in-the-url");
  });
});

describe("when a queued delivery is attempted", () => {
  it("should read the webhook within the job's tenant and sign with its current secret", async () => {
    const attemptDelivery = await deliveryHandler();
    transport.post = vi.fn(async () => ({ status: 204 }));
    state.webhooks = [subscriber(1)];

    await attemptDelivery({ data: job(), attempt: 1 });

    expect(transport.post).toHaveBeenCalledTimes(1);
    const [url, request] = transport.post.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://hooks.example/1");
    expect(request.headers["X-ReconcileAI-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    // The guide on the Integrations page promises these; a receiver relies on them.
    expect(request.headers["X-ReconcileAI-Event"]).toBe(EVENT);
    expect(request.headers["X-ReconcileAI-Delivery"]).toBe("1");
    expect(attemptRecord()).toMatchObject({ status: "delivered", responseStatus: 204, lastError: null });
  });

  it("should settle a refused destination at once rather than retry it", async () => {
    const attemptDelivery = await deliveryHandler();
    transport.post = vi.fn().mockRejectedValue(
      new DestinationRefusedError("hooks.example resolves to a refused address: 10.0.0.5 is a private or internal address"),
    );
    state.webhooks = [subscriber(1)];

    // Attempt 1 of 6: an ordinary failure would throw for a retry.
    await expect(attemptDelivery({ data: job(), attempt: 1 })).resolves.toBeUndefined();
    expect(attemptRecord()).toMatchObject({ status: "failed" });
    expect(String(attemptRecord()?.lastError)).toMatch(/^Destination refused: hooks\.example resolves/);
  });

  it.each([
    ["deleted", []],
    ["deactivated", [{ ...subscriber(1), isActive: false }]],
  ])("should send nothing for a webhook since %s, and not retry", async (_label, rows) => {
    const attemptDelivery = await deliveryHandler();
    transport.post = vi.fn(async () => ({ status: 200 }));
    state.webhooks = rows as Array<Record<string, unknown>>;

    await expect(attemptDelivery({ data: job(), attempt: 1 })).resolves.toBeUndefined();
    expect(transport.post).not.toHaveBeenCalled();
    expect(attemptRecord()).toMatchObject({ status: "failed", lastError: "Not sent: the webhook was deleted" });
  });

  it("should treat a redirect as a failure, say so, and retry it", async () => {
    const attemptDelivery = await deliveryHandler();
    transport.post = vi.fn(async () => ({ status: 302 }));
    state.webhooks = [subscriber(1)];

    await expect(attemptDelivery({ data: job(), attempt: 1 })).rejects.toThrow(/redirects are not followed/);
    expect(attemptRecord()).toMatchObject({ status: "pending", responseStatus: 302 });
  });
});
