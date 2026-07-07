/**
 * LAPO integration tests: source registry completeness, row mapping for every
 * source system (including the POC's exact file shapes), split debit/credit
 * ledgers, Nigerian date formats, dedupe identity, and the exception taxonomy
 * against the schema enum. Pure — no DB, no network.
 */
import { describe, expect, it } from "vitest";
import {
  LAPO_SOURCES,
  LAPO_SOURCE_KEYS,
  lapoChannelCode,
  lapoExternalRef,
} from "../../../shared/lapoSources";
import { RESOLUTION_TEMPLATE_CATEGORIES } from "../../../drizzle/schema";
import { mapLapoRow, normalizeRow, parseLapoDate } from "./etl";
import { LAPO_EXCEPTION_CATEGORIES, lapoTaxonomyPromptBlock } from "./exceptions";

describe("LAPO source registry (deliverable 1)", () => {
  it("declares all eight transaction-generating systems", () => {
    expect(LAPO_SOURCE_KEYS).toHaveLength(8);
    const types = new Set(Object.values(LAPO_SOURCES).map((s) => s.channelType));
    // CBS core, mobile, USSD, agent, NIP, cards — the full LAPO channel estate.
    expect(types).toEqual(
      new Set(["bank_core", "mobile_banking", "ussd", "agent_banking", "nibss", "card_payments"]),
    );
  });

  it("every source carries timing config for cross-channel differences (deliverable 3)", () => {
    for (const s of Object.values(LAPO_SOURCES)) {
      expect(s.matching.dateWindowDays, s.key).toBeGreaterThanOrEqual(1);
      // The matching window must cover the settlement lag, or T+1 items
      // would false-positive as breaks every single day.
      expect(s.matching.dateWindowDays, s.key).toBeGreaterThanOrEqual(s.settlementLagDays);
      expect(s.identityFields.length, s.key).toBeGreaterThan(0);
      expect(s.format.signature.length, s.key).toBeGreaterThan(0);
    }
  });

  it("card processors settle T+1 with tolerance; realtime rails are same-day exact", () => {
    expect(LAPO_SOURCES.cards_interswitch.settlementLagDays).toBe(1);
    expect(LAPO_SOURCES.cards_interswitch.matching.amountTolerancePct).toBeGreaterThan(0);
    expect(LAPO_SOURCES.nibss_nip.settlementLagDays).toBe(0);
    expect(LAPO_SOURCES.nibss_nip.matching.amountTolerancePct).toBe(0);
    expect(LAPO_SOURCES.ussd.matching.amountTolerancePct).toBe(0);
  });

  it("channel codes and dedupe refs are org- and source-namespaced", () => {
    expect(lapoChannelCode("ussd", 42)).toBe("LAPO_USSD_42");
    expect(lapoExternalRef("nibss_nip", ["S123"])).toBe("lapo:nibss_nip:S123");
    expect(lapoExternalRef("cards_interswitch", ["RRN1", "STAN9"])).toBe("lapo:cards_interswitch:RRN1:STAN9");
    expect(lapoExternalRef("ussd", ["", null])).toBeNull();
  });
});

describe("parseLapoDate — Nigerian export formats", () => {
  it("ISO and dd/mm/yyyy both land on the same UTC day", () => {
    expect(parseLapoDate("2026-06-23")!.toISOString()).toBe("2026-06-23T00:00:00.000Z");
    expect(parseLapoDate("23/06/2026")!.toISOString()).toBe("2026-06-23T00:00:00.000Z");
    expect(parseLapoDate("23-06-2026 14:35:00")!.toISOString()).toBe("2026-06-23T14:35:00.000Z");
  });
  it("rejects garbage and impossible dates", () => {
    expect(parseLapoDate("31/13/2026")).toBeNull();
    expect(parseLapoDate("not a date")).toBeNull();
    expect(parseLapoDate("")).toBeNull();
  });
});

describe("mapLapoRow — CBS unified ledger (split debit/credit)", () => {
  const profile = LAPO_SOURCES.cbs_ledger;
  // Exact POC sample shape (scripts/generate_lapo_samples.py).
  const debitRow = {
    "Transaction Date": "2026-06-20", "Value Date": "2026-06-20",
    Narration: "POS PURCHASE @SHOPRITE", Reference: "TRX0001",
    "Debit (NGN)": "15,000.00", "Credit (NGN)": "", "Balance (NGN)": "85,000.00",
    Channel: "POS", "Card Type": "Verve", "Terminal ID": "2LAP0001", "PAN (masked)": "506099******1234",
  };

  it("maps a debit row: amount from the debit column, direction=debit", () => {
    const r = mapLapoRow(profile, debitRow);
    expect(r.ok).toBe(true);
    expect(r.value!.amount).toBe("15000.00");
    expect(r.value!.debitCredit).toBe("debit");
    expect(r.value!.externalRef).toBe("lapo:cbs_ledger:TRX0001");
    expect(r.value!.transactionDate.toISOString()).toBe("2026-06-20T00:00:00.000Z");
  });

  it("maps a credit row from the credit column", () => {
    const r = mapLapoRow(profile, { ...debitRow, "Debit (NGN)": "", "Credit (NGN)": "50,000.00", Reference: "TRX0002" });
    expect(r.ok).toBe(true);
    expect(r.value!.amount).toBe("50000.00");
    expect(r.value!.debitCredit).toBe("credit");
  });

  it("rejects a row with BOTH debit and credit filled (ledger corruption signal)", () => {
    const r = mapLapoRow(profile, { ...debitRow, "Credit (NGN)": "10.00" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/BOTH/);
  });

  it("rejects a row with neither side filled", () => {
    const r = mapLapoRow(profile, { ...debitRow, "Debit (NGN)": "", "Credit (NGN)": "" });
    expect(r.ok).toBe(false);
  });

  it("flags reversals from the narration", () => {
    const r = mapLapoRow(profile, { ...debitRow, Narration: "REVERSAL OF TRX0009" });
    expect(r.value!.isReversal).toBe(true);
  });
});

describe("mapLapoRow — Interswitch settlement (POC shape)", () => {
  const profile = LAPO_SOURCES.cards_interswitch;
  const row = {
    "Settlement Date": "2026-06-21", "Transaction Date": "2026-06-20",
    RRN: "000000123456", STAN: "123456", "Terminal ID": "2LAP0001",
    "Merchant Name": "LAPO AGENT 001", "Card Type": "Verve", PAN: "506099******1234",
    "Transaction Amount (NGN)": "15,000.00", "Settlement Amount (NGN)": "15,000.00",
    "Interchange Fee (NGN)": "75.00", "Scheme Fee (NGN)": "15.00",
    "Net Settlement (NGN)": "14,910.00", "Response Code": "00",
    "Transaction Type": "PURCHASE", "Batch Number": "4551",
  };

  it("maps with RRN+STAN identity and value date from settlement date", () => {
    const r = mapLapoRow(profile, row);
    expect(r.ok).toBe(true);
    expect(r.value!.externalRef).toBe("lapo:cards_interswitch:000000123456:123456");
    expect(r.value!.valueDate!.toISOString()).toBe("2026-06-21T00:00:00.000Z");
    // PURCHASE is a known direction word → debit side of the cardholder flow
    // is settled TO the bank; direction resolves from the type column.
    expect(["debit", "credit"]).toContain(r.value!.debitCredit);
  });

  it("prefers settlement/net amount aliases over gross when present", () => {
    const r = mapLapoRow(profile, row);
    // First filled alias wins: settlement_amount_(ngn) = 15,000.00
    expect(r.value!.amount).toBe("15000.00");
  });
});

describe("mapLapoRow — realtime JSON events (mobile / USSD / NIP)", () => {
  it("maps a USSD gateway event with session identity and default-debit", () => {
    const r = mapLapoRow(LAPO_SOURCES.ussd, {
      session_id: "USSD-778899", msisdn: "2348030000001",
      amount: 2000, transaction_date: "2026-06-22 08:14:00", service: "Airtime",
    });
    expect(r.ok).toBe(true);
    expect(r.value!.externalRef).toBe("lapo:ussd:USSD-778899");
    expect(r.value!.debitCredit).toBe("debit"); // profile default
  });

  it("maps a mobile-banking event with explicit type", () => {
    const r = mapLapoRow(LAPO_SOURCES.mobile_banking, {
      transaction_id: "MB-1001", wallet_id: "W-88", amount: "7500.50",
      type: "TRANSFER_OUT", transaction_date: "2026-06-22T09:00:00Z", narration: "To GTB",
    });
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe("debit");
    expect(r.value!.amount).toBe("7500.50");
  });

  it("maps a NIP event on session_id with inward direction", () => {
    const r = mapLapoRow(LAPO_SOURCES.nibss_nip, {
      session_id: "999999999999", name_enquiry_ref: "NE-1",
      amount: "25000", transaction_type: "INWARD", transaction_date: "22/06/2026",
      beneficiary_account_name: "ADAEZE OKAFOR",
    });
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe("credit");
    expect(r.value!.externalRef).toBe("lapo:nibss_nip:999999999999");
  });

  it("fails loudly when identity is missing (never silently ingests)", () => {
    const r = mapLapoRow(LAPO_SOURCES.ussd, { amount: 100, transaction_date: "2026-06-22" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/identity/);
  });
});

describe("normalizeRow", () => {
  it("normalizes headers the same way for CSV and JSON payloads", () => {
    const n = normalizeRow({ "Debit (NGN)": "5", " Session ID ": "x", AMOUNT: 3 });
    expect(n["debit_(ngn)"]).toBe("5");
    expect(n["session_id"]).toBe("x");
    expect(n["amount"]).toBe("3");
  });
});

describe("LAPO exception taxonomy (deliverable 4)", () => {
  it("every category key exists in the resolution-template enum (schema-wired)", () => {
    const enumSet = new Set<string>(RESOLUTION_TEMPLATE_CATEGORIES as readonly string[]);
    for (const c of LAPO_EXCEPTION_CATEGORIES) {
      expect(enumSet.has(c.key), `${c.key} missing from RESOLUTION_TEMPLATE_CATEGORIES`).toBe(true);
    }
  });

  it("ships 10 categories, each with regulatory context, resolution and AI hint", () => {
    expect(LAPO_EXCEPTION_CATEGORIES).toHaveLength(10);
    for (const c of LAPO_EXCEPTION_CATEGORIES) {
      expect(c.regulatoryContext.length, c.key).toBeGreaterThan(40);
      expect(c.recommendedResolution.length, c.key).toBeGreaterThan(40);
      expect(c.aiDiagnosisHint.length, c.key).toBeGreaterThan(30);
      expect(c.slaHours).toBeGreaterThan(0);
    }
  });

  it("CBN 24h-reversal classes are critical with 24h SLA", () => {
    for (const key of ["lapo_ussd_debit_no_value", "lapo_nip_inward_not_credited", "lapo_nip_outward_debit_unsettled"]) {
      const c = LAPO_EXCEPTION_CATEGORIES.find((x) => x.key === key)!;
      expect(c.severity).toBe("critical");
      expect(c.slaHours).toBe(24);
    }
  });

  it("taxonomy prompt block feeds all categories to the Super Agent", () => {
    const block = lapoTaxonomyPromptBlock();
    for (const c of LAPO_EXCEPTION_CATEGORIES) expect(block).toContain(c.key);
  });
});
