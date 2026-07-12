/**
 * Uganda channel pack tests (G1): row mapping across the rails, taxonomy
 * integrity + registry wiring, and enum coverage so seeding cannot fail.
 */
import { describe, expect, it } from "vitest";
import { mapUgandaRow, parseUgandaDate } from "./etl";
import { UGANDA_SOURCES, UGANDA_SOURCE_KEYS } from "@shared/ugandaSources";
import {
  UGANDA_EXCEPTIONS,
  UGANDA_EXCEPTION_KEYS,
  ugandaExceptionFor,
  ugandaExceptionsTaxonomyPromptBlock,
} from "../../exceptions/uganda";
import { EXCEPTION_REGISTRY, ALL_EXCEPTIONS } from "../../exceptions/index";
import { RESOLUTION_TEMPLATE_CATEGORIES } from "../../../drizzle/schema";

describe("parseUgandaDate — day-first (dd/mm/yyyy), the NG/UG convention", () => {
  it("reads an ambiguous day-≤12 slash date day-first, not US month-first", () => {
    // 12/07/2026 must be 12 July, not 7 December — the silent-corruption case.
    expect(parseUgandaDate("12/07/2026")!.toISOString()).toBe("2026-07-12T00:00:00.000Z");
    expect(parseUgandaDate("12/07/2026 14:30")!.toISOString()).toBe("2026-07-12T14:30:00.000Z");
    expect(parseUgandaDate("01/02/2026")!.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
  it("still parses unambiguous ISO", () => {
    expect(parseUgandaDate("2026-07-12")!.toISOString()).toBe("2026-07-12T00:00:00.000Z");
  });
  it("rejects impossible dates and junk", () => {
    expect(parseUgandaDate("45/13/2026")).toBeNull();
    expect(parseUgandaDate("not-a-date")).toBeNull();
    expect(parseUgandaDate("")).toBeNull();
  });
});

describe("mapUgandaRow — rail file mapping", () => {
  it("maps an MTN MoMo credit with UGX default", () => {
    const r = mapUgandaRow(UGANDA_SOURCES.mtn_momo, {
      "Transaction ID": "MP240712.1234.A00001",
      MSISDN: "256772000000",
      Amount: "150000",
      Type: "CASH_IN",
      "Transaction Date": "12/07/2026 14:30",
      Narration: "Deposit",
    });
    expect(r.ok).toBe(true);
    expect(r.value!.externalRef).toBe("ug:mtn_momo:MP240712.1234.A00001");
    expect(r.value!.debitCredit).toBe("credit");
    expect(r.value!.currency).toBe("UGX");
    expect(r.value!.amount).toBe("150000.00");
    expect(r.value!.transactionDate.toISOString()).toBe("2026-07-12T14:30:00.000Z");
  });

  it("maps a split-ledger CBS/trust row (dd/mm/yyyy date)", () => {
    const r = mapUgandaRow(UGANDA_SOURCES.trust_account, {
      "Trust Account No": "01100XXXX",
      Reference: "TRN-9001",
      "Transaction Date": "12/07/2026",
      "Debit (UGX)": "",
      "Credit (UGX)": "5,000,000",
      Narration: "Wallet funding",
    });
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe("credit");
    expect(r.value!.amount).toBe("5000000.00");
  });

  it("maps an ABC shared-agent-rail cash-out as a debit", () => {
    const r = mapUgandaRow(UGANDA_SOURCES.abc_agent_rail, {
      "Agent ID": "AG-7781",
      "Agent Name": "Kampala Central Agent",
      Reference: "ABC-55221",
      "Transaction Date": "12/07/2026",
      Amount: "80000",
      Type: "CASH-OUT",
    });
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe("debit");
    expect(r.value!.externalRef).toBe("ug:abc_agent_rail:AG-7781:ABC-55221");
  });

  it("flags a row missing its identity", () => {
    const r = mapUgandaRow(UGANDA_SOURCES.mtn_momo, { Amount: "1000", Type: "CASH_IN", "Transaction Date": "12/07/2026" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/identity/);
  });

  it("flags an undeterminable direction", () => {
    const r = mapUgandaRow(UGANDA_SOURCES.mtn_momo, {
      "Transaction ID": "X1", MSISDN: "256700", Amount: "1000", Type: "SIDEWAYS", "Transaction Date": "12/07/2026",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/debit\/credit/);
  });
});

describe("Uganda round-2 rails + categories", () => {
  it("registers the 3 round-2 rails (digital lending, bill/utility, aggregator)", () => {
    for (const k of ["digital_lending", "bill_utility", "aggregator_switch"] as const) {
      expect(UGANDA_SOURCES[k], k).toBeDefined();
    }
  });

  it("maps a MoKash disbursement (credit to wallet) on the digital-lending rail", () => {
    const r = mapUgandaRow(UGANDA_SOURCES.digital_lending, {
      "Loan ID": "MK-778812",
      MSISDN: "256772000000",
      Amount: "250000",
      Type: "DISBURSEMENT",
      "Transaction Date": "12/07/2026",
      "Loan Status": "ACTIVE",
    });
    expect(r.ok).toBe(true);
    expect(r.value!.externalRef).toBe("ug:digital_lending:MK-778812");
    expect(r.value!.debitCredit).toBe("credit");
  });

  it("maps a Yaka bill payment (debit) with a token reference", () => {
    const r = mapUgandaRow(UGANDA_SOURCES.bill_utility, {
      "Payment Ref": "YK-99001",
      "Biller Code": "UMEME",
      "Meter Number": "01234567890",
      Amount: "50000",
      Type: "PAYMENT",
      "Transaction Date": "12/07/2026 09:15",
    });
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe("debit");
    expect(r.value!.counterparty).toBe("UMEME");
  });

  it("covers the round-2 exception surfaces", () => {
    const keys = new Set(UGANDA_EXCEPTION_KEYS);
    for (const k of [
      "ug_bill_payment_no_token", "ug_airtime_data_not_delivered",
      "ug_digital_loan_disbursement_mismatch", "ug_digital_loan_repayment_unapplied",
      "ug_dormant_wallet_balance", "ug_duplicate_wallet_credit", "ug_orphan_reversal",
      "ug_aggregator_settlement_variance", "ug_agent_commission_variance", "ug_fx_settlement_variance",
    ]) {
      expect(keys.has(k), k).toBe(true);
    }
  });
});

describe("Uganda taxonomy — integrity + moat wiring", () => {
  it("defines the full BoU-framework catalogue (12 round-1 + 10 round-2)", () => {
    expect(UGANDA_EXCEPTIONS).toHaveLength(22);
    for (const e of UGANDA_EXCEPTIONS) {
      expect(e.regulatoryContext.length, `${e.key} context`).toBeGreaterThan(40);
      expect(e.recommendedResolution.length, `${e.key} resolution`).toBeGreaterThan(40);
      expect(e.aiDiagnosisHint.length, `${e.key} hint`).toBeGreaterThan(40);
      expect(e.slaHours).toBeGreaterThan(0);
    }
  });

  it("the licence-critical classes are critical + same-day SLA", () => {
    for (const key of ["ug_trust_account_mismatch", "ug_suspense_aged_entry", "ug_momo_debit_no_credit"]) {
      const e = ugandaExceptionFor(key)!;
      expect(e.severity).toBe("critical");
      expect(e.slaHours).toBeLessThanOrEqual(24);
    }
  });

  it("every key is a valid resolution_templates.category (seeding cannot fail)", () => {
    const enumSet = new Set<string>(RESOLUTION_TEMPLATE_CATEGORIES as readonly string[]);
    const missing = UGANDA_EXCEPTION_KEYS.filter((k) => !enumSet.has(k));
    expect(missing, `absent from enum: ${missing.join(", ")}`).toEqual([]);
  });

  it("every key resolves through the cross-market EXCEPTION_REGISTRY + ALL_EXCEPTIONS", () => {
    const all = new Set(ALL_EXCEPTIONS.map((e) => e.key));
    for (const e of UGANDA_EXCEPTIONS) {
      expect(EXCEPTION_REGISTRY.get(e.key), `registry missing ${e.key}`).toBeDefined();
      expect(all.has(e.key)).toBe(true);
    }
    // did not collide with Nigerian/retail keys
    expect(all.has("nip_timeout_debit_no_credit")).toBe(true);
    expect(all.has("retail_chargeback_not_posted")).toBe(true);
  });

  it("the AI prompt block lists every Uganda category", () => {
    const block = ugandaExceptionsTaxonomyPromptBlock();
    for (const e of UGANDA_EXCEPTIONS) expect(block).toContain(e.key);
    expect(block.split("\n")).toHaveLength(UGANDA_EXCEPTIONS.length);
  });

  it("provisioning iterates every rail (round-1 + round-2 = 11)", () => {
    expect(UGANDA_SOURCE_KEYS).toHaveLength(11);
  });
});
