/**
 * Multi-tenant hardening tests: envelope key wrapping, tenant ciphertext
 * hygiene, tenancy guards, and the per-tenant rate limiter — all DB-free.
 */
import { beforeAll, describe, expect, it } from "vitest";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-hardening-suite";

type TenantKeysModule = typeof import("./tenantKeys");
type RateLimitModule = typeof import("./rateLimit");
type TenancyModule = typeof import("./tenancy");

let tk: TenantKeysModule;
let rl: RateLimitModule;
let tenancy: TenancyModule;

beforeAll(async () => {
  tk = await import("./tenantKeys");
  rl = await import("./rateLimit");
  tenancy = await import("./tenancy");
});

describe("tenant keys — local master-key provider", () => {
  it("wraps and unwraps a DEK losslessly", async () => {
    const provider = tk.getMasterKeyProvider();
    expect(provider.name).toBe("local"); // default when TENANT_KEY_PROVIDER unset
    const { dek, wrapped, kmsKeyId } = await provider.generateDek();
    expect(dek).toHaveLength(32);
    expect(kmsKeyId).toBeNull();
    expect(wrapped).not.toContain(dek.toString("hex")); // never stored raw
    const unwrapped = await provider.unwrapDek(wrapped, null);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("every wrap uses a fresh IV (identical DEKs produce distinct wraps)", async () => {
    const provider = tk.getMasterKeyProvider();
    const a = await provider.generateDek();
    const b = await provider.generateDek();
    expect(a.wrapped).not.toBe(b.wrapped);
  });

  it("tampered wrapped DEKs fail authentication", async () => {
    const provider = tk.getMasterKeyProvider();
    const { wrapped } = await provider.generateDek();
    const parts = wrapped.split(":");
    const tampered = [parts[0], parts[1], parts[2].slice(0, -2) + "00"].join(":");
    await expect(provider.unwrapDek(tampered, null)).rejects.toThrow();
  });
});

describe("tenant ciphertext hygiene", () => {
  it("recognizes tenant-format ciphertexts by prefix", () => {
    expect(tk.isTenantCiphertext("tk1:5:1:aa:bb:cc")).toBe(true);
    expect(tk.isTenantCiphertext("aabb:ccdd:eeff")).toBe(false); // legacy global-key format
    expect(tk.isTenantCiphertext(null)).toBe(false);
  });

  it("refuses to decrypt another tenant's ciphertext BEFORE any key lookup", async () => {
    // org 999's ciphertext presented under org 1 — must fail closed with no DB.
    const foreign = `${tk.TENANT_CIPHERTEXT_PREFIX}:999:1:${"a".repeat(32)}:${"b".repeat(32)}:${"c".repeat(32)}`;
    const result = await tk.decryptForTenant(1, foreign);
    expect(result).toBeNull();
  });

  it("rejects malformed ciphertexts without throwing", async () => {
    expect(await tk.decryptForTenant(1, "tk1:not:enough")).toBeNull();
    expect(await tk.decryptForTenant(1, "garbage")).toBeNull();
  });
});

describe("tenancy guards", () => {
  const admin = { role: "admin", organizationId: 10 };
  const superAdmin = { role: "super_admin", organizationId: 1 };
  const orphan = { role: "user", organizationId: null };

  it("resolveOrgScope locks regular users to their own org", () => {
    expect(tenancy.resolveOrgScope(admin)).toBe(10);
    expect(() => tenancy.resolveOrgScope(admin, 99)).toThrow(/super admins/i);
  });

  it("resolveOrgScope lets super admins override", () => {
    expect(tenancy.resolveOrgScope(superAdmin, 42)).toBe(42);
    expect(tenancy.resolveOrgScope(superAdmin)).toBe(1);
  });

  it("orphan accounts never fall through to unscoped access", () => {
    expect(() => tenancy.resolveOrgScope(orphan)).toThrow(/not linked/i);
  });

  it("assertSameOrg blocks cross-tenant resource access", () => {
    expect(() => tenancy.assertSameOrg(admin, 11)).toThrow(/another organization/i);
    expect(() => tenancy.assertSameOrg(admin, null)).toThrow(/another organization/i);
    expect(() => tenancy.assertSameOrg(admin, 10)).not.toThrow();
    expect(() => tenancy.assertSameOrg(superAdmin, 11)).not.toThrow();
  });
});

describe("per-tenant rate limiter", () => {
  it("enforces the window limit and reports retry-after", () => {
    rl.clearRateLimitStateForTests();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(rl.checkWindow("org1:api", 5, t0 + i).allowed).toBe(true);
    }
    const denied = rl.checkWindow("org1:api", 5, t0 + 10);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("tenants do not share windows (noisy neighbour isolation)", () => {
    rl.clearRateLimitStateForTests();
    const t0 = 2_000_000;
    for (let i = 0; i < 5; i++) rl.checkWindow("org1:webhook", 5, t0 + i);
    expect(rl.checkWindow("org1:webhook", 5, t0 + 6).allowed).toBe(false);
    expect(rl.checkWindow("org2:webhook", 5, t0 + 6).allowed).toBe(true);
  });

  it("window resets after 60s", () => {
    rl.clearRateLimitStateForTests();
    const t0 = 3_000_000;
    for (let i = 0; i < 6; i++) rl.checkWindow("org1:api", 5, t0 + i);
    expect(rl.checkWindow("org1:api", 5, t0 + 30_000).allowed).toBe(false);
    expect(rl.checkWindow("org1:api", 5, t0 + 60_001).allowed).toBe(true);
  });

  it("platform defaults support the 1M/day tenant target", () => {
    // 1M/day ≈ 695/min sustained; default must exceed it with burst headroom.
    expect(rl.DEFAULT_LIMITS.webhookEventsPerMin).toBeGreaterThan(695 * 1.5);
    expect(rl.DEFAULT_LIMITS.dailyTransactionSoftLimit).toBeGreaterThanOrEqual(1_000_000);
  });
});
