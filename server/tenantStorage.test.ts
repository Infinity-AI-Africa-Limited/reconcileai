import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as unknown[], reads: 0 }));
const storage = vi.hoisted(() => ({ put: vi.fn() }));

vi.mock("./db", () => ({
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            db.reads += 1;
            return db.rows;
          },
        }),
      }),
    }),
  }),
}));
vi.mock("./storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./storage")>()),
  storagePut: storage.put,
}));

import { tenantObjectKey } from "./storage";
import {
  csvExportPath,
  legacyUserFilePrefixes,
  putTenantObject,
  TENANT_FILES_CLOSED_MESSAGE,
  userExportPath,
} from "./tenantStorage";

beforeEach(() => {
  db.rows = [];
  db.reads = 0;
  storage.put.mockReset();
  storage.put.mockImplementation(async (key: string) => ({ key, url: `https://signed.example/${key}` }));
});

describe("when a file holds one tenant's data", () => {
  it("should be stored under that tenant's prefix", () => {
    expect(tenantObjectKey(42, userExportPath(7, "a.xlsx"))).toBe("org/42/exports/7/a.xlsx");
    expect(tenantObjectKey(42, "/reports/cfo/r.xlsx")).toBe("org/42/reports/cfo/r.xlsx");
    expect(tenantObjectKey(42, csvExportPath("cfo", 7, "1-r.csv"))).toBe("org/42/csv-exports/cfo/7/1-r.csv");
  });

  it.each([null, undefined, 0, -1])("should keep the relative key when the tenant is %s", (organizationId) => {
    expect(tenantObjectKey(organizationId, "exports/7/a.xlsx")).toBe("exports/7/a.xlsx");
  });
});

describe("when a file is stored for a tenant", () => {
  it("should upload it under the tenant's prefix while the tenant is active", async () => {
    db.rows = [{ deletionState: "active" }];

    const stored = await putTenantObject({
      organizationId: 42,
      relKey: userExportPath(7, "a.xlsx"),
      body: "x",
      contentType: "text/csv",
    });

    expect(storage.put).toHaveBeenCalledWith("org/42/exports/7/a.xlsx", "x", "text/csv");
    expect(stored.key).toBe("org/42/exports/7/a.xlsx");
  });

  it.each([
    ["being deleted", [{ deletionState: "redacting" }]],
    ["gone", []],
  ])("should refuse it while the tenant is %s, storing nothing", async (_label, rows) => {
    db.rows = rows;

    await expect(
      putTenantObject({ organizationId: 42, relKey: "exports/7/a.xlsx", body: "x", contentType: "text/csv" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: TENANT_FILES_CLOSED_MESSAGE });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("should store data that belongs to no tenant at its relative key without asking the database", async () => {
    await putTenantObject({ organizationId: null, relKey: "exports/7/a.xlsx", body: "x", contentType: "text/csv" });

    expect(db.reads).toBe(0);
    expect(storage.put).toHaveBeenCalledWith("exports/7/a.xlsx", "x", "text/csv");
  });
});

describe("when erasure looks for a user's files from before tenant prefixes", () => {
  it("should name the user's own export folders, each ending in a separator", () => {
    expect(legacyUserFilePrefixes(7)).toEqual([
      "exports/7/",
      "csv-exports/cbn/7/",
      "csv-exports/cfo/7/",
      "csv-exports/reconciliation/7/",
    ]);
  });
});
