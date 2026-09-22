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

import { encryptForTenant } from "../../_core/tenantKeys";
import { sendWelcomeEmail } from "../../magicLinkService";
import { provisionTenantBaseline } from "../../provisioning";
import { onboardShopifyMerchant, ShopifyOnboardingError } from "./onboarding";
import { duplicateKeyError, scriptedDb, type RecordedOp } from "./scriptedDb.testkit";

const SHOP = "merchant.myshopify.com";
const SHOP_ID = "gid://shopify/Shop/1001";
const STORES = "shopify_connector_stores";
const TOKENS = "shopify_connector_tokens";
const USERS = "users";
const ORGS = "organizations";

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
  claimedByUserId: 9,
  claimedAt: new Date("2026-09-01T00:00:00Z"),
};

const onboard = () =>
  onboardShopifyMerchant({ shopDomain: SHOP, metadata, tokenResponse, origin: "https://www.reconcileaiafrica.com" });

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
      const fake = scriptedDb({ select: { [STORES]: [[existingStore]], [USERS]: [[]] } });
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
      expect(fake.writes("delete", TOKENS)[0]?.where?.params).toEqual(expect.arrayContaining([7, 42]));
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
      const fake = scriptedDb({ select: { [STORES]: [[existingStore]], [USERS]: [[{ id: 9 }]], [ORGS]: [[{ code: "SHP_ABC" }]] } });
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
      const fake = scriptedDb({
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
      const fake = scriptedDb({ select: { [STORES]: [[existingStore]], [USERS]: [[{ id: 9 }]] } });
      state.db = fake.db;
      vi.mocked(encryptForTenant).mockRejectedValueOnce(new Error("KMS unavailable"));

      expect(await codeOf(onboard)).toBe("TOKEN_STORE_FAILED");
      expect(storeUpdates(fake.committed())).toEqual([{ status: "reauthorization_required", statusReason: "token_store_failed" }]);
    });
  });

  describe("and the permanent domain now names a different shop", () => {
    it("should refuse without writing anything", async () => {
      const fake = scriptedDb({ select: { [STORES]: [[{ ...existingStore, shopId: "gid://shopify/Shop/9999" }]] } });
      state.db = fake.db;

      expect(await codeOf(onboard)).toBe("SHOP_IDENTITY_CONFLICT");
      expect(fake.ops.filter((op) => op.kind !== "select")).toEqual([]);
    });
  });
});

describe("when a shop installs for the first time", () => {
  function firstInstall(extra: Parameters<typeof scriptedDb>[0] = {}) {
    const fake = scriptedDb({
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
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  describe("and a concurrent callback for the same shop created the workspace first", () => {
    // Greptile #134 finding 4: the loser used to show a generic failure while
    // the other callback had completed the install.
    it("should complete as a reauthorization of the winning store", async () => {
      const winner = { ...existingStore, status: "pending_claim" };
      const fake = scriptedDb({
        select: { [STORES]: [[], [winner]], [USERS]: [[], [{ id: 9 }]], [ORGS]: [[{ code: "SHP_ABC" }]] },
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
      const fake = scriptedDb({
        select: { [STORES]: [[], [existingStore]], [USERS]: [[], []] },
        insert: { [ORGS]: [duplicateKeyError()] },
      });
      state.db = fake.db;
      expect(await codeOf(onboard)).toBe("OWNERSHIP_UNVERIFIED");
    });

    it("should refuse clearly when the conflicting workspace has no store to resolve", async () => {
      const fake = scriptedDb({ select: { [STORES]: [[], []], [USERS]: [[]] }, insert: { [ORGS]: [duplicateKeyError()] } });
      state.db = fake.db;
      expect(await codeOf(onboard)).toBe("WORKSPACE_CONFLICT");
    });

    it("should not treat an unrelated database error as a concurrent install", async () => {
      const fake = scriptedDb({ select: { [STORES]: [[]], [USERS]: [[]] }, insert: { [ORGS]: [new Error("ECONNRESET")] } });
      state.db = fake.db;
      expect(await codeOf(onboard)).toBe("other:ECONNRESET");
    });
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
    const fake = scriptedDb({ select: { [STORES]: [[existingStore]], [USERS]: [[]] }, delete: { [TOKENS]: [down, down, down] } });
    state.db = fake.db;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await failClosedOf(onboard)).toBe("not_confirmed");
    expect(fake.ops.filter((op) => op.kind === "delete" && op.table === TOKENS)).toHaveLength(3);
    expect(log.mock.calls.flat().join(" ")).toMatch(/FAIL-CLOSED NOT CONFIRMED/);
    log.mockRestore();
  });

  it("should confirm it once a retry succeeds after a transient failure", async () => {
    const fake = scriptedDb({
      select: { [STORES]: [[existingStore]], [USERS]: [[]] },
      delete: { [TOKENS]: [new Error("ECONNRESET"), 1] },
    });
    state.db = fake.db;

    expect(await failClosedOf(onboard)).toBe("confirmed");
    expect(storeUpdates(fake.committed())).toEqual([{ status: "reauthorization_required", statusReason: "ownership_unverified" }]);
  });

  it("should still refuse with the original reason either way", async () => {
    const down = new Error("ECONNRESET");
    state.db = scriptedDb({ select: { [STORES]: [[existingStore]], [USERS]: [[]] }, delete: { [TOKENS]: [down, down, down] } }).db;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await codeOf(onboard)).toBe("OWNERSHIP_UNVERIFIED");
    vi.mocked(console.error).mockRestore();
  });
});

describe("when Shopify returns no usable contact email", () => {
  it("should refuse before touching the database", async () => {
    const fake = scriptedDb();
    state.db = fake.db;
    const code = await codeOf(() =>
      onboardShopifyMerchant({ shopDomain: SHOP, metadata: { ...metadata, contactEmail: "not-an-email" }, tokenResponse, origin: "https://x" }),
    );
    expect(code).toBe("MISSING_CONTACT_EMAIL");
    expect(fake.ops).toEqual([]);
  });
});
