/**
 * Merchant onboarding and reauthorization — the tenant boundary of the Shopify
 * connector.
 *
 * The rule underneath every branch: by the time onboarding runs, the callback
 * has exchanged an authorization code, and Shopify retires every other refresh
 * token for the store at that moment. A branch that does not store the new pair
 * must take the store out of service, because the pair it still holds is dead.
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
}));
vi.mock("../../magicLinkService", () => ({
  sendWelcomeEmail: vi.fn(async () => ({ success: true, magicLink: "https://example.invalid/magic-login?token=x" })),
}));
vi.mock("../../provisioning", () => ({
  provisionTenantBaseline: vi.fn(async (organizationId: number) => ({ organizationId, ok: true, steps: [] })),
}));
vi.mock("../../exceptions/retail-commerce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../exceptions/retail-commerce")>()),
  seedRetailResolutionTemplates: vi.fn(async () => ({ inserted: 25, existing: 0 })),
}));

import { encryptForTenant } from "../../_core/tenantKeys";
import { sendWelcomeEmail } from "../../magicLinkService";
import { provisionTenantBaseline } from "../../provisioning";
import { seedRetailResolutionTemplates } from "../../exceptions/retail-commerce";
import { onboardShopifyMerchant, ShopifyOnboardingError, suspendForReauthorization } from "./onboarding";
import type { TokenGeneration } from "./tokenStore";
import { duplicateKeyError, scriptedDb, type RecordedOp } from "./scriptedDb.testkit";

const SHOP = "merchant.myshopify.com";
const SHOP_ID = "gid://shopify/Shop/1001";
const STORES = "shopify_connector_stores";
const TOKENS = "shopify_connector_tokens";
const USERS = "users";
const ORGS = "organizations";
const CHANNELS = "channels";

const metadata = {
  id: SHOP_ID,
  name: "Merchant Ltd",
  contactEmail: "Owner@Merchant.com",
  primaryDomain: "merchant.com",
  currencyCode: "USD",
  ianaTimezone: "Africa/Lagos",
};
const tokenResponse = {
  access_token: "fresh-access",
  refresh_token: "fresh-refresh",
  scope: "read_orders",
  expires_in: 3600,
  refresh_token_expires_in: 7_776_000,
};
const existingStore = {
  id: 7,
  organizationId: 42,
  shopDomain: SHOP,
  shopId: SHOP_ID,
  displayName: "Merchant Ltd",
  status: "active",
  statusReason: null,
  privacyRedactionState: "active",
  privacyRedactionRequestId: null,
  claimedByUserId: 9,
  claimedAt: new Date("2026-09-01T00:00:00Z"),
};

const LEASES = "shopify_install_leases";
/** The shop's install lease this callback holds. */
const LEASE = { shopDomain: SHOP, leaseId: "lease-1" };

/** A database in which this callback still holds the shop's lease (a standing answer). */
const held = (script: Parameters<typeof scriptedDb>[0] = {}) =>
  scriptedDb({
    ...script,
    standing: {
      [LEASES]: [{ leaseId: LEASE.leaseId }],
      [CHANNELS]: [{ id: 77 }],
      // The tenant is not being redacted (read again, locked, before any write).
      [ORGS]: [{ deletionState: "active", code: "SHP_ABC" }],
      ...script.standing,
    },
  });

const onboardFirst = () =>
  onboardShopifyMerchant({
    shopDomain: SHOP,
    metadata,
    tokenResponse,
    origin: "https://www.reconcileaiafrica.com",
    reauthorization: { retiring: "none" },
    lease: LEASE,
  });

/** The pair the store held when this callback suspended it — what its grant retires. */
const HELD: TokenGeneration = { tokenRowId: 501, rotationVersion: 3 };

const onboard = (retiring: TokenGeneration = HELD) =>
  onboardShopifyMerchant({
    shopDomain: SHOP,
    metadata,
    tokenResponse,
    origin: "https://www.reconcileaiafrica.com",
    reauthorization: { retiring },
    lease: LEASE,
  });

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof ShopifyOnboardingError ? error.code : `other:${(error as Error).message}`;
  }
}

const storeUpdates = (ops: RecordedOp[]) => ops.filter((op) => op.kind === "update" && op.table === STORES).map((op) => op.data);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("when a shop we already know is reauthorized", () => {
  describe("and its contact email matches no active administrator of the owning workspace", () => {
    // Greptile #134 finding 1: a shop that changed hands must not have the new
    // owner's order access filed under the previous owner's workspace.
    function setup() {
      const fake = held({ select: { [STORES]: [[existingStore]], [USERS]: [[]] } });
      state.db = fake.db;
      return fake;
    }

    it("should refuse with OWNERSHIP_UNVERIFIED", async () => {
      setup();
      expect(await codeOf(onboard)).toBe("OWNERSHIP_UNVERIFIED");
    });

    it("should not store the new grant under the existing workspace", async () => {
      const fake = setup();
      await codeOf(onboard);
      expect(fake.writes("insert", TOKENS)).toEqual([]);
      expect(encryptForTenant).not.toHaveBeenCalled();
    });

    it("should take the store out of service, since the new grant retired its refresh token", async () => {
      const fake = setup();
      await codeOf(onboard);
      // Fenced on the exact pair this grant retired (row 501, version 3).
      expect(fake.writes("delete", TOKENS)[0]?.where?.params).toEqual(expect.arrayContaining([7, 42, 501, 3]));
      expect(storeUpdates(fake.committed())).toEqual([{ status: "reauthorization_required", statusReason: "ownership_unverified" }]);
    });

    it("should compare against active administrators of THAT workspace, case-insensitively", async () => {
      const fake = setup();
      await codeOf(onboard);
      const adminLookup = fake.ops.find((op) => op.kind === "select" && op.table === USERS);
      expect(adminLookup?.where?.params).toEqual(expect.arrayContaining([42, "admin", "owner@merchant.com"]));
      expect(adminLookup?.where?.sql).toMatch(/lower\(`users`\.`email`\)/);
      expect(adminLookup?.where?.sql).toMatch(/`users`\.`isActive` = \?/);
    });
  });

  describe("and its contact email matches an active administrator", () => {
    it("should store the new pair and mark the store active in the same committed transaction", async () => {
      const fake = held({
        select: {
          [STORES]: [[existingStore], [{ privacyRedactionState: "active" }]],
          [USERS]: [[{ id: 9 }]],
          [ORGS]: [[{ code: "SHP_ABC" }]],
        },
      });
      state.db = fake.db;

      const result = await onboard();

      expect(result).toMatchObject({ storeId: 7, organizationId: 42, connectedUserId: 9, isReinstallation: true });
      const activate = fake.writes("update", STORES)[0];
      const tokens = fake.writes("insert", TOKENS)[0];
      expect(activate?.data).toMatchObject({ status: "active", statusReason: null, claimedByUserId: 9, uninstalledAt: null });
      expect(tokens?.data).toMatchObject({ storeId: 7, organizationId: 42, accessTokenEnc: "enc:42:fresh-access" });
      expect(tokens?.upsert).toBe(true);
      expect(activate?.txId).not.toBeNull();
      expect(activate?.txId).toBe(tokens?.txId);
    });
  });

  describe("and storing the replacement credentials fails", () => {
    // Greptile #134 finding 2: the store was committed `active` before the save,
    // leaving it active on a pair Shopify had already retired.
    it("should not leave the store active, and should record why", async () => {
      const fake = held({
        select: { [STORES]: [[existingStore]], [USERS]: [[{ id: 9 }]] },
        insert: { [TOKENS]: [new Error("disk full")] },
      });
      state.db = fake.db;

      expect(await codeOf(onboard)).toBe("TOKEN_STORE_FAILED");
      const committed = storeUpdates(fake.committed());
      expect(committed).not.toContainEqual(expect.objectContaining({ status: "active" }));
      expect(committed).toContainEqual({ status: "reauthorization_required", statusReason: "token_store_failed" });
      expect(fake.writes("delete", TOKENS)).toHaveLength(1);
    });

    it("should do the same when encryption fails", async () => {
      const fake = held({ select: { [STORES]: [[existingStore]], [USERS]: [[{ id: 9 }]] } });
      state.db = fake.db;
      vi.mocked(encryptForTenant).mockRejectedValueOnce(new Error("KMS unavailable"));

      expect(await codeOf(onboard)).toBe("TOKEN_STORE_FAILED");
      expect(storeUpdates(fake.committed())).toEqual([{ status: "reauthorization_required", statusReason: "token_store_failed" }]);
    });
  });

  describe("and the permanent domain now names a different shop", () => {
    it("should refuse without writing anything", async () => {
      const fake = held({ select: { [STORES]: [[{ ...existingStore, shopId: "gid://shopify/Shop/9999" }]] } });
      state.db = fake.db;

      expect(await codeOf(onboard)).toBe("SHOP_IDENTITY_CONFLICT");
      expect(fake.ops.filter((op) => op.kind !== "select")).toEqual([]);
    });
  });
});

describe("when a shop redaction fences the tenant after the early check", () => {
  // The pre-transaction check is advice only: a redaction admitted between it
  // and the write must still stop the write. Greptile #156 (stacked review).
  const fenced = { deletionState: "redacting", code: "SHP_ABC" };

  it("should refuse a reauthorization without storing a pair or reactivating the store", async () => {
    const fake = held({
      select: { [STORES]: [[existingStore]], [USERS]: [[{ id: 9 }]], [ORGS]: [[{ deletionState: "active" }], [fenced]] },
    });
    state.db = fake.db;

    expect(await codeOf(onboard)).toBe("REDACTION_IN_PROGRESS");
    expect(fake.writes("insert", TOKENS)).toEqual([]);
    // Nothing relabels the store either: the fence owns its state now.
    expect(storeUpdates(fake.committed())).toEqual([]);
  });

  it("should take the organisation lock before the store lock, inside the transaction that writes", async () => {
    const fake = held({ select: { [STORES]: [[existingStore]], [USERS]: [[{ id: 9 }]] } });
    state.db = fake.db;
    await onboard();

    const inTx = fake.ops.filter((op) => op.txId !== null);
    const orgLock = inTx.findIndex((op) => op.table === ORGS && op.locked);
    const storeLock = inTx.findIndex((op) => op.table === STORES && op.kind === "select" && op.locked);
    expect(orgLock).toBeGreaterThanOrEqual(0);
    expect(storeLock).toBeGreaterThan(orgLock);
    expect(inTx.findIndex((op) => op.table === TOKENS && op.kind === "insert")).toBeGreaterThan(storeLock);
  });

  it("should refuse when this store has itself been fenced as a sibling of the redacted one", async () => {
    const fake = held({ select: { [STORES]: [[existingStore], [{ status: "redacting" }]], [USERS]: [[{ id: 9 }]] } });
    state.db = fake.db;

    expect(await codeOf(onboard)).toBe("REDACTION_IN_PROGRESS");
    expect(fake.writes("insert", TOKENS)).toEqual([]);
  });

  it("should refuse while a customer redaction holds this store's write fence", async () => {
    const fake = held({
      select: { [STORES]: [[existingStore], [{ status: "active", privacyRedactionState: "customer_redacting" }]], [USERS]: [[{ id: 9 }]] },
    });
    state.db = fake.db;

    expect(await codeOf(onboard)).toBe("REDACTION_IN_PROGRESS");
    expect(fake.writes("insert", TOKENS)).toEqual([]);
    expect(storeUpdates(fake.committed())).toEqual([]);
  });

  it("should activate a store only while it is not fenced, in the statement itself", async () => {
    const fake = held({ select: { [STORES]: [[existingStore]], [USERS]: [[{ id: 9 }]] } });
    state.db = fake.db;
    await onboard();

    expect(fake.writes("update", STORES)[0]?.where?.params).toContain("redacting");
  });

  it("should refuse to finish a first install whose new tenant was fenced before its credentials were stored", async () => {
    const fake = held({
      select: { [STORES]: [[]], [USERS]: [[]], [ORGS]: [[fenced]] },
      insert: { [ORGS]: [42], [USERS]: [9], [STORES]: [7] },
    });
    state.db = fake.db;

    expect(await codeOf(onboardFirst)).toBe("REDACTION_IN_PROGRESS");
    expect(fake.writes("insert", TOKENS)).toEqual([]);
    expect(storeUpdates(fake.committed())).not.toContainEqual(expect.objectContaining({ status: "active" }));
  });
});

describe("when a shop installs for the first time", () => {
  const onboard = () => onboardFirst();
  function firstInstall(extra: Parameters<typeof scriptedDb>[0] = {}) {
    const fake = held({
      select: { [STORES]: [[]], [USERS]: [[]] },
      insert: { [ORGS]: [42], [USERS]: [9], [STORES]: [7] },
      ...extra,
    });
    state.db = fake.db;
    return fake;
  }

  it("should create the workspace with its store pending until credentials are stored", async () => {
    const fake = firstInstall();
    const result = await onboard();

    expect(result).toMatchObject({ storeId: 7, organizationId: 42, connectedUserId: 9, isReinstallation: false, welcomeEmailSent: true });
    expect(fake.writes("insert", ORGS)[0]?.data).toMatchObject({ segment: "retail_commerce", onboardingChannel: "shopify_public_app" });
    expect(fake.writes("insert", USERS)[0]?.data).toMatchObject({ email: "owner@merchant.com", role: "admin", organizationId: 42 });
    expect(fake.writes("insert", STORES)[0]?.data).toMatchObject({ status: "pending_claim" });
    const activate = fake.writes("update", STORES)[0];
    expect(activate?.data).toEqual({ status: "active", statusReason: null });
    expect(activate?.txId).toBe(fake.writes("insert", TOKENS)[0]?.txId);
  });

  it("should provision the tenant baseline before encrypting under the tenant's key", async () => {
    firstInstall();
    await onboard();
    expect(provisionTenantBaseline).toHaveBeenCalledWith(42);
    const baselineAt = vi.mocked(provisionTenantBaseline).mock.invocationCallOrder[0];
    const encryptAt = vi.mocked(encryptForTenant).mock.invocationCallOrder[0];
    expect(baselineAt).toBeLessThan(encryptAt);
  });

  it("should give the new tenant its own retail resolution templates (§9A)", async () => {
    firstInstall();
    await onboard();
    expect(seedRetailResolutionTemplates).toHaveBeenCalledWith(42);
  });

  it("should still finish installing when the templates cannot be seeded", async () => {
    firstInstall();
    vi.mocked(seedRetailResolutionTemplates).mockRejectedValueOnce(new Error("database busy"));
    await expect(onboard()).resolves.toMatchObject({ storeId: 7, organizationId: 42 });
  });

  it("should send the welcome link to the default landing, with no redirect continuation", async () => {
    firstInstall();
    await onboard();
    expect(sendWelcomeEmail).toHaveBeenCalledWith({
      userId: 9,
      name: "Merchant Ltd",
      email: "owner@merchant.com",
      role: "admin",
      origin: "https://www.reconcileaiafrica.com",
    });
  });

  it("should refuse an address already used by another workspace, whatever its case", async () => {
    const fake = firstInstall({ select: { [STORES]: [[]], [USERS]: [[{ id: 55 }]] } });
    expect(await codeOf(onboard)).toBe("EMAIL_CONFLICT");
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === USERS);
    expect(lookup?.where?.sql).toMatch(/lower\(`users`\.`email`\)/);
    expect(fake.writes("insert", ORGS)).toEqual([]);
  });

  it("should leave the store out of service when its credentials cannot be stored", async () => {
    const fake = firstInstall({ insert: { [ORGS]: [42], [USERS]: [9], [STORES]: [7], [TOKENS]: [new Error("disk full")] } });
    expect(await codeOf(onboard)).toBe("TOKEN_STORE_FAILED");
    expect(storeUpdates(fake.committed())).toEqual([{ status: "reauthorization_required", statusReason: "token_store_failed" }]);
    // It held nothing before, so the mark is conditioned on still holding nothing.
    expect(fake.writes("update", STORES)[0]?.where?.sql).toMatch(/not exists \(select/i);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it("should not mark a store a concurrent callback has since given credentials", async () => {
    const fake = firstInstall({
      insert: { [ORGS]: [42], [USERS]: [9], [STORES]: [7], [TOKENS]: [new Error("disk full")] },
      update: { [STORES]: [0] },
    });
    let failClosed: unknown;
    try {
      await onboard();
    } catch (error) {
      failClosed = (error as ShopifyOnboardingError).storeFailClosed;
    }
    // The only store write is the conditional mark — one statement that
    // changes nothing while a token row exists — and it matched no row.
    expect(failClosed).toBe("superseded");
    const marks = fake.writes("update", STORES);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.where?.sql).toMatch(/not exists \(select/i);
  });

  describe("and a concurrent callback for the same shop created the workspace first", () => {
    // Greptile #134 finding 4: the loser used to show a generic failure while
    // the other callback had completed the install.
    it("should complete as a reauthorization of the winning store", async () => {
      const winner = { ...existingStore, status: "pending_claim" };
      const fake = held({
        select: {
          [STORES]: [[], [winner], [{ privacyRedactionState: "active" }]],
          [USERS]: [[], [{ id: 9 }]],
          [ORGS]: [[{ code: "SHP_ABC" }]],
        },
        insert: { [ORGS]: [duplicateKeyError()] },
      });
      state.db = fake.db;

      const result = await onboard();

      expect(result).toMatchObject({ storeId: 7, organizationId: 42, isReinstallation: true });
      expect(fake.writes("insert", ORGS)).toEqual([]); // the losing tenant rolled back
      expect(fake.writes("insert", TOKENS)[0]?.data).toMatchObject({ storeId: 7, organizationId: 42 });
      expect(fake.writes("update", STORES)[0]?.data).toMatchObject({ status: "active" });
    });

    it("should still require the ownership check on that path", async () => {
      const fake = held({
        select: { [STORES]: [[], [existingStore]], [USERS]: [[], []] },
        insert: { [ORGS]: [duplicateKeyError()] },
      });
      state.db = fake.db;
      expect(await codeOf(onboard)).toBe("OWNERSHIP_UNVERIFIED");
    });

    it("should refuse clearly when the conflicting workspace has no store to resolve", async () => {
      const fake = held({ select: { [STORES]: [[], []], [USERS]: [[]] }, insert: { [ORGS]: [duplicateKeyError()] } });
      state.db = fake.db;
      expect(await codeOf(onboard)).toBe("WORKSPACE_CONFLICT");
    });

    it("should not treat an unrelated database error as a concurrent install", async () => {
      const fake = held({ select: { [STORES]: [[]], [USERS]: [[]] }, insert: { [ORGS]: [new Error("ECONNRESET")] } });
      state.db = fake.db;
      expect(await codeOf(onboard)).toBe("other:ECONNRESET");
    });
  });
});

describe("when an overlapping callback stored a newer pair before this one failed", () => {
  // Greptile #134, fourth pass: B's reinstall succeeded, then A — whose grant
  // may be the OLDER one — failed and ran an unfenced fail-close that deleted
  // B's valid credentials and marked the store out of service.
  it("should leave the newer installation alone and say so", async () => {
    const fake = held({
      select: { [STORES]: [[existingStore]], [USERS]: [[{ id: 9 }]] },
      insert: { [TOKENS]: [new Error("disk full")] },
      delete: { [TOKENS]: [0] }, // the pair A retired is no longer stored
    });
    state.db = fake.db;

    let error: ShopifyOnboardingError | undefined;
    try {
      await onboard();
    } catch (caught) {
      error = caught as ShopifyOnboardingError;
    }
    expect(error?.code).toBe("TOKEN_STORE_FAILED");
    expect(error?.storeFailClosed).toBe("superseded");
    expect(storeUpdates(fake.committed())).not.toContainEqual(expect.objectContaining({ status: "reauthorization_required" }));
  });
});

describe("when a callback suspends a store before its exchange", () => {
  it("should take only an active store out of service, and record the pair its grant will retire", async () => {
    const fake = held({ select: { [TOKENS]: [[{ id: 501, rotationVersion: 3 }]] } });
    state.db = fake.db;

    expect(await suspendForReauthorization(LEASE)).toEqual({ retiring: { tokenRowId: 501, rotationVersion: 3 } });
    const suspend = fake.writes("update", STORES)[0];
    expect(suspend?.data).toEqual({ status: "reauthorization_required", statusReason: "reauthorization_pending" });
    expect(suspend?.where?.params).toEqual(expect.arrayContaining([SHOP, "active"]));
    // Lease renewed first, then suspend, then read the pair — one transaction.
    const kinds = fake.ops.map((op) => `${op.kind}:${op.table}`);
    expect(kinds.indexOf(`update:${LEASES}`)).toBeLessThan(kinds.indexOf(`update:${STORES}`));
    expect(kinds.indexOf(`update:${STORES}`)).toBeLessThan(kinds.indexOf(`select:${TOKENS}`));
    const txIds = new Set(fake.ops.map((op) => op.txId));
    expect(txIds.size).toBe(1);
    expect([...txIds][0]).not.toBeNull();
  });

  it("should retire nothing when the store holds no credentials", async () => {
    state.db = held({ select: { [TOKENS]: [[]] } }).db;
    expect(await suspendForReauthorization(LEASE)).toEqual({ retiring: "none" });
  });

  it("should suspend nothing when this callback's lease was taken over", async () => {
    // Greptile #134, seventh pass: a callback that stalled past its TTL must
    // not disable the installation that took over and reactivated the store.
    const fake = held({ update: { [LEASES]: [0] } });
    state.db = fake.db;
    expect(await suspendForReauthorization(LEASE)).toBeNull();
    expect(fake.writes("update", STORES)).toEqual([]);
  });
});

describe("when this callback's install lease was taken over mid-install", () => {
  // Greptile #134, sixth pass: past the lease TTL another callback can take
  // the shop. It renewed the lease right before ITS exchange, so its grant is
  // the later one — this callback must write nothing, success or failure.
  const lost = (script: Parameters<typeof scriptedDb>[0] = {}) => scriptedDb({ ...script, standing: { [LEASES]: [] } });

  it("should not activate the store or store its pair", async () => {
    const fake = lost({ select: { [STORES]: [[existingStore]], [USERS]: [[{ id: 9 }]] } });
    state.db = fake.db;

    expect(await codeOf(onboard)).toBe("INSTALL_LEASE_LOST");
    expect(fake.writes("insert", TOKENS)).toEqual([]);
    expect(storeUpdates(fake.committed())).toEqual([]);
    expect(fake.writes("delete", TOKENS)).toEqual([]); // and no fail-close either
  });

  it("should check the lease with a locking read inside the transaction that writes", async () => {
    const fake = held({
      select: {
        [STORES]: [[existingStore], [{ privacyRedactionState: "active" }]],
        [USERS]: [[{ id: 9 }]],
        [ORGS]: [[{ code: "SHP_ABC" }]],
      },
    });
    state.db = fake.db;
    await onboard();
    const check = fake.ops.find((op) => op.kind === "select" && op.table === LEASES);
    expect(check?.locked).toBe(true);
    expect(check?.txId).toBe(fake.writes("insert", TOKENS)[0]?.txId);
    expect(check?.where?.params).toEqual([SHOP, LEASE.leaseId]);
  });

  it("should leave the store alone on an ownership refusal too", async () => {
    const fake = lost({ select: { [STORES]: [[existingStore]], [USERS]: [[]] } });
    state.db = fake.db;
    let failClosed: unknown;
    try {
      await onboard();
    } catch (error) {
      failClosed = (error as ShopifyOnboardingError).storeFailClosed;
    }
    expect(failClosed).toBe("superseded");
    expect(fake.writes("delete", TOKENS)).toEqual([]);
    expect(storeUpdates(fake.committed())).toEqual([]);
  });

  it("should not create a workspace for a first install", async () => {
    const fake = lost({ select: { [STORES]: [[]], [USERS]: [[]] } });
    state.db = fake.db;
    expect(await codeOf(onboardFirst)).toBe("INSTALL_LEASE_LOST");
    expect(fake.writes("insert", ORGS)).toEqual([]);
  });
});

describe("when taking a store out of service itself fails", () => {
  // Greptile #134 re-review: failClosed used to log and swallow, so a store
  // could keep reading `active` on a refresh token Shopify had already retired
  // while the caller reported the refusal as if it were complete.
  const failClosedOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return null;
    } catch (error) {
      return error instanceof ShopifyOnboardingError ? error.storeFailClosed : "other";
    }
  };

  it("should retry, then report the transition as not confirmed rather than swallow it", async () => {
    const down = new Error("ECONNRESET");
    const fake = held({ select: { [STORES]: [[existingStore]], [USERS]: [[]] }, delete: { [TOKENS]: [down, down, down] } });
    state.db = fake.db;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await failClosedOf(onboard)).toBe("not_confirmed");
    expect(fake.ops.filter((op) => op.kind === "delete" && op.table === TOKENS)).toHaveLength(3);
    expect(log.mock.calls.flat().join(" ")).toMatch(/FAIL-CLOSED NOT CONFIRMED/);
    log.mockRestore();
  });

  it("should confirm it once a retry succeeds after a transient failure", async () => {
    const fake = held({
      select: { [STORES]: [[existingStore]], [USERS]: [[]] },
      delete: { [TOKENS]: [new Error("ECONNRESET"), 1] },
    });
    state.db = fake.db;

    expect(await failClosedOf(onboard)).toBe("confirmed");
    expect(storeUpdates(fake.committed())).toEqual([{ status: "reauthorization_required", statusReason: "ownership_unverified" }]);
  });

  it("should still refuse with the original reason either way", async () => {
    const down = new Error("ECONNRESET");
    state.db = held({ select: { [STORES]: [[existingStore]], [USERS]: [[]] }, delete: { [TOKENS]: [down, down, down] } }).db;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await codeOf(onboard)).toBe("OWNERSHIP_UNVERIFIED");
    vi.mocked(console.error).mockRestore();
  });
});

describe("when Shopify returns no usable contact email", () => {
  it("should refuse before touching the database", async () => {
    const fake = held();
    state.db = fake.db;
    const code = await codeOf(() =>
      onboardShopifyMerchant({
        shopDomain: SHOP,
        metadata: { ...metadata, contactEmail: "not-an-email" },
        tokenResponse,
        origin: "https://x",
        reauthorization: { retiring: "none" },
        lease: LEASE,
      }),
    );
    expect(code).toBe("MISSING_CONTACT_EMAIL");
    expect(fake.ops).toEqual([]);
  });
});
