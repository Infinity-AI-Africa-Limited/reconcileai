/**
 * Shared currency helpers (WS-6) — Unit Tests
 * NGN/UGX behaviour is additionally covered via the mobile money engine tests,
 * which re-export these helpers.
 */
import { describe, it, expect } from "vitest";
import { fmtMoney, priorityFor, PRIORITY_THRESHOLDS } from "./currency";

describe("fmtMoney", () => {
  it("formats known currencies with their symbols", () => {
    expect(fmtMoney(5000.5, "NGN")).toBe("₦5,000.50");
    expect(fmtMoney(500, "USD")).toBe("$500.00");
    expect(fmtMoney(500, "GBP")).toBe("£500.00");
  });

  it("zero-decimal currencies render without decimals", () => {
    expect(fmtMoney(1_250_000, "UGX")).toBe("USh 1,250,000");
    expect(fmtMoney(9_000, "RWF")).toBe("RWF 9,000");
  });

  it("unknown currencies fall back to CODE prefix", () => {
    expect(fmtMoney(100, "TZS")).toBe("TZS 100.00");
  });
});

describe("priorityFor — currency-scaled thresholds", () => {
  it("hard currencies use their own bands, not NGN's", () => {
    // 600 USD ≈ ₦900k — CRITICAL under USD's band; would be LOW under NGN's.
    expect(priorityFor(600, "USD")).toBe("CRITICAL");
    expect(priorityFor(600, "NGN")).toBe("LOW");
  });

  it("unlisted currencies fall back to the NGN band", () => {
    expect(priorityFor(600_000, "TZS")).toBe("CRITICAL");
  });

  it("uses absolute amounts (credits and debits rank equally)", () => {
    expect(priorityFor(-600, "USD")).toBe("CRITICAL");
  });

  it("every configured currency has a full band", () => {
    for (const [ccy, band] of Object.entries(PRIORITY_THRESHOLDS)) {
      expect(band.critical, ccy).toBeGreaterThan(band.high);
      expect(band.high, ccy).toBeGreaterThan(band.medium);
      expect(band.medium, ccy).toBeGreaterThan(0);
    }
  });
});
