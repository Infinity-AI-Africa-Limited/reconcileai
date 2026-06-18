import { describe, it, expect } from "vitest";
import { runLayer1, runLayer2, runLayer3, type CanonicalRow } from "./poc-engine";

const ledger: CanonicalRow[] = [
  { date: "2026-01-10", description: "Payment A", amount: 5000, direction: "debit", reference: "REF-1" },
  { date: "2026-01-11", description: "Cheque 22", amount: 200000, direction: "debit", reference: "REF-2" },
];
const statement: CanonicalRow[] = [
  { date: "2026-01-10", description: "Payment A", amount: 5000, direction: "debit", reference: "REF-1" },
  { date: "2026-01-12", description: "Bank charge", amount: 1500, direction: "debit", reference: "CHG-9" },
];

describe("POC Layer 1 — balance", () => {
  it("detects a net variance between ledger and statement", () => {
    const l1 = runLayer1(ledger, statement, "NGN");
    expect(l1.ledgerCount).toBe(2);
    expect(l1.statementCount).toBe(2);
    expect(l1.ledgerNet).toBe(-205000); // both debits
    expect(l1.statementNet).toBe(-6500);
    expect(l1.varianceAmount).toBe(-198500);
    expect(l1.status).toBe("VARIANCE_DETECTED");
  });

  it("reports BALANCED when the nets agree", () => {
    const same = runLayer1(ledger, ledger, "NGN");
    expect(same.varianceAmount).toBe(0);
    expect(same.status).toBe("BALANCED");
  });
});

describe("POC Layer 2 — exceptions", () => {
  it("matches the common item and flags the unmatched ones on each side", () => {
    const l2 = runLayer2(ledger, statement);
    expect(l2.matchedCount).toBe(1); // REF-1 matches
    const cats = l2.exceptions.map((e) => e.category).sort();
    expect(cats).toEqual(["IN_BANK_NOT_IN_LEDGER", "IN_LEDGER_NOT_IN_BANK"]);

    const ledgerOnly = l2.exceptions.find((e) => e.category === "IN_LEDGER_NOT_IN_BANK");
    expect(ledgerOnly?.reference).toBe("REF-2");
    expect(ledgerOnly?.amount).toBe(200000);

    const bankOnly = l2.exceptions.find((e) => e.category === "IN_BANK_NOT_IN_LEDGER");
    expect(bankOnly?.reference).toBe("CHG-9");
    expect(bankOnly?.amount).toBe(1500);
  });
});

describe("POC Layer 3 — AI agent", () => {
  it("assigns priority by amount and attaches an explanation + action", () => {
    const l2 = runLayer2(ledger, statement);
    const l3 = runLayer3(l2.exceptions);
    const high = l3.find((e) => e.reference === "REF-2");
    const low = l3.find((e) => e.reference === "CHG-9");
    expect(high?.priorityLevel).toBe("HIGH"); // 200,000
    expect(low?.priorityLevel).toBe("LOW"); // 1,500
    for (const e of l3) {
      expect(e.agentExplanation.length).toBeGreaterThan(0);
      expect(e.recommendedAction.length).toBeGreaterThan(0);
      expect(e.agentConfidence).toBeGreaterThan(0);
    }
  });
});
