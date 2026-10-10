/**
 * The governed run's population, against a scripted database.
 *
 * Greptile #186: the worker matched every unmatched row in the channels' date
 * window, not the batch the manifest approved. So a later import, or another
 * batch's rows in the same window, were matched under the approved run's name.
 * These pin that a governed run reads exactly the approved batch, only after
 * proving it still is the population the manifest recorded, and reads nothing
 * when it is not.
 */
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { SQL, getTableName, type Table } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const script = vi.hoisted(() => ({
  manifest: undefined as Record<string, unknown> | undefined,
  batch: undefined as Record<string, unknown> | undefined,
  summary: undefined as Record<string, unknown> | undefined,
  currencies: [] as Array<{ currency: string }>,
  rows: [] as Array<Record<string, unknown>>,
  reads: [] as Array<{ table: string; kind: "fields" | "rows" | "distinct"; where: { sql: string; params: unknown[] } | null }>,
}));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: vi.fn(async () => ({ transaction: async (work: (tx: unknown) => unknown) => work(executor) })),
}));

const dialect = new MySqlDialect();
const render = (where: unknown) => (where instanceof SQL ? dialect.sqlToQuery(where) : null);

/**
 * Answers by the id the query asked for, so the two sides of a run are read
 * independently. The manifest and batch are scripted for the settlement side;
 * for the register side's ids they are re-keyed to that side.
 */
function answer(table: string, kind: "fields" | "rows" | "distinct", params: unknown[]): unknown[] {
  const sides = [settlement, register];
  if (table === "control_batch_manifests") {
    const side = sides.find(candidate => candidate.manifestId === params[0]);
    if (!script.manifest || !side) return [];
    const ownBatch = script.manifest.uploadBatchId === settlement.uploadBatchId;
    return [{ ...script.manifest, uploadBatchId: ownBatch ? side.uploadBatchId : script.manifest.uploadBatchId }];
  }
  if (table === "upload_batches") {
    const side = sides.find(candidate => candidate.uploadBatchId === params[0]);
    if (!script.batch || !side) return [];
    const ownChannel = script.batch.channelId === settlement.channelId;
    return [{ ...script.batch, channelId: ownChannel ? side.channelId : script.batch.channelId }];
  }
  if (kind === "distinct") return script.currencies;
  if (kind === "fields") return script.summary ? [script.summary] : [];
  return script.rows;
}

function reader(kind: "fields" | "rows" | "distinct") {
  return {
    from: (table: Table) => ({
      where: (where: unknown) => {
        const name = getTableName(table);
        const rendered = render(where);
        script.reads.push({ table: name, kind, where: rendered });
        const result = Promise.resolve(answer(name, kind, rendered?.params ?? []));
        return Object.assign(result, { limit: () => result, orderBy: () => result });
      },
    }),
  };
}

const executor = {
  select: (fields?: unknown) => reader(fields === undefined ? "rows" : "fields"),
  selectDistinct: () => reader("distinct"),
};

import {
  GovernedPopulationError,
  loadGovernedPopulation,
  verifyGovernedSide,
  type GovernedSide,
} from "./controlRunAdmission";

const TENANT = 42;
const settlement: GovernedSide = { channelId: 101, manifestId: 701, uploadBatchId: 901 };
const register: GovernedSide = { channelId: 102, manifestId: 702, uploadBatchId: 902 };

function agreeing(side: GovernedSide = settlement) {
  script.manifest = {
    uploadBatchId: side.uploadBatchId,
    receivedRecordCount: 2,
    receivedMonetaryTotal: "1250.10",
    receivedCurrency: "NGN",
  };
  script.batch = { channelId: side.channelId, status: "completed" };
  script.summary = { rowCount: 2, offChannelCount: "0", notUnmatchedCount: "0", total: "1250.10" };
  script.currencies = [{ currency: "NGN" }];
}

beforeEach(() => {
  script.manifest = undefined;
  script.batch = undefined;
  script.summary = undefined;
  script.currencies = [];
  script.rows = [{ id: 1 }, { id: 2 }];
  script.reads.length = 0;
});

describe("when a side's evidence still holds", () => {
  it("should find no reason to refuse it", async () => {
    agreeing();
    expect(await verifyGovernedSide(executor as never, TENANT, settlement)).toEqual([]);
  });

  it("should count every row of the batch, whatever its channel, so a stray row is seen", async () => {
    agreeing();
    await verifyGovernedSide(executor as never, TENANT, settlement);

    const aggregate = script.reads.find(read => read.table === "transactions" && read.kind === "fields");
    expect(aggregate?.where?.sql).toMatch(/`batchId` = \?/);
    expect(aggregate?.where?.sql).not.toMatch(/`channelId`/);
    expect(aggregate?.where?.params).toEqual([901]);
  });
});

describe("when a side's evidence no longer holds", () => {
  it("should refuse a manifest that is not this tenant's", async () => {
    agreeing();
    script.manifest = undefined;
    expect(await verifyGovernedSide(executor as never, TENANT, settlement)).toEqual(["manifest_unavailable"]);
  });

  it("should refuse a manifest that names another batch", async () => {
    agreeing();
    script.manifest = { ...script.manifest, uploadBatchId: 999 };
    expect(await verifyGovernedSide(executor as never, TENANT, settlement)).toEqual(["manifest_unavailable"]);
  });

  it("should refuse a batch that is missing or not completed", async () => {
    agreeing();
    script.batch = { channelId: 101, status: "processing" };
    expect(await verifyGovernedSide(executor as never, TENANT, settlement)).toEqual(["upload_batch_unavailable"]);
  });

  it("should refuse a batch on another channel than the side's", async () => {
    agreeing();
    script.batch = { channelId: 555, status: "completed" };
    expect(await verifyGovernedSide(executor as never, TENANT, settlement)).toEqual([
      "upload_batch_channel_mismatch",
    ]);
  });

  it("should refuse a batch whose rows no longer add up to the manifest", async () => {
    agreeing();
    script.summary = { rowCount: 3, offChannelCount: 0, notUnmatchedCount: 0, total: "1300.10" };
    expect(await verifyGovernedSide(executor as never, TENANT, settlement)).toEqual([
      "population_count_mismatch",
      "population_total_mismatch",
    ]);
  });
});

describe("when the worker loads a governed run's rows", () => {
  it("should load exactly the approved batches' unmatched rows, never a date window", async () => {
    agreeing();
    const loaded = await loadGovernedPopulation(TENANT, { settlement, register });

    expect(loaded.sourceTxns).toHaveLength(2);
    expect(loaded.targetTxns).toHaveLength(2);
    const rowReads = script.reads.filter(read => read.table === "transactions" && read.kind === "rows");
    expect(rowReads).toHaveLength(2);
    for (const read of rowReads) {
      expect(read.where?.sql).toMatch(/`batchId` = \?/);
      expect(read.where?.sql).toMatch(/`channelId` = \?/);
      expect(read.where?.sql).toMatch(/`organizationId` = \?/);
      expect(read.where?.sql).not.toMatch(/`transactionDate`/);
    }
    expect(rowReads[0].where?.params).toEqual(expect.arrayContaining([901, 101, TENANT, "unmatched"]));
    expect(rowReads[1].where?.params).toEqual(expect.arrayContaining([902, 102, TENANT, "unmatched"]));
  });

  it("should refuse, and read no row, when the population has changed since admission", async () => {
    agreeing();
    script.summary = { rowCount: 3, offChannelCount: 0, notUnmatchedCount: 0, total: "1250.10" };

    await expect(loadGovernedPopulation(TENANT, { settlement, register })).rejects.toBeInstanceOf(
      GovernedPopulationError
    );
    expect(script.reads.some(read => read.table === "transactions" && read.kind === "rows")).toBe(false);
  });
});

describe("when the worker runs a governed job", () => {
  // runReconciliation is internal to routers.ts, and importing that module in a
  // test starts its schedulers, so the wiring is read as source, as the
  // module-scope ratchet does. The loader's behaviour is pinned above.
  it("should load the approved population, reaching the date-window loader only for an ordinary job", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8").replace(/\r\n/g, "\n");
    const start = source.indexOf("async function runReconciliation(");
    const end = source.indexOf('"pass1_exact_match"', start);
    expect(start, "runReconciliation not found").toBeGreaterThan(-1);
    expect(end, "matching pass not found").toBeGreaterThan(start);
    const loading = source.slice(start, end);

    const decided = loading.indexOf("governedSidesOf(runJob?.engineConfig");
    const governed = loading.indexOf("? await loadGovernedPopulation(runOrganizationId, governedSides)");
    const window = loading.indexOf("getTransactionsForReconciliation(");
    expect(decided).toBeGreaterThan(-1);
    expect(governed).toBeGreaterThan(decided);
    // The window loader appears only after the governed branch: in its else.
    expect(window).toBeGreaterThan(governed);
  });
});
