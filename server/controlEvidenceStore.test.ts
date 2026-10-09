/**
 * Reading a tenant's control evidence.
 *
 * Both collections used to be capped — 100 contracts, 200 manifests — with no
 * cursor, no period filter, and nothing to say the list was short. Evidence
 * accrues one manifest per source per control period, so a tenant running a few
 * daily sources passed that ceiling within months and the older evidence became
 * unreachable through the API. Worse, a caller reading "is this control
 * complete?" could not tell a truncated answer from a complete one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: vi.fn(async () => state.db),
}));

import { scriptedDb } from "./connectors/shopify/scriptedDb.testkit";
import { CONTROL_EVIDENCE_PAGE_DEFAULT } from "./controlEvidenceSchema";
import { listControlEvidence } from "./controlEvidenceStore";

const organizationId = 42;
const CONTRACTS = "control_source_contracts";
const MANIFESTS = "control_batch_manifests";

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 8, 0, 0));

const manifestRow = (id: number) => ({ id, organizationId, receivedAt: at(id), controlPeriod: `2026-10-${id}` });
const contractRow = (id: number) => ({ id, organizationId, effectiveAt: at(id), sourceKey: "switch-settlement" });

/** `rows` as the engine would return them: newest first, one past the limit. */
function evidenceDb(counts: { contracts: number; manifests: number }) {
  const fake = scriptedDb({
    select: {
      [CONTRACTS]: [Array.from({ length: counts.contracts }, (_, i) => contractRow(counts.contracts - i))],
      [MANIFESTS]: [Array.from({ length: counts.manifests }, (_, i) => manifestRow(counts.manifests - i))],
    },
  });
  state.db = fake.db;
  return fake;
}

const whereFor = (fake: ReturnType<typeof scriptedDb>, table: string) =>
  fake.ops.find(op => op.kind === "select" && op.table === table)?.where ?? { sql: "", params: [] };
const whereParamsFor = (fake: ReturnType<typeof scriptedDb>, table: string) => whereFor(fake, table).params;
const limitFor = (fake: ReturnType<typeof scriptedDb>, table: string) =>
  fake.ops.find(op => op.kind === "select" && op.table === table)?.limit;

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
});

describe("when a page of control evidence is read", () => {
  it("should scope both collections to the caller's organisation", async () => {
    const fake = evidenceDb({ contracts: 1, manifests: 1 });

    const page = await listControlEvidence(organizationId);

    expect(page.organizationId).toBe(organizationId);
    expect(whereParamsFor(fake, CONTRACTS)).toContain(organizationId);
    expect(whereParamsFor(fake, MANIFESTS)).toContain(organizationId);
  });

  it("should bound the page by the default limit when the caller names none", async () => {
    const fake = evidenceDb({ contracts: 0, manifests: 0 });

    expect((await listControlEvidence(organizationId)).limit).toBe(CONTROL_EVIDENCE_PAGE_DEFAULT);
    expect(fake.ops.filter(op => op.kind === "select")).toHaveLength(2);
  });

  it("should ask the database for one row beyond the page, so it can answer whether more exists", async () => {
    // The limit the QUERY carries, not the rows the fake returns: without the
    // extra row `hasMore` is false against a real database no matter how much
    // evidence is there, and this fake cannot apply a limit to show it.
    const fake = evidenceDb({ contracts: 1, manifests: 1 });

    await listControlEvidence(organizationId, { limit: 25 });

    expect(limitFor(fake, CONTRACTS)).toBe(26);
    expect(limitFor(fake, MANIFESTS)).toBe(26);
  });

  it("should report the page as complete when nothing was held back", async () => {
    evidenceDb({ contracts: 2, manifests: 2 });

    const page = await listControlEvidence(organizationId, { limit: 5 });

    expect(page.sourceContracts).toMatchObject({ hasMore: false, nextCursor: null });
    expect(page.manifests).toMatchObject({ hasMore: false, nextCursor: null });
    expect(page.sourceContracts.rows).toHaveLength(2);
    expect(page.manifests.rows).toHaveLength(2);
  });
});

describe("when more evidence exists than one page holds", () => {
  it("should return exactly the limit and say that more exists", async () => {
    // Three rows available, a limit of two: the third was fetched only to
    // answer "is there more?" and must not be returned as data.
    evidenceDb({ contracts: 3, manifests: 3 });

    const page = await listControlEvidence(organizationId, { limit: 2 });

    expect(page.sourceContracts.rows).toHaveLength(2);
    expect(page.sourceContracts.hasMore).toBe(true);
    expect(page.manifests.rows).toHaveLength(2);
    expect(page.manifests.hasMore).toBe(true);
  });

  it("should hand back a cursor naming the last row it returned, not the one it withheld", async () => {
    evidenceDb({ contracts: 3, manifests: 3 });

    const page = await listControlEvidence(organizationId, { limit: 2 });

    // Newest first: ids 3, 2 returned; 1 withheld. The cursor is row 2.
    const lastContract = page.sourceContracts.rows[1];
    const lastManifest = page.manifests.rows[1];
    expect(page.sourceContracts.nextCursor).toEqual({ id: lastContract?.id, effectiveAt: lastContract?.effectiveAt });
    expect(page.manifests.nextCursor).toEqual({ id: lastManifest?.id, receivedAt: lastManifest?.receivedAt });
  });

  it("should never return a cursor for a page that ended the collection", async () => {
    evidenceDb({ contracts: 1, manifests: 1 });

    const page = await listControlEvidence(organizationId, { limit: 1 });

    expect(page.sourceContracts.nextCursor).toBeNull();
    expect(page.manifests.nextCursor).toBeNull();
  });
});

describe("when the caller follows a cursor", () => {
  it("should ask for rows strictly after it, by sort key and then by id", async () => {
    const fake = evidenceDb({ contracts: 1, manifests: 1 });

    await listControlEvidence(organizationId, {
      contractCursor: { effectiveAt: at(9), id: 55 },
      manifestCursor: { receivedAt: at(9), id: 66 },
    });

    // The whole keyset, not half of it: `sort < c` OR (`sort = c` AND `id < c`).
    // Without the tiebreak, rows sharing a sort value straddle the page
    // boundary and one is repeated or skipped.
    expect(whereFor(fake, CONTRACTS).sql).toBe(
      "(`control_source_contracts`.`organizationId` = ? and (`control_source_contracts`.`effectiveAt` < ? or (`control_source_contracts`.`effectiveAt` = ? and `control_source_contracts`.`id` < ?)))"
    );
    expect(whereFor(fake, MANIFESTS).sql).toBe(
      "(`control_batch_manifests`.`organizationId` = ? and (`control_batch_manifests`.`receivedAt` < ? or (`control_batch_manifests`.`receivedAt` = ? and `control_batch_manifests`.`id` < ?)))"
    );
    // Rendered as the driver sends them, and the id is the last bound value.
    expect(whereParamsFor(fake, CONTRACTS)).toEqual([organizationId, expect.any(String), expect.any(String), 55]);
    expect(whereParamsFor(fake, MANIFESTS)).toEqual([organizationId, expect.any(String), expect.any(String), 66]);
  });
});

describe("when the caller looks evidence up by control period", () => {
  it("should filter the manifests by that period, which the tenant index serves", async () => {
    const fake = evidenceDb({ contracts: 1, manifests: 1 });

    await listControlEvidence(organizationId, { controlPeriod: "2026-10-09" });

    expect(whereParamsFor(fake, MANIFESTS)).toEqual(
      expect.arrayContaining([organizationId, "2026-10-09"])
    );
  });

  it("should narrow both collections when a source contract is named", async () => {
    const fake = evidenceDb({ contracts: 1, manifests: 1 });

    await listControlEvidence(organizationId, { sourceContractId: 41 });

    expect(whereParamsFor(fake, CONTRACTS)).toContain(41);
    expect(whereParamsFor(fake, MANIFESTS)).toContain(41);
  });
});

describe("when the database is unavailable", () => {
  it("should refuse rather than answer with an empty page", async () => {
    // An empty page would read as "this tenant has recorded no evidence",
    // which is a different and much worse answer than "ask again".
    state.db = null;

    await expect(listControlEvidence(organizationId)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});
