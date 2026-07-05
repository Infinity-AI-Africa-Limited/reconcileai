/**
 * WoodCore connector — shared types.
 *
 * WoodCore is built on Apache Fineract, so the request/response shapes here are
 * modeled on the Fineract REST API (v1) plus what we've observed in the live
 * tenant DB. Endpoint paths are configurable per connection (endpointsJson) so
 * that when WoodCore's official API docs arrive, only configuration changes.
 */

// ─── Entities we ingest ──────────────────────────────────────────────────────
export type WcEntity = "savings_transaction" | "loan_transaction" | "journal_entry";

export const WC_ENTITIES: WcEntity[] = [
  "savings_transaction",
  "loan_transaction",
  "journal_entry",
];

// ─── Canonical transaction (what the reconciliation engine consumes) ─────────
export interface CanonicalTransaction {
  /** Stable unique id from WoodCore, e.g. "wc:savings:12345". Dedupe key. */
  externalRef: string;
  /** Human-facing reference where the source provides one (receipt no, GL txn id). */
  transactionRef: string | null;
  /** Absolute amount as a decimal string (canonical `transactions.amount`). */
  amount: string;
  currency: string;
  debitCredit: "debit" | "credit";
  transactionDate: Date;
  valueDate: Date | null;
  description: string | null;
  counterparty: string | null;
  isReversal: boolean;
  /** Which WoodCore entity this came from. */
  sourceEntity: WcEntity;
  /** Decoded type label, e.g. "Deposit", "Repayment", "DEBIT". */
  sourceType: string;
  /** Original payload, persisted to transactions.rawData for audit. */
  raw: unknown;
}

// ─── Auth ────────────────────────────────────────────────────────────────────
export type WcAuthMode = "oauth2" | "api_key" | "basic";

/** Decrypted, ready-to-use connection settings (never persisted in this form). */
export interface WcConnection {
  configId: number;
  organizationId: number;
  /** CBS profile key: woodcore | t24 | mambu | flexcube (see cbs/registry.ts). */
  cbsType: string;
  baseUrl: string;
  tenantId: string;
  authMode: WcAuthMode;
  oauthClientId: string | null;
  oauthClientSecret: string | null;
  oauthTokenUrl: string | null;
  oauthScope: string | null;
  apiKey: string | null;
  apiKeyHeader: string;
  basicUsername: string | null;
  basicPassword: string | null;
  pageSize: number;
  maxRetries: number;
  requestTimeoutMs: number;
  endpoints: WcEndpoints;
}

export interface WcEndpoints {
  savingsTransactions: string;
  loanTransactions: string;
  journalEntries: string;
  tokenUrl: string; // relative to baseUrl unless absolute
  ping: string;
  writeBack: string;
}

/**
 * Default endpoint paths (Fineract-style). `savingsTransactions` and
 * `loanTransactions` assume a WoodCore aggregate search endpoint; the
 * journal-entries path is standard Fineract.
 */
export const DEFAULT_ENDPOINTS: WcEndpoints = {
  savingsTransactions: "/savingsaccounts/transactions/search",
  loanTransactions: "/loans/transactions/search",
  journalEntries: "/journalentries",
  tokenUrl: "/oauth/token",
  ping: "/offices?limit=1",
  writeBack: "/notes",
};

// ─── Fineract-style paged list response ──────────────────────────────────────
export interface WcPagedResponse<T> {
  totalFilteredRecords?: number;
  pageItems?: T[];
  // Some list endpoints return a bare array instead of the paged envelope.
  [key: string]: unknown;
}

// ─── OAuth2 token response ───────────────────────────────────────────────────
export interface OAuthTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number; // seconds
  refresh_token?: string;
  scope?: string;
}

// ─── Injectable dependencies (testability without a live WoodCore) ──────────
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface WcClientDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Sleep between retries — injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}
