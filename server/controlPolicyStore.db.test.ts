/**
 * The control-policy registry against a REAL MySQL — CI's database only, gated
 * like the other *.db.test.ts files because the local .env names production
 * and this suite writes rows. It calls the store directly: no router import, so
 * nothing boots.
 *
 * What only a real engine can show:
 *   - MySQL's JSON type re-orders object keys and re-encodes numbers, so the
 *     digest must recompute from what the database hands BACK, not only from
 *     what was sent;
 *   - the one-active-version rule is a unique index over a column that is NULL
 *     on every inactive row, and MySQL must let many NULLs coexist;
 *   - keyset paging must reach every version exactly once, ties included.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditChainLocks, auditLogs, controlPolicies, organizations } from "../drizzle/schema";
import { controlPolicyScopeInput } from "./controlPolicySchema";
import {
  activateControlPolicy,
  approveControlPolicy,
  createControlPolicy,
  getControlPolicy,
  listControlPolicies,
  policyDefinitionDigest,
  retireControlPolicy,
} from "./controlPolicyStore";
import { getDb } from "./db";
import { classifyDatabaseTarget } from "./dbTarget";
import { TIMESTAMP_MAX, TIMESTAMP_MIN } from "./storableTimestamp";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe.runIf(localDatabase)("when the policy registry runs on a real database", () => {
  const organizationId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  const missingOrganizationId = organizationId + 1;
  const actor = { id: 1, role: "operations", organizationId, isGuest: false };
  const client = { ip: "127.0.0.1", ua: "vitest" };
  let db: Db;

  function draft(policyKey: string, version: number, effectiveAt: string, definition: Record<string, unknown> = { tolerance: "0.00" }) {
    return createControlPolicy({
      actor,
      organizationId,
      client,
      input: {
        policyType: "reconciliation",
        policyKey,
        version,
        displayName: `${policyKey} v${version}`,
        description: "Real-database proof.",
        definition: definition as never,
        effectiveAt: new Date(effectiveAt),
      },
    });
  }

  async function approvedAndActivated(policyId: number) {
    await approveControlPolicy({ actor, organizationId, client, input: { policyId, approvalReference: `CAB-${policyId}` } });
    return activateControlPolicy({ actor, organizationId, client, input: { policyId } });
  }

  function failureOf(run: () => Promise<unknown>) {
    return run().then(
      () => ({ code: null as string | null }),
      (error: { code?: string }) => ({ code: error.code ?? "UNKNOWN" })
    );
  }

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;
    // drizzle writes TIMESTAMPs as zone-less UTC strings and the app pins no
    // session time zone, so it relies on a UTC database, as production (TiDB
    // Cloud) and CI are. Elsewhere every date here would be shifted; say so.
    const [clock] = (await db.execute(
      sql`SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS offsetSeconds`
    )) as unknown as [Array<{ offsetSeconds: number | string }>];
    if (Number(clock[0]?.offsetSeconds) !== 0) {
      throw new Error("The test database must run in UTC, as production and CI do (set default-time-zone = +00:00).");
    }
    await db.insert(organizations).values({
      id: organizationId,
      name: `Policy registry proof ${organizationId}`,
      code: `POLPROOF_${organizationId}`,
      segment: "financial_services",
      isDemo: true,
    });
  });

  afterAll(async () => {
    if (!db) return;
    for (const org of [organizationId, missingOrganizationId]) {
      for (const step of [
        () => db.delete(controlPolicies).where(eq(controlPolicies.organizationId, org)),
        () => db.delete(auditLogs).where(eq(auditLogs.organizationId, org)),
        () => db.delete(auditChainLocks).where(eq(auditChainLocks.chainKey, org)),
        () => db.delete(organizations).where(eq(organizations.id, org)),
      ]) {
        try {
          await step();
        } catch (error) {
          console.error("[controlPolicyStore.db.test] cleanup step failed:", error);
        }
      }
    }
  });

  it("should store a definition whose digest recomputes from what the database returns", async () => {
    // Key order MySQL will rewrite (it sorts by length, then bytes), unicode,
    // decimals, negatives, nesting, null and booleans.
    const definition = {
      zeta: { thresholdMinor: 1, ratio: 0.1, offset: -2.5 },
      a: [3, 1, 2, { nested: null, flag: true }],
      "naïve ✓": "unicode",
      mid: false,
      amountTolerance: "0.00",
    };
    const created = await draft("digest-proof", 1, "2026-10-01T00:00:00.000Z", definition);

    const stored = await getControlPolicy(organizationId, created.id);

    expect(stored.definition).toEqual(definition);
    expect(stored.definitionDigest).toBe(created.definitionDigest);
    expect(policyDefinitionDigest(stored.definition)).toBe(stored.definitionDigest);
  });

  it("should refuse a draft for an organisation that does not exist, leaving no policy and no audit", async () => {
    const refusal = await failureOf(() =>
      createControlPolicy({
        actor,
        organizationId: missingOrganizationId,
        client,
        input: {
          policyType: "mapping",
          policyKey: "orphan",
          version: 1,
          displayName: "Orphan",
          description: "Should never be filed.",
          definition: { a: 1 },
          effectiveAt: new Date("2026-10-01T00:00:00.000Z"),
        },
      })
    );

    expect(refusal).toEqual({ code: "NOT_FOUND" });
    const [policies] = await db.select({ n: count() }).from(controlPolicies).where(eq(controlPolicies.organizationId, missingOrganizationId));
    const [audits] = await db.select({ n: count() }).from(auditLogs).where(eq(auditLogs.organizationId, missingOrganizationId));
    expect(policies.n).toBe(0);
    expect(audits.n).toBe(0);
  });

  it("should answer a repeated version as a conflict, keeping the first", async () => {
    await draft("version-proof", 1, "2026-10-01T00:00:00.000Z");
    expect(await failureOf(() => draft("version-proof", 1, "2026-10-01T00:00:00.000Z", { other: true }))).toEqual({ code: "CONFLICT" });
  });

  it("should hold one active version per key, while any number of retired ones coexist", async () => {
    const v1 = await draft("slot-proof", 1, "2026-10-01T00:00:00.000Z");
    const v2 = await draft("slot-proof", 2, "2026-10-02T00:00:00.000Z");
    const v3 = await draft("slot-proof", 3, "2026-10-03T00:00:00.000Z");

    await approvedAndActivated(v1.id);
    // The unique slot, not a read-then-write check, refuses the second.
    expect(await failureOf(() => approvedAndActivated(v2.id))).toEqual({ code: "CONFLICT" });

    await retireControlPolicy({ actor, organizationId, client, input: { policyId: v1.id, retirementReference: "CAB-r1" } });
    await expect(activateControlPolicy({ actor, organizationId, client, input: { policyId: v2.id } })).resolves.toMatchObject({ status: "active" });
    await retireControlPolicy({ actor, organizationId, client, input: { policyId: v2.id, retirementReference: "CAB-r2" } });
    await expect(approvedAndActivated(v3.id)).resolves.toMatchObject({ status: "active" });

    const rows = await db
      .select({ id: controlPolicies.id, status: controlPolicies.status, activeSlot: controlPolicies.activeSlot, retiredAt: controlPolicies.retiredAt })
      .from(controlPolicies)
      .where(and(eq(controlPolicies.organizationId, organizationId), eq(controlPolicies.policyKey, "slot-proof")));
    const byId = new Map(rows.map(row => [row.id, row]));
    expect(byId.get(v1.id)).toMatchObject({ status: "retired", activeSlot: null });
    expect(byId.get(v2.id)).toMatchObject({ status: "retired", activeSlot: null });
    expect(byId.get(v3.id)).toMatchObject({ status: "active", activeSlot: `${organizationId}:reconciliation:slot-proof` });
    expect(byId.get(v1.id)?.retiredAt).toBeInstanceOf(Date);

    // Every step left its audit event in the tenant's chain.
    const audited = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.entityId, v1.id)));
    expect(audited.map(row => row.action).sort()).toEqual([
      "control_policy_activated",
      "control_policy_approved",
      "control_policy_drafted",
      "control_policy_retired",
    ]);
  });

  it("should withdraw an approved policy before its effective date, dated by the server", async () => {
    const future = await draft("withdraw-proof", 1, "2037-12-31T00:00:00.000Z");
    await approveControlPolicy({ actor, organizationId, client, input: { policyId: future.id, approvalReference: "CAB-w" } });
    const before = Date.now();

    await retireControlPolicy({ actor, organizationId, client, input: { policyId: future.id, retirementReference: "CAB-withdrawn" } });

    const stored = await getControlPolicy(organizationId, future.id);
    expect(stored.status).toBe("retired");
    // TIMESTAMP keeps whole seconds; the recorded time is now, not the future date.
    expect(stored.retiredAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(stored.retiredAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("should store both edges of the admitted date range, where the engine refuses one second past", async () => {
    const earliest = await draft("range-proof", 1, TIMESTAMP_MIN.toISOString());
    const latest = await draft("range-proof", 2, TIMESTAMP_MAX.toISOString());
    expect((await getControlPolicy(organizationId, earliest.id)).effectiveAt).toEqual(TIMESTAMP_MIN);
    expect((await getControlPolicy(organizationId, latest.id)).effectiveAt).toEqual(TIMESTAMP_MAX);

    // The control: written past the input bound, the database itself refuses,
    // so the bound is the column's real limit and not an invented one.
    const pastTheEdge = db.insert(controlPolicies).values({
      organizationId,
      policyType: "mapping",
      policyKey: "range-proof-raw",
      version: 1,
      displayName: "Raw",
      description: "Bypasses the input bound.",
      definition: {},
      definitionDigest: "x".repeat(64),
      effectiveAt: new Date(TIMESTAMP_MAX.getTime() + 1_000),
      createdByUserId: 1,
    });
    await expect(pastTheEdge).rejects.toThrow();
  });

  it("should page through every version exactly once, newest effective first, ties by id", async () => {
    const created: number[] = [];
    for (const [version, at] of [
      [1, "2026-09-01T00:00:00.000Z"],
      [2, "2026-09-02T00:00:00.000Z"],
      [3, "2026-09-02T00:00:00.000Z"], // ties with v2: the id breaks the tie
      [4, "2026-09-03T00:00:00.000Z"],
      [5, "2026-09-04T00:00:00.000Z"],
    ] as const) {
      created.push((await draft("paging-proof", version, at)).id);
    }

    const seen: number[] = [];
    let pages = 0;
    let cursor: unknown = undefined;
    do {
      // Parsed as the router parses it, so the ISO-string cursor round-trips.
      const options = controlPolicyScopeInput.parse({ policyKey: "paging-proof", limit: 2, ...(cursor ? { cursor } : {}) });
      const result = await listControlPolicies(organizationId, options);
      seen.push(...result.rows.map(row => row.id));
      cursor = result.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    const [v1, v2, v3, v4, v5] = created;
    expect(pages).toBe(3);
    expect(seen).toEqual([v5, v4, Math.max(v2, v3), Math.min(v2, v3), v1]);
  });
});
