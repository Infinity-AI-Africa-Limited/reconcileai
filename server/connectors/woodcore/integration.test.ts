/**
 * End-to-end integration test: a real in-process HTTP server simulates the
 * WoodCore API (OAuth2 token endpoint + paginated Fineract-style transaction
 * endpoints + transient failures), and the full pipeline runs against it:
 *
 *   WoodcoreClient (OAuth2 session) → pagination → field mapping → canonical
 *
 * 15+ transaction types flow through in one sweep. No mocked fetch — this uses
 * the real global fetch over a real socket, exactly as production would.
 */
import http from "http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearTokenCacheForTests } from "./auth";
import { WoodcoreClient } from "./client";
import { applyMapping } from "./mapping";
import { DEFAULT_ENDPOINTS, type CanonicalTransaction, type WcConnection } from "./types";

// ─── The simulated WoodCore tenant ───────────────────────────────────────────
const SAVINGS_TYPES: Array<[number, string]> = [
  [1, "Deposit"], [2, "Withdrawal"], [3, "Interest Posting"], [4, "Withdrawal Fee"],
  [5, "Annual Fee"], [7, "Pay Charge"], [8, "Dividend Payout"], [12, "Initiate Transfer"],
  [16, "Written-Off"], [17, "Overdraft Interest"], [19, "Withhold Tax"],
];
const LOAN_TYPES: Array<[number, string]> = [
  [1, "Disbursement"], [2, "Repayment"], [4, "Waive Interest"], [6, "Write-Off"],
  [8, "Recovery Repayment"], [10, "Accrual"], [16, "Refund"],
];

const savingsRows = SAVINGS_TYPES.map(([id, value], i) => ({
  id: 10_000 + i,
  transactionType: { id, value },
  accountNo: `SAV-${i}`,
  amount: 1000 + i,
  currency: { code: "NGN" },
  date: [2026, 7, 1],
  receiptNumber: `R-${i}`,
  reversed: false,
}));

const loanRows = LOAN_TYPES.map(([id, value], i) => ({
  id: 20_000 + i,
  type: { id, value },
  loanAccountNo: `LN-${i}`,
  amount: 50_000 + i,
  currency: { code: "NGN" },
  date: [2026, 7, 2],
  manuallyReversed: i === 3, // one reversal in the mix
}));

const glRows = [1, 2].map((entryTypeId, i) => ({
  id: 30_000 + i,
  entryType: { id: entryTypeId, value: entryTypeId === 1 ? "DEBIT" : "CREDIT" },
  amount: 77_000 + i,
  currencyCode: "NGN",
  transactionDate: "2026-07-03",
  transactionId: `GL-${i}`,
  glAccountCode: "1100-CASH",
  reversed: false,
}));

let server: http.Server;
let baseUrl = "";
let tokenRequests = 0;
let savingsFlaky = 0; // first N savings requests fail with 503

function paged(rows: unknown[], url: URL) {
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  return { totalFilteredRecords: rows.length, pageItems: rows.slice(offset, offset + limit) };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.endsWith("/oauth/token")) {
      tokenRequests++;
      // Enforce that the client authenticates properly (Basic client creds)
      if (!req.headers.authorization?.startsWith("Basic ")) return send(401, { error: "no client auth" });
      return send(200, { access_token: `live-token-${tokenRequests}`, expires_in: 3600 });
    }

    // All API endpoints require the Bearer token + tenant header
    if (req.headers.authorization !== `Bearer live-token-${tokenRequests}`) {
      return send(401, { error: "bad token" });
    }
    if (req.headers["fineract-platform-tenantid"] !== "default") {
      return send(400, { error: "missing tenant" });
    }

    if (url.pathname.endsWith("/savingsaccounts/transactions/search")) {
      if (savingsFlaky > 0) {
        savingsFlaky--;
        return send(503, { error: "transient" });
      }
      return send(200, paged(savingsRows, url));
    }
    if (url.pathname.endsWith("/loans/transactions/search")) {
      return send(200, paged(loanRows, url));
    }
    if (url.pathname.endsWith("/journalentries")) {
      return send(200, paged(glRows, url));
    }
    if (url.pathname.endsWith("/offices")) {
      return send(200, [{ id: 1, name: "Head Office" }]);
    }
    return send(404, { error: `no route ${url.pathname}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function makeConn(): WcConnection {
  return {
    configId: 999_999,
    organizationId: 1,
    cbsType: "woodcore",
    baseUrl,
    tenantId: "default",
    authMode: "oauth2",
    oauthClientId: "reconcileai",
    oauthClientSecret: "s3cret",
    oauthTokenUrl: null,
    oauthScope: null,
    apiKey: null,
    apiKeyHeader: "x-api-key",
    basicUsername: null,
    basicPassword: null,
    pageSize: 4, // force multi-page pagination
    maxRetries: 3,
    requestTimeoutMs: 5000,
    endpoints: { ...DEFAULT_ENDPOINTS },
  };
}

describe("E2E: WoodCore mock tenant → client → mapping → canonical", () => {
  it("connectivity ping succeeds over a real socket with OAuth2", async () => {
    clearTokenCacheForTests();
    const client = new WoodcoreClient(makeConn());
    const ping = await client.ping();
    expect(ping.ok).toBe(true);
    expect(client.lastAuth?.modeUsed).toBe("oauth2");
  });

  it("syncs all three entities across pages, mapping every one of 20 types", async () => {
    clearTokenCacheForTests();
    savingsFlaky = 2; // exercise transient-retry on the way
    const client = new WoodcoreClient(makeConn(), { sleep: async () => {} });

    const canonical: CanonicalTransaction[] = [];
    const failures: string[] = [];

    const collect =
      (entity: "savings_transaction" | "loan_transaction" | "journal_entry") =>
      async (items: unknown[]) => {
        for (const item of items) {
          const r = applyMapping(entity, item);
          if (r.ok && r.value) canonical.push(r.value);
          else failures.push(r.errors.join("; "));
        }
      };

    const s = await client.fetchSavingsTransactions("2026-07-01", "2026-07-05", collect("savings_transaction"));
    const l = await client.fetchLoanTransactions("2026-07-01", "2026-07-05", collect("loan_transaction"));
    const g = await client.fetchJournalEntries("2026-07-01", "2026-07-05", collect("journal_entry"));

    // Every simulated row fetched (pagination complete, transient 503s absorbed)
    expect(s.total).toBe(savingsRows.length);
    expect(l.total).toBe(loanRows.length);
    expect(g.total).toBe(glRows.length);
    expect(s.pages).toBeGreaterThan(1); // pageSize 4 over 11 rows

    // Every row mapped — 11 + 7 + 2 = 20 transaction types, zero failures
    expect(failures).toEqual([]);
    expect(canonical).toHaveLength(20);

    // Spot-check semantics across the board
    const byRef = new Map(canonical.map((c) => [c.externalRef, c]));
    expect(byRef.get("wc:savings:10000")!.debitCredit).toBe("credit"); // Deposit
    expect(byRef.get("wc:savings:10001")!.debitCredit).toBe("debit"); // Withdrawal
    expect(byRef.get("wc:loan:20000")!.debitCredit).toBe("debit"); // Disbursement
    expect(byRef.get("wc:loan:20001")!.debitCredit).toBe("credit"); // Repayment
    expect(byRef.get("wc:loan:20003")!.isReversal).toBe(true); // flagged reversal
    expect(byRef.get("wc:gl:30000")!.debitCredit).toBe("debit");
    expect(byRef.get("wc:gl:30001")!.debitCredit).toBe("credit");

    // Dedupe keys are unique across entities even if numeric ids collide
    expect(new Set(canonical.map((c) => c.externalRef)).size).toBe(20);

    // All dates normalized to UTC
    for (const c of canonical) {
      expect(c.transactionDate.toISOString().endsWith("T00:00:00.000Z")).toBe(true);
      expect(Number(c.amount)).toBeGreaterThan(0);
      expect(c.currency).toBe("NGN");
    }

    // OAuth session was established once and reused across all requests
    expect(tokenRequests).toBeLessThanOrEqual(2);
  });
});
