/**
 * Field-mapping layer tests: 20 WoodCore transaction types → canonical model.
 * (11 savings + 7 loan + 2 GL entry types.)
 */
import { describe, expect, it } from "vitest";
import {
  applyMapping,
  externalRefFor,
  getByPath,
  mergeRules,
  parseWcDate,
  validateRules,
  type MappingRule,
} from "./mapping";

// ─── Payload factories (Fineract-shaped, per live-tenant observation) ────────
function savingsTxn(typeId: number, typeName: string, over: Record<string, unknown> = {}) {
  return {
    id: 9000 + typeId,
    transactionType: { id: typeId, value: typeName },
    accountNo: "000012345",
    amount: 25000.5,
    currency: { code: "NGN" },
    date: [2026, 7, 4],
    submittedOnDate: [2026, 7, 4],
    receiptNumber: `RCPT-${typeId}`,
    reversed: false,
    ...over,
  };
}

function loanTxn(typeId: number, typeName: string, over: Record<string, unknown> = {}) {
  return {
    id: 7000 + typeId,
    type: { id: typeId, value: typeName },
    loanAccountNo: "LN-889",
    amount: 150000,
    currency: { code: "NGN" },
    date: [2026, 6, 30],
    manuallyReversed: false,
    ...over,
  };
}

function glEntry(entryTypeId: number, over: Record<string, unknown> = {}) {
  return {
    id: 555000 + entryTypeId,
    entryType: { id: entryTypeId, value: entryTypeId === 1 ? "DEBIT" : "CREDIT" },
    amount: 98765.43,
    currencyCode: "NGN",
    transactionDate: "2026-07-01",
    transactionId: "TXN-GL-42",
    glAccountCode: "1100-CASH",
    comments: "Daily posting",
    reversed: false,
    ...over,
  };
}

describe("WoodCore mapping — savings transaction types", () => {
  const cases: Array<[number, string, "debit" | "credit"]> = [
    [1, "Deposit", "credit"],
    [2, "Withdrawal", "debit"],
    [3, "Interest Posting", "credit"],
    [4, "Withdrawal Fee", "debit"],
    [5, "Annual Fee", "debit"],
    [7, "Pay Charge", "debit"],
    [8, "Dividend Payout", "credit"],
    [12, "Initiate Transfer", "debit"],
    [16, "Written-Off", "debit"],
    [17, "Overdraft Interest", "debit"],
    [19, "Withhold Tax", "debit"],
  ];

  it.each(cases)("type %i (%s) maps with direction %s", (typeId, typeName, direction) => {
    const r = applyMapping("savings_transaction", savingsTxn(typeId, typeName));
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe(direction);
    expect(r.value!.sourceType).toBe(typeName);
    expect(r.value!.externalRef).toBe(`wc:savings:${9000 + typeId}`);
    expect(r.value!.amount).toBe("25000.50");
    expect(r.value!.currency).toBe("NGN");
    expect(r.value!.transactionDate.toISOString()).toBe("2026-07-04T00:00:00.000Z");
    expect(r.value!.isReversal).toBe(false);
  });
});

describe("WoodCore mapping — loan transaction types", () => {
  const cases: Array<[number, string, "debit" | "credit"]> = [
    [1, "Disbursement", "debit"],
    [2, "Repayment", "credit"],
    [4, "Waive Interest", "credit"],
    [6, "Write-Off", "credit"],
    [8, "Recovery Repayment", "credit"],
    [10, "Accrual", "debit"],
    [16, "Refund", "credit"],
  ];

  it.each(cases)("type %i (%s) maps with direction %s", (typeId, typeName, direction) => {
    const r = applyMapping("loan_transaction", loanTxn(typeId, typeName));
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe(direction);
    expect(r.value!.externalRef).toBe(`wc:loan:${7000 + typeId}`);
    expect(r.value!.counterparty).toBe("LN-889");
  });
});

describe("WoodCore mapping — GL journal entry types", () => {
  it("entry type 1 → debit", () => {
    const r = applyMapping("journal_entry", glEntry(1));
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe("debit");
    expect(r.value!.sourceType).toBe("DEBIT");
    expect(r.value!.transactionRef).toBe("TXN-GL-42");
    expect(r.value!.counterparty).toBe("1100-CASH");
  });

  it("entry type 2 → credit", () => {
    const r = applyMapping("journal_entry", glEntry(2));
    expect(r.ok).toBe(true);
    expect(r.value!.debitCredit).toBe("credit");
  });
});

describe("mapping edge cases", () => {
  it("reversal flag carries through", () => {
    const r = applyMapping("savings_transaction", savingsTxn(2, "Withdrawal", { reversed: true }));
    expect(r.ok).toBe(true);
    expect(r.value!.isReversal).toBe(true);
  });

  it("negative amounts are normalized to absolute values", () => {
    const r = applyMapping("savings_transaction", savingsTxn(2, "Withdrawal", { amount: -5000 }));
    expect(r.ok).toBe(true);
    expect(r.value!.amount).toBe("5000.00");
  });

  it("missing amount fails with a clear error", () => {
    const r = applyMapping("savings_transaction", savingsTxn(1, "Deposit", { amount: null }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/amount/);
  });

  it("missing id fails with a clear error", () => {
    const r = applyMapping("savings_transaction", savingsTxn(1, "Deposit", { id: null }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/externalId/);
  });

  it("unknown type enum cannot derive direction and says how to fix it", () => {
    const r = applyMapping("savings_transaction", savingsTxn(99, "Mystery"));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/debitCredit/);
  });

  it("unmapped currency defaults to NGN", () => {
    const r = applyMapping("savings_transaction", savingsTxn(1, "Deposit", { currency: undefined }));
    expect(r.ok).toBe(true);
    expect(r.value!.currency).toBe("NGN");
  });

  it("raw payload is preserved for the audit trail", () => {
    const payload = savingsTxn(1, "Deposit");
    const r = applyMapping("savings_transaction", payload);
    expect(r.value!.raw).toBe(payload);
  });
});

describe("parseWcDate — Fineract date formats", () => {
  it("array form [y,m,d] → UTC midnight", () => {
    expect(parseWcDate([2026, 1, 15])!.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
  it("string form yyyy-MM-dd → UTC midnight", () => {
    expect(parseWcDate("2026-01-15")!.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
  it("epoch millis pass through", () => {
    const ms = Date.UTC(2026, 0, 15, 10, 30);
    expect(parseWcDate(ms)!.getTime()).toBe(ms);
  });
  it("garbage returns null", () => {
    expect(parseWcDate("not-a-date")).toBeNull();
    expect(parseWcDate({})).toBeNull();
    expect(parseWcDate(null)).toBeNull();
  });
});

describe("override rules", () => {
  it("override replaces the default rule for the same target only", () => {
    const overrides: MappingRule[] = [
      { target: "description", source: "narration", transform: "string" },
    ];
    const r = applyMapping(
      "savings_transaction",
      savingsTxn(1, "Deposit", { narration: "POS purchase reversal narration" }),
      overrides,
    );
    expect(r.ok).toBe(true);
    expect(r.value!.description).toBe("POS purchase reversal narration");
    // untouched defaults still apply
    expect(r.value!.amount).toBe("25000.50");
  });

  it("mergeRules keeps defaults for targets not overridden", () => {
    const merged = mergeRules(
      [
        { target: "amount", source: "amount", transform: "absAmount" },
        { target: "currency", source: "currency.code" },
      ],
      [{ target: "currency", source: "ccy" }],
    );
    expect(merged.find((r) => r.target === "currency")!.source).toBe("ccy");
    expect(merged.find((r) => r.target === "amount")!.source).toBe("amount");
  });

  it("validateRules rejects bad targets, sources and transforms", () => {
    const bad = validateRules([
      { target: "nonsense", source: "x" },
      { target: "amount", source: "" },
      { target: "amount", source: "a", transform: "evalCode" },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.errors).toHaveLength(3);
  });

  it("validateRules accepts a correct rule set", () => {
    const good = validateRules([
      { target: "amount", source: "txn.amount", transform: "absAmount" },
      { target: "transactionDate", source: "txn.postedAt", transform: "wcDate" },
    ]);
    expect(good.ok).toBe(true);
  });
});

describe("helpers", () => {
  it("getByPath walks nested objects and tolerates gaps", () => {
    expect(getByPath({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
    expect(getByPath({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(getByPath(null, "a")).toBeUndefined();
  });

  it("externalRefFor namespaces by entity", () => {
    expect(externalRefFor("savings_transaction", "1")).toBe("wc:savings:1");
    expect(externalRefFor("loan_transaction", "1")).toBe("wc:loan:1");
    expect(externalRefFor("journal_entry", "1")).toBe("wc:gl:1");
  });
});
