/**
 * What every exception closure does after it commits. Greptile #194: governed
 * closure had dropped the exception.resolved webhook and the learning record;
 * both paths now share this helper.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  recordLocalSignature: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./webhookDelivery", () => ({ dispatchWebhookEvent: mocks.dispatchWebhookEvent }));
vi.mock("./exceptionIntelligence", async importOriginal => ({
  ...(await importOriginal<typeof import("./exceptionIntelligence")>()),
  recordLocalSignature: mocks.recordLocalSignature,
}));

import { afterExceptionClosed } from "./exceptionClosureEffects";
import { rowOf, scriptedDb } from "./connectors/shopify/scriptedDb.testkit";

const closure = { organizationId: 42, exceptionId: 5, userId: 71, outcome: "resolved" as const, resolutionNotes: "Reversed at bank" };
const learnedRow = { category: "amount_mismatch", description: "Off by 10", amount: "250000.00", counterparty: "GTBank", transactionRef: "REF-1" };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.dispatchWebhookEvent.mockResolvedValue(undefined);
  mocks.recordLocalSignature.mockResolvedValue(undefined);
});

describe("when an exception closes", () => {
  it("should learn from it within the closing tenant and feed the anonymised pool", async () => {
    const fake = scriptedDb({ select: { exceptions: [[learnedRow]] } });
    mocks.getDb.mockResolvedValue(fake.db);

    await afterExceptionClosed(closure);

    const read = fake.ops.find(op => op.kind === "select");
    // By id AND tenant: the legacy read used the id alone.
    expect(read?.where?.sql).toMatch(/`exceptions`.`id` = \? and `exceptions`.`organizationId` = \?/);
    expect(read?.where?.params).toEqual([5, 42]);
    expect(rowOf(fake.writes("insert", "agent_memory")[0])).toMatchObject({
      organizationId: 42, exceptionId: 5, amountRange: "100k-1m", resolution: "Reversed at bank", outcome: "resolved", resolvedBy: 71,
    });
    expect(mocks.recordLocalSignature).toHaveBeenCalledWith(42, expect.anything());
  });

  it("should send the same exception.resolved webhook the legacy route sent", async () => {
    mocks.getDb.mockResolvedValue(scriptedDb({ select: { exceptions: [[learnedRow]] } }).db);
    await afterExceptionClosed({ ...closure, outcome: "dismissed" });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith("exception.resolved", { exceptionId: 5, status: "dismissed" });
  });

  it("should learn nothing from another tenant's exception, which the scoped read cannot see", async () => {
    const fake = scriptedDb({ select: { exceptions: [[]] } });
    mocks.getDb.mockResolvedValue(fake.db);
    await afterExceptionClosed(closure);
    expect(fake.writes("insert", "agent_memory")).toEqual([]);
    expect(mocks.recordLocalSignature).not.toHaveBeenCalled();
  });

  it("should skip learning for an org-less closure but still notify", async () => {
    await afterExceptionClosed({ ...closure, organizationId: null });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it("should never throw, whichever effect fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getDb.mockRejectedValue(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
    mocks.dispatchWebhookEvent.mockRejectedValue(new Error("queue down"));
    await expect(afterExceptionClosed(closure)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
