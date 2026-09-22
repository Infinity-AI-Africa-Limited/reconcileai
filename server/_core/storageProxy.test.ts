/**
 * Which audit chain a storage access decision is filed in (storageAuditTenant).
 *
 * It named none, so every download — a bank's staff opening their own exports
 * and uploads — joined the global chain, which no tenant's Audit Trail reads.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../storage", () => ({ storageGet: vi.fn(), orgIdFromKey: vi.fn() }));
vi.mock("./sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));
import { storageAuditTenant } from "./storageProxy";

const bankOps = { role: "operations", organizationId: 4 };
const staff = { role: "super_admin", organizationId: 30002 };

describe("when access to an object is allowed", () => {
  it("should file it in the object's own tenant's trail — staff reading it included", () => {
    expect(storageAuditTenant(true, 4, bankOps)).toBe(4);
    expect(storageAuditTenant(true, 4, staff)).toBe(4);
  });

  it("should fall back to the requester's own tenant for a legacy key that names none", () => {
    expect(storageAuditTenant(true, null, bankOps)).toBe(4);
    expect(storageAuditTenant(true, null, staff)).toBeNull();
    expect(storageAuditTenant(true, null, { role: "user", organizationId: 0 })).toBeNull();
  });
});

describe("when access is denied", () => {
  it("should file it in the global chain — either tenant's trail would expose the other", () => {
    expect(storageAuditTenant(false, 4, { role: "operations", organizationId: 7 })).toBeNull();
    expect(storageAuditTenant(false, 4, bankOps)).toBeNull();
  });
});
