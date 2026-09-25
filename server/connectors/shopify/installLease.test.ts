import { describe, expect, it } from "vitest";
import { acquireInstallLease, holdsInstallLease, releaseInstallLease, renewInstallLease } from "./installLease";
import { duplicateKeyError, scriptedDb } from "./scriptedDb.testkit";

const SHOP = "merchant.myshopify.com";
const LEASES = "shopify_install_leases";
const NOW = new Date("2026-09-22T12:00:00Z");

describe("when a callback claims the install lease for a shop", () => {
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

describe("when a callback releases the lease it holds", () => {
  it("should release only the lease this callback holds", async () => {
    const fake = scriptedDb();
    await releaseInstallLease(fake.db as never, SHOP, "lease-a");
    expect(fake.writes("delete", LEASES)[0]?.where?.params).toEqual([SHOP, "lease-a"]);
  });
});

describe("when a callback extends its lease mid-install", () => {
  it("should extend a lease this callback still holds", async () => {
    const fake = scriptedDb({ update: { [LEASES]: [1] } });
    expect(await renewInstallLease(fake.db as never, { shopDomain: SHOP, leaseId: "lease-a" }, NOW)).toBe(true);
    expect(fake.writes("update", LEASES)[0]?.where?.params).toEqual([SHOP, "lease-a"]);
  });

  it("should report a lease that was taken over", async () => {
    const fake = scriptedDb({ update: { [LEASES]: [0] } });
    expect(await renewInstallLease(fake.db as never, { shopDomain: SHOP, leaseId: "lease-a" }, NOW)).toBe(false);
  });
});

describe("when a callback checks it still holds the lease", () => {
  it("should answer with a locking read, so a takeover cannot commit before the caller does", async () => {
    const fake = scriptedDb({ select: { [LEASES]: [[{ leaseId: "lease-a" }]] } });
    expect(await holdsInstallLease(fake.db as never, { shopDomain: SHOP, leaseId: "lease-a" })).toBe(true);
    const read = fake.ops[0];
    expect(read?.locked).toBe(true);
    expect(read?.where?.params).toEqual([SHOP, "lease-a"]);
  });

  it("should be false once another callback holds it", async () => {
    const fake = scriptedDb({ select: { [LEASES]: [[]] } });
    expect(await holdsInstallLease(fake.db as never, { shopDomain: SHOP, leaseId: "lease-a" })).toBe(false);
  });
});
