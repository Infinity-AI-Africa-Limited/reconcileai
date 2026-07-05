/**
 * Auth manager + API client tests: OAuth2 session lifecycle, API-key fallback,
 * 401 renewal, transient-failure retry, and pagination — all against an
 * injected fetch (no network).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTokenCacheForTests, getAuthHeaders, invalidateToken, resolveTokenUrl } from "./auth";
import { backoffMs, WoodcoreClient } from "./client";
import { verifySignature, computeSignature, inferEntity } from "./webhooks";
import { computeNextRetryMs } from "./dlq";
import { DEFAULT_ENDPOINTS, type FetchLike, type WcConnection } from "./types";

let nextConfigId = 1000;

function makeConn(over: Partial<WcConnection> = {}): WcConnection {
  return {
    configId: nextConfigId++,
    organizationId: 1,
    baseUrl: "http://localhost:9999/api/v1",
    tenantId: "default",
    authMode: "oauth2",
    oauthClientId: "client-1",
    oauthClientSecret: "secret-1",
    oauthTokenUrl: null,
    oauthScope: null,
    apiKey: null,
    apiKeyHeader: "x-api-key",
    basicUsername: null,
    basicPassword: null,
    pageSize: 2,
    maxRetries: 3,
    requestTimeoutMs: 5000,
    endpoints: { ...DEFAULT_ENDPOINTS },
    ...over,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

beforeEach(() => clearTokenCacheForTests());

describe("auth — OAuth2 session management", () => {
  it("fetches a token, sends Bearer + tenant header", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token")) {
        return jsonResponse(200, { access_token: "tok-abc", expires_in: 3600 });
      }
      throw new Error("unexpected call");
    }) as unknown as FetchLike;

    const conn = makeConn();
    const r = await getAuthHeaders(conn, { fetchImpl });
    expect(r.modeUsed).toBe("oauth2");
    expect(r.degraded).toBe(false);
    expect(r.headers.Authorization).toBe("Bearer tok-abc");
    expect(r.headers["Fineract-Platform-TenantId"]).toBe("default");
  });

  it("caches the token until expiry; invalidateToken forces re-fetch", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return jsonResponse(200, { access_token: `tok-${calls}`, expires_in: 3600 });
    }) as unknown as FetchLike;

    const conn = makeConn();
    const a = await getAuthHeaders(conn, { fetchImpl });
    const b = await getAuthHeaders(conn, { fetchImpl });
    expect(a.headers.Authorization).toBe(b.headers.Authorization);
    expect(calls).toBe(1);

    invalidateToken(conn.configId);
    const c = await getAuthHeaders(conn, { fetchImpl });
    expect(c.headers.Authorization).toBe("Bearer tok-2");
    expect(calls).toBe(2);
  });

  it("expired tokens are refreshed proactively (60s skew)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { access_token: `tok-${++calls}`, expires_in: 3600 }),
    ) as unknown as FetchLike;
    let clock = 1_000_000;
    const now = () => clock;

    const conn = makeConn();
    await getAuthHeaders(conn, { fetchImpl, now });
    clock += 3600_000; // beyond expiry
    const r = await getAuthHeaders(conn, { fetchImpl, now });
    expect(r.headers.Authorization).toBe("Bearer tok-2");
  });

  it("falls back to API key when OAuth2 fails, and reports degraded", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "idp down" })) as unknown as FetchLike;
    const conn = makeConn({ apiKey: "key-xyz" });
    const r = await getAuthHeaders(conn, { fetchImpl });
    expect(r.modeUsed).toBe("api_key");
    expect(r.degraded).toBe(true);
    expect(r.headers["x-api-key"]).toBe("key-xyz");
  });

  it("throws when OAuth2 fails and no fallback credentials exist", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "bad client" })) as unknown as FetchLike;
    await expect(getAuthHeaders(makeConn(), { fetchImpl })).rejects.toThrow(/authentication failed/i);
  });

  it("api_key mode sends the configured header name", async () => {
    const conn = makeConn({ authMode: "api_key", apiKey: "k1", apiKeyHeader: "x-wc-key" });
    const r = await getAuthHeaders(conn, { fetchImpl: vi.fn() as unknown as FetchLike });
    expect(r.headers["x-wc-key"]).toBe("k1");
  });

  it("basic mode builds a correct Authorization header", async () => {
    const conn = makeConn({ authMode: "basic", basicUsername: "mifos", basicPassword: "password" });
    const r = await getAuthHeaders(conn, { fetchImpl: vi.fn() as unknown as FetchLike });
    expect(r.headers.Authorization).toBe(
      "Basic " + Buffer.from("mifos:password").toString("base64"),
    );
  });

  it("resolveTokenUrl handles relative and absolute forms", () => {
    expect(resolveTokenUrl(makeConn())).toBe("http://localhost:9999/api/v1/oauth/token");
    expect(resolveTokenUrl(makeConn({ oauthTokenUrl: "http://idp.local/token" }))).toBe(
      "http://idp.local/token",
    );
  });
});

describe("client — retry, session renewal, pagination", () => {
  const instantSleep = async () => {};

  it("renews the session once on 401 and succeeds", async () => {
    let tokenCalls = 0;
    let dataCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token")) {
        tokenCalls++;
        return jsonResponse(200, { access_token: `tok-${tokenCalls}`, expires_in: 3600 });
      }
      dataCalls++;
      if (dataCalls === 1) return jsonResponse(401, { error: "expired" });
      return jsonResponse(200, { hello: "world" });
    }) as unknown as FetchLike;

    const client = new WoodcoreClient(makeConn(), { fetchImpl, sleep: instantSleep });
    const res = await client.request<{ hello: string }>("/offices");
    expect(res.hello).toBe("world");
    expect(tokenCalls).toBe(2); // initial + renewal after 401
  });

  it("retries 5xx with backoff then succeeds", async () => {
    let dataCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token")) return jsonResponse(200, { access_token: "t", expires_in: 3600 });
      dataCalls++;
      if (dataCalls <= 2) return jsonResponse(503, { error: "busy" });
      return jsonResponse(200, { ok: true });
    }) as unknown as FetchLike;

    const client = new WoodcoreClient(makeConn(), { fetchImpl, sleep: instantSleep });
    const res = await client.request<{ ok: boolean }>("/offices");
    expect(res.ok).toBe(true);
    expect(dataCalls).toBe(3);
  });

  it("gives up after maxRetries and surfaces a retryable error", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token")) return jsonResponse(200, { access_token: "t", expires_in: 3600 });
      return jsonResponse(500, { error: "down" });
    }) as unknown as FetchLike;

    const client = new WoodcoreClient(makeConn({ maxRetries: 2 }), { fetchImpl, sleep: instantSleep });
    await expect(client.request("/offices")).rejects.toMatchObject({ retryable: true, status: 500 });
  });

  it("does not retry non-retryable 4xx", async () => {
    let dataCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token")) return jsonResponse(200, { access_token: "t", expires_in: 3600 });
      dataCalls++;
      return jsonResponse(404, { error: "no such resource" });
    }) as unknown as FetchLike;

    const client = new WoodcoreClient(makeConn(), { fetchImpl, sleep: instantSleep });
    await expect(client.request("/nope")).rejects.toMatchObject({ retryable: false, status: 404 });
    expect(dataCalls).toBe(1);
  });

  it("paginates a Fineract-style envelope to completion", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token")) return jsonResponse(200, { access_token: "t", expires_in: 3600 });
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 2);
      return jsonResponse(200, {
        totalFilteredRecords: all.length,
        pageItems: all.slice(offset, offset + limit),
      });
    }) as unknown as FetchLike;

    const client = new WoodcoreClient(makeConn({ pageSize: 2 }), { fetchImpl, sleep: instantSleep });
    const seen: number[] = [];
    const r = await client.fetchAllPages<{ id: number }>("/txns", {}, async (items) => {
      seen.push(...items.map((i) => i.id));
    });
    expect(r.total).toBe(5);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(r.pages).toBe(3);
  });

  it("handles bare-array list responses", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token")) return jsonResponse(200, { access_token: "t", expires_in: 3600 });
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      return jsonResponse(200, offset === 0 ? [{ id: 1 }] : []);
    }) as unknown as FetchLike;

    const client = new WoodcoreClient(makeConn(), { fetchImpl, sleep: instantSleep });
    const seen: number[] = [];
    await client.fetchAllPages<{ id: number }>("/txns", {}, async (items) => {
      seen.push(...items.map((i) => i.id));
    });
    expect(seen).toEqual([1]);
  });

  it("backoffMs grows exponentially and stays capped", () => {
    const fixed = () => 0.5;
    expect(backoffMs(0, fixed)).toBeLessThan(backoffMs(3, fixed));
    expect(backoffMs(10, fixed)).toBeLessThanOrEqual(15_250);
  });
});

describe("webhook signature + entity inference (pure)", () => {
  it("accepts a correct HMAC, with or without the sha256= prefix", () => {
    const body = JSON.stringify({ id: 1, amount: 100 });
    const sig = computeSignature(body, "shh");
    expect(verifySignature(body, "shh", sig)).toBe(true);
    expect(verifySignature(body, "shh", `sha256=${sig}`)).toBe(true);
  });

  it("rejects a wrong secret, tampered body, or missing header", () => {
    const body = JSON.stringify({ id: 1, amount: 100 });
    const sig = computeSignature(body, "shh");
    expect(verifySignature(body, "wrong", sig)).toBe(false);
    expect(verifySignature(body + " ", "shh", sig)).toBe(false);
    expect(verifySignature(body, "shh", undefined)).toBe(false);
    expect(verifySignature(body, "shh", "sha256=zzzz")).toBe(false);
  });

  it("infers the entity from event type first, payload shape second", () => {
    expect(inferEntity("savings.transaction.created", {})).toBe("savings_transaction");
    expect(inferEntity("loan.repayment.posted", {})).toBe("loan_transaction");
    expect(inferEntity("gl.journalentry.created", {})).toBe("journal_entry");
    expect(inferEntity(null, { loanId: 5 })).toBe("loan_transaction");
    expect(inferEntity(null, { savingsAccountId: 5 })).toBe("savings_transaction");
    expect(inferEntity(null, { glAccountCode: "1100" })).toBe("journal_entry");
    expect(inferEntity(null, { foo: 1 })).toBeNull();
  });
});

describe("DLQ backoff schedule", () => {
  it("doubles per attempt and caps at 6 hours", () => {
    const fixed = () => 0.5; // zero jitter
    expect(computeNextRetryMs(0, fixed)).toBe(60_000);
    expect(computeNextRetryMs(1, fixed)).toBe(120_000);
    expect(computeNextRetryMs(2, fixed)).toBe(240_000);
    expect(computeNextRetryMs(20, fixed)).toBe(6 * 60 * 60_000);
  });

  it("jitter stays within ±20%", () => {
    for (let i = 0; i < 50; i++) {
      const v = computeNextRetryMs(1);
      expect(v).toBeGreaterThanOrEqual(96_000);
      expect(v).toBeLessThanOrEqual(144_000);
    }
  });
});
