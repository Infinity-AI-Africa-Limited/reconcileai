import { describe, it, expect } from "vitest";
import {
  normalizeHeader,
  detectFormat,
  formatById,
  resolveField,
  hasField,
  GENERIC_FORMAT,
  NIBSS_NIP_FORMAT,
  INTERSWITCH_SETTLEMENT_FORMAT,
} from "./formats";

const norm = (hs: string[]) => hs.map(normalizeHeader);

describe("connector format detection", () => {
  it("falls back to generic for an unrecognised header set", () => {
    const headers = norm(["Reference", "Amount", "Transaction Date", "Type", "Counterparty"]);
    expect(detectFormat(headers).id).toBe("generic");
  });

  it("detects NIBSS NIP from its distinctive signature columns", () => {
    const headers = norm([
      "Session ID",
      "Name Enquiry Ref",
      "Amount",
      "Transaction Date",
      "Beneficiary Account Name",
      "Narration",
    ]);
    expect(detectFormat(headers).id).toBe("nibss_nip");
  });

  it("detects Interswitch settlement from RRN + STAN", () => {
    const headers = norm([
      "RRN",
      "STAN",
      "Transaction Amount",
      "Transaction Date",
      "Merchant ID",
      "Terminal ID",
    ]);
    expect(detectFormat(headers).id).toBe("interswitch_settlement");
  });

  it("does not false-positive when only part of a signature is present", () => {
    // RRN without STAN should NOT be classified as Interswitch.
    const headers = norm(["RRN", "Amount", "Transaction Date"]);
    expect(detectFormat(headers).id).toBe("generic");
  });
});

describe("formatById", () => {
  it("resolves known ids and generic", () => {
    expect(formatById("nibss_nip")).toBe(NIBSS_NIP_FORMAT);
    expect(formatById("interswitch_settlement")).toBe(INTERSWITCH_SETTLEMENT_FORMAT);
    expect(formatById("generic")).toBe(GENERIC_FORMAT);
  });
  it("returns undefined for unknown / empty", () => {
    expect(formatById("nope")).toBeUndefined();
    expect(formatById(null)).toBeUndefined();
    expect(formatById(undefined)).toBeUndefined();
  });
});

describe("resolveField", () => {
  it("maps NIBSS-specific columns to canonical fields", () => {
    const row = {
      session_id: "SESS-001",
      name_enquiry_ref: "NE-001",
      amount: "15000.00",
      transaction_date: "2026-06-01",
      beneficiary_account_name: "ACME LTD",
      narration: "salary",
      payment_reference: "PAY-999",
    };
    expect(resolveField(row, NIBSS_NIP_FORMAT, "amount")).toBe("15000.00");
    expect(resolveField(row, NIBSS_NIP_FORMAT, "transactionRef")).toBe("PAY-999");
    expect(resolveField(row, NIBSS_NIP_FORMAT, "externalRef")).toBe("SESS-001");
    expect(resolveField(row, NIBSS_NIP_FORMAT, "counterparty")).toBe("ACME LTD");
    expect(resolveField(row, NIBSS_NIP_FORMAT, "description")).toBe("salary");
  });

  it("maps Interswitch-specific columns to canonical fields", () => {
    const row = {
      rrn: "000123456789",
      stan: "456789",
      transaction_amount: "2500.50",
      transaction_date: "2026-06-02",
      merchant_name: "SHOPRITE LEKKI",
    };
    expect(resolveField(row, INTERSWITCH_SETTLEMENT_FORMAT, "amount")).toBe("2500.50");
    expect(resolveField(row, INTERSWITCH_SETTLEMENT_FORMAT, "transactionRef")).toBe("000123456789");
    expect(resolveField(row, INTERSWITCH_SETTLEMENT_FORMAT, "externalRef")).toBe("456789");
    expect(resolveField(row, INTERSWITCH_SETTLEMENT_FORMAT, "counterparty")).toBe("SHOPRITE LEKKI");
  });

  it("falls back to generic aliases for columns not in the format-specific map", () => {
    // A NIBSS file that happens to also carry a generic `reference` column.
    const row = { reference: "REF-XYZ", amount: "10", transaction_date: "2026-06-03" };
    // transactionRef tries payment_reference/transaction_ref/session_id (none present)
    // then generic reference/ref/... → "REF-XYZ".
    expect(resolveField(row, NIBSS_NIP_FORMAT, "transactionRef")).toBe("REF-XYZ");
  });
});

describe("hasField (required-header validation)", () => {
  it("confirms amount + date present for a NIBSS header set", () => {
    const headers = norm(["Session ID", "Name Enquiry Ref", "Amount", "Transaction Date"]);
    expect(hasField(headers, NIBSS_NIP_FORMAT, "amount")).toBe(true);
    expect(hasField(headers, NIBSS_NIP_FORMAT, "transactionDate")).toBe(true);
  });
  it("flags a missing amount column", () => {
    const headers = norm(["Reference", "Transaction Date"]);
    expect(hasField(headers, GENERIC_FORMAT, "amount")).toBe(false);
  });
});
