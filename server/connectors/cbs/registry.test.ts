/**
 * Multi-CBS profile tests: T24, Mambu and FLEXCUBE payloads (API + CSV) map to
 * the canonical model through the same engine that runs WoodCore in production.
 */
import { describe, expect, it } from "vitest";
import { applyMapping } from "../woodcore/mapping";
import { mapCsvRows, parseCsvRows } from "./csvImport";
import { CBS_PROFILES, CBS_TYPES, getCbsProfile, listCbsProfiles } from "./registry";

describe("registry shape", () => {
  it("every CBS profile is complete for all three entities (API + CSV)", () => {
    for (const t of CBS_TYPES) {
      const p = CBS_PROFILES[t];
      for (const entity of ["savings_transaction", "loan_transaction", "journal_entry"] as const) {
        expect(p.apiMappings[entity].length, `${t}/${entity} api`).toBeGreaterThan(4);
        expect(p.csvMappings[entity].length, `${t}/${entity} csv`).toBeGreaterThan(4);
        // Non-woodcore profiles must define debitCredit explicitly (no enum tables).
        if (t !== "woodcore") {
          expect(
            p.apiMappings[entity].some((r) => r.target === "debitCredit"),
            `${t}/${entity} needs a debitCredit rule`,
          ).toBe(true);
        }
      }
      expect(p.onboardingChannel).toBe(t);
    }
  });

  it("getCbsProfile falls back to woodcore for unknown/legacy values", () => {
    expect(getCbsProfile("t24").label).toBe("Temenos T24");
    expect(getCbsProfile("nonsense").type).toBe("woodcore");
    expect(getCbsProfile(null).type).toBe("woodcore");
  });

  it("CBS picker shows the four vendor platforms; LAPO is hidden (direct-onboarded)", () => {
    const shown = listCbsProfiles().map((p) => p.type);
    expect(shown).toEqual(["woodcore", "t24", "mambu", "flexcube"]);
    expect(shown).not.toContain("lapo");
    // …but the LAPO profile still resolves from the registry (plumbing intact).
    expect(getCbsProfile("lapo").type).toBe("lapo");
    expect(CBS_PROFILES.lapo.pickerHidden).toBe(true);
  });
});

describe("T24 (IRIS-shaped) API mapping", () => {
  const t24 = CBS_PROFILES.t24;

  it("maps a credit account transaction", () => {
    const r = applyMapping(
      "savings_transaction",
      {
        transactionId: "FT24001ABC",
        transactionName: "Funds Transfer",
        amount: "150000.00",
        currency: "NGN",
        creditDebitIndicator: "CREDIT",
        bookingDate: "2026-07-01",
        valueDate: "2026-07-02",
        transactionReference: "FT-778",
        accountId: "10001234",
        narrative: "Inward NIP transfer",
      },
      null,
      t24.apiMappings.savings_transaction,
    );
    expect(r.ok).toBe(true);
    expect(r.value!.externalRef).toBe("wc:savings:FT24001ABC");
    expect(r.value!.debitCredit).toBe("credit");
    expect(r.value!.sourceType).toBe("Funds Transfer");
    expect(r.value!.transactionDate.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("maps DR/DEBIT indicator variants to debit", () => {
    for (const word of ["DEBIT", "DR", "D", "debit"]) {
      const r = applyMapping(
        "loan_transaction",
        { transactionId: `L-${word}`, activityName: "Disburse", amount: 5, currency: "NGN", creditDebitIndicator: word, bookingDate: "2026-07-01" },
        null,
        t24.apiMappings.loan_transaction,
      );
      expect(r.ok).toBe(true);
      expect(r.value!.debitCredit).toBe("debit");
    }
  });

  it("fails cleanly on an unknown direction word", () => {
    const r = applyMapping(
      "savings_transaction",
      { transactionId: "X1", amount: 5, currency: "NGN", creditDebitIndicator: "SIDEWAYS", bookingDate: "2026-07-01" },
      null,
      t24.apiMappings.savings_transaction,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/debitCredit/);
  });
});

describe("Mambu (v2-shaped) API mapping", () => {
  const mambu = CBS_PROFILES.mambu;

  it.each([
    ["DEPOSIT", "credit"],
    ["WITHDRAWAL", "debit"],
    ["INTEREST_APPLIED", "credit"],
    ["FEE_APPLIED", "debit"],
    ["TRANSFER_OUT", "debit"],
    ["TRANSFER_IN", "credit"],
  ] as const)("deposit txn type %s → %s", (type, direction) => {
    const r = applyMapping(
      "savings_transaction",
      {
        encodedKey: `8a8e-${type}`,
        type,
        amount: 2500.75,
        currencyCode: "NGN",
        valueDate: "2026-07-03T10:15:00Z",
        creationDate: "2026-07-03T10:15:01Z",
        id: "1234",
        parentAccountKey: "acct-9",
      },
      null,
      mambu.apiMappings.savings_transaction,
    );
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe(direction);
    expect(r.value!.sourceType).toBe(type);
  });

  it.each([
    ["DISBURSEMENT", "debit"],
    ["REPAYMENT", "credit"],
    ["PENALTY_APPLIED", "debit"],
  ] as const)("loan txn type %s → %s", (type, direction) => {
    const r = applyMapping(
      "loan_transaction",
      { encodedKey: `L-${type}`, type, amount: 100, currencyCode: "NGN", valueDate: "2026-07-03", id: "9" },
      null,
      mambu.apiMappings.loan_transaction,
    );
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe(direction);
  });

  it("adjustmentTransactionKey presence marks a reversal", () => {
    const base = { encodedKey: "k1", type: "DEPOSIT", amount: 10, currencyCode: "NGN", valueDate: "2026-07-03", id: "1" };
    const normal = applyMapping("savings_transaction", base, null, mambu.apiMappings.savings_transaction);
    const reversed = applyMapping(
      "savings_transaction",
      { ...base, encodedKey: "k2", adjustmentTransactionKey: "8a8e-adj-1" },
      null,
      mambu.apiMappings.savings_transaction,
    );
    expect(normal.value!.isReversal).toBe(false);
    expect(reversed.value!.isReversal).toBe(true);
  });

  it("maps a GL journal entry with DEBIT/CREDIT entry type", () => {
    const r = applyMapping(
      "journal_entry",
      { entryId: 42, type: "CREDIT", amount: 999, bookingDate: "2026-07-01", transactionId: "J-1", glAccount: { glCode: "2100", currency: { code: "NGN" } } },
      null,
      mambu.apiMappings.journal_entry,
    );
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe("credit");
    expect(r.value!.counterparty).toBe("2100");
    expect(r.value!.currency).toBe("NGN");
  });
});

describe("FLEXCUBE (FCUBS-shaped) mapping", () => {
  const fc = CBS_PROFILES.flexcube;

  it("maps a D/C indicator row from the API shape", () => {
    const r = applyMapping(
      "savings_transaction",
      { acEntrySrNo: 991, trnCode: "CHQ", drcrInd: "D", lcyAmount: "20000", acCcy: "NGN", trnDt: "2026-06-30", trnRefNo: "FC-77", acNo: "0011223344" },
      null,
      fc.apiMappings.savings_transaction,
    );
    expect(r.ok).toBe(true);
    expect(r.value!.externalRef).toBe("wc:savings:991");
    expect(r.value!.debitCredit).toBe("debit");
    expect(r.value!.transactionRef).toBe("FC-77");
  });
});

describe("CSV fallback import (pure pipeline)", () => {
  it("parses and maps a FLEXCUBE-style CSV export", () => {
    const csv = [
      "AC_ENTRY_SR_NO,TRN_CODE,DRCR_IND,LCY_AMOUNT,AC_CCY,TRN_DT,TRN_REF_NO,AC_NO",
      "1001,DEP,C,50000.00,NGN,2026-07-01,FCR-1,0011",
      "1002,WDL,D,15000.00,NGN,2026-07-01,FCR-2,0011",
      "1003,DEP,C,not-a-number,NGN,2026-07-01,FCR-3,0022",
    ].join("\n");

    const { rows, parseErrors } = parseCsvRows(csv);
    expect(parseErrors).toEqual([]);
    expect(rows).toHaveLength(3);

    const { mapped, failures } = mapCsvRows("flexcube", "savings_transaction", rows);
    expect(mapped).toHaveLength(2);
    expect(failures).toHaveLength(1);
    expect(failures[0].rowIndex).toBe(4); // header + 1-based
    expect(mapped[0].externalRef).toBe("wc:savings:1001");
    expect(mapped[0].debitCredit).toBe("credit");
    expect(mapped[1].debitCredit).toBe("debit");
  });

  it("maps a T24-style CSV with dotted column names (flat keys beat dot-paths)", () => {
    const csv = [
      "TRANS.ID,TXN.TYPE,AMOUNT,CURRENCY,DR.CR.MARKER,BOOKING.DATE,TRANS.REFERENCE,ACCOUNT.NO,NARRATIVE",
      "FT001,TRANSFER,1000,NGN,CR,2026-07-02,REF1,ACC1,inward",
    ].join("\n");
    const { rows } = parseCsvRows(csv);
    const { mapped, failures } = mapCsvRows("t24", "savings_transaction", rows);
    expect(failures).toEqual([]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].externalRef).toBe("wc:savings:FT001");
    expect(mapped[0].debitCredit).toBe("credit");
    expect(mapped[0].sourceType).toBe("TRANSFER");
    expect(mapped[0].transactionDate.toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });

  it("maps a Mambu-style CSV with spaced column names", () => {
    const csv = [
      "Transaction ID,Type,Amount,Currency,Value Date,Account ID,Notes",
      "TX-1,DEPOSIT,200.50,NGN,2026-07-04,ACC-77,cash in",
      "TX-2,WITHDRAWAL,80.25,NGN,2026-07-04,ACC-77,cash out",
      "TX-1,DEPOSIT,200.50,NGN,2026-07-04,ACC-77,duplicate row",
    ].join("\n");
    const { rows } = parseCsvRows(csv);
    const { mapped, failures } = mapCsvRows("mambu", "savings_transaction", rows);
    expect(failures).toEqual([]);
    expect(mapped).toHaveLength(3); // in-file duplicate refs are dropped at ingest, not mapping
    expect(mapped[0].externalRef).toBe("wc:savings:TX-1");
    expect(mapped[0].debitCredit).toBe("credit");
    expect(mapped[1].debitCredit).toBe("debit");
    expect(new Set(mapped.map((m) => m.externalRef)).size).toBe(2);
  });
});
