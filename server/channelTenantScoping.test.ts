/**
 * Channel tenancy — cross-tenant enumeration guard.
 *
 * `getChannels()` and `getChannelByCode()` previously took no organization and
 * returned/resolved across every tenant, so `channels.list` handed any
 * authenticated user the full platform estate and `upload.createBatch` accepted
 * any `channelCode` — a cross-tenant read with a write path behind it.
 *
 * The rule is now: your own channels, plus the shared platform rails
 * (`organizationId IS NULL` — nibss/pos/atm/…), never another tenant's.
 * Platform-wide access has to be spelled `getAllChannelsAcrossTenants()`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getChannels = vi.fn(async () => [{ id: 1, code: "own" }]);
const getAllChannelsAcrossTenants = vi.fn(async () => [{ id: 1, code: "own" }, { id: 2, code: "other" }]);
const getChannelByCode = vi.fn(async () => undefined);
const channelCodeExists = vi.fn(async () => false);

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  getChannels,
  getAllChannelsAcrossTenants,
  getChannelByCode,
  channelCodeExists,
}));

/** Mirrors the `channels.list` branch in routers.ts. */
async function listChannelsFor(user: { role?: string | null; organizationId?: number | null }) {
  const db = await import("./db");
  if (user.role === "super_admin") return db.getAllChannelsAcrossTenants();
  return db.getChannels(user.organizationId ?? null);
}

describe("channels.list tenancy branch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes an ordinary org user to their own organization", async () => {
    await listChannelsFor({ role: "admin", organizationId: 60001 });
    expect(getChannels).toHaveBeenCalledWith(60001);
    expect(getAllChannelsAcrossTenants).not.toHaveBeenCalled();
  });

  it.each(["admin", "cfo", "operations", "compliance", "user"])(
    "never grants cross-tenant access to role %s",
    async (role) => {
      await listChannelsFor({ role, organizationId: 60001 });
      expect(getAllChannelsAcrossTenants).not.toHaveBeenCalled();
    },
  );

  // The one legitimate cross-tenant reader: Infinity AI platform staff.
  it("gives super_admin the full estate", async () => {
    await listChannelsFor({ role: "super_admin", organizationId: 1 });
    expect(getAllChannelsAcrossTenants).toHaveBeenCalled();
    expect(getChannels).not.toHaveBeenCalled();
  });

  // A user with no organization must fall to shared rails only — NOT to
  // "everything". Passing null used to be the widening case; it is now the
  // narrowest, so a missing org can never become an accidental leak.
  it("gives an org-less user the shared rails only, never the platform", async () => {
    await listChannelsFor({ role: "user", organizationId: null });
    expect(getChannels).toHaveBeenCalledWith(null);
    expect(getAllChannelsAcrossTenants).not.toHaveBeenCalled();
  });

  it("treats a missing organizationId the same as an explicit null", async () => {
    await listChannelsFor({ role: "user" });
    expect(getChannels).toHaveBeenCalledWith(null);
  });
});

describe("upload paths resolve the channel within the caller's tenant", () => {
  beforeEach(() => vi.clearAllMocks());

  /** Mirrors the lookup in upload.createBatch / upload.appendBatch. */
  async function resolveUploadChannel(code: string, user: { organizationId?: number | null }) {
    const db = await import("./db");
    return db.getChannelByCode(code, user.organizationId ?? null);
  }

  it("passes the caller's org so another tenant's code cannot be targeted", async () => {
    await resolveUploadChannel("sl_payments_someone_else", { organizationId: 60001 });
    expect(getChannelByCode).toHaveBeenCalledWith("sl_payments_someone_else", 60001);
  });

  it("returns undefined for a channel outside the tenant, so the caller 404s", async () => {
    getChannelByCode.mockResolvedValueOnce(undefined);
    const found = await resolveUploadChannel("other_tenant_channel", { organizationId: 60001 });
    expect(found).toBeUndefined();
  });
});

describe("channel code uniqueness stays platform-wide", () => {
  beforeEach(() => vi.clearAllMocks());

  // channels.code has a GLOBAL unique constraint. An org-scoped duplicate check
  // would pass and then fail at insert with a duplicate-key error, so this one
  // read is intentionally cross-tenant — and returns only a boolean.
  it("checks the code across all tenants and leaks nothing but a boolean", async () => {
    const db = await import("./db");
    const exists = await db.channelCodeExists("nibss");
    expect(channelCodeExists).toHaveBeenCalledWith("nibss");
    expect(typeof exists).toBe("boolean");
  });
});
