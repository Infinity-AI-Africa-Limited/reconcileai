/**
 * `shoplineConnector.uninstall` must never touch another tenant's store.
 *
 * It is open to any tenant admin. It scoped its status update to the caller's
 * organisation, then deleted credentials by store id ALONE — so an admin of one
 * tenant could delete another tenant's SHOPLINE credentials by naming its store
 * id (they are sequential) and break that merchant's syncs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: vi.fn(async () => state.db),
}));

import { appRouter } from "./routers";
import { deleteToken } from "./connectors/shopline/tokenStore";
import { scriptedDb } from "./connectors/shopify/scriptedDb.testkit";

const TOKENS = "sl_connector_tokens";
const STORES = "sl_connector_stores";
const OWN_ORG = 42;
const ANOTHER_TENANTS_STORE = 999;

function adminOf(organizationId: number) {
  return appRouter.createCaller({
    user: { id: 7, role: "admin", organizationId, email: "admin@example.com" },
    viewingAs: null,
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie: () => {}, clearCookie: () => {} },
  } as never);
}

beforeEach(() => {
  state.db = scriptedDb().db;
});

describe("when a tenant admin uninstalls a store id that is not theirs", () => {
  it("should delete credentials only within their own organisation", async () => {
    const fake = scriptedDb();
    state.db = fake.db;

    await adminOf(OWN_ORG).shoplineConnector.uninstall({ storeId: ANOTHER_TENANTS_STORE });

    const [tokenDelete] = fake.writes("delete", TOKENS);
    expect(tokenDelete?.where?.params).toEqual([ANOTHER_TENANTS_STORE, OWN_ORG]);
    expect(tokenDelete?.where?.sql).toMatch(/`sl_connector_tokens`\.`organizationId` = \?/);
    // The status change was already scoped; both writes now name the same tenant.
    expect(fake.writes("update", STORES)[0]?.where?.params).toEqual(expect.arrayContaining([ANOTHER_TENANTS_STORE, OWN_ORG]));
  });
});

describe("when any caller deletes a store's credentials", () => {
  it("should require the owning tenant, so a store id alone can never reach another tenant", async () => {
    const fake = scriptedDb();
    await deleteToken(fake.db as never, 5, 60001);

    expect(fake.writes("delete", TOKENS)[0]?.where?.params).toEqual([5, 60001]);
  });
});
