/**
 * Tests for fee/charge "noise" detection in the POC reconciliation engine.
 *
 * In a ledger ↔ bank-statement reconciliation, bank-generated fee/charge/levy
 * lines are informational and skew the result. detectNoise() classifies a row as
 * reconcilable or noise (with a human-readable reason) so the engine can set the
 * noise aside and flag it. These tests pin the keyword behaviour and guard
 * against over-matching legitimate transactions.
 */
import { describe, expect, it } from "vitest";
import { detectNoise, type CanonicalRow } from "./poc-engine";

const row = (description: string, extra: Partial<CanonicalRow> = {}): CanonicalRow => ({
  date: "2026-01-15",
  description,
  amount: 100,
  direction: "debit",
  ...extra,
});

describe("detectNoise", () => {
  it("flags Nigerian bank fee / charge / levy descriptions", () => {
    const noisy = [
      "SMS Alert Fee",
      "Account Maintenance Fee",
      "VAT on charges",
      "Stamp Duty",
      "EMTL - Electronic Money Transfer Levy",
      "COT Commission on Turnover",
      "NIP Transfer Charge",
      "Service Charge",
      "Card Maintenance",
      "Commission",
    ];
    for (const d of noisy) {
      expect(detectNoise(row(d)).noise, `expected "${d}" to be flagged`).toBe(true);
    }
  });

  it("returns a human-readable reason for each match", () => {
    expect(detectNoise(row("Stamp Duty")).reason).toBe("Tax, levy or duty");
    expect(detectNoise(row("Account Maintenance Fee")).reason).toBe("Account maintenance fee");
    expect(detectNoise(row("SMS Alert")).reason).toBe("Card / channel fee");
    expect(detectNoise(row("NIP Charge")).reason).toBe("Bank charge / commission");
  });

  it("does NOT flag ordinary business transactions", () => {
    const clean = [
      "Transfer to John Doe",
      "POS Purchase - ShopRite",
      "Salary payment",
      "Airtime recharge", // 'recharge' must not match \bcharge\b
      "Coffee supplies",   // 'coffee' must not match \bfee\b
      "Invoice INV-3049 settlement",
    ];
    for (const d of clean) {
      expect(detectNoise(row(d)).noise, `expected "${d}" NOT to be flagged`).toBe(false);
    }
  });

  it("treats empty / missing descriptions as not noise", () => {
    expect(detectNoise(row("")).noise).toBe(false);
    expect(detectNoise({ date: "", amount: 0, direction: "debit", description: "" }).noise).toBe(false);
  });

  it("matches on the reference field too (catches fee codes in refs)", () => {
    expect(detectNoise(row("", { reference: "STAMP DUTY" })).noise).toBe(true);
  });
});

// Regression: verbatim descriptions from the real Salad Technologies bank
// statement (1782560271862-statement.xlsx). Locks in precise classification —
// every fee line is set aside, and real transactions (transfers, NIP, interest
// payouts) are kept — so a future pattern tweak can't quietly regress this.
describe("detectNoise — real Salad statement descriptions", () => {
  const FEES = [
    "COMMISSION PRV: To undefined|MAHMUD SHEHU INTEGRATED from SALAD TECHNOLOGIES LIMITED",
    "STAMP DUTY PRV: To undefined|MAHMUD SHEHU INTEGRATED from SALAD TECHNOLOGIES LIMITED",
    "VAT PRV: To undefined|AKINSANYA AYOOLA from SALAD TECHNOLOGIES LIMITED Investment interest payout",
    "MISC. SMS ALERT CHARGE for 1st - 31stJAN 2026",
    "MISC. ELECTRONIC MONEY TRANSFER LEVY 6JAN-14JAN 2026",
    "ACCOUNT MAINTENANCE FEE",
  ];
  const REAL_TXNS = [
    "INWARD TRANSFER (N) FROM LOTUS BANK/ REDLAND INTEGRATED CONCEPT LIMITED to SALAD",
    "OUTWARD TRANSFER (N) PRV: To undefined|MAHMUD SHEHU INTEGRATED from SALAD TECHNOLOGIES LIMITED Soybeans Supply Financing",
    "ADESOLA AYOOLA-NIP Transfer to SALAD TECHNOLOGIES",
    "EMMANUEL ISAAC-NIP IFO Salad Technologies Limited",
    "AKINSANYA AYOOLA Investment Interest Payout",
  ];

  it("sets aside every fee line in the statement", () => {
    for (const d of FEES) {
      expect(detectNoise(row(d)).noise, `expected fee "${d.slice(0, 40)}…" to be set aside`).toBe(true);
    }
  });

  it("keeps every real transaction (transfers, NIP, interest payouts)", () => {
    for (const d of REAL_TXNS) {
      expect(detectNoise(row(d)).noise, `expected txn "${d.slice(0, 40)}…" to be kept`).toBe(false);
    }
  });
});
