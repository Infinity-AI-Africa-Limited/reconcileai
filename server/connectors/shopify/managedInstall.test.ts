import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

const state = vi.hoisted(() => ({
  verify: vi.fn(),
  queues: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  suspend: vi.fn(),
  exchange: vi.fn(),
  metadata: vi.fn(),
  onboard: vi.fn(),
  failClosed: vi.fn(),
  db: null as unknown,
}));

vi.mock("../../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: vi.fn(async () => state.db),
}));
vi.mock("./embeddedAuth", async importOriginal => ({
  ...(await importOriginal<typeof import("./embeddedAuth")>()),
  verifyShopifyIdToken: state.verify,
}));
vi.mock("./runtimeQueueReadiness", () => ({
  confirmShopifyRuntimeQueues: state.queues,
}));
vi.mock("./installLease", async importOriginal => ({
  ...(await importOriginal<typeof import("./installLease")>()),
  acquireInstallLease: state.acquire,
  releaseInstallLease: state.release,
}));
vi.mock("./auth", async importOriginal => ({
  ...(await importOriginal<typeof import("./auth")>()),
  exchangeShopifyIdTokenForOfflineAccess: state.exchange,
}));
vi.mock("./apiClient", () => ({ fetchShopifyShopMetadata: state.metadata }));
vi.mock("./onboarding", async importOriginal => ({
  ...(await importOriginal<typeof import("./onboarding")>()),
  suspendForReauthorization: state.suspend,
  onboardShopifyMerchant: state.onboard,
  failClosedAfterTokenExchange: state.failClosed,
}));

import { scriptedDb } from "./scriptedDb.testkit";
import {
  completeShopifyManagedInstall,
  ShopifyManagedInstallError,
} from "./managedInstall";

const SHOP = "merchant.myshopify.com";
const STORES = "shopify_connector_stores";
const token = {
  access_token: "access",
  refresh_token: "refresh",
  scope: "read_orders",
  expires_in: 3600,
};
const metadata = {
  id: "gid://shopify/Shop/1001",
  name: "Merchant Ltd",
  contactEmail: "owner@example.com",
  primaryDomain: null,
  currencyCode: "USD",
  ianaTimezone: "Africa/Lagos",
};
const lease = { shopDomain: SHOP, leaseId: "lease-1" };

function noActiveStore() {
  state.db = scriptedDb({ select: { [STORES]: [[], []] } }).db;
}

async function errorCode(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof ShopifyManagedInstallError
      ? error.code
      : `other:${(error as Error).message}`;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.verify.mockResolvedValue({ shopDomain: SHOP, shopifyUserId: "123" });
  state.queues.mockResolvedValue({ status: "confirmed", durable: true });
  state.acquire.mockResolvedValue(lease.leaseId);
  state.release.mockResolvedValue(undefined);
  state.suspend.mockResolvedValue({ retiring: "none" });
  state.exchange.mockResolvedValue({ kind: "exchanged", token });
  state.metadata.mockResolvedValue(metadata);
  state.onboard.mockResolvedValue({ isReinstallation: false });
  state.failClosed.mockResolvedValue(undefined);
  noActiveStore();
});

describe("Shopify managed installation", () => {
  it("should verify the App Bridge identity, exchange its bearer token once, and provision a new workspace", async () => {
    await expect(
      completeShopifyManagedInstall({
        authorization: "Bearer id-token",
        origin: "https://www.reconcileaiafrica.com",
      })
    ).resolves.toEqual({
      status: "connected",
    });

    expect(state.verify).toHaveBeenCalledWith("Bearer id-token");
    expect(state.exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: SHOP,
        idToken: "id-token",
        reauthorization: { retiring: "none" },
      })
    );
    expect(state.metadata).toHaveBeenCalledWith({
      shopDomain: SHOP,
      accessToken: "access",
    });
    expect(state.onboard).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: SHOP,
        metadata,
        tokenResponse: token,
        lease,
      })
    );
    expect(state.release).toHaveBeenCalledWith(
      expect.anything(),
      SHOP,
      lease.leaseId
    );
    expect(JSON.stringify(state.onboard.mock.calls)).not.toContain("id-token");
  });

  it("should not exchange or rotate credentials each time an active store opens App Home", async () => {
    state.db = scriptedDb({ select: { [STORES]: [[{ id: 7 }]] } }).db;

    await expect(
      completeShopifyManagedInstall({
        authorization: "Bearer id-token",
        origin: "https://www.reconcileaiafrica.com",
      })
    ).resolves.toEqual({
      status: "already_connected",
    });

    expect(state.acquire).not.toHaveBeenCalled();
    expect(state.exchange).not.toHaveBeenCalled();
    expect(state.onboard).not.toHaveBeenCalled();
  });

  it("should refuse before database access or exchange when durable queues are unavailable", async () => {
    state.queues.mockResolvedValue({
      status: "unavailable",
      durable: false,
      reason: "queue_unavailable",
    });

    expect(
      await errorCode(() =>
        completeShopifyManagedInstall({
          authorization: "Bearer id-token",
          origin: "https://www.reconcileaiafrica.com",
        })
      )
    ).toBe("DURABLE_QUEUE_UNAVAILABLE");
    expect(state.acquire).not.toHaveBeenCalled();
    expect(state.exchange).not.toHaveBeenCalled();
  });

  it("should serialize the token exchange per shop", async () => {
    state.acquire.mockResolvedValue(null);

    expect(
      await errorCode(() =>
        completeShopifyManagedInstall({
          authorization: "Bearer id-token",
          origin: "https://www.reconcileaiafrica.com",
        })
      )
    ).toBe("INSTALLATION_IN_PROGRESS");
    expect(state.exchange).not.toHaveBeenCalled();
  });

  it("should fail closed if a successful exchange does not carry the required read-only scope", async () => {
    state.exchange.mockResolvedValue({
      kind: "exchanged",
      token: { ...token, scope: "read_products" },
    });

    expect(
      await errorCode(() =>
        completeShopifyManagedInstall({
          authorization: "Bearer id-token",
          origin: "https://www.reconcileaiafrica.com",
        })
      )
    ).toBe("REQUIRED_PERMISSIONS_NOT_GRANTED");
    expect(state.failClosed).toHaveBeenCalledWith(lease, { retiring: "none" });
    expect(state.metadata).not.toHaveBeenCalled();
    expect(state.onboard).not.toHaveBeenCalled();
  });

  it("should fail closed if metadata cannot be loaded after Shopify issued a token", async () => {
    state.metadata.mockRejectedValue(new Error("provider unavailable"));

    expect(
      await errorCode(() =>
        completeShopifyManagedInstall({
          authorization: "Bearer id-token",
          origin: "https://www.reconcileaiafrica.com",
        })
      )
    ).toBe("SHOP_METADATA_UNAVAILABLE");
    expect(state.failClosed).toHaveBeenCalledWith(lease, { retiring: "none" });
    expect(state.onboard).not.toHaveBeenCalled();
  });

  it("should ask the browser to obtain a fresh ID token without exposing provider detail", async () => {
    state.exchange.mockResolvedValue({ kind: "id_token_rejected" });

    expect(
      await errorCode(() =>
        completeShopifyManagedInstall({
          authorization: "Bearer id-token",
          origin: "https://www.reconcileaiafrica.com",
        })
      )
    ).toBe("ID_TOKEN_REJECTED");
    expect(state.metadata).not.toHaveBeenCalled();
    expect(state.onboard).not.toHaveBeenCalled();
  });
});
