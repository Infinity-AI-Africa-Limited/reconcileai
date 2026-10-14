/**
 * Webhook tenancy: every event reaches only the webhooks of the tenant it
 * belongs to.
 *
 * Until 2026-10-14 dispatch selected every active webhook on the platform
 * (`WHERE isActive = true`) and no caller named a tenant, so a user at bank B
 * could subscribe to "*" and receive bank A's run results, exception counts
 * and resolution events. It passed readScopeRatchet because that ratchet asks
 * only whether a select on `webhooks` HAS a where clause — and it had one, on
 * `isActive`. A where clause is not a tenant predicate.
 *
 * Three layers here:
 *   - the dispatcher itself, against a fake database that records its query;
 *   - a structural ratchet over the server source: every read of `webhooks`
 *     restricts it to one tenant IN ITS WHERE CLAUSE (an allow-list of
 *     shapes: the column merely appearing elsewhere in the query, as Greptile
 *     showed on #196, scopes nothing), and every dispatch call names a tenant;
 *   - the types: a tenant is a required `number`, so `null` does not compile.
 *
 * The real-database proof, over real HTTP, is webhookTenancy.db.test.ts. The
 * callers' tenants are pinned in webhookTenancy.callers.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { SQL } from "drizzle-orm";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  selects: [] as unknown[],
  inserts: [] as Array<Record<string, unknown>>,
  nextId: 1,
}));

const fakeDb = {
  select: () => ({
    from: () => ({
      where: async (where: unknown) => {
        state.selects.push(where);
        return state.rows;
      },
    }),
  }),
  insert: () => ({
    values: (values: Record<string, unknown>) => ({
      $returningId: async () => {
        state.inserts.push(values);
        return [{ id: state.nextId++ }];
      },
    }),
  }),
  update: () => ({ set: () => ({ where: async () => [{ affectedRows: 1 }] }) }),
};

vi.mock("./db", () => ({ getDb: async () => fakeDb }));
vi.mock("./_core/egress", () => ({ isEgressAllowed: () => true, isOnPremise: () => false }));
const queue = vi.hoisted(() => ({ enqueue: null as unknown as ReturnType<typeof vi.fn> }));
vi.mock("./jobQueue", async importOriginal => ({
  ...(await importOriginal<typeof import("./jobQueue")>()),
  createQueue: vi.fn(async () => ({
    backend: "in-process",
    enqueue: (...args: unknown[]) => queue.enqueue(...args),
    stats: async () => ({ backend: "in-process", durable: false }),
    close: async () => {},
  })),
}));

import { activeWebhooksOfTenant, dispatchWebhookEvent } from "./webhookDelivery";

const TENANT_A = 42;
const TENANT_B = 60001;
const EVENT = "reconciliation.completed";

const webhookOf = (organizationId: number | null, id: number, events: unknown = ["*"]) => ({
  id,
  organizationId,
  url: `https://hooks.example/${id}`,
  secret: "s",
  isActive: true,
  events,
});
const rendered = (where: unknown) => (where instanceof SQL ? new MySqlDialect().sqlToQuery(where) : null);
const enqueuedTo = () => (queue.enqueue.mock.calls as Array<[string, { webhookId: number }]>).map(c => c[1].webhookId);

beforeEach(() => {
  state.rows = [];
  state.selects.length = 0;
  state.inserts.length = 0;
  queue.enqueue = vi.fn(async () => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("when dispatch looks for an event's targets", () => {
  it("should ask for the named tenant's active webhooks and no one else's", async () => {
    await activeWebhooksOfTenant(TENANT_A);

    const where = rendered(state.selects[0]);
    expect(where?.sql).toMatch(/`webhooks`\.`organizationId` = \?/);
    expect(where?.sql).toMatch(/`webhooks`\.`isActive` = \?/);
    expect(where?.params).toEqual(expect.arrayContaining([TENANT_A]));
  });

  it("should send to the tenant's own subscribed webhook", async () => {
    state.rows = [webhookOf(TENANT_A, 1)];
    await dispatchWebhookEvent(TENANT_A, EVENT, { jobId: 9 });

    expect(rendered(state.selects[0])?.params).toEqual(expect.arrayContaining([TENANT_A]));
    expect(enqueuedTo()).toEqual([1]);
    expect(state.inserts).toHaveLength(1);
  });

  it("should withhold a row of another tenant, or of none, even if the query returned one", async () => {
    // The query is the control; this pins the second barrier behind it, so a
    // future edit to the query fails safe rather than open.
    state.rows = [webhookOf(TENANT_B, 2), webhookOf(null, 3), webhookOf(TENANT_A, 1)];
    await dispatchWebhookEvent(TENANT_A, EVENT, { jobId: 9 });

    expect(enqueuedTo()).toEqual([1]);
    expect(state.inserts.map(row => row.webhookId)).toEqual([1]);
  });
});

describe("when dispatch is given something that is not a tenant", () => {
  it.each([0, -1, 1.5, Number.NaN, null, undefined])(
    "should refuse %s before reading any webhook, and send nothing",
    async (notATenant) => {
      state.rows = [webhookOf(TENANT_A, 1)];
      await dispatchWebhookEvent(notATenant as unknown as number, EVENT, { jobId: 9 });

      expect(state.selects).toEqual([]);
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/no owning tenant/));
    },
  );
});

describe("when a tenant's webhooks subscribe to different events", () => {
  it("should send each only what it subscribed to, and nothing to a string-encoded subscription", async () => {
    // A JSON column written as a JSON string reads back as a string. The old
    // create path wrote exactly that, so its webhooks subscribed to nothing.
    state.rows = [
      webhookOf(TENANT_A, 1, ["exception.created"]),
      webhookOf(TENANT_A, 2, ["*"]),
      webhookOf(TENANT_A, 3, JSON.stringify(["*"])),
      webhookOf(TENANT_A, 4, [EVENT]),
    ];
    await dispatchWebhookEvent(TENANT_A, EVENT, { jobId: 9 });

    expect(enqueuedTo()).toEqual([2, 4]);
  });
});

describe("the dispatch signature", () => {
  it("should require a tenant as a number, so null does not compile", () => {
    // Type-level: checked by `pnpm check:tests` (tsconfig.tests.json).
    expectTypeOf(dispatchWebhookEvent).parameter(0).toEqualTypeOf<number>();
    expectTypeOf(activeWebhooksOfTenant).parameter(0).toEqualTypeOf<number>();
    // @ts-expect-error — no tenant is not a tenant.
    const refused: Parameters<typeof dispatchWebhookEvent> = [null, EVENT, {}];
    expect(refused[0]).toBeNull();
  });
});

// ─── Structural ratchet over the server source ───────────────────────────────

const SERVER = path.resolve(__dirname);

function serverSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
    }
  };
  walk(SERVER);
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/** A snippet parsed as if it were a server file, for the ratchet's own negative cases. */
function parseSnippet(source: string): ts.SourceFile {
  return ts.createSourceFile(path.join(SERVER, "snippet.ts"), source, ts.ScriptTarget.Latest, true);
}

function visit(node: ts.Node, fn: (node: ts.Node) => void) {
  fn(node);
  node.forEachChild(child => visit(child, fn));
}

const where = (sf: ts.SourceFile, node: ts.Node) => {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${path.relative(SERVER, sf.fileName).replace(/\\/g, "/")}:${line + 1}`;
};

/** `obj.prop` with both names as given. */
function isMember(node: ts.Node, obj: string, prop: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === obj &&
    node.name.text === prop
  );
}

/** A reference to any column of `webhooks`. */
function isWebhooksColumn(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "webhooks";
}

/**
 * Does this where-clause argument restrict rows to ONE tenant? An allow-list of
 * shapes, because only these provably do:
 *   - `eq(webhooks.organizationId, <x>)`, where <x> is not itself a webhooks column;
 *   - `and(...)` with such a term among its own arguments (recursively).
 * Everything else is refused: `or(...)` and `not(...)` widen, a variable cannot
 * be read here, and the column appearing elsewhere in the chain (selected, for
 * instance) restricts nothing.
 */
function scopesToTenant(expr: ts.Node): boolean {
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) return false;
  const [left, right] = expr.arguments;
  if (expr.expression.text === "eq" && expr.arguments.length === 2) {
    return (
      (isMember(left, "webhooks", "organizationId") && !isWebhooksColumn(right)) ||
      (isMember(right, "webhooks", "organizationId") && !isWebhooksColumn(left))
    );
  }
  if (expr.expression.text === "and") return expr.arguments.some(scopesToTenant);
  return false;
}

/** The calls of one builder chain, outermost first: `.where(...)`, `.from(...)`, `.select(...)`. */
function chainCalls(top: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  let node: ts.Node = top;
  while (ts.isCallExpression(node)) {
    calls.push(node);
    if (!ts.isPropertyAccessExpression(node.expression)) break;
    node = node.expression.expression;
  }
  return calls;
}

const methodOf = (call: ts.CallExpression) =>
  ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;

const READS_A_TABLE = ["from", "innerJoin", "leftJoin", "rightJoin"];

/**
 * Every query reading `webhooks` (from or join) whose where clause does not
 * restrict it to one tenant, and every read of `webhookDeliveries` that does
 * not join `webhooks` (a delivery's tenant is its webhook's).
 */
function tenantScopeOffenders(sf: ts.SourceFile): { offenders: string[]; reads: number } {
  const offenders: string[] = [];
  let reads = 0;
  visit(sf, node => {
    if (!ts.isCallExpression(node) || !READS_A_TABLE.includes(methodOf(node) ?? "")) return;
    const table = node.arguments[0];
    if (!table || !ts.isIdentifier(table)) return;
    if (table.text !== "webhooks" && !(table.text === "webhookDeliveries" && methodOf(node) === "from")) return;

    // Climb to the outermost call of this builder chain.
    let top: ts.Node = node;
    while (ts.isPropertyAccessExpression(top.parent) && ts.isCallExpression(top.parent.parent)) top = top.parent.parent;
    const calls = chainCalls(top);

    if (table.text === "webhookDeliveries") {
      const joinsWebhooks = calls.some(
        call => methodOf(call) === "innerJoin" && ts.isIdentifier(call.arguments[0]) && call.arguments[0].text === "webhooks",
      );
      if (!joinsWebhooks) offenders.push(`${where(sf, node)} reads webhookDeliveries without joining webhooks`);
      return;
    }

    reads++;
    const whereArgs = calls.filter(call => methodOf(call) === "where").map(call => call.arguments[0]);
    if (!whereArgs.some(arg => arg !== undefined && scopesToTenant(arg))) {
      offenders.push(`${where(sf, node)} reads webhooks without a tenant predicate`);
    }
  });
  return { offenders, reads };
}

const DISPATCHERS = new Set(["dispatchWebhook", "dispatchWebhookEvent"]);

/** Every call that sends a webhook event without naming a real tenant first. */
function dispatchOffenders(sf: ts.SourceFile): { offenders: string[]; calls: number } {
  const offenders: string[] = [];
  let calls = 0;
  visit(sf, node => {
    if (!ts.isCallExpression(node)) return;
    const callee = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : null;
    if (!callee || !DISPATCHERS.has(callee)) return;
    calls++;
    const at = where(sf, node);
    if (node.arguments.length !== 3) {
      offenders.push(`${at} ${callee}: ${node.arguments.length} arguments — (tenant, event, payload) expected`);
      return;
    }
    const tenant = node.arguments[0];
    const text = tenant.getText(sf);
    const bad =
      tenant.kind === ts.SyntaxKind.NullKeyword ||
      ts.isLiteralExpression(tenant) ||
      ts.isPrefixUnaryExpression(tenant) ||
      (ts.isIdentifier(tenant) && tenant.text === "undefined") ||
      // `x!` or `x as number` asserts a tenant the code does not have.
      ts.isNonNullExpression(tenant) ||
      ts.isAsExpression(tenant) ||
      ts.isTypeAssertionExpression(tenant) ||
      // The request's tenant is not the event's: name the row's (§6).
      /\bctx\b/.test(text);
    if (bad) offenders.push(`${at} ${callee}(${text}, …)`);
  });
  return { offenders, calls };
}

describe("the server source, read structurally", () => {
  it("should restrict every read of webhooks to one tenant in its where clause", () => {
    const offenders: string[] = [];
    let reads = 0;
    for (const file of serverSources()) {
      const found = tenantScopeOffenders(parse(file));
      offenders.push(...found.offenders);
      reads += found.reads;
    }
    // Vacuity guard: the reads that exist today (list, the active count,
    // dispatch's targets, delivery's target, the dashboard and its stats).
    expect(reads).toBeGreaterThanOrEqual(6);
    expect(
      offenders,
      "These can return another tenant's webhooks. Put eq(webhooks.organizationId, <tenant>) " +
        "in the where clause, alone or as a term of and(...), and join webhooks to read deliveries.",
    ).toEqual([]);
  });

  it("should name a tenant as the first argument of every webhook dispatch", () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const file of serverSources()) {
      const found = dispatchOffenders(parse(file));
      offenders.push(...found.offenders);
      calls += found.calls;
    }
    // Vacuity guard: the wrapper's own call, its exception helper, both upload
    // paths, the run's four outcomes and the closure effects' resolution.
    expect(calls).toBeGreaterThanOrEqual(9);
    expect(
      offenders,
      "Each webhook dispatch must name the tenant that owns what the event is about — the " +
        "job's, the exception's, the upload's — as a narrowed variable, not a literal, an " +
        "assertion, or the request context.",
    ).toEqual([]);
  });
});

describe("the ratchet itself", () => {
  // Each snippet is a way a read can lose its tenant while still LOOKING
  // scoped. The first is Greptile's (#196): the column selected, not filtered.
  it.each([
    [
      "the tenant column only selected",
      "db.select({ organizationId: webhooks.organizationId }).from(webhooks).where(eq(webhooks.isActive, true));",
    ],
    ["no where clause", "db.select().from(webhooks);"],
    ["the tenant only in an or()", "db.select().from(webhooks).where(or(eq(webhooks.organizationId, org), eq(webhooks.isActive, true)));"],
    ["a not()", "db.select().from(webhooks).where(not(eq(webhooks.organizationId, org)));"],
    ["a ne()", "db.select().from(webhooks).where(ne(webhooks.organizationId, org));"],
    ["a tautology", "db.select().from(webhooks).where(eq(webhooks.organizationId, webhooks.organizationId));"],
    ["a predicate the ratchet cannot read", "const scope = eq(webhooks.organizationId, org); db.select().from(webhooks).where(scope);"],
    ["a join onto webhooks filtered elsewhere", "db.select().from(webhookDeliveries).innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id)).where(eq(webhookDeliveries.status, 'failed'));"],
    ["deliveries read without their webhook", "db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));"],
  ])("should flag a read with %s", (_label, source) => {
    expect(tenantScopeOffenders(parseSnippet(source)).offenders).toHaveLength(1);
  });

  it.each([
    ["the tenant alone", "db.select().from(webhooks).where(eq(webhooks.organizationId, org));"],
    ["the tenant reversed", "db.select().from(webhooks).where(eq(org, webhooks.organizationId));"],
    ["the tenant as a term of and()", "db.select().from(webhooks).where(and(eq(webhooks.isActive, true), eq(webhooks.organizationId, org))).limit(1);"],
    ["the tenant in a nested and()", "db.select().from(webhooks).where(and(eq(webhooks.isActive, true), and(gte(webhooks.createdAt, d), eq(webhooks.organizationId, org))));"],
    ["deliveries joined and scoped", "db.select().from(webhookDeliveries).innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id)).where(and(eq(webhooks.organizationId, org), gte(webhookDeliveries.createdAt, d)));"],
  ])("should pass a read with %s", (_label, source) => {
    expect(tenantScopeOffenders(parseSnippet(source)).offenders).toEqual([]);
  });

  it.each([
    ["a literal", "dispatchWebhook(1, 'upload.completed', {});"],
    ["null", "dispatchWebhookEvent(null, 'upload.completed', {});"],
    ["the request context", "dispatchWebhook(ctx.user.organizationId, 'upload.completed', {});"],
    ["a non-null assertion", "dispatchWebhook(job.organizationId!, 'upload.completed', {});"],
    ["a cast", "dispatchWebhook(job.organizationId as number, 'upload.completed', {});"],
    ["no tenant at all", "dispatchWebhookEvent('upload.completed', {});"],
  ])("should flag a dispatch naming %s", (_label, source) => {
    expect(dispatchOffenders(parseSnippet(source)).offenders).toHaveLength(1);
  });

  it("should pass a dispatch naming a narrowed tenant", () => {
    expect(dispatchOffenders(parseSnippet("dispatchWebhook(batchTenant, 'upload.completed', {});")).offenders).toEqual([]);
  });
});
