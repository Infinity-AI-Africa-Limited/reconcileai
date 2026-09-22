/**
 * Starting a reconciliation run: the real procedures, with the database, the
 * queue and the module gate mocked.
 *
 * Every run started here was created with no organisation, and runReconciliation
 * refuses such a job — so every run failed. The same procedures resolved the
 * caller's channel ids by id alone, which only the missing owner stopped. These
 * tests drive `reconciliation.create` and `createMultiChannel` end to end and
 * assert what reaches the database: the owner on the job, and every channel
 * resolved under that owner.
 *
 * No path here may reach a real database: DATABASE_URL is blanked before any
 * module loads, and `getDb` is mocked to null. (The local .env names production.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: vi.fn(async () => null),
  getChannelByIdForOrg: vi.fn(),
  getChannels: vi.fn(async () => []),
  createReconciliationJob: vi.fn(),
  updateReconciliationJob: vi.fn(),
  abandonUnstartedReconciliationJob: vi.fn(),
  getReconciliationJobsByMultiRun: vi.fn(async () => []),
}));
vi.mock("../reconciliationQueue", () => ({
  assertReconciliationQueueAvailable: vi.fn(async () => {}),
  enqueueReconciliationRun: vi.fn(async () => {}),
}));
vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  assertModuleAvailable: vi.fn(async () => {}),
  logAudit: vi.fn(async () => {}),
}));

import * as db from "../db";
import { enqueueReconciliationRun } from "../reconciliationQueue";
import { reconciliationRouter } from "./reconciliation";
import { requireOwnedChannels, runOwner } from "./shared";
import { isTenantId } from "@shared/tenantId";

const TENANT = 30001;
/** Channels this tenant can see (its own and shared rails); anything else is another tenant's. */
const OWN = new Set([11, 12, 13]);

const caller = (organizationId: number | null) =>
  reconciliationRouter.createCaller({
    user: { id: 7, role: "operations", organizationId, isGuest: false, isReadOnly: false, openId: "t", name: "t", email: "t@t" },
    req: { headers: {}, socket: {} },
    res: {},
  } as never);

const single = { name: "run", sourceChannelId: 11, targetChannelId: 12, dateFrom: "2026-09-01", dateTo: "2026-09-21" };
const multi = { name: "fan", sourceChannelId: 11, targetChannelIds: [12, 13], dateFrom: "2026-09-01", dateTo: "2026-09-21" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getChannelByIdForOrg).mockImplementation(async (id: number, org: number | null) =>
    org === TENANT && OWN.has(id) ? ({ id, name: `ch${id}`, code: `C${id}`, isActive: true } as never) : undefined,
  );
  let next = 500;
  vi.mocked(db.createReconciliationJob).mockImplementation(async () => ++next);
});

describe("when a user starts a single reconciliation run", () => {
  it("should create the job under their organisation, from channels resolved under it", async () => {
    await expect(caller(TENANT).create(single)).resolves.toMatchObject({ jobId: 501 });
    expect(db.getChannelByIdForOrg).toHaveBeenCalledWith(11, TENANT);
    expect(db.getChannelByIdForOrg).toHaveBeenCalledWith(12, TENANT);
    expect(vi.mocked(db.createReconciliationJob).mock.calls[0][0]).toMatchObject({ organizationId: TENANT, userId: 7 });
    expect(enqueueReconciliationRun).toHaveBeenCalledTimes(1);
  });

  it("should refuse another tenant's channel, creating and queueing nothing", async () => {
    await expect(caller(TENANT).create({ ...single, targetChannelId: 99 })).rejects.toThrow("Target channel not found");
    expect(db.createReconciliationJob).not.toHaveBeenCalled();
    expect(enqueueReconciliationRun).not.toHaveBeenCalled();
  });

  it("should refuse a user with no organisation before looking anything up", async () => {
    await expect(caller(null).create(single)).rejects.toThrow(/not linked to an organisation/);
    expect(db.getChannelByIdForOrg).not.toHaveBeenCalled();
    expect(db.createReconciliationJob).not.toHaveBeenCalled();
  });
});

describe("when a user starts a multi-channel run", () => {
  it("should create every child job under their organisation, from channels resolved under it", async () => {
    await expect(caller(TENANT).createMultiChannel(multi)).resolves.toMatchObject({ targetCount: 2 });
    for (const id of [11, 12, 13]) expect(db.getChannelByIdForOrg).toHaveBeenCalledWith(id, TENANT);
    const jobs = vi.mocked(db.createReconciliationJob).mock.calls.map((c) => c[0]);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) expect(job).toMatchObject({ organizationId: TENANT });
  });

  it("should refuse the whole run when any target is another tenant's", async () => {
    await expect(caller(TENANT).createMultiChannel({ ...multi, targetChannelIds: [12, 99] })).rejects.toThrow("Target channel 99 not found");
    expect(db.createReconciliationJob).not.toHaveBeenCalled();
  });

  it("should draw 'all active targets' from their organisation only", async () => {
    vi.mocked(db.getChannels).mockResolvedValue([{ id: 12, name: "a", code: "A", isActive: true }] as never);
    await caller(TENANT).createMultiChannel({ ...multi, targetChannelIds: undefined, allActiveTargets: true });
    expect(db.getChannels).toHaveBeenCalledWith(TENANT);
  });
});

describe("when a multi-channel run is opened by its id", () => {
  const child = (id: number, organizationId: number) => ({
    id, organizationId, targetChannelId: 12, status: "completed", matchRate: "90.00",
    totalSourceTxns: 1, totalTargetTxns: 1, matchedCount: 1, exceptionCount: 0, unmatchedCount: 0,
  });

  it("should show only the caller's own tenant's jobs", async () => {
    vi.mocked(db.getReconciliationJobsByMultiRun).mockResolvedValue([child(1, TENANT), child(2, 60001)] as never);
    const run = await caller(TENANT).getMultiRun({ multiRunId: "a" });
    expect(run.jobCount).toBe(1);
    expect(run.channels.map((c) => c.jobId)).toEqual([1]);
  });

  it("should answer another tenant's run exactly as a missing one", async () => {
    // A UUID is hard to guess but not authorisation; this returned any tenant's run.
    vi.mocked(db.getReconciliationJobsByMultiRun).mockResolvedValue([child(2, 60001)] as never);
    await expect(caller(TENANT).getMultiRun({ multiRunId: "a" })).rejects.toThrow("Multi-channel run not found");
  });
});

describe("when a run's owner and channels are decided", () => {
  it("should resolve each channel under the owner, in order, failing on the first it cannot see", async () => {
    await expect(requireOwnedChannels(TENANT, [{ id: 11, notFound: "a" }, { id: 12, notFound: "b" }])).resolves.toHaveLength(2);
    await expect(requireOwnedChannels(TENANT, [{ id: 11, notFound: "a" }, { id: 98, notFound: "b" }, { id: 97, notFound: "c" }])).rejects.toThrow("b");
    // The same channel under ANOTHER owner is not visible.
    await expect(requireOwnedChannels(60001, [{ id: 11, notFound: "not yours" }])).rejects.toThrow("not yours");
  });

  it("should own a run under the caller's organisation, and refuse a caller with none", () => {
    expect(runOwner({ organizationId: TENANT })).toBe(TENANT);
    expect(() => runOwner({ organizationId: null })).toThrow(/not linked to an organisation/);
    expect(() => runOwner({})).toThrow(/not linked to an organisation/);
  });

  it("should refuse the legacy organisation 0, which is no tenant", () => {
    // `== null` let 0 through; anything filed there belongs to nobody.
    expect(() => runOwner({ organizationId: 0 })).toThrow(/not linked to an organisation/);
    for (const id of [0, -1, 1.5, Number.NaN, null, undefined]) expect(isTenantId(id), String(id)).toBe(false);
    for (const id of [1, 30001]) expect(isTenantId(id)).toBe(true);
  });

  it("should refuse an organisation-0 caller at the procedure, before any lookup", async () => {
    await expect(caller(0).create(single)).rejects.toThrow(/not linked to an organisation/);
    expect(db.getChannelByIdForOrg).not.toHaveBeenCalled();
    expect(db.createReconciliationJob).not.toHaveBeenCalled();
  });
});

describe("when a schedule is created", () => {
  // schedules.create lives in server/routers.ts, which starts the scheduler,
  // SFTP polling and SLA monitoring the moment it is imported — against
  // whatever database is configured, which on a developer machine is
  // production. It is not imported here. Its owner is enforced by the COMPILER
  // (createScheduledTask requires organizationId); its channels go through the
  // same requireOwnedChannels tested above, which this pins by call, not format.
  it("should take its owner from runOwner and resolve its channels through requireOwnedChannels", () => {
    const src = readFileSync(path.resolve(__dirname, "..", "routers.ts"), "utf8");
    const start = src.indexOf("const id = await db.createScheduledTask(");
    expect(start, "schedules.create has moved").toBeGreaterThan(-1);
    const before = src.slice(src.lastIndexOf(".mutation(", start), start);
    expect(before).toMatch(/const tenant = runOwner\(ctx\.user\)/);
    expect(before).toMatch(/requireOwnedChannels\(tenant,/);
    expect(before).not.toMatch(/getChannelById\(/);
  });
});
