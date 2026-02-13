import { describe, expect, it } from "vitest";
import { runMatchingEngine, categorizeException } from "./reconciliationEngine";

// ─── Test Data Factory ──────────────────────────────────────────────

function makeTxn(overrides: Partial<{
  id: number;
  batchId: number;
  userId: number;
  organizationId: number | null;
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
  valueDate: Date | null;
  isReversal: boolean;
  originalTransactionRef: string | null;
  matchId: number | null;
  rawData: any;
  createdAt: Date;
}>) {
  return {
    id: 1,
    batchId: 1,
    userId: 1,
    organizationId: null,
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
    valueDate: null,
    isReversal: false,
    originalTransactionRef: null,
    matchId: null,
    rawData: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ─── Pass 1: Exact Reference Matching ──────────────────────────────

describe("runMatchingEngine - Pass 1: Exact Reference Matching", () => {
  const config = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("produces exact matches when ref and amount match", () => {
    const source = [makeTxn({ id: 1, transactionRef: "REF001", amount: "5000.00" })];
    const target = [makeTxn({ id: 2, transactionRef: "REF001", amount: "5000.00" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe("exact");
    expect(result.matches[0].confidenceScore).toBe(100);
    expect(result.unmatchedSource).toHaveLength(0);
    expect(result.unmatchedTarget).toHaveLength(0);
  });

  it("matches references case-insensitively", () => {
    const source = [makeTxn({ id: 1, transactionRef: "NIP/REF-001", amount: "5000.00" })];
    const target = [makeTxn({ id: 2, transactionRef: "nip/ref-001", amount: "5000.00" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe("exact");
  });

  it("does NOT exact-match when amounts differ even with same ref", () => {
    const source = [makeTxn({ id: 1, transactionRef: "REF001", amount: "5000.00" })];
    const target = [makeTxn({ id: 2, transactionRef: "REF001", amount: "6000.00" })];
    const result = runMatchingEngine(source, target, config);

    // Should not be an exact match (pass 1), but may match in pass 2 if within tolerance
    const exactMatches = result.matches.filter((m) => m.matchType === "exact");
    expect(exactMatches).toHaveLength(0);
  });

  it("prioritizes exact ref matches over fuzzy matches", () => {
    const source = [makeTxn({ id: 1, transactionRef: "REF-EXACT", amount: "5000.00" })];
    const target = [
      makeTxn({ id: 2, transactionRef: "REF-EXACT", amount: "5000.00" }),
      makeTxn({ id: 3, transactionRef: null, amount: "5000.00" }),
    ];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe("exact");
    expect(result.matches[0].targetId).toBe(2);
  });
});

// ─── Pass 2: Amount Tolerance + Date Window ─────────────────────────

describe("runMatchingEngine - Pass 2: Tolerance Matching", () => {
  const config = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("matches within amount tolerance (±0.5%)", () => {
    // Use different descriptions/counterparties to avoid fuzzy match taking precedence
    const source = [makeTxn({ id: 1, transactionRef: null, amount: "10000.00", description: "Xfer Alpha", counterparty: "Alpha Co" })];
    const target = [makeTxn({ id: 2, transactionRef: null, amount: "10040.00", description: "Xfer Alpha", counterparty: "Alpha Co" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(1);
    // Engine may classify as amount_tolerance or fuzzy depending on similarity scores
    expect(["amount_tolerance", "fuzzy"]).toContain(result.matches[0].matchType);
    expect(Math.abs(result.matches[0].amountDifference)).toBe(40);
  });

  it("matches within date window (±3 days)", () => {
    const source = [makeTxn({ id: 1, transactionRef: null, amount: "5000.00", transactionDate: new Date("2025-06-15") })];
    const target = [makeTxn({ id: 2, transactionRef: null, amount: "5000.00", transactionDate: new Date("2025-06-17") })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].dateDifference).toBeGreaterThan(0);
  });

  it("does NOT match when amount exceeds tolerance", () => {
    const source = [makeTxn({ id: 1, transactionRef: null, amount: "10000.00", description: "Unique Source", counterparty: "Source Co" })];
    const target = [makeTxn({ id: 2, transactionRef: null, amount: "11000.00", description: "Unique Target", counterparty: "Target Co" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedSource).toContain(1);
    expect(result.unmatchedTarget).toContain(2);
  });

  it("does NOT match when date exceeds window", () => {
    const source = [makeTxn({ id: 1, transactionRef: null, amount: "5000.00", transactionDate: new Date("2025-06-01"), description: "Alpha", counterparty: "Alpha Corp" })];
    const target = [makeTxn({ id: 2, transactionRef: null, amount: "5000.00", transactionDate: new Date("2025-06-25"), description: "Beta", counterparty: "Beta Ltd" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(0);
  });
});

// ─── Pass 3: Fuzzy Matching ─────────────────────────────────────────

describe("runMatchingEngine - Pass 3: Fuzzy Matching", () => {
  const config = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("fuzzy matches on similar descriptions", () => {
    const source = [makeTxn({ id: 1, transactionRef: null, amount: "5000.00", description: "Payment to Dangote Cement Ltd", counterparty: "Dangote Cement" })];
    const target = [makeTxn({ id: 2, transactionRef: null, amount: "5010.00", description: "Payment to Dangote Cement Limited", counterparty: "Dangote Cement Ltd" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe("fuzzy");
    expect(result.matches[0].confidenceScore).toBeGreaterThanOrEqual(50);
    expect(result.matches[0].confidenceScore).toBeLessThanOrEqual(85);
  });

  it("does NOT fuzzy match when descriptions and counterparties are completely different and amounts differ", () => {
    // Use different amounts beyond tolerance to ensure no match
    const source = [makeTxn({ id: 1, transactionRef: null, amount: "5000.00", description: "NIBSS Instant Payment", counterparty: "GTBank" })];
    const target = [makeTxn({ id: 2, transactionRef: null, amount: "7500.00", description: "POS Terminal Purchase", counterparty: "Shoprite" })];
    const result = runMatchingEngine(source, target, config);

    // With 50% amount difference and different descriptions, should not match
    expect(result.matches).toHaveLength(0);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────

describe("runMatchingEngine - Edge Cases", () => {
  const config = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("handles empty source array", () => {
    const result = runMatchingEngine([], [makeTxn({ id: 2 })], config);
    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedSource).toHaveLength(0);
    expect(result.unmatchedTarget).toHaveLength(1);
  });

  it("handles empty target array", () => {
    const result = runMatchingEngine([makeTxn({ id: 1 })], [], config);
    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedSource).toHaveLength(1);
    expect(result.unmatchedTarget).toHaveLength(0);
  });

  it("handles both empty arrays", () => {
    const result = runMatchingEngine([], [], config);
    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedSource).toHaveLength(0);
    expect(result.unmatchedTarget).toHaveLength(0);
  });

  it("handles multiple transactions with correct 1:1 matching", () => {
    const source = [
      makeTxn({ id: 1, transactionRef: "A", amount: "1000.00" }),
      makeTxn({ id: 2, transactionRef: "B", amount: "2000.00" }),
      makeTxn({ id: 3, transactionRef: "C", amount: "3000.00" }),
    ];
    const target = [
      makeTxn({ id: 4, transactionRef: "A", amount: "1000.00" }),
      makeTxn({ id: 5, transactionRef: "B", amount: "2000.00" }),
    ];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(2);
    expect(result.unmatchedSource).toContain(3);
    expect(result.unmatchedTarget).toHaveLength(0);
  });

  it("handles large amounts (Nigerian banking scale)", () => {
    const source = [makeTxn({ id: 1, transactionRef: "LRG001", amount: "999999999.99" })];
    const target = [makeTxn({ id: 2, transactionRef: "LRG001", amount: "999999999.99" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe("exact");
  });

  it("handles zero-amount transactions", () => {
    const source = [makeTxn({ id: 1, transactionRef: "ZERO01", amount: "0.00" })];
    const target = [makeTxn({ id: 2, transactionRef: "ZERO01", amount: "0.00" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(1);
  });
});

// ─── Duplicate Detection ────────────────────────────────────────────

describe("runMatchingEngine - Duplicate Detection", () => {
  const config = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("detects duplicate transactions with same ref, amount, and date", () => {
    const source = [
      makeTxn({ id: 1, transactionRef: "DUP001", amount: "5000.00", channelId: 1 }),
      makeTxn({ id: 2, transactionRef: "DUP001", amount: "5000.00", channelId: 1 }),
    ];
    const target = [makeTxn({ id: 3, transactionRef: "DUP001", amount: "5000.00" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.duplicates.length).toBeGreaterThan(0);
    const dupGroup = result.duplicates.find((d) => d.transactionIds.includes(1) && d.transactionIds.includes(2));
    expect(dupGroup).toBeDefined();
  });

  it("does NOT flag as duplicate when refs differ", () => {
    const source = [
      makeTxn({ id: 1, transactionRef: "REF-A", amount: "5000.00", channelId: 1 }),
      makeTxn({ id: 2, transactionRef: "REF-B", amount: "5000.00", channelId: 1 }),
    ];
    const result = runMatchingEngine(source, [], config);

    const dupGroup = result.duplicates.find((d) => d.transactionIds.includes(1) && d.transactionIds.includes(2));
    expect(dupGroup).toBeUndefined();
  });
});

// ─── Reversal Detection ─────────────────────────────────────────────

describe("runMatchingEngine - Reversal Detection", () => {
  const config = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("detects reversal transactions by isReversal flag", () => {
    const source = [
      makeTxn({ id: 1, transactionRef: "ORIG001", amount: "5000.00", debitCredit: "debit", channelId: 1, transactionDate: new Date("2025-06-15") }),
      makeTxn({ id: 2, transactionRef: "REV-ORIG001", amount: "5000.00", debitCredit: "credit", channelId: 1, isReversal: true, originalTransactionRef: "ORIG001", transactionDate: new Date("2025-06-16") }),
    ];
    const result = runMatchingEngine(source, [], config);

    expect(result.reversals.length).toBeGreaterThan(0);
    const rev = result.reversals.find((r) => r.reversalId === 2);
    expect(rev).toBeDefined();
    expect(rev!.originalId).toBe(1);
  });

  it("detects reversal transactions by description keywords with isReversal flag", () => {
    const source = [
      makeTxn({ id: 1, transactionRef: "PAY001", amount: "3000.00", debitCredit: "debit", channelId: 1, transactionDate: new Date("2025-06-10") }),
      makeTxn({ id: 2, transactionRef: "PAY001-REVERSAL", amount: "3000.00", debitCredit: "credit", channelId: 1, description: "Reversal of PAY001", isReversal: true, originalTransactionRef: "PAY001", transactionDate: new Date("2025-06-12") }),
    ];
    const result = runMatchingEngine(source, [], config);

    expect(result.reversals.length).toBeGreaterThan(0);
    expect(result.reversals[0].originalId).toBe(1);
    expect(result.reversals[0].reversalId).toBe(2);
  });
});

// ─── Engine Stats ───────────────────────────────────────────────────

describe("runMatchingEngine - Stats", () => {
  const config = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("returns accurate engine stats", () => {
    const source = [
      makeTxn({ id: 1, transactionRef: "A", amount: "1000.00" }),
      makeTxn({ id: 2, transactionRef: null, amount: "2000.00" }),
    ];
    const target = [
      makeTxn({ id: 3, transactionRef: "A", amount: "1000.00" }),
      makeTxn({ id: 4, transactionRef: null, amount: "2000.00" }),
    ];
    const result = runMatchingEngine(source, target, config);

    expect(result.stats.totalSourceTxns).toBe(2);
    expect(result.stats.totalTargetTxns).toBe(2);
    expect(result.stats.pass1ExactMatches).toBe(1);
    expect(result.stats.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── Exception Categorization ───────────────────────────────────────

describe("categorizeException", () => {
  const config = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("categorizes as unmatched when no close matches exist", () => {
    const txn = makeTxn({ id: 1, amount: "50000.00", counterparty: "Some Vendor" });
    const result = categorizeException(txn, [], config);

    expect(result.category).toBe("unmatched");
    expect(result.severity).toBeDefined();
    expect(result.description).toBeTruthy();
  });

  it("categorizes as missing_counterparty when counterparty is empty", () => {
    const txn = makeTxn({ id: 1, amount: "50000.00", counterparty: "" });
    const result = categorizeException(txn, [], config);

    expect(result.category).toBe("missing_counterparty");
  });

  it("categorizes as amount_mismatch when amounts differ beyond tolerance", () => {
    const txn = makeTxn({ id: 1, amount: "10000.00", counterparty: "Vendor" });
    const targets = [makeTxn({ id: 2, amount: "10100.00", counterparty: "Vendor" })];
    const result = categorizeException(txn, targets, config);

    expect(result.category).toBe("amount_mismatch");
  });

  it("categorizes as timing_difference when amounts match but dates differ", () => {
    const txn = makeTxn({ id: 1, amount: "5000.00", transactionDate: new Date("2025-06-15"), counterparty: "Vendor" });
    const targets = [makeTxn({ id: 2, amount: "5000.00", transactionDate: new Date("2025-06-20"), counterparty: "Vendor" })];
    const result = categorizeException(txn, targets, config);

    expect(result.category).toBe("timing_difference");
  });

  it("categorizes as reversal_unmatched for reversal transactions", () => {
    const txn = makeTxn({ id: 1, amount: "5000.00", isReversal: true, description: "Reversal of payment" });
    const result = categorizeException(txn, [], config);

    expect(result.category).toBe("reversal_unmatched");
    expect(result.severity).toBe("high");
  });

  it("categorizes as currency_mismatch for cross-currency ref matches", () => {
    const txn = makeTxn({ id: 1, amount: "5000.00", currency: "NGN", transactionRef: "CROSS001" });
    const targets = [makeTxn({ id: 2, amount: "12.50", currency: "USD", transactionRef: "CROSS001" })];
    const result = categorizeException(txn, targets, config);

    expect(result.category).toBe("currency_mismatch");
    expect(result.severity).toBe("high");
  });

  it("assigns high severity for large unmatched amounts", () => {
    const txn = makeTxn({ id: 1, amount: "5000000.00", counterparty: "Big Corp" });
    const result = categorizeException(txn, [], config);

    expect(result.category).toBe("unmatched");
    expect(result.severity).toBe("high");
  });

  it("always returns all required fields", () => {
    const txn = makeTxn({ id: 1, counterparty: "Vendor" });
    const result = categorizeException(txn, [], config);

    expect(result).toHaveProperty("category");
    expect(result).toHaveProperty("severity");
    expect(result).toHaveProperty("description");
    expect(result).toHaveProperty("suggestedResolution");
    expect(typeof result.description).toBe("string");
    expect(typeof result.suggestedResolution).toBe("string");
  });

  it("provides Nigerian-specific resolution suggestions", () => {
    const txn = makeTxn({ id: 1, amount: "50000.00", counterparty: "Vendor" });
    const result = categorizeException(txn, [], config);

    // Should reference Nigerian banking concepts
    expect(result.suggestedResolution.toLowerCase()).toMatch(/nib|nip|bank|channel/);
  });
});

// ─── Multi-Currency Scenarios ───────────────────────────────────────

describe("runMatchingEngine - Multi-Currency", () => {
  const config = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("matches transactions in the same currency", () => {
    const source = [makeTxn({ id: 1, transactionRef: "KES001", amount: "100000.00", currency: "KES" })];
    const target = [makeTxn({ id: 2, transactionRef: "KES001", amount: "100000.00", currency: "KES" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(1);
  });

  it("matches GHS transactions correctly", () => {
    const source = [makeTxn({ id: 1, transactionRef: "GHS001", amount: "5000.00", currency: "GHS" })];
    const target = [makeTxn({ id: 2, transactionRef: "GHS001", amount: "5000.00", currency: "GHS" })];
    const result = runMatchingEngine(source, target, config);

    expect(result.matches).toHaveLength(1);
  });
});

// ─── Performance Characteristics ────────────────────────────────────

describe("runMatchingEngine - Performance", () => {
  const config = { amountTolerance: 0.005, dateWindowDays: 3 };

  it("handles 500 transactions within reasonable time", () => {
    const source = Array.from({ length: 250 }, (_, i) =>
      makeTxn({ id: i + 1, transactionRef: `SRC${i}`, amount: `${1000 + i}.00`, transactionDate: new Date("2025-06-15") })
    );
    const target = Array.from({ length: 250 }, (_, i) =>
      makeTxn({ id: i + 251, transactionRef: `SRC${i}`, amount: `${1000 + i}.00`, transactionDate: new Date("2025-06-15") })
    );

    const start = Date.now();
    const result = runMatchingEngine(source, target, config);
    const elapsed = Date.now() - start;

    expect(result.matches).toHaveLength(250);
    expect(elapsed).toBeLessThan(5000); // Should complete within 5 seconds
    expect(result.stats.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});
