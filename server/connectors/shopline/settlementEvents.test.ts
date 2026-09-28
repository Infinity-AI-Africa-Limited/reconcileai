import { beforeEach, describe, expect, it, vi } from "vitest";

const { runRetailReconciliation } = vi.hoisted(() => ({ runRetailReconciliation: vi.fn() }));
vi.mock("../../retailReconciliationEngine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../retailReconciliationEngine")>()),
  runRetailReconciliation,
}));
vi.mock("./retailIntelligence", () => ({ mapRetailToCoreCategory: () => "amount_mismatch" }));

import { scriptedDb } from "../shopify/scriptedDb.testkit";
import {
  resolveConfirmedColumns,
  selectUnimportedSettlementEvents,
  settlementEventKey,
  type SettlementEventFields,
} from "./settlementFileImport";
import { runReconciliationOnPersistedData } from "./syncOrchestrator";

function event(overrides: Partial<SettlementEventFields> = {}): SettlementEventFields {
  return {
    transactionRef: "gid://shopify/Order/1001",
    amount: "12.34",
    debitCredit: "credit",
    currency: "USD",
    valueDate: new Date("2026-09-01T10:00:00.000Z"),
    rawData: { originalOrderRef: "#1001", gatewayRef: "gw-1" },
    ...overrides,
  };
}

describe("settlement event identity", () => {
  describe("when two rows settle the same order", () => {
    it("should tell a payment from its refund", () => {
      expect(settlementEventKey(event())).not.toBe(settlementEventKey(event({ debitCredit: "debit" })));
    });

    it("should tell two settlements with different gateway ids apart", () => {
      expect(settlementEventKey(event())).not.toBe(
        settlementEventKey(event({ rawData: { originalOrderRef: "#1001", gatewayRef: "gw-2" } })),
      );
    });
  });

  describe("when a stored row is compared with the same row re-imported", () => {
    it("should agree once the column has rounded the amount to cents", () => {
      expect(settlementEventKey(event({ amount: "12.345" }))).toBe(settlementEventKey(event({ amount: "12.35" })));
      expect(settlementEventKey(event({ amount: "12.344" }))).toBe(settlementEventKey(event({ amount: "12.34" })));
      expect(settlementEventKey(event({ amount: "0.005" }))).toBe(settlementEventKey(event({ amount: "0.01" })));
    });

    it("should agree once the column has rounded the settlement time to the second", () => {
      expect(settlementEventKey(event({ valueDate: new Date("2026-09-01T10:00:00.600Z") }))).toBe(
        settlementEventKey(event({ valueDate: new Date("2026-09-01T10:00:01.000Z") })),
      );
    });

    it("should agree when the stored reference was rewritten to the canonical order id", () => {
      expect(settlementEventKey(event({ transactionRef: "1001" }))).toBe(settlementEventKey(event()));
    });

    it("should read provenance the driver returned as JSON text", () => {
      expect(settlementEventKey(event({ rawData: JSON.stringify({ originalOrderRef: "#1001", gatewayRef: "gw-1" }) as never })))
        .toBe(settlementEventKey(event()));
    });
  });

  describe("when the file had no settlement date", () => {
    it("should leave the import time out of the identity, so a re-upload is recognised", () => {
      const undated = event({ valueDate: null });
      expect(settlementEventKey({ ...undated })).toBe(settlementEventKey({ ...undated }));
      expect(settlementEventKey(undated)).not.toContain("2026");
    });
  });
});

describe("selecting unimported settlement events", () => {
  const key = (row: string) => row;

  it("should keep every event when nothing is stored", () => {
    expect(selectUnimportedSettlementEvents([], ["a", "b", "a"], key)).toEqual(["a", "b", "a"]);
  });

  it("should import only the occurrences beyond those already stored", () => {
    expect(selectUnimportedSettlementEvents(["a"], ["a", "a", "b"], key)).toEqual(["a", "b"]);
    expect(selectUnimportedSettlementEvents(["a", "a", "b"], ["a", "a", "b"], key)).toEqual([]);
  });
});

describe("resolving a confirmed column mapping", () => {
  const headers = ["Order", "Net", "Fee", "Ref"];

  it("should take the mapping as given and not re-detect a field it leaves out", () => {
    expect(resolveConfirmedColumns(headers, { orderRef: "Order", amount: "Net" })).toEqual({
      mapping: { orderRef: "Order", amount: "Net" },
      missingRequired: [],
    });
  });

  it("should drop a header that is not in this file", () => {
    expect(resolveConfirmedColumns(headers, { orderRef: "order_id", amount: "Net" })).toEqual({
      mapping: { amount: "Net" },
      missingRequired: ["orderRef"],
    });
  });
});

describe("reconciling persisted data for a scope", () => {
  const from = new Date("2026-09-01T00:00:00.000Z");
  const to = new Date("2026-09-04T00:00:00.000Z");
  const order = { id: 11, transactionRef: "ORD-1" };
  const settlement = { id: 21, transactionRef: "ORD-1" };
  const raised = (transactionId: number, category: string) => ({
    transactionId,
    category,
    severity: "high",
    description: "d",
    suggestedResolution: "s",
  });

  beforeEach(() => {
    runRetailReconciliation.mockReset();
    runRetailReconciliation.mockReturnValue({
      matches: [],
      retailExceptions: [
        raised(11, "retail_settlement_shortfall"),
        raised(11, "retail_gateway_fee_variance"),
        raised(21, "retail_settlement_shortfall"),
      ],
    });
  });

  it("should read only the named orders on both legs", async () => {
    const fake = scriptedDb({ select: { transactions: [[order], [settlement]], exceptions: [[]] } });

    await runReconciliationOnPersistedData(fake.db as never, 42, 70, 80, from, to, "USD", { orderRefs: ["ORD-1"] });

    const legs = fake.ops.filter((op) => op.kind === "select" && op.table === "transactions");
    expect(legs).toHaveLength(2);
    expect(legs[0]?.where?.params).toEqual(expect.arrayContaining([42, 70, "unmatched", "ORD-1"]));
    expect(legs[1]?.where?.params).toEqual(expect.arrayContaining([42, 80, "unmatched", "ORD-1"]));
  });

  it("should not raise an exception already awaiting a person for the same transaction and category", async () => {
    const fake = scriptedDb({
      select: {
        transactions: [[order], [settlement]],
        exceptions: [[{ transactionId: 11, subCategory: "retail_settlement_shortfall" }]],
      },
    });

    const result = await runReconciliationOnPersistedData(
      fake.db as never, 42, 70, 80, from, to, "USD", { orderRefs: ["ORD-1"] },
    );

    expect(result.exceptionCount).toBe(2);
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === "exceptions");
    expect(lookup?.where?.params).toEqual([42, 11, 21, "open", "in_review", "escalated"]);
    const written = fake.writes("insert", "exceptions")[0]?.data as unknown as Array<Record<string, unknown>>;
    expect(written.map((row) => [row.transactionId, row.subCategory])).toEqual([
      [11, "retail_gateway_fee_variance"],
      [21, "retail_settlement_shortfall"],
    ]);
  });

  it("should do nothing for an empty scope", async () => {
    const fake = scriptedDb();
    await expect(
      runReconciliationOnPersistedData(fake.db as never, 42, 70, 80, from, to, "USD", { orderRefs: [] }),
    ).resolves.toEqual({ matchedCount: 0, exceptionCount: 0 });
    expect(fake.ops).toEqual([]);
  });

  it("should keep an unscoped run (the SHOPLINE sync) exactly as it was", async () => {
    const fake = scriptedDb({ select: { transactions: [[order], [settlement]] } });

    const result = await runReconciliationOnPersistedData(fake.db as never, 42, 70, 80, from, to, "USD");

    expect(result.exceptionCount).toBe(3);
    expect(fake.ops.filter((op) => op.table === "exceptions" && op.kind === "select")).toEqual([]);
    const legs = fake.ops.filter((op) => op.kind === "select" && op.table === "transactions");
    expect(legs[0]?.where?.params).not.toContain("ORD-1");
  });
});
