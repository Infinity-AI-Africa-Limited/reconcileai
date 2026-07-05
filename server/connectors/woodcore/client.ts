/**
 * WoodCore REST API client.
 *
 * - Auth via getAuthHeaders() (OAuth2 + fallbacks), with one automatic retry on
 *   401 after invalidating the cached token (session renewal).
 * - Transient-failure retry with exponential backoff + jitter on 429/5xx and
 *   network errors, capped at conn.maxRetries.
 * - Fineract-style offset/limit pagination via fetchAllPages().
 * - Data-residency: every URL passes assertEgressAllowed() before dispatch.
 *
 * Endpoint paths come from conn.endpoints (per-org configurable) so the client
 * does not need code changes when WoodCore's real API paths are confirmed.
 */
import { assertEgressAllowed } from "../../_core/egress";
import { getAuthHeaders, invalidateToken, type AuthResult } from "./auth";
import type { FetchLike, WcClientDeps, WcConnection, WcPagedResponse } from "./types";

export class WoodcoreApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WoodcoreApiError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with full jitter: 500ms · 2^attempt, capped at 15s. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const cap = Math.min(500 * 2 ** attempt, 15_000);
  return Math.floor(rand() * cap) + 250;
}

export class WoodcoreClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Auth degradation observed on the most recent request (for health). */
  public lastAuth: AuthResult | null = null;

  constructor(
    private readonly conn: WcConnection,
    deps: WcClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const abs = /^https?:\/\//i.test(path)
      ? path
      : this.conn.baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
    if (!query) return abs;
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (!qs) return abs;
    return abs + (abs.includes("?") ? "&" : "?") + qs;
  }

  /**
   * Perform one API call with session renewal (401 → token refresh → retry once)
   * and transient-failure backoff (429/5xx/network → retry up to maxRetries).
   */
  async request<T>(
    path: string,
    opts: {
      method?: string;
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    assertEgressAllowed(url, "WoodCore API call");

    let attempt = 0;
    let retried401 = false;

    for (;;) {
      const auth = await getAuthHeaders(this.conn, { fetchImpl: this.fetchImpl, now: this.now });
      this.lastAuth = auth;

      let res: Awaited<ReturnType<FetchLike>>;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.conn.requestTimeoutMs);
        try {
          res = await this.fetchImpl(url, {
            method: opts.method ?? "GET",
            headers: {
              ...auth.headers,
              ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        // Network error / timeout — retryable
        if (attempt < this.conn.maxRetries) {
          await this.sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new WoodcoreApiError(`WoodCore request failed (network): ${msg}`, null, true);
      }

      if (res.status === 401 && !retried401) {
        // Session expired — renew once.
        invalidateToken(this.conn.configId);
        retried401 = true;
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.conn.maxRetries) {
          await this.sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        const text = await res.text().catch(() => "");
        throw new WoodcoreApiError(
          `WoodCore request failed (HTTP ${res.status}) after ${attempt + 1} attempts: ${text.slice(0, 300)}`,
          res.status,
          true,
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new WoodcoreApiError(
          `WoodCore request rejected (HTTP ${res.status}): ${text.slice(0, 300)}`,
          res.status,
          false,
        );
      }

      return (await res.json()) as T;
    }
  }

  /**
   * Fetch every page of a Fineract-style list endpoint (offset/limit with
   * `totalFilteredRecords`/`pageItems`, or a bare array). `onPage` receives each
   * page so callers can stream-process rather than accumulate.
   */
  async fetchAllPages<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    onPage: (items: T[], offset: number) => Promise<void>,
    opts: { maxPages?: number } = {},
  ): Promise<{ total: number; pages: number }> {
    const limit = this.conn.pageSize;
    const maxPages = opts.maxPages ?? 10_000; // hard stop against endless loops
    let offset = 0;
    let total = 0;
    let pages = 0;

    for (;;) {
      const res = await this.request<WcPagedResponse<T> | T[]>(path, {
        query: { ...query, offset, limit },
      });
      // Envelope tolerance across CBS dialects: Fineract `pageItems`, Temenos
      // IRIS `body`, generic `content`/`items`, or a bare array.
      const items: T[] = Array.isArray(res)
        ? res
        : ((res.pageItems ??
            (Array.isArray(res.body) ? (res.body as T[]) : undefined) ??
            (Array.isArray(res.content) ? (res.content as T[]) : undefined) ??
            (Array.isArray(res.items) ? (res.items as T[]) : undefined)) ?? []);
      if (items.length > 0) {
        await onPage(items, offset);
        total += items.length;
      }
      pages++;

      const declaredTotal = Array.isArray(res) ? null : (res.totalFilteredRecords ?? null);
      const done =
        items.length < limit ||
        (declaredTotal !== null && offset + items.length >= declaredTotal) ||
        pages >= maxPages;
      if (done) return { total, pages };
      offset += limit;
    }
  }

  // ─── Typed endpoints (paths configurable via conn.endpoints) ───────────────

  async ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = this.now();
    try {
      await this.request<unknown>(this.conn.endpoints.ping);
      return { ok: true, latencyMs: this.now() - started };
    } catch (err) {
      return {
        ok: false,
        latencyMs: this.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  fetchSavingsTransactions<T>(
    fromDate: string,
    toDate: string,
    onPage: (items: T[], offset: number) => Promise<void>,
  ) {
    return this.fetchAllPages<T>(
      this.conn.endpoints.savingsTransactions,
      { fromDate, toDate, dateFormat: "yyyy-MM-dd", locale: "en" },
      onPage,
    );
  }

  fetchLoanTransactions<T>(
    fromDate: string,
    toDate: string,
    onPage: (items: T[], offset: number) => Promise<void>,
  ) {
    return this.fetchAllPages<T>(
      this.conn.endpoints.loanTransactions,
      { fromDate, toDate, dateFormat: "yyyy-MM-dd", locale: "en" },
      onPage,
    );
  }

  fetchJournalEntries<T>(
    fromDate: string,
    toDate: string,
    onPage: (items: T[], offset: number) => Promise<void>,
  ) {
    return this.fetchAllPages<T>(
      this.conn.endpoints.journalEntries,
      { fromDate, toDate, dateFormat: "yyyy-MM-dd", locale: "en" },
      onPage,
    );
  }

  /** Bidirectional write-back: push a note/annotation to WoodCore. */
  postWriteBack(body: unknown): Promise<unknown> {
    return this.request<unknown>(this.conn.endpoints.writeBack, { method: "POST", body });
  }
}
