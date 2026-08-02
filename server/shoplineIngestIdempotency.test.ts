/**
 * SHOPLINE ingest idempotency.
 *
 * Regression cover for a production data-integrity failure on 2026-08-02:
 * order 21076388995485181306699745 was ingested FOUR times, from four separate
 * sync cycles (batches 810008/810009/810010/810012, 02:44:53 → 03:40:02).
 *
 * Re-presentation of the same order is the NORMAL path here, not an edge case:
 *   - catchUpWindow deliberately re-reads the 5-minute watermark overlap
 *   - a webhook realtime sync and a scheduled cycle can overlap by seconds
 *   - the cron fired from both GitHub repos against one endpoint
 *
 * In a reconciliation product duplicates are not cosmetic — four copies of an
 * order inflate settled totals 4x and corrupt the match rate, which is the
 * primary output of the system.
 *
 * A UNIQUE index is unavailable: the shared `transactions` table already holds
 * ~6.6M duplicated (channelId, transactionRef) pairs across ~35M rows from
 * other verticals, so dedupe is scoped to this connector.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Rows the fake DB should report as already present.
let existingRows: Array<{ channelId: number; transactionRef: string }> = [];
const selectCalls: number[] = [];

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn(() => {
    selectCalls.push(1);
    return Promise.resolve(existingRows);
  }),
};

// The db module is mocked only so importing the orchestrator does not try to
// open a real connection. `rejectAlreadyIngested` takes its Db as an argument,
// so the fake above is passed in directly and the factory needs no reference to
// it (referencing it here would break — vi.mock is hoisted above the const).
vi.mock("../server/db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  insertTransactions: vi.fn(),
  createUploadBatch: vi.fn(),
  updateUploadBatch: vi.fn(),
  insertExceptionsBatch: vi.fn(),
}));

import { rejectAlreadyIngested } from "./connectors/shopline/syncOrchestrator";

const ORDERS_CH = 300001;
const PAY_CH = 300002;
const row = (ref: string | null, channelId = ORDERS_CH) =>
  ({ transactionRef: ref, channelId, amount: "10.00" }) as never;

describe("SHOPLINE ingest — rejectAlreadyIngested", () => {
  beforeEach(() => {
    existingRows = [];
    selectCalls.length = 0;
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("keeps rows that have never been ingested", async () => {
    const out = await rejectAlreadyIngested(mockDb as never, [row("A"), row("B")], [ORDERS_CH, PAY_CH]);
    expect(out).toHaveLength(2);
  });

  // The exact production failure.
  it("drops an order already present for the same channel", async () => {
    existingRows = [{ channelId: ORDERS_CH, transactionRef: "21076388995485181306699745" }];
    const out = await rejectAlreadyIngested(
      mockDb as never,
      [row("21076388995485181306699745")],
      [ORDERS_CH, PAY_CH],
    );
    expect(out).toHaveLength(0);
  });

  it("re-running the same batch four times still yields one insert", async () => {
    const candidate = [row("ORDER-1")];
    // Cycle 1: nothing exists yet → row is kept and (in prod) inserted.
    let out = await rejectAlreadyIngested(mockDb as never, candidate, [ORDERS_CH]);
    expect(out).toHaveLength(1);
    // Cycles 2-4: now present → dropped every time.
    existingRows = [{ channelId: ORDERS_CH, transactionRef: "ORDER-1" }];
    for (let i = 0; i < 3; i++) {
      out = await rejectAlreadyIngested(mockDb as never, candidate, [ORDERS_CH]);
      expect(out).toHaveLength(0);
    }
  });

  it("does not confuse the same ref on a different channel", async () => {
    existingRows = [{ channelId: PAY_CH, transactionRef: "SHARED" }];
    const out = await rejectAlreadyIngested(mockDb as never, [row("SHARED", ORDERS_CH)], [ORDERS_CH, PAY_CH]);
    expect(out).toHaveLength(1); // orders-channel copy is genuinely new
  });

  it("collapses duplicates that appear twice within one batch", async () => {
    const out = await rejectAlreadyIngested(
      mockDb as never,
      [row("DUP"), row("DUP"), row("OK")],
      [ORDERS_CH],
    );
    expect(out.map((r) => (r as { transactionRef: string }).transactionRef)).toEqual(["DUP", "OK"]);
  });

  it("passes through rows with no transactionRef rather than dropping them", async () => {
    const out = await rejectAlreadyIngested(mockDb as never, [row(null)], [ORDERS_CH]);
    expect(out).toHaveLength(1);
  });

  it("skips the lookup entirely when there is nothing to check", async () => {
    const out = await rejectAlreadyIngested(mockDb as never, [], [ORDERS_CH]);
    expect(out).toHaveLength(0);
    expect(selectCalls).toHaveLength(0);
  });

  it("chunks the lookup for large batches instead of one giant IN(...)", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => row(`R${i}`));
    await rejectAlreadyIngested(mockDb as never, many, [ORDERS_CH]);
    expect(selectCalls.length).toBe(3); // 1200 refs / 500 per chunk
  });
});
