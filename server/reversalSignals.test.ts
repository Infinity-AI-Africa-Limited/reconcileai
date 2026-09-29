import { describe, expect, it } from "vitest";
import { settlementImportDescription } from "./connectors/shopline/settlementFileImport";
import { REVERSAL_PATTERNS, reversalSignals } from "./reversalSignals";

describe("when a description is reduced to its reversal signal", () => {
  it("should name each signal with a word that still triggers the engine's pattern for it", () => {
    for (const word of reversalSignals("reversal reversed rvsl refund chargeback return cancel void rvs rev/")) {
      expect(REVERSAL_PATTERNS.some((pattern) => pattern.test(word)), word).toBe(true);
    }
  });

  it("should return our vocabulary, never the text's own words", () => {
    expect(reversalSignals("REFUNDED to Jane Doe, Order Cancelled")).toEqual(["refund", "cancel"]);
  });

  it("should find nothing in text without a reversal word, or no text at all", () => {
    expect(reversalSignals("Payout for order 1001 — Jane Doe")).toEqual([]);
    expect(reversalSignals(null)).toEqual([]);
  });
});

describe("when a settlement row's description is stored", () => {
  it("should keep the source and the refund signal, and none of the customer's details", () => {
    const stored = settlementImportDescription("Refund to Jane Doe, jane@example.com, 1 Private Street", "Stripe");

    expect(stored).toBe("Settlement import (Stripe) — refund");
    expect(stored).not.toMatch(/Jane|example\.com|Private Street/);
    // The engine still reads it as a reversal, exactly as it read the original.
    expect(REVERSAL_PATTERNS.some((pattern) => pattern.test(stored))).toBe(true);
  });

  it("should store only the source when the text carries no reversal word", () => {
    expect(settlementImportDescription("Payout — Jane Doe", "DHL COD")).toBe("Settlement import (DHL COD)");
    expect(settlementImportDescription("", "DHL COD")).toBe("Settlement import (DHL COD)");
  });

  it("should give the same answer when applied to its own output", () => {
    const once = settlementImportDescription("Chargeback reversed", "Stripe");
    expect(settlementImportDescription(once, "Stripe")).toBe(once);
  });
});
