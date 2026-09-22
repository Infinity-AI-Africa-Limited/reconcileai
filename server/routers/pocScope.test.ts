/**
 * A POC's access link proves only its own slug, so every id it names must be
 * that POC's.
 *
 * Four paths took an id and never checked it against the slug: an exception's
 * review status (updated by id alone), a run's exceptions (read by run id), the
 * uploads a run reconciles (loaded by id — another POC's ledger and statement
 * reconciled and read back under your own POC), and a share link or saved file
 * naming another POC's run. These run the real router against a recording fake
 * database and assert what was actually queried and written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SQL, getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: vi.fn(async () => null),
}));
vi.mock("../pocAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pocAccess")>()),
  assertPocAccess: vi.fn(async () => {}),
  tokenFromCtx: vi.fn(() => "token"),
}));
vi.mock("../storage", () => ({ storagePut: vi.fn(async () => ({ url: "u" })) }));
vi.mock("../_core/notification", () => ({ notifyOwner: vi.fn(async () => true) }));

import * as db from "../db";
import * as storage from "../storage";
import { pocRouter } from "./poc";

const dialect = new MySqlDialect();
type Read = { table: string; params: unknown[] };
type Write = { op: "update" | "insert"; table: string; params: unknown[]; values?: unknown };

/** A fake db that answers selects from `rows` by table and records every query. */
function fakeDb(rows: Record<string, unknown[]>) {
  const reads: Read[] = [];
  const writes: Write[] = [];
  const paramsOf = (cond: unknown) => (cond instanceof SQL ? dialect.sqlToQuery(cond).params : []);
  const select = () => {
    let table = "";
    let params: unknown[] = [];
    const q = {
      from(t: Parameters<typeof getTableName>[0]) { table = getTableName(t); return q; },
      where(cond: unknown) { params = paramsOf(cond); return q; },
      orderBy() { return q; },
      limit() { return q; },
      then(resolve: (r: unknown[]) => unknown) {
        reads.push({ table, params });
        return Promise.resolve(rows[table] ?? []).then(resolve);
      },
    };
    return q;
  };
  const handle = {
    select,
    update: (t: Parameters<typeof getTableName>[0]) => ({
      set: (values: unknown) => ({
        where: async (cond: unknown) => { writes.push({ op: "update", table: getTableName(t), params: paramsOf(cond), values }); },
      }),
    }),
    insert: (t: Parameters<typeof getTableName>[0]) => ({
      values: async (values: unknown) => {
        writes.push({ op: "insert", table: getTableName(t), params: [], values });
        return [{ insertId: 1 }];
      },
    }),
  };
  vi.mocked(db.getDb).mockResolvedValue(handle as never);
  return { reads, writes };
}

const caller = () => pocRouter.createCaller({ user: null, req: { headers: {} }, res: {} } as never);
const MINE = "lapo_mfb";

beforeEach(() => vi.clearAllMocks());

describe("when a POC reviews an exception", () => {
  const review = { pocSlug: MINE, exceptionId: 7, reviewStatus: "RESOLVED" as const };

  it("should update its own exception, with the slug in the write itself", async () => {
    const { reads, writes } = fakeDb({ poc_exceptions: [{ id: 7 }] });
    await expect(caller().updateExceptionStatus(review)).resolves.toMatchObject({ success: true });
    expect(reads[0]).toEqual({ table: "poc_exceptions", params: [7, MINE] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ op: "update", table: "poc_exceptions", params: [7, MINE] });
  });

  it("should answer another POC's exception as not found, and write nothing", async () => {
    const { writes } = fakeDb({ poc_exceptions: [] });
    await expect(caller().updateExceptionStatus(review)).rejects.toThrow("Exception not found");
    expect(writes).toEqual([]);
  });
});

describe("when a POC reads a run's exceptions", () => {
  it("should ask only for its own POC's", async () => {
    const { reads } = fakeDb({ poc_exceptions: [] });
    await caller().getExceptions({ pocSlug: MINE, runId: 12 });
    expect(reads).toEqual([{ table: "poc_exceptions", params: [12, MINE] }]);
  });
});

describe("when a POC reconciles two uploads", () => {
  it("should load each only from its own POC, and refuse another POC's", async () => {
    const { reads } = fakeDb({ poc_uploads: [] });
    await expect(caller().run({ pocSlug: MINE, ledgerUploadId: 3, statementUploadId: 4 })).rejects.toThrow(/Upload\(s\) not found/);
    expect(reads.filter((r) => r.table === "poc_uploads").map((r) => r.params)).toEqual([[3, MINE], [4, MINE]]);
  });
});

describe("when a POC names a run for a share link or a saved file", () => {
  it("should refuse to mint a share link for another POC's run", async () => {
    const { reads, writes } = fakeDb({ poc_runs: [] });
    await expect(caller().createShareToken({ pocSlug: MINE, runId: 99 })).rejects.toThrow("Run not found");
    expect(reads[0]).toEqual({ table: "poc_runs", params: [99, MINE] });
    expect(writes).toEqual([]);
  });

  it("should still mint one for its own run", async () => {
    const { writes } = fakeDb({ poc_runs: [{ id: 99, pocSlug: MINE }] });
    await expect(caller().createShareToken({ pocSlug: MINE, runId: 99 })).resolves.toMatchObject({ token: expect.any(String) });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ op: "insert", values: { runId: 99, pocSlug: MINE } });
  });

  it("should refuse to file an upload against another POC's run — before storing anything", async () => {
    const { writes } = fakeDb({ poc_runs: [] });
    const file = { pocSlug: MINE, fileRole: "cbs" as const, originalName: "a.csv", mimeType: "text/csv", sizeBytes: 1, dataBase64: "YQ==" };
    await expect(caller().saveFile({ ...file, runId: 99 })).rejects.toThrow("Run not found");
    expect(storage.storagePut).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
