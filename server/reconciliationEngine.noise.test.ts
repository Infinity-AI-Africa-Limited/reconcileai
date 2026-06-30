/**
 * Tests for fee/charge "noise" detection in the MAIN reconciliation engine.
 *
 * Same intent as the POC engine — set aside general bank fees so they don't skew
 * the reconciliation — but with a hard guard: card-settlement fees (interchange,
 * scheme fee, MDR, merchant discount, acquirer/issuer/settlement fees) are
 * RELEVANT to card reconciliation and must NEVER be treated as noise.
 */
import { describe, expect, it } from "vitest";
import { detectReconciliationNoise } from "./reconciliationEngine";

const t = (description: string, transactionRef: string | null = null) => ({ description, transactionRef });

describe("detectReconciliationNoise — general bank fees are set aside", () => {
  it("flags general bank fee / charge / levy lines", () => {
    const fees = [
      "VAT on transfer",
      "Stamp Duty",
      "EMTL - Electronic Money Transfer Levy",
      "COT Commission on Turnover",
      "ACCOUNT MAINTENANCE FEE",
      "SMS Alert Charge",
      "NIP Transfer Charge",
      "Service Charge",
      "Commission",
      "MISC. SMS ALERT CHARGE for 1st - 31stJAN 2026",
    ];
    for (const d of fees) {
      expect(detectReconciliationNoise(t(d)).noise, `expected "${d}" to be flagged`).toBe(true);
    }
  });
});

describe("detectReconciliationNoise — card-settlement fees are KEPT (the guard)", () => {
  it("never sets aside card interchange / scheme / settlement fees", () => {
    const cardFees = [
      "Interchange Fee",
      "Interchange fee deduction - Mastercard",
      "Scheme Fee - Visa",
      "MDR charge",
      "Merchant Discount Rate fee",
      "Merchant service charge",
      "Acquirer fee",
      "Issuer fee",
      "Settlement fee - Interswitch",
      "Chargeback fee",
    ];
    for (const d of cardFees) {
      expect(detectReconciliationNoise(t(d)).noise, `card fee "${d}" must be KEPT (not noise)`).toBe(false);
    }
  });
});

describe("detectReconciliationNoise — ordinary transactions are kept", () => {
  it("does not flag real transactions", () => {
    const clean = [
      "POS Purchase - ShopRite",
      "Transfer to John Doe",
      "Salary payment",
      "Airtime recharge",
      "Settlement of invoice INV-3049",
    ];
    for (const d of clean) {
      expect(detectReconciliationNoise(t(d)).noise, `expected "${d}" NOT to be flagged`).toBe(false);
    }
  });

  it("treats empty descriptions as not noise", () => {
    expect(detectReconciliationNoise(t("")).noise).toBe(false);
  });
});
