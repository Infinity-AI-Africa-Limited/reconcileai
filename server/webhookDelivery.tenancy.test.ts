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
 *     names `webhooks.organizationId`, and every dispatch call names a tenant;
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
vi.mock("./_core/egress", () => ({ isEgressAllowed: () => true }));
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

function visit(node: ts.Node, fn: (node: ts.Node) => void) {
  fn(node);
  node.forEachChild(child => visit(child, fn));
}

const where = (sf: ts.SourceFile, node: ts.Node) => {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${path.relative(SERVER, sf.fileName).replace(/\\/g, "/")}:${line + 1}`;
};

/** Every query chain that reads `webhooks`: `.from(webhooks)` or a join onto it, with the whole chain's text. */
function webhookReadChains(): Array<{ at: string; chain: string }> {
  const out: Array<{ at: string; chain: string }> = [];
  for (const file of serverSources()) {
    const sf = parse(file);
    visit(sf, node => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text;
      if (!["from", "innerJoin", "leftJoin", "rightJoin"].includes(method)) return;
      const first = node.arguments[0];
      if (!first || !ts.isIdentifier(first) || first.text !== "webhooks") return;
      // Climb to the outermost call of the builder chain.
      let top: ts.Node = node;
      while (ts.isPropertyAccessExpression(top.parent) && ts.isCallExpression(top.parent.parent)) top = top.parent.parent;
      out.push({ at: where(sf, node), chain: top.getText(sf) });
    });
  }
  return out;
}

const DISPATCHERS = new Set(["dispatchWebhook", "dispatchWebhookEvent"]);

/** Every call that sends a webhook event, with its arguments. */
function dispatchCalls(): Array<{ at: string; callee: string; args: ts.Expression[]; sf: ts.SourceFile }> {
  const out: Array<{ at: string; callee: string; args: ts.Expression[]; sf: ts.SourceFile }> = [];
  for (const file of serverSources()) {
    const sf = parse(file);
    visit(sf, node => {
      if (!ts.isCallExpression(node)) return;
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (!callee || !DISPATCHERS.has(callee)) return;
      out.push({ at: where(sf, node), callee, args: [...node.arguments], sf });
    });
  }
  return out;
}

describe("the server source, read structurally", () => {
  it("should name webhooks.organizationId in the where clause of every read of webhooks", () => {
    const chains = webhookReadChains();
    // Vacuity guard: the four reads that exist today (list, dispatch's target
    // lookup, the delivery dashboard and its stats).
    expect(chains.length).toBeGreaterThanOrEqual(4);

    const unscoped = chains
      .filter(({ chain }) => !/\.where\(/.test(chain) || !/webhooks\.organizationId/.test(chain))
      .map(({ at }) => at);
    expect(
      unscoped,
      "These read `webhooks` without a tenant predicate, so they can return every tenant's " +
        "webhooks. Add eq(webhooks.organizationId, <tenant>) to the where clause.",
    ).toEqual([]);
  });

  it("should name a tenant as the first argument of every webhook dispatch", () => {
    const calls = dispatchCalls();
    // Vacuity guard: the wrapper's own call, its exception helper, both upload
    // paths and the run's four outcomes.
    expect(calls.length).toBeGreaterThanOrEqual(8);

    const offenders: string[] = [];
    for (const { at, callee, args, sf } of calls) {
      if (args.length !== 3) {
        offenders.push(`${at} ${callee}: ${args.length} arguments — (tenant, event, payload) expected`);
        continue;
      }
      const tenant = args[0];
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
    }
    expect(
      offenders,
      "Each webhook dispatch must name the tenant that owns what the event is about — the " +
        "job's, the exception's, the upload's — as a narrowed variable, not a literal, an " +
        "assertion, or the request context.",
    ).toEqual([]);
  });
});
