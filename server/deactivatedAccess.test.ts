/**
 * A deactivated account, or a fenced tenant, loses access on its next request.
 *
 * Two doors stayed open after deactivation:
 *
 *   - a SESSION: magic-link sign-in refuses an inactive user, but the session
 *     cookie is a stateless JWT, and nothing re-checked the account on use — so a
 *     user deactivated by an administrator, or by a Shopify `shop/redact` fence
 *     (which deactivates every user of the tenant), kept working until expiry;
 *   - an API KEY: validation checked only that the key itself was active, so a
 *     key could keep writing transactions for an organisation being redacted.
 *
 * Both are exercised through the real gate — `sdk.authenticateRequest` with a
 * genuinely signed cookie, and `validateApiKey` — not by reading the code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ENV is a frozen snapshot, so the signing secret must exist before it loads.
vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "deactivated-access-test-secret-0123456789";
});

const getUserByOpenId = vi.hoisted(() => vi.fn());
const getDb = vi.hoisted(() => vi.fn());
vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getUserByOpenId,
  getDb,
}));

import { COOKIE_NAME } from "@shared/const";
import { sdk } from "./_core/sdk";
import { validateApiKey } from "./apiIngestionService";
import { scriptedDb } from "./connectors/shopify/scriptedDb.testkit";

beforeEach(() => {
  getUserByOpenId.mockReset();
  getDb.mockReset();
});

const account = (over: Record<string, unknown> = {}) => ({
  id: 5,
  openId: "user_5",
  name: "Merchant Admin",
  email: "admin@example.com",
  loginMethod: "magic_link",
  role: "admin",
  organizationId: 42,
  isGuest: false,
  isReadOnly: false,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
  ...over,
});

async function requestSignedInAs(user: ReturnType<typeof account>) {
  const token = await sdk.createSessionToken(user.openId, { name: user.name });
  getUserByOpenId.mockResolvedValue(user);
  return { headers: { cookie: `${COOKIE_NAME}=${token}` } } as never;
}

describe("when a signed-in account is deactivated", () => {
  it("should refuse its still-valid session on the very next request", async () => {
    const req = await requestSignedInAs(account({ isActive: false }));
    await expect(sdk.authenticateRequest(req)).rejects.toThrow(/deactivated/i);
  });

  it("should keep admitting an active account's session", async () => {
    const req = await requestSignedInAs(account());
    await expect(sdk.authenticateRequest(req)).resolves.toMatchObject({ id: 5 });
  });
});

describe("when an API key is presented", () => {
  const KEY = "k".repeat(40);
  const keyRow = { id: 3, keyHash: "h", organizationId: 42, userId: 5, isActive: true, expiresAt: null };

  function withRows(owner: unknown[], org: unknown[]) {
    const fake = scriptedDb({ select: { api_keys: [[keyRow]], users: [owner], organizations: [org] } });
    getDb.mockResolvedValue(fake.db);
    return fake;
  }

  it("should refuse a key whose owner has been deactivated", async () => {
    withRows([{ isActive: false }], [{ isActive: true, deletionState: "active" }]);
    await expect(validateApiKey(KEY)).resolves.toMatchObject({ valid: false, error: "API key owner is inactive" });
  });

  it("should refuse a key whose organisation is being redacted", async () => {
    withRows([{ isActive: true }], [{ isActive: false, deletionState: "redacting" }]);
    await expect(validateApiKey(KEY)).resolves.toMatchObject({ valid: false, error: "API key organisation is inactive" });
  });

  it("should refuse a key whose organisation is merely deactivated", async () => {
    withRows([{ isActive: true }], [{ isActive: false, deletionState: "active" }]);
    await expect(validateApiKey(KEY)).resolves.toMatchObject({ valid: false });
  });

  it("should accept a key whose owner and organisation are both live", async () => {
    const fake = withRows([{ isActive: true }], [{ isActive: true, deletionState: "active" }]);
    await expect(validateApiKey(KEY)).resolves.toMatchObject({ valid: true, organizationId: 42, userId: 5 });
    // The owner and tenant checks read the key's own owner and tenant.
    const owner = fake.ops.find((op) => op.kind === "select" && op.table === "users");
    const org = fake.ops.find((op) => op.kind === "select" && op.table === "organizations");
    expect(owner?.where?.params).toEqual([5]);
    expect(org?.where?.params).toEqual([42]);
  });
});
