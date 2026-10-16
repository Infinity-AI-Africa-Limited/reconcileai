import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as unknown[], reads: 0, delayMs: 0 }));
const storage = vi.hoisted(() => ({ put: vi.fn() }));

vi.mock("./db", () => ({
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            db.reads += 1;
            if (db.delayMs) await new Promise((resolve) => setTimeout(resolve, db.delayMs));
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
  TENANT_UPLOAD_DEADLINE_MS,
  userExportPath,
} from "./tenantStorage";

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  db.rows = [];
  db.reads = 0;
  db.delayMs = 0;
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

    expect(storage.put).toHaveBeenCalledWith("org/42/exports/7/a.xlsx", "x", "text/csv", {
      abortSignal: expect.any(AbortSignal),
    });
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
    expect(storage.put).toHaveBeenCalledWith("exports/7/a.xlsx", "x", "text/csv", {
      abortSignal: expect.any(AbortSignal),
    });
  });
});

describe("when an upload runs past its deadline", () => {
  /** An upload that never finishes on its own, but stops when its signal aborts — as the S3 client does. */
  const hangingUpload = async (_key: string, _body: unknown, _type: string, options?: { abortSignal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason));
    });

  it("should abort it, so no upload that saw the tenant active can land later", async () => {
    vi.useFakeTimers();
    db.rows = [{ deletionState: "active" }];
    storage.put.mockImplementation(hangingUpload);

    const upload = putTenantObject({ organizationId: 42, relKey: "exports/7/a.xlsx", body: "x", contentType: "text/csv" });
    const outcome = expect(upload).rejects.toMatchObject({ name: "TenantUploadDeadlineError" });
    await vi.advanceTimersByTimeAsync(TENANT_UPLOAD_DEADLINE_MS);
    await outcome;
  });

  it("should count the deadline from before the tenant check", async () => {
    vi.useFakeTimers();
    db.rows = [{ deletionState: "active" }];
    db.delayMs = TENANT_UPLOAD_DEADLINE_MS + 1;

    const upload = putTenantObject({ organizationId: 42, relKey: "exports/7/a.xlsx", body: "x", contentType: "text/csv" });
    const outcome = expect(upload).rejects.toMatchObject({ name: "TenantUploadDeadlineError" });
    await vi.advanceTimersByTimeAsync(TENANT_UPLOAD_DEADLINE_MS + 1);
    await outcome;
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("should clear its timer once the upload finishes", async () => {
    vi.useFakeTimers();
    db.rows = [{ deletionState: "active" }];

    await putTenantObject({ organizationId: 42, relKey: "exports/7/a.xlsx", body: "x", contentType: "text/csv" });

    expect(vi.getTimerCount()).toBe(0);
    expect(storage.put.mock.calls[0]?.[3]?.abortSignal).toBeInstanceOf(AbortSignal);
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
