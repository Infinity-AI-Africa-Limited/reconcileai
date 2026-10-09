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
}));

const fakeDb = {
  select: () => ({ from: () => ({ where: async () => state.webhooks }) }),
  insert: () => ({ values: () => ({ $returningId: async () => [{ id: state.nextId++ }] }) }),
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
vi.mock("./_core/egress", () => ({ isEgressAllowed: () => true }));
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
import { dispatchWebhookEvent } from "./webhookDelivery";

const EVENT = "reconciliation.completed";
const subscriber = (id: number) => ({
  id,
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
  vi.restoreAllMocks();
});

describe("when an enqueue times out mid fan-out", () => {
  it("should record that subscriber and every later one as not queued, without waiting on each", async () => {
    state.webhooks = [subscriber(1), subscriber(2), subscriber(3)];
    queue.enqueue = vi.fn(async () => {
      throw new QueueOperationTimeoutError("webhook-delivery", "enqueue", 3_000);
    });

    await expect(dispatchWebhookEvent(EVENT, { jobId: 9 })).resolves.toBeUndefined();

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

    await dispatchWebhookEvent(EVENT, { jobId: 9 });

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

    await dispatchWebhookEvent(EVENT, { jobId: 9 });

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

    await dispatchWebhookEvent(EVENT, { jobId: 9 });

    expect(String(notQueued()[0]?.set.lastError).length).toBeLessThanOrEqual(500);
  });

  it("should store a delivery attempt's error that fits the column", async () => {
    state.webhooks = [subscriber(1)];
    queue.enqueue = vi.fn(async () => {});
    await dispatchWebhookEvent(EVENT, { jobId: 9 });
    const attemptDelivery = queue.handler!;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("y".repeat(2_000)));
    state.updates.length = 0;

    // The final attempt, so a failure is recorded rather than retried.
    await attemptDelivery({
      data: { deliveryId: 1, webhookId: 1, url: "https://hooks.example/1", secret: "s", body: "{}" },
      attempt: 6,
    });

    const attempt = state.updates.find(u => "attempts" in u.set);
    expect(String(attempt?.set.lastError).length).toBeLessThanOrEqual(500);
  });
});
