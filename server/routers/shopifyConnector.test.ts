/**
 * shopifyConnector.listStores — who may list which organisation's stores, and
 * what a caller is shown.
 *
 * Calls go through the real base procedure, so the portal scope is the one the
 * application opens (ctx.viewingAs → request scope), not a stub. The database is
 * scripted and every query's WHERE is rendered, so "scoped to the tenant" is
 * asserted on the predicate that was actually sent, not inferred from a result.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
const state = vi.hoisted(() => ({ db: null as unknown, runSync: vi.fn() }));

vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: vi.fn(async () => state.db),
}));
vi.mock("../connectors/shopify/syncOrchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../connectors/shopify/syncOrchestrator")>()),
  runShopifyOrderSync: state.runSync,
}));

import { SHOPIFY_STORE_PUBLIC_FIELDS, shopifyConnectorRouter } from "./shopifyConnector";
import { scriptedDb } from "../connectors/shopify/scriptedDb.testkit";

const OWN_ORG = 42;
const OTHER_ORG = 60001;
const STORES = "shopify_connector_stores";
const ARTIFACTS = "shopify_privacy_artifacts";

type Role = "admin" | "user" | "operations" | "compliance" | "cfo" | "super_admin";

function caller(role: Role | null, organizationId: number | null = OWN_ORG, viewingAs: number | null = null, isActive = true) {
  const user = role === null ? null : { id: 7, role, organizationId, isReadOnly: false, isActive, email: "person@example.com" };
  return shopifyConnectorRouter.createCaller({ user, viewingAs, req: { headers: {} }, res: {} } as never);
}

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof TRPCError ? error.code : `NON_TRPC:${(error as Error).message}`;
  }
}

/** The organisation id the store query filtered on. */
function scopedOrg(fake: ReturnType<typeof scriptedDb>): unknown {
  const query = fake.ops.find((op) => op.kind === "select" && op.table === STORES);
  expect(query?.where?.sql).toMatch(/`shopify_connector_stores`\.`organizationId` = \?/);
  return query?.where?.params[0];
}

let fake: ReturnType<typeof scriptedDb>;
beforeEach(() => {
  fake = scriptedDb({ select: { [STORES]: [[{ id: 1, shopDomain: "merchant.myshopify.com", status: "active" }]] } });
  state.db = fake.db;
});

describe("when a tenant user lists stores", () => {
  it("should read their own organisation's stores only", async () => {
    const rows = await caller("admin").listStores();
    expect(rows).toEqual([{ id: 1, shopDomain: "merchant.myshopify.com", status: "active" }]);
    expect(scopedOrg(fake)).toBe(OWN_ORG);
  });

  it("should accept an empty input the same way", async () => {
    await caller("operations").listStores({});
    expect(scopedOrg(fake)).toBe(OWN_ORG);
  });

  it.each<Role>(["admin", "user", "operations", "compliance", "cfo"])(
    "should refuse %s naming another organisation, before any query runs",
    async (role) => {
      expect(await codeOf(() => caller(role).listStores({ organizationId: OTHER_ORG }))).toBe("FORBIDDEN");
      expect(fake.ops).toEqual([]);
    },
  );

  it("should refuse even when the named organisation is their own — the override is staff-only", async () => {
    expect(await codeOf(() => caller("admin").listStores({ organizationId: OWN_ORG }))).toBe("FORBIDDEN");
  });
});

describe("when Infinity AI staff list stores", () => {
  it("should read a named organisation from outside any portal", async () => {
    await caller("super_admin", 1).listStores({ organizationId: OTHER_ORG });
    expect(scopedOrg(fake)).toBe(OTHER_ORG);
  });

  it("should default to the tenant on screen inside a portal", async () => {
    // applyPortalView makes the viewed tenant the request's organisation.
    await caller("super_admin", OTHER_ORG, OTHER_ORG).listStores();
    expect(scopedOrg(fake)).toBe(OTHER_ORG);
  });

  it("should allow naming the tenant on screen inside its portal", async () => {
    await caller("super_admin", OTHER_ORG, OTHER_ORG).listStores({ organizationId: OTHER_ORG });
    expect(scopedOrg(fake)).toBe(OTHER_ORG);
  });

  it("should refuse naming a different tenant from inside a portal", async () => {
    // A stale id from tenant B, opened in tenant A's portal, would otherwise list
    // B's stores under A's banner (CLAUDE.md §6, the by-id rule from PR #141).
    expect(await codeOf(() => caller("super_admin", OTHER_ORG, OTHER_ORG).listStores({ organizationId: OWN_ORG }))).toBe(
      "FORBIDDEN",
    );
    expect(fake.ops).toEqual([]);
  });
});

describe("when the caller has no usable identity", () => {
  it("should refuse an account with no organisation rather than widen the query", async () => {
    expect(await codeOf(() => caller("admin", null).listStores())).toBe("PRECONDITION_FAILED");
    expect(fake.ops).toEqual([]);
  });

  it("should refuse an unauthenticated caller", async () => {
    expect(await codeOf(() => caller(null).listStores())).toBe("UNAUTHORIZED");
  });
});

describe("when the database is unavailable", () => {
  it("should fail rather than report that the merchant has no stores", async () => {
    state.db = null;
    expect(await codeOf(() => caller("admin").listStores())).toBe("INTERNAL_SERVER_ERROR");
  });

  it("should surface a failing query as an error, not an empty list", async () => {
    state.db = scriptedDb({ select: { [STORES]: [new Error("ECONNRESET")] } }).db;
    expect(await codeOf(() => caller("admin").listStores())).not.toBeNull();
  });
});

describe("what a store summary exposes", () => {
  it("should project exactly the merchant-safe fields", () => {
    expect(Object.keys(SHOPIFY_STORE_PUBLIC_FIELDS).sort()).toEqual(
      [
        "claimedAt",
        "createdAt",
        "currency",
        "displayName",
        "grantedScopes",
        "ianaTimezone",
        "id",
        "lastWebhookAt",
        "requestedScopes",
        "shopDomain",
        "status",
        "statusReason",
        "uninstalledAt",
      ].sort(),
    );
  });

  it("should never project credentials, the claiming user or the Shopify shop id", () => {
    const keys = Object.keys(SHOPIFY_STORE_PUBLIC_FIELDS);
    for (const forbidden of ["accessTokenEnc", "refreshTokenEnc", "claimedByUserId", "shopId", "organizationId"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("when privacy artifact delivery is staged in the authenticated portal", () => {
  it("should project only non-sensitive notice fields to the exact claimant admin", async () => {
    const notice = {
      artifactId: "11111111-1111-4111-8111-111111111111",
      kind: "order_evidence",
      recordsFound: 1,
      generatedAt: new Date("2026-09-25T12:00:00Z"),
      expiresAt: new Date("2026-10-02T12:00:00Z"),
      deliveryStatus: "pending",
    };
    fake = scriptedDb({ select: { [ARTIFACTS]: [[notice]] } });
    state.db = fake.db;
    expect(await caller("admin").listPrivacyDeliveries()).toEqual([notice]);
    expect(fake.ops[0]?.where?.params).toEqual(expect.arrayContaining([OWN_ORG, 7, "ready"]));
    for (const forbidden of ["objectKey", "sha256", "organizationId", "storeId", "recipientUserId", "requestId"]) {
      expect(Object.keys(notice)).not.toContain(forbidden);
    }
  });

  it.each<Role>(["user", "operations", "compliance", "cfo", "super_admin"])(
    "should deny %s before reading artifact metadata",
    async (role) => {
      expect(await codeOf(() => caller(role).listPrivacyDeliveries())).toBe("FORBIDDEN");
      expect(fake.ops).toEqual([]);
    },
  );

  it("should deny an inactive admin before reading artifact metadata", async () => {
    expect(await codeOf(() => caller("admin", OWN_ORG, null, false).listPrivacyDeliveries())).toBe("FORBIDDEN");
    expect(fake.ops).toEqual([]);
  });
});

describe("when someone starts a manual Shopify order sync", () => {
  const REPORT = { success: true, fetched: 3, inserted: 1, updated: 1, unchanged: 1 };
  beforeEach(() => {
    state.runSync.mockReset();
    state.runSync.mockResolvedValue(REPORT);
  });

  it("should sync the store within the administrator's own organisation", async () => {
    await expect(caller("admin").syncOrdersNow({ storeId: 7 })).resolves.toEqual(REPORT);
    // The tenant comes from the session, never the input; the orchestrator
    // then selects the store by (storeId, organizationId).
    expect(state.runSync).toHaveBeenCalledWith({ storeId: 7, organizationId: OWN_ORG, trigger: "manual" });
  });

  it.each<Role>(["user", "operations", "compliance", "cfo"])(
    "should refuse %s before anything runs — it writes the tenant's reconciliation workspace",
    async (role) => {
      expect(await codeOf(() => caller(role).syncOrdersNow({ storeId: 7 }))).toBe("FORBIDDEN");
      expect(state.runSync).not.toHaveBeenCalled();
    },
  );

  it("should refuse an administrator naming another organisation", async () => {
    expect(await codeOf(() => caller("admin").syncOrdersNow({ storeId: 7, organizationId: OTHER_ORG }))).toBe("FORBIDDEN");
    expect(state.runSync).not.toHaveBeenCalled();
  });

  it("should refuse a read-only session, whatever its role", async () => {
    const readOnly = shopifyConnectorRouter.createCaller({
      user: { id: 7, role: "admin", organizationId: OWN_ORG, isReadOnly: true, email: "reviewer@example.com" },
      viewingAs: null,
      req: { headers: {} },
      res: {},
    } as never);
    expect(await codeOf(() => readOnly.syncOrdersNow({ storeId: 7 }))).toBe("FORBIDDEN");
    expect(state.runSync).not.toHaveBeenCalled();
  });

  it("should let staff outside a portal sync the tenant they name", async () => {
    await caller("super_admin", 1).syncOrdersNow({ storeId: 7, organizationId: OTHER_ORG });
    expect(state.runSync).toHaveBeenCalledWith({ storeId: 7, organizationId: OTHER_ORG, trigger: "manual" });
  });

  it("should confine staff inside a portal to the tenant on screen", async () => {
    expect(
      await codeOf(() => caller("super_admin", OTHER_ORG, OTHER_ORG).syncOrdersNow({ storeId: 7, organizationId: OWN_ORG })),
    ).toBe("FORBIDDEN");
    expect(state.runSync).not.toHaveBeenCalled();
  });

  it("should answer a failed sync with a generic precondition error, not the internal message", async () => {
    state.runSync.mockRejectedValue(new Error("token decrypt failed for store 7: key tk1:abc"));
    const error = await caller("admin").syncOrdersNow({ storeId: 7 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");
    expect((error as TRPCError).message).not.toMatch(/decrypt|tk1/);
  });
});
