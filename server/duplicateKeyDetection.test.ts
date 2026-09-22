/**
 * Duplicate-key detection, at every place that relies on it.
 *
 * drizzle-orm (0.44) wraps each failed query in a DrizzleQueryError whose own
 * message is "Failed query: <sql>\nparams: …"; the driver's ER_DUP_ENTRY is on
 * `.cause`. Three places recognised a duplicate by regex on the OUTER message,
 * so none of them ever saw a real one:
 *
 *   - _core/tenantKeys.ts provisionTenantKey — the concurrent-first-use race
 *     rethrew instead of adopting the key the other caller stored (fixed in
 *     its own PR, as server/_core is protected — CLAUDE.md §17);
 *   - provisioning.ts provisionTenantBaseline — a step that already existed
 *     reported `failed`, so a re-run of the "idempotent" baseline never passed
 *     (and CBS onboarding, which encrypts its secrets before the baseline,
 *     reported encryption_key failed on every client with a secret);
 *   - connectors/woodcore/webhooks.ts — a redelivered CBS webhook answered 503
 *     instead of "duplicate", so the sender kept retrying one it had delivered.
 *
 * ── Why these tests go through drizzle ────────────────────────────────────
 *
 * The bug lived entirely in the gap between the driver's error and the error
 * application code receives. A test that throws a hand-built
 * `new Error("Duplicate entry …")` skips that gap and passes against the broken
 * regex. So each test here runs a REAL drizzle instance over a scripted mysql2
 * client: drizzle builds the statement and wraps the failure itself, and the
 * only fake is the wire — which raises exactly the error mysql2 raises.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-duplicate-key-suite";
});
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: vi.fn(async () => state.db),
}));
vi.mock("./connectors/woodcore/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connectors/woodcore/config")>()),
  getConfigRow: vi.fn(),
}));
vi.mock("./connectors/woodcore/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connectors/woodcore/secrets")>()),
  decryptSecretForOrg: vi.fn(async () => "webhook-secret"),
}));
vi.mock("./_core/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_core/rateLimit")>()),
  checkTenantRate: vi.fn(async () => ({ allowed: true, retryAfterSec: 0 })),
}));

import { drizzle } from "drizzle-orm/mysql2";
import { tenantQuotas } from "../drizzle/tenant_schema";
import { isDuplicateKeyError } from "./dbErrors";
import { provisionTenantBaseline } from "./provisioning";
import { clearDekCacheForTests, getMasterKeyProvider, provisionTenantKey } from "./_core/tenantKeys";
import { getConfigRow } from "./connectors/woodcore/config";
import { computeSignature, handleWoodcoreWebhook } from "./connectors/woodcore/webhooks";

const ORG = 42;

/** The error mysql2 raises for a unique-key violation — the driver's shape, before drizzle touches it. */
function mysqlDuplicateEntry(key: string): Error {
  const message = `Duplicate entry '${ORG}-1' for key '${key}'`;
  return Object.assign(new Error(message), { code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000", sqlMessage: message });
}

type Reply = unknown[] | { insertId: number; affectedRows: number } | Error;

/**
 * A real drizzle instance over a scripted mysql2 client. Statements are built,
 * sent and — on failure — wrapped by drizzle itself; `reply` stands in for the
 * server, answering each statement by its SQL.
 */
function drizzleOver(reply: (sql: string) => Reply) {
  const statements: string[] = [];
  const client = {
    async query(query: string | { sql: string }) {
      const sql = typeof query === "string" ? query : query.sql;
      statements.push(sql);
      const answer = reply(sql);
      if (answer instanceof Error) throw answer;
      return [answer, []];
    },
  };
  return { db: drizzle(client as never), statements };
}

/** A tenant_encryption_keys row as the driver returns it (columns in table order). */
function keyRow(wrappedDek: string) {
  return [7, ORG, "local", wrappedDek, null, 1, 1, "2026-09-22 00:00:00", null];
}

const unexpected = (sql: string) => new Error(`unexpected statement: ${sql}`);

beforeEach(() => {
  vi.clearAllMocks();
  clearDekCacheForTests();
});

describe("the premise: drizzle wraps the driver's error", () => {
  it("should hide the duplicate from the outer message and keep it on the cause", async () => {
    const { db } = drizzleOver(() => mysqlDuplicateEntry("PRIMARY"));
    const error = await db
      .insert(tenantQuotas)
      .values({ organizationId: ORG })
      .then(
        () => null,
        (caught: unknown) => caught as Error & { cause?: { code?: string } },
      );

    expect(error?.message).toMatch(/^Failed query: insert into `tenant_quotas`/);
    // What all three sites used to read — and why they never matched:
    expect(/duplicate/i.test(error?.message ?? "")).toBe(false);
    expect(error?.cause?.code).toBe("ER_DUP_ENTRY");
    expect(isDuplicateKeyError(error)).toBe(true);
  });
});

describe("when two callers provision the same tenant's key at once", () => {
  it("should adopt the key the other caller stored instead of failing", async () => {
    const winner = await getMasterKeyProvider().generateDek();
    const { db, statements } = drizzleOver((sql) => {
      if (sql.startsWith("insert into `tenant_encryption_keys`")) return mysqlDuplicateEntry("uq_tenant_key_org_version");
      if (sql.startsWith("select") && sql.includes("from `tenant_encryption_keys`")) return [keyRow(winner.wrapped)];
      return unexpected(sql);
    });
    state.db = db;

    const key = await provisionTenantKey(ORG);

    // The winner's DEK: anything either caller encrypts decrypts under the stored key.
    expect(key.dek.equals(winner.dek)).toBe(true);
    expect(statements.some((sql) => sql.startsWith("select"))).toBe(true);
  });

  it("should still surface a failure that is not a duplicate", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", errno: -4077 });
    state.db = drizzleOver(() => reset).db;
    await expect(provisionTenantKey(ORG)).rejects.toThrow(/Failed query/);
  });
});

describe("when the tenant baseline is re-run on a tenant that already has one", () => {
  // provisioning.ts: "provisioning is idempotent, so re-running repairs it" —
  // true only if an existing step reads as present rather than failed.
  it("should report no failed step and ok", async () => {
    const existing = await getMasterKeyProvider().generateDek();
    const { db } = drizzleOver((sql) => {
      if (sql.startsWith("insert into `tenant_encryption_keys`")) return mysqlDuplicateEntry("uq_tenant_key_org_version");
      if (sql.startsWith("insert into `tenant_quotas`")) return mysqlDuplicateEntry("PRIMARY");
      if (sql.startsWith("insert into `module_configurations`")) return mysqlDuplicateEntry("uq_module_org_type");
      if (sql.startsWith("select") && sql.includes("from `organizations`")) return [["financial_services"]];
      if (sql.startsWith("select") && sql.includes("from `tenant_encryption_keys`")) return [keyRow(existing.wrapped)];
      return unexpected(sql);
    });
    state.db = db;

    const result = await provisionTenantBaseline(ORG);

    expect(result.steps.filter((step) => step.status === "failed")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.steps).toContainEqual({ step: "quotas", status: "already_present" });
  });

  it("should still report a step that genuinely failed", async () => {
    const existing = await getMasterKeyProvider().generateDek();
    const { db } = drizzleOver((sql) => {
      if (sql.startsWith("insert into `tenant_encryption_keys`")) return mysqlDuplicateEntry("uq_tenant_key_org_version");
      if (sql.startsWith("insert into `tenant_quotas`")) return Object.assign(new Error("Lock wait timeout exceeded"), { code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205 });
      if (sql.startsWith("insert into `module_configurations`")) return mysqlDuplicateEntry("uq_module_org_type");
      if (sql.startsWith("select") && sql.includes("from `organizations`")) return [["financial_services"]];
      if (sql.startsWith("select") && sql.includes("from `tenant_encryption_keys`")) return [keyRow(existing.wrapped)];
      return unexpected(sql);
    });
    state.db = db;

    const result = await provisionTenantBaseline(ORG);

    expect(result.ok).toBe(false);
    expect(result.steps).toContainEqual(expect.objectContaining({ step: "quotas", status: "failed" }));
  });
});

describe("when a CBS webhook is delivered twice", () => {
  const SECRET = "webhook-secret";

  function deliver() {
    const rawBody = Buffer.from(JSON.stringify({ eventId: "evt-1", eventType: "savings.deposit", data: { id: 1 } }));
    return handleWoodcoreWebhook({
      configId: 5,
      rawBody,
      headers: { "x-woodcore-signature": computeSignature(rawBody, SECRET) },
    });
  }

  beforeEach(() => {
    vi.mocked(getConfigRow).mockResolvedValue({
      id: 5,
      organizationId: ORG,
      isEnabled: true,
      webhookEnabled: true,
      webhookSecretEnc: "stored",
      cbsType: "woodcore",
    } as never);
  });

  it("should acknowledge the redelivery as a duplicate, not fail it", async () => {
    // A 503 here makes the core banking system retry a delivery we already hold.
    state.db = drizzleOver((sql) =>
      sql.startsWith("insert into `wc_connector_webhook_events`") ? mysqlDuplicateEntry("uq_wc_webhook_event") : unexpected(sql),
    ).db;
    expect(await deliver()).toEqual({ httpStatus: 200, body: { ok: true, status: "duplicate" } });
  });

  it("should still answer 503 when the event store genuinely fails", async () => {
    state.db = drizzleOver(() => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", errno: -4077 })).db;
    const result = await deliver();
    expect(result.httpStatus).toBe(503);
    expect(result.body).toMatchObject({ status: "event_store_failed" });
  });
});

describe("no hand-rolled duplicate detection", () => {
  /**
   * The same mistake was made three times, each a local copy of one line. Any
   * code that decides "was this a duplicate?" must call isDuplicateKeyError.
   * These are the spellings a local copy takes.
   */
  const HAND_ROLLED = [/\/duplicate\/i/, /["'`]Duplicate entry/i, /\bER_DUP_ENTRY\b/, /\berrno\s*===?\s*1062\b/];

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
      return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
    });
  }

  const offendingLines = (source: string) =>
    source.split(/\r?\n/).filter((line) => HAND_ROLLED.some((pattern) => pattern.test(line)));

  /**
   * Known offenders whose fix lives elsewhere, each with its reason. An entry
   * must still offend: the moment its fix lands, the staleness test below fails
   * until the entry is removed, so this list can only shrink.
   */
  const AWAITING_FIX: Record<string, string> = {};

  const normalise = (file: string) => file.split(path.sep).join("/");

  it("should find none outside server/dbErrors.ts and the files awaiting a fix", () => {
    const offenders = sourceFiles("server")
      .filter((file) => path.basename(file) !== "dbErrors.ts" && !(normalise(file) in AWAITING_FIX))
      .flatMap((file) => offendingLines(fs.readFileSync(file, "utf8")).map((line) => `${normalise(file)}: ${line.trim()}`));
    expect(offenders, "Detect duplicates with isDuplicateKeyError (server/dbErrors.ts), not a local check").toEqual([]);
  });

  it("should drop a file from the awaiting list as soon as it is fixed", () => {
    for (const file of Object.keys(AWAITING_FIX)) {
      expect(offendingLines(fs.readFileSync(file, "utf8")), `${file} no longer offends — remove it from AWAITING_FIX`).not.toEqual([]);
    }
  });

  it("should recognise each spelling it forbids, so the check above cannot pass vacuously", () => {
    // The three lines this suite replaced, plus the other spellings.
    expect(offendingLines("if (/duplicate/i.test(msg)) {")).toHaveLength(1);
    expect(offendingLines('if (msg.includes("Duplicate entry")) {')).toHaveLength(1);
    expect(offendingLines('if (err.code === "ER_DUP_ENTRY") {')).toHaveLength(1);
    expect(offendingLines("if (err.errno === 1062) {")).toHaveLength(1);
    expect(sourceFiles("server").length).toBeGreaterThan(100);
  });
});
