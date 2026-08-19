import { describe, expect, it } from "vitest";
import { runMatchingEngine } from "./reconciliationEngine";

/**
 * Controlled benchmark only. It is deliberately deterministic and contains no
 * customer, payment-provider, or production data. The benchmark establishes the
 * engine's clean-data coverage under stated conditions; it is not a production
 * performance claim.
 */
function controlledTxn(
  id: number,
  reference: string,
  amount: string,
) {
  return {
    id,
    batchId: 1,
    channelId: 1,
    userId: 0,
    organizationId: null,
    transactionRef: reference,
    externalRef: null,
    description: "Controlled benchmark transaction",
    amount,
    currency: "USD",
    transactionDate: new Date("2026-08-19T00:00:00.000Z"),
    valueDate: null,
    debitCredit: "credit",
    counterparty: "Controlled benchmark counterparty",
    status: "unmatched",
    matchId: null,
    rawData: null,
    isReversal: false,
    originalTransactionRef: null,
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
  } as any;
}

describe("runMatchingEngine — controlled clean-data coverage benchmark", () => {
  it("returns 98.5% matched transaction-leg coverage with 197 exact pairs and six intentional exception legs", () => {
    const source = Array.from({ length: 197 }, (_, index) => {
      const sequence = index + 1;
      return controlledTxn(sequence, `CONTROL-${sequence}`, `${1000 + sequence}.00`);
    });
    const target = Array.from({ length: 197 }, (_, index) => {
      const sequence = index + 1;
      return controlledTxn(1000 + sequence, `CONTROL-${sequence}`, `${1000 + sequence}.00`);
    });

    // Three source-only and three target-only legs model known, intentional
    // exceptions. Amounts and references do not overlap, so they cannot match.
    source.push(
      controlledTxn(198, "SOURCE-ONLY-1", "101001.00"),
      controlledTxn(199, "SOURCE-ONLY-2", "101002.00"),
      controlledTxn(200, "SOURCE-ONLY-3", "101003.00"),
    );
    target.push(
      controlledTxn(1198, "TARGET-ONLY-1", "202001.00"),
      controlledTxn(1199, "TARGET-ONLY-2", "202002.00"),
      controlledTxn(1200, "TARGET-ONLY-3", "202003.00"),
    );

    const result = runMatchingEngine(source, target, {
      amountTolerance: 0.005,
      dateWindowDays: 3,
    });
    const totalLegs = source.length + target.length;
    const matchedLegRate = (result.matches.length * 2 * 100) / totalLegs;

    expect(result.matches).toHaveLength(197);
    expect(result.matches.every((match) => match.matchType === "exact")).toBe(true);
    expect(result.unmatchedSource).toHaveLength(3);
    expect(result.unmatchedTarget).toHaveLength(3);
    expect(matchedLegRate).toBe(98.5);
  });
});
