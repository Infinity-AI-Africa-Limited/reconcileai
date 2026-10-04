/**
 * Refresh-token rotation under concurrency.
 *
 * Shopify's rules this rests on (shopify.dev, "How refresh token rotation
 * works"): every refresh returns a new pair; the presented refresh token stays
 * usable until its successor is used, so a discarded response never strands a
 * store; and an authorization-code grant retires every other refresh token for
 * the store at once. So the database, not any one worker, decides which pair is
 * current — and every write after a refresh must be conditioned on the pair the
 * refresh started from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: vi.fn(async () => state.db),
  createAuditLog: vi.fn(async () => {}),
}));
vi.mock("../../_core/tenantKeys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../_core/tenantKeys")>()),
  encryptForTenant: vi.fn(async (org: number, plain: string) => `enc:${org}:${plain}`),
  decryptForTenant: vi.fn(async (org: number, stored: string) =>
    stored.startsWith(`enc:${org}:`) ? stored.slice(`enc:${org}:`.length) : null,
  ),
}));
vi.mock("../../_core/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../_core/env")>();
  return { ...mod, ENV: { ...mod.ENV, shopifyClientId: "client-id", shopifyClientSecret: "client-secret" } };
});
vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  refreshExpiringOfflineToken: vi.fn(),
}));

import * as db from "../../db";
import { refreshExpiringOfflineToken } from "./auth";
import { getValidShopifyAccessToken, ShopifyTokenUnavailableError } from "./tokenStore";
import { scriptedDb, type RecordedOp } from "./scriptedDb.testkit";

const ORG = 42;
const STORE = 7;
const TOKENS = "shopify_connector_tokens";
const STORES = "shopify_connector_stores";

const inAnHour = () => new Date(Date.now() + 60 * 60_000);
const inAMinute = () => new Date(Date.now() + 60_000); // inside the 5-minute refresh skew

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    storeId: STORE,
    organizationId: ORG,
    accessTokenEnc: `enc:${ORG}:old-access`,
    refreshTokenEnc: `enc:${ORG}:old-refresh`,
    accessExpiresAt: inAMinute(),
    refreshExpiresAt: null,
    refreshLeaseId: "lease",
    refreshLeaseExpiresAt: inAMinute(),
    rotationVersion: 3,
    ...overrides,
  };
}
const joined = (token: Record<string, unknown>) => ({ token, shopDomain: "merchant.myshopify.com" });

const REFRESHED = {
  kind: "refreshed" as const,
  token: { access_token: "new-access", refresh_token: "new-refresh", scope: "read_orders", expires_in: 3600, refresh_token_expires_in: 7_776_000 },
};

/** The update that stores a refreshed pair (it is the one carrying accessTokenEnc). */
const pairWrite = (ops: RecordedOp[]) => ops.find((op) => op.kind === "update" && op.table === TOKENS && op.data && "accessTokenEnc" in op.data);

async function reasonOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof ShopifyTokenUnavailableError ? error.reason : `other:${(error as Error).message}`;
  }
}

const call = () => getValidShopifyAccessToken({ storeId: STORE, organizationId: ORG });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("when the stored access token is still fresh", () => {
  it("should return it without refreshing", async () => {
    const fake = scriptedDb({ select: { [TOKENS]: [[joined(tokenRow({ accessExpiresAt: inAnHour() }))]] } });
    state.db = fake.db;
    expect(await call()).toBe("old-access");
    expect(refreshExpiringOfflineToken).not.toHaveBeenCalled();
  });
});

describe("when the tenant has been fenced for a shop redaction", () => {
  it("should hand out no credential, whatever the store row says", async () => {
    // The read joins the tenant and requires it to be live; a fenced tenant's
    // token is simply not found. The scripted answer is the database's reply.
    const fake = scriptedDb({ select: { [TOKENS]: [[]] } });
    state.db = fake.db;
    expect(await reasonOf(call)).toBe("not_found");
    const read = fake.ops.find((op) => op.kind === "select" && op.table === TOKENS);
    expect(read?.where?.sql).toMatch(/`organizations`\.`deletionState` = \?/);
    expect(read?.where?.params).toEqual(expect.arrayContaining([STORE, ORG, "active"]));
  });
});

describe("when a refresh completes with the lease still held", () => {
  it("should store the new pair, fenced on the exact row and version it started from", async () => {
    const fake = scriptedDb({
      select: { [TOKENS]: [[joined(tokenRow())], [tokenRow()]] },
      update: { [TOKENS]: [1, 1, 0] },
    });
    state.db = fake.db;
    vi.mocked(refreshExpiringOfflineToken).mockResolvedValue(REFRESHED);

    expect(await call()).toBe("new-access");
    const write = pairWrite(fake.ops);
    expect(write?.data).toMatchObject({ accessTokenEnc: `enc:${ORG}:new-access`, refreshTokenEnc: `enc:${ORG}:new-refresh` });
    // Row 501 at rotation version 3 — not "whichever row holds my lease".
    expect(write?.where?.params).toEqual(expect.arrayContaining([501, ORG, 3]));
    expect(write?.where?.sql).toMatch(/`rotationVersion` = \?/);
  });
});

describe("when the pair is replaced while the refresh is in flight", () => {
  // Greptile #134 finding 3: the lease expired mid-refresh and another worker
  // stored its rotation first. The fenced write matches nothing.
  it("should return the token the database retained, never its own unpersisted one", async () => {
    const winner = tokenRow({ accessTokenEnc: `enc:${ORG}:winner-access`, accessExpiresAt: inAnHour(), rotationVersion: 4 });
    const fake = scriptedDb({
      select: { [TOKENS]: [[joined(tokenRow())], [tokenRow()], [joined(winner)]] },
      update: { [TOKENS]: [1, 0, 0] },
    });
    state.db = fake.db;
    vi.mocked(refreshExpiringOfflineToken).mockResolvedValue(REFRESHED);

    expect(await call()).toBe("winner-access");
  });

  it("should ask the caller to retry, rather than return its own token, while no fresh pair is stored yet", async () => {
    const fake = scriptedDb({
      select: { [TOKENS]: [[joined(tokenRow())], [tokenRow()], [joined(tokenRow({ rotationVersion: 4 }))]] },
      update: { [TOKENS]: [1, 0, 0] },
    });
    state.db = fake.db;
    vi.mocked(refreshExpiringOfflineToken).mockResolvedValue(REFRESHED);

    expect(await reasonOf(call)).toBe("refresh_in_progress");
  });
});

describe("when Shopify rejects the refresh token", () => {
  it("should delete the rejected pair and mark the store for reauthorization, with the reason", async () => {
    const fake = scriptedDb({
      select: { [TOKENS]: [[joined(tokenRow())], [tokenRow()]] },
      update: { [TOKENS]: [1, 0] },
      delete: { [TOKENS]: [1] },
    });
    state.db = fake.db;
    vi.mocked(refreshExpiringOfflineToken).mockResolvedValue({ kind: "reauthorize" });

    expect(await reasonOf(call)).toBe("reauthorize");
    expect(fake.writes("delete", TOKENS)[0]?.where?.params).toEqual(expect.arrayContaining([501, 3]));
    expect(fake.writes("update", STORES)[0]?.data).toEqual({ status: "reauthorization_required", statusReason: "refresh_rejected" });
    expect(db.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "shopify_store_reauthorization_required", details: expect.objectContaining({ reason: "refresh_rejected" }) }),
    );
  });

  it("should never relabel a store a shop redaction has fenced", async () => {
    const fake = scriptedDb({
      select: { [TOKENS]: [[joined(tokenRow())], [tokenRow()]] },
      update: { [TOKENS]: [1, 0] },
      delete: { [TOKENS]: [1] },
    });
    state.db = fake.db;
    vi.mocked(refreshExpiringOfflineToken).mockResolvedValue({ kind: "reauthorize" });

    await reasonOf(call);
    // The dead pair is still deleted; the store's label changes only if it is not `redacting`.
    expect(fake.writes("delete", TOKENS)).toHaveLength(1);
    const relabel = fake.writes("update", STORES)[0];
    expect(relabel?.where?.sql).toMatch(/`status` <> \?/);
    expect(relabel?.where?.params).toContain("redacting");
  });

  it("should leave a reinstall's new credentials alone when the rejection was about the pair it replaced", async () => {
    // A reinstall mid-refresh retires the refresh token this worker presented,
    // so Shopify answers 401 — about credentials the store no longer holds.
    const reinstalled = tokenRow({ id: 502, accessTokenEnc: `enc:${ORG}:reinstall-access`, accessExpiresAt: inAnHour(), rotationVersion: 1 });
    const fake = scriptedDb({
      select: { [TOKENS]: [[joined(tokenRow())], [tokenRow()], [joined(reinstalled)]] },
      update: { [TOKENS]: [1, 0] },
      delete: { [TOKENS]: [0] },
    });
    state.db = fake.db;
    vi.mocked(refreshExpiringOfflineToken).mockResolvedValue({ kind: "reauthorize" });

    expect(await call()).toBe("reinstall-access");
    expect(fake.writes("update", STORES)).toEqual([]);
    expect(db.createAuditLog).not.toHaveBeenCalled();
  });

  it("should still take the store out of service when the audit write fails", async () => {
    const fake = scriptedDb({
      select: { [TOKENS]: [[joined(tokenRow())], [tokenRow()]] },
      update: { [TOKENS]: [1, 0] },
      delete: { [TOKENS]: [1] },
    });
    state.db = fake.db;
    vi.mocked(refreshExpiringOfflineToken).mockResolvedValue({ kind: "reauthorize" });
    vi.mocked(db.createAuditLog).mockRejectedValueOnce(new Error("audit chain unavailable"));

    expect(await reasonOf(call)).toBe("reauthorize");
    expect(fake.writes("update", STORES)[0]?.data).toMatchObject({ status: "reauthorization_required" });
  });
});

describe("when another worker already holds the refresh lease", () => {
  it("should use the pair that worker stored instead of refreshing again", async () => {
    const theirs = tokenRow({ accessTokenEnc: `enc:${ORG}:their-access`, accessExpiresAt: inAnHour(), rotationVersion: 4 });
    const fake = scriptedDb({ select: { [TOKENS]: [[joined(tokenRow())], [], [joined(theirs)]] }, update: { [TOKENS]: [0] } });
    state.db = fake.db;

    expect(await call()).toBe("their-access");
    expect(refreshExpiringOfflineToken).not.toHaveBeenCalled();
  });
});

describe("when Shopify cannot be reached", () => {
  it("should ask for a retry and release its lease without touching the stored pair", async () => {
    const fake = scriptedDb({ select: { [TOKENS]: [[joined(tokenRow())], [tokenRow()]] }, update: { [TOKENS]: [1, 1] } });
    state.db = fake.db;
    vi.mocked(refreshExpiringOfflineToken).mockResolvedValue({ kind: "retry" });

    expect(await reasonOf(call)).toBe("refresh_retry");
    expect(pairWrite(fake.ops)).toBeUndefined();
    expect(fake.writes("delete", TOKENS)).toEqual([]);
    const release = fake.writes("update", TOKENS).at(-1);
    expect(release?.data).toEqual({ refreshLeaseId: null, refreshLeaseExpiresAt: null });
  });
});
