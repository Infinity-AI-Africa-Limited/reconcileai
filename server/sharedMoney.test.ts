/**
 * The single money parser, shared by client and server.
 *
 * Three implementations existed before this and they disagreed:
 *   server/apiIngestionService  replace(/[^0-9.-]/g,"")   SFTP + API path
 *   client Upload.tsx           replace(/[,\s]/g,"")      the 57M-row path
 *   the SHOPLINE settlement importer
 *
 * Divergence here is uniquely dangerous because a mis-parsed amount is still a
 * plausible amount — no downstream check fires. These tests are the contract.
 */
import { describe, it, expect } from "vitest";
import { parseMoney, parseMoneyDate } from "../shared/money";
// The server ingestion core must be the SAME function, not a copy.
import { parseAmount, parseDate } from "./ingest/fileParser";

describe("parseMoney — regressions from each old implementation", () => {
  it("keeps the sign of an accounting negative (server path lost it)", () => {
    expect(parseMoney("(12.30)")).toBe(-12.3);
    expect(parseMoney("(1,234.56)")).toBeCloseTo(-1234.56, 2);
  });

  it("reads European decimals correctly (BOTH old paths got this wrong)", () => {
    // client: "1.234,56" -> replace(/[,\s]/g,"") -> "1.23456" -> 1.23456
    expect(parseMoney("1.234,56")).toBeCloseTo(1234.56, 2);
    expect(parseMoney("1.234.567,89")).toBeCloseTo(1234567.89, 2);
  });

  it("accepts a parenthesised negative the client used to reject outright", () => {
    // parseFloat("(12.30)") is NaN, so the row was dropped with "Invalid amount".
    expect(parseMoney("(45.00)")).toBe(-45);
  });

  it("does not mistake thousands grouping for a decimal", () => {
    expect(parseMoney("₦ 12,000")).toBe(12000);
    expect(parseMoney("12,000")).toBe(12000);
    expect(parseMoney("1,234,567.89")).toBeCloseTo(1234567.89, 2);
  });

  it("handles the ordinary Anglo cases unchanged", () => {
    expect(parseMoney("1234.56")).toBeCloseTo(1234.56, 2);
    expect(parseMoney("$1,234.56")).toBeCloseTo(1234.56, 2);
    expect(parseMoney("-45.00")).toBe(-45);
    expect(parseMoney("0")).toBe(0);
    expect(parseMoney(42)).toBe(42);
  });

  it("returns null, never NaN, for unreadable input", () => {
    for (const v of ["", "   ", "n/a", "-", ".", ",", undefined, null]) {
      expect(parseMoney(v as string)).toBeNull();
    }
    expect(parseMoney(Number.NaN)).toBeNull();
  });
});

describe("parseMoneyDate", () => {
  it("never yields an Invalid Date", () => {
    expect(parseMoneyDate("not a date")).toBeNull();
    expect(parseMoneyDate("")).toBeNull();
    expect(parseMoneyDate(undefined)).toBeNull();
  });
  it("accepts ISO strings and Date objects", () => {
    expect(parseMoneyDate("2026-08-02T10:00:00Z")?.toISOString()).toBe("2026-08-02T10:00:00.000Z");
    expect(parseMoneyDate(new Date("2026-08-02"))).toBeInstanceOf(Date);
  });
});

describe("there is exactly one implementation", () => {
  it("the server ingestion core re-exports shared/money rather than copying it", () => {
    // Identity, not equivalence: a copy could drift, a re-export cannot.
    expect(parseAmount).toBe(parseMoney);
    expect(parseDate).toBe(parseMoneyDate);
  });
});
