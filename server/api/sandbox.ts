/**
 * Developer sandbox (gap-closure plan WS-4, Phase 3).
 *
 * Keyless, self-service, zero-setup: POST /api/v1/sandbox/reconciliation/runs
 * executes the REAL matching engine + exception categorizer on a deterministic
 * synthetic dataset and returns the results synchronously — a developer's
 * first successful call happens in minutes, no signup, no DB writes.
 *
 * The dataset is deterministic on purpose: the Getting Started guide shows the
 * exact expected output, and repeated calls return identical results. It
 * exercises the interesting paths — exact matches, an amount mismatch (fee),
 * a timing difference, a duplicate, an unmatched leg, and a cross-currency
 * FX pair (fx_rate_variance).
 */
import {
  runMatchingEngine,
  categorizeException,
} from "../reconciliationEngine";
import type { Transaction } from "../../drizzle/schema";

const CONFIG = { amountTolerance: 0.005, dateWindowDays: 3 };

function txn(overrides: Partial<Transaction> & { id: number; amount: string }): Transaction {
  return {
    batchId: 1,
    channelId: 1,
    userId: 0,
    organizationId: null,
    transactionRef: null,
    externalRef: null,
    description: null,
    currency: "NGN",
    transactionDate: new Date("2026-06-15T00:00:00Z"),
    valueDate: null,
    debitCredit: "credit",
    counterparty: "Sandbox Counterparty",
    isReversal: false,
    originalTransactionRef: null,
    status: "unmatched",
    matchId: null,
    rawData: null,
    createdAt: new Date("2026-06-15T00:00:00Z"),
    ...overrides,
  } as Transaction;
}

// Source = internal ledger; target = processor settlement.
function buildDataset() {
  const source: Transaction[] = [
    txn({ id: 1, transactionRef: "NIP/A0001", amount: "250000.00", description: "Customer transfer" }),
    txn({ id: 2, transactionRef: "NIP/A0002", amount: "78500.00", description: "POS settlement" }),
    txn({ id: 3, transactionRef: "NIP/A0003", amount: "1200000.00", description: "Corporate inflow" }),
    // Amount mismatch: fee-deducted on the settlement side (0.4% inside tolerance band edge)
    txn({ id: 4, transactionRef: "NIP/A0004", amount: "50000.00", description: "Transfer with fee" }),
    // Timing difference: settles 5 days later on the target side
    txn({ id: 5, transactionRef: "NIP/A0005", amount: "94000.00", description: "Weekend settlement", transactionDate: new Date("2026-06-12T00:00:00Z") }),
    // Unmatched: exists only in the ledger
    txn({ id: 6, transactionRef: "NIP/A0006", amount: "15750.00", description: "Missing at processor" }),
    // FX pair: USD leg of a correspondent settlement (same ref, different currency)
    txn({ id: 7, transactionRef: "FX/B0001", amount: "1000.00", currency: "USD", description: "Correspondent settlement USD leg" }),
  ];
  const target: Transaction[] = [
    txn({ id: 101, transactionRef: "NIP/A0001", amount: "250000.00", description: "Customer transfer" }),
    txn({ id: 102, transactionRef: "NIP/A0002", amount: "78500.00", description: "POS settlement" }),
    txn({ id: 103, transactionRef: "NIP/A0003", amount: "1200000.00", description: "Corporate inflow" }),
    txn({ id: 104, transactionRef: "NIP/A0004", amount: "49800.00", description: "Transfer with fee deducted" }),
    txn({ id: 105, transactionRef: "NIP/A0005", amount: "94000.00", description: "Weekend settlement", transactionDate: new Date("2026-06-17T00:00:00Z") }),
    // Duplicate pair on the settlement side
    txn({ id: 106, transactionRef: "DUP/C0001", amount: "20000.00", description: "Duplicate posting" }),
    txn({ id: 107, transactionRef: "DUP/C0001", amount: "20000.00", description: "Duplicate posting" }),
    // NGN leg of the FX pair — implied rate 1,520 NGN/USD
    txn({ id: 108, transactionRef: "FX/B0001", amount: "1520000.00", currency: "NGN", description: "Correspondent settlement NGN leg" }),
  ];
  return { source, target };
}

export function runSandboxReconciliation() {
  const { source, target } = buildDataset();
  const result = runMatchingEngine(source, target, CONFIG);

  const byId = new Map<number, Transaction>([...source, ...target].map((t) => [t.id, t]));
  const unmatched = [...result.unmatchedSource, ...result.unmatchedTarget]
    .map((id) => byId.get(id))
    .filter((t): t is Transaction => !!t);

  const exceptions = unmatched.map((t, i) => {
    const info = categorizeException(t, t.id < 100 ? target : source, CONFIG);
    return {
      id: i + 1,
      reference: t.transactionRef,
      amount: parseFloat(String(t.amount)),
      currency: t.currency,
      category: info.category,
      severity: info.severity,
      description: info.description,
      suggestedResolution: info.suggestedResolution,
      status: "open" as const,
    };
  });

  return {
    runId: 0,
    sandbox: true as const,
    status: "completed" as const,
    module: "settlement" as const,
    currency: "NGN",
    stats: {
      sourceCount: source.length,
      targetCount: target.length,
      matchedPairs: result.matches.length,
      duplicatesDetected: result.stats.duplicatesDetected,
      exceptionCount: exceptions.length,
      matchRate:
        Math.round(
          ((result.matches.length * 2) / (source.length + target.length)) * 10000,
        ) / 100,
    },
    matches: result.matches.map((m) => ({
      sourceRef: byId.get(m.sourceId)?.transactionRef ?? null,
      targetRef: byId.get(m.targetId)?.transactionRef ?? null,
      matchType: m.matchType,
      confidenceScore: m.confidenceScore,
      amountDifference: m.amountDifference,
      dateDifferenceDays: m.dateDifference,
    })),
    exceptions,
    _next:
      "This ran ReconcileAI's real matching engine on synthetic data. " +
      "Get an API key from your dashboard (Admin → API Keys) and call the same endpoints without /sandbox against your own channels.",
  };
}
