import { describe, expect, it } from "vitest";
import { runMatchingEngine, categorizeException } from "./reconciliationEngine";

// ─── Test Data ──────────────────────────────────────────────────────

function makeTxn(overrides: Partial<{
  id: number;
  amount: string;
  transactionDate: Date;
  transactionRef: string | null;
  externalRef: string | null;
  description: string | null;
  debitCredit: string;
  counterparty: string | null;
  channelId: number;
  currency: string;
  status: string;
}>) {
  return {
    id: 1,
    amount: "1000.00",
    transactionDate: new Date("2025-06-15"),
    transactionRef: "REF001",
    externalRef: null,
    description: "Payment",
    debitCredit: "debit",
    counterparty: "Vendor A",
    channelId: 1,
    currency: "NGN",
    status: "pending",
    ...overrides,
  };
}

// ─── Matching Engine Tests ──────────────────────────────────────────

describe("runMatchingEngine", () => {
  const defaultConfig = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("produces exact matches when ref, amount, and date all match", () => {
    const source = [makeTxn({ id: 1, transactionRef: "REF001", amount: "5000.00", transactionDate: new Date("2025-06-15") })];
    const target = [makeTxn({ id: 2, transactionRef: "REF001", amount: "5000.00", transactionDate: new Date("2025-06-15") })];

    const result = runMatchingEngine(source, target, defaultConfig);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe("exact");
    expect(result.matches[0].confidenceScore).toBe(100);
    expect(result.unmatchedSource).toHaveLength(0);
    expect(result.unmatchedTarget).toHaveLength(0);
  });

  it("matches within amount tolerance (±0.5%)", () => {
    // Use null refs to avoid exact ref match, force into Pass 2
    const source = [makeTxn({ id: 1, transactionRef: null, amount: "10000.00", transactionDate: new Date("2025-06-15") })];
    const target = [makeTxn({ id: 2, transactionRef: null, amount: "10040.00", transactionDate: new Date("2025-06-15") })];

    const result = runMatchingEngine(source, target, defaultConfig);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe("amount_tolerance");
    // amountDifference is source - target = 10000 - 10040 = -40
    expect(result.matches[0].amountDifference).toBe(-40);
  });

  it("matches within date window (±3 days)", () => {
    const source = [makeTxn({ id: 1, transactionRef: null, amount: "5000.00", transactionDate: new Date("2025-06-15") })];
    const target = [makeTxn({ id: 2, transactionRef: null, amount: "5000.00", transactionDate: new Date("2025-06-17") })];

    const result = runMatchingEngine(source, target, defaultConfig);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].dateDifference).toBeGreaterThan(0);
  });

  it("does NOT match when amount exceeds tolerance", () => {
    const source = [makeTxn({ id: 1, transactionRef: null, amount: "10000.00", transactionDate: new Date("2025-06-15"), description: "Unique Source", counterparty: "Source Co" })];
    const target = [makeTxn({ id: 2, transactionRef: null, amount: "11000.00", transactionDate: new Date("2025-06-15"), description: "Unique Target", counterparty: "Target Co" })];

    const result = runMatchingEngine(source, target, defaultConfig);

    // 10% difference far exceeds 0.5% tolerance, and also exceeds 2x tolerance for fuzzy
    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedSource).toContain(1);
    expect(result.unmatchedTarget).toContain(2);
  });

  it("does NOT match when date exceeds window and refs differ", () => {
    // Use different descriptions/counterparties to prevent fuzzy match
    const source = [makeTxn({ id: 1, transactionRef: null, amount: "5000.00", transactionDate: new Date("2025-06-01"), description: "Alpha payment", counterparty: "Alpha Corp" })];
    const target = [makeTxn({ id: 2, transactionRef: null, amount: "5000.00", transactionDate: new Date("2025-06-25"), description: "Beta receipt", counterparty: "Beta Ltd" })];

    const result = runMatchingEngine(source, target, defaultConfig);

    // 24-day difference exceeds 3-day window
    expect(result.matches).toHaveLength(0);
  });

  it("handles empty source array", () => {
    const result = runMatchingEngine([], [makeTxn({ id: 2 })], defaultConfig);

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedSource).toHaveLength(0);
    expect(result.unmatchedTarget).toHaveLength(1);
  });

  it("handles empty target array", () => {
    const result = runMatchingEngine([makeTxn({ id: 1 })], [], defaultConfig);

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedSource).toHaveLength(1);
    expect(result.unmatchedTarget).toHaveLength(0);
  });

  it("handles multiple transactions with correct 1:1 matching", () => {
    const source = [
      makeTxn({ id: 1, transactionRef: "A", amount: "1000.00", transactionDate: new Date("2025-06-15") }),
      makeTxn({ id: 2, transactionRef: "B", amount: "2000.00", transactionDate: new Date("2025-06-15") }),
      makeTxn({ id: 3, transactionRef: "C", amount: "3000.00", transactionDate: new Date("2025-06-15") }),
    ];
    const target = [
      makeTxn({ id: 4, transactionRef: "A", amount: "1000.00", transactionDate: new Date("2025-06-15") }),
      makeTxn({ id: 5, transactionRef: "B", amount: "2000.00", transactionDate: new Date("2025-06-15") }),
    ];

    const result = runMatchingEngine(source, target, defaultConfig);

    expect(result.matches).toHaveLength(2);
    expect(result.unmatchedSource).toContain(3);
    expect(result.unmatchedTarget).toHaveLength(0);
  });

  it("prioritizes exact ref matches over fuzzy matches", () => {
    const source = [makeTxn({ id: 1, transactionRef: "REF-EXACT", amount: "5000.00", transactionDate: new Date("2025-06-15") })];
    const target = [
      makeTxn({ id: 2, transactionRef: "REF-EXACT", amount: "5000.00", transactionDate: new Date("2025-06-15") }),
      makeTxn({ id: 3, transactionRef: null, amount: "5000.00", transactionDate: new Date("2025-06-15") }),
    ];

    const result = runMatchingEngine(source, target, defaultConfig);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe("exact");
    expect(result.matches[0].targetId).toBe(2);
  });
});

// ─── Exception Categorization Tests ─────────────────────────────────

describe("categorizeException", () => {
  const defaultConfig = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("categorizes as unmatched when no close matches exist and counterparty is present", () => {
    const txn = makeTxn({ id: 1, amount: "50000.00", transactionDate: new Date("2025-06-15"), counterparty: "Some Vendor" });
    const allTargets: any[] = [];

    const result = categorizeException(txn, allTargets, defaultConfig);

    expect(result.category).toBe("unmatched");
    expect(result.severity).toBeDefined();
    expect(result.description).toBeTruthy();
  });

  it("categorizes as missing_counterparty when counterparty is empty", () => {
    const txn = makeTxn({ id: 1, amount: "50000.00", transactionDate: new Date("2025-06-15"), counterparty: "" });
    const allTargets: any[] = [];

    const result = categorizeException(txn, allTargets, defaultConfig);

    expect(result.category).toBe("missing_counterparty");
  });

  it("categorizes as amount_mismatch when amounts differ beyond tolerance but within 5x", () => {
    // 0.5% tolerance = 0.005. Need diff between 0.5% and 2.5% (5x)
    // 10000 * 0.01 = 100 → 1% diff, which is > 0.5% but < 2.5%
    const txn = makeTxn({ id: 1, amount: "10000.00", transactionDate: new Date("2025-06-15"), counterparty: "Vendor" });
    const targets = [
      makeTxn({ id: 2, amount: "10100.00", transactionDate: new Date("2025-06-15"), counterparty: "Vendor" }),
    ];

    const result = categorizeException(txn, targets, defaultConfig);

    expect(result.category).toBe("amount_mismatch");
  });

  it("categorizes as timing_difference when amounts match but dates differ beyond window", () => {
    // Amounts match exactly, date diff > 3 days but <= 9 days (3x window)
    const txn = makeTxn({ id: 1, amount: "5000.00", transactionDate: new Date("2025-06-15"), counterparty: "Vendor" });
    const targets = [
      makeTxn({ id: 2, amount: "5000.00", transactionDate: new Date("2025-06-20"), counterparty: "Vendor" }),
    ];

    const result = categorizeException(txn, targets, defaultConfig);

    expect(result.category).toBe("timing_difference");
  });

  it("always returns required fields", () => {
    const txn = makeTxn({ id: 1, counterparty: "Vendor" });
    const result = categorizeException(txn, [], defaultConfig);

    expect(result).toHaveProperty("category");
    expect(result).toHaveProperty("severity");
    expect(result).toHaveProperty("description");
    expect(result).toHaveProperty("suggestedResolution");
  });
});
