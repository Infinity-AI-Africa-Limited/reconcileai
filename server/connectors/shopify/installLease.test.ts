import { describe, expect, it } from "vitest";
import { acquireInstallLease, releaseInstallLease } from "./installLease";
import { duplicateKeyError, scriptedDb } from "./scriptedDb.testkit";

const SHOP = "merchant.myshopify.com";
const LEASES = "shopify_install_leases";
const NOW = new Date("2026-09-22T12:00:00Z");

describe("acquireInstallLease", () => {
  it("should take a shop's lease when none exists", async () => {
    const fake = scriptedDb();
    const leaseId = await acquireInstallLease(fake.db as never, SHOP, NOW);
    expect(leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.writes("insert", LEASES)[0]?.data).toMatchObject({ shopDomain: SHOP, leaseId });
  });

  it("should refuse while another callback holds a live lease", async () => {
    const fake = scriptedDb({ insert: { [LEASES]: [duplicateKeyError()] }, update: { [LEASES]: [0] } });
    expect(await acquireInstallLease(fake.db as never, SHOP, NOW)).toBeNull();
  });

  it("should take over an expired lease, with one conditional update", async () => {
    const fake = scriptedDb({ insert: { [LEASES]: [duplicateKeyError()] }, update: { [LEASES]: [1] } });
    const leaseId = await acquireInstallLease(fake.db as never, SHOP, NOW);
    expect(leaseId).not.toBeNull();
    const takeover = fake.writes("update", LEASES)[0];
    // Conditioned on the old lease having expired as of now — so of two
    // callbacks racing for it, only one can match.
    expect(takeover?.where?.sql).toMatch(/`expiresAt` < \?/);
    expect(takeover?.where?.params).toEqual(expect.arrayContaining([SHOP]));
  });

  it("should not mistake an unrelated database error for a held lease", async () => {
    const fake = scriptedDb({ insert: { [LEASES]: [new Error("ECONNRESET")] } });
    await expect(acquireInstallLease(fake.db as never, SHOP, NOW)).rejects.toThrow("ECONNRESET");
  });
});

describe("releaseInstallLease", () => {
  it("should release only the lease this callback holds", async () => {
    const fake = scriptedDb();
    await releaseInstallLease(fake.db as never, SHOP, "lease-a");
    expect(fake.writes("delete", LEASES)[0]?.where?.params).toEqual([SHOP, "lease-a"]);
  });
});
