/**
 * No Express route may let a rejection escape unless it is wrapped in `asyncHandler`.
 *
 * Express 4 lets a rejected handler promise reach the process, and Node 22
 * exits on it. The next such handler would be as fatal as the first, so this
 * is a rule rather than a one-off fix: every route is either `try`-wrapped
 * (it answers its own failures) or wrapped in `asyncHandler`.
 *
 * The check is an AST walk (tools/scanAsyncHandlers.ts), not a regex — a regex
 * cannot tell an `await` inside a `try` from one outside it, which is the whole
 * question. Handlers are followed wherever they are defined, so naming one or
 * building it in a factory does not take it out of scope.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createScanner, scanFile, type Exposure } from "../tools/scanAsyncHandlers";

const SERVER = path.resolve(__dirname);

function serverSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) serverSources(full, acc);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts")) acc.push(full);
  }
  return acc;
}

/** Scan an in-memory set of files, entry first — lets a test follow an import without touching disk. */
function scanVirtual(files: Record<string, string>) {
  const byPath = new Map(Object.entries(files).map(([name, text]) => [path.resolve("/virtual", name), text]));
  const [entry] = byPath.keys();
  return scanFile(entry, byPath.get(entry), { read: f => byPath.get(f) });
}

const HEADER = `import express from "express";\nimport type { Request, Response } from "express";\nconst app = express();\n`;

describe("when the real server code is scanned", () => {
  // Every server file is parsed once and shared by both cases below.
  const REAL_SCAN_TIMEOUT = 60_000;
  let real: { handlers: string[]; exposures: Exposure[] } | undefined;
  beforeAll(() => {
    const handlers = new Set<string>();
    const scanner = createScanner({
      onHandler: h => handlers.add(`${h.route} -> ${h.name} @ ${path.relative(SERVER, h.file).split(path.sep).join("/")}${h.wrapped ? " [wrapped]" : ""}`),
    });
    const exposures = serverSources(SERVER).flatMap(f => scanner.scanFile(f));
    real = { handlers: [...handlers], exposures };
  }, REAL_SCAN_TIMEOUT);

  it("should see into the handlers the server really registers, so a clean result means something", () => {
    // An empty result is only reassuring if the scan looked. These are the
    // shapes that escaped the first version of it: a named const, a named
    // middleware function, and handlers built by a factory — plus a wrapped
    // inline one, to prove the wrapper is recognised on real code.
    expect(real?.handlers).toEqual(
      expect.arrayContaining([
        "POST /api/webhooks/cbs/:configId -> cbsWebhookHandler @ _core/index.ts",
        "USE <middleware> -> requireApiKey @ api/gateway.ts",
        "POST /api/shopline/gdpr/shop-data-request -> <anonymous> @ connectors/shopline/routes.ts",
        // Imported from another file — and the route where this crash class was first found (#134).
        "POST /api/webhooks/shopify -> handleShopifyWebhook @ connectors/shopify/webhooks.ts",
        "GET /developers -> <anonymous> @ _core/index.ts [wrapped]",
      ]),
    );
  });

  it("should leave no route exposed without asyncHandler", () => {
    const exposed = (real?.exposures ?? [])
      .filter(e => !e.wrapped)
      .map(e => `${path.relative(SERVER, e.file)}:${e.line} ${e.route} [${e.kind}] ${e.expression}`);

    expect(real, "the real-code scan did not run").toBeDefined();
    expect(
      exposed,
      "Wrap the handler in asyncHandler(...) from _core/asyncHandler, or move the work inside a try/catch that answers the caller",
    ).toEqual([]);
  });
});

describe("when a handler is written inline", () => {
  it("should flag an await outside a try, and see the wrapper when it is added", () => {
    const sample = `${HEADER}import { asyncHandler } from "./_core/asyncHandler";
      app.get("/x", async (req, res) => {
        const mod = await import("./thing");
        res.json(mod.value);
      });
      app.get("/y", asyncHandler(async (req, res) => {
        const mod = await import("./thing");
        res.json(mod.value);
      }));`;
    const found = scanFile(path.resolve("/virtual/a.ts"), sample);
    expect(found.map(e => [e.route, e.kind, e.wrapped])).toEqual([
      ["GET /x", "await", false],
      ["GET /y", "await", true],
    ]);
  });

  it("should not flag a handler whose work is entirely inside a try", () => {
    const guarded = `${HEADER}
      app.post("/y", async (req, res) => {
        try {
          const mod = await import("./thing");
          return res.json(mod.value);
        } catch (err) {
          return res.status(500).json({ error: "nope" });
        }
      });`;
    expect(scanFile(path.resolve("/virtual/a.ts"), guarded)).toEqual([]);
  });

  it("should not be fooled by a try WITHOUT a catch", () => {
    // `try { … } finally { … }` re-throws: the rejection still escapes.
    const finallyOnly = `${HEADER}
      app.post("/z", async (req, res) => {
        try {
          await work();
          res.end();
        } finally {
          cleanup();
        }
      });`;
    expect(scanFile(path.resolve("/virtual/a.ts"), finallyOnly).map(e => e.kind)).toEqual(["await"]);
  });

  it("should flag an await in a concise arrow body, not only in a block", () => {
    const concise = `${HEADER}
      app.get("/c1", async (req, res) => await loadData());
      app.get("/c2", async (req, res) => res.json(await loadData()));`;
    expect(scanFile(path.resolve("/virtual/a.ts"), concise).map(e => [e.route, e.kind])).toEqual([
      ["GET /c1", "await"],
      ["GET /c2", "await"],
    ]);
  });

  it("should flag the awaits that are not await expressions — for await, await using", () => {
    const loops = `${HEADER}
      app.get("/l1", async (req, res) => { for await (const row of stream()) res.write(row); res.end(); });
      app.get("/l2", async (req, res) => { await using lock = acquire(); res.end(); });
      app.get("/l3", async (req, res) => {
        try { for await (const row of stream()) res.write(row); res.end(); } catch { res.status(500).end(); }
      });`;
    expect(scanFile(path.resolve("/virtual/a.ts"), loops).map(e => [e.route, e.kind])).toEqual([
      ["GET /l1", "await"],
      ["GET /l2", "await"],
    ]);
  });

  it("should not trust a function merely NAMED asyncHandler", () => {
    const impostor = `${HEADER}
      const asyncHandler = (fn: unknown) => fn;
      app.get("/x", asyncHandler(async (req, res) => { await work(); res.end(); }));`;
    expect(scanFile(path.resolve("/virtual/a.ts"), impostor)[0]?.wrapped).toBe(false);
  });
});

describe("when a handler returns a promise instead of awaiting it", () => {
  const routes = (body: string) => `${HEADER}
      import { dispatchWork } from "some-package";
      async function doWork(req: Request) { return 1; }
      function sendError(res: Response, status: number) { return res.status(status).json({}); }
      app.post("/r", async (req, res) => { ${body} });`;
  const kinds = (body: string) => scanFile(path.resolve("/virtual/a.ts"), routes(body)).map(e => e.kind);

  it("should flag the returned call whatever the callee is called", () => {
    // The old scanner only looked at names starting handle|run|process|sync.
    expect(kinds("return dispatchWork(req, res);")).toEqual(["returned-promise"]);
    expect(kinds("return doWork(req);")).toEqual(["returned-promise"]);
  });

  it("should flag it even inside a try, because a try does not catch a returned promise", () => {
    // `return p` hands p back unawaited: it rejects after the try has exited.
    expect(kinds("try { return doWork(req); } catch { return res.status(500).end(); }")).toEqual(["returned-promise"]);
  });

  it("should accept `return await` inside a try — that one IS caught", () => {
    expect(kinds("try { return await doWork(req); } catch { return res.status(500).end(); }")).toEqual([]);
  });

  it("should accept a returned response, directly or through an Express-typed helper", () => {
    expect(kinds("return res.status(400).json({ error: 'bad' });")).toEqual([]);
    expect(kinds("return sendError(res, 400);")).toEqual([]);
  });

  it("should flag a NON-async handler that returns a promise — Express ignores it just the same", () => {
    const plain = `${HEADER}
      async function work() {}
      app.get("/p", (req, res) => work());`;
    expect(scanFile(path.resolve("/virtual/a.ts"), plain).map(e => e.kind)).toEqual(["returned-promise"]);
  });
});

describe("when a handler is defined somewhere other than the route call", () => {
  const unguarded = `async (req: Request, res: Response) => { await work(); res.end(); }`;

  it("should follow a named const and a function declaration in the same file", () => {
    const sample = `${HEADER}
      const named = ${unguarded};
      async function declared(req: Request, res: Response) { await work(); res.end(); }
      app.post("/a", named);
      app.post("/b", declared);`;
    expect(scanFile(path.resolve("/virtual/a.ts"), sample).map(e => e.route)).toEqual(["POST /a", "POST /b"]);
  });

  it("should follow a factory to the handler it returns", () => {
    const sample = `${HEADER}
      const make = (kind: string) => ${unguarded};
      function makeBlock(kind: string) { return ${unguarded}; }
      app.post("/c", make("x"));
      app.post("/d", makeBlock("y"));`;
    expect(scanFile(path.resolve("/virtual/a.ts"), sample).map(e => e.route)).toEqual(["POST /c", "POST /d"]);
  });

  it("should follow a static import and an `await import()` into the other file", () => {
    const found = scanVirtual({
      "routes.ts": `${HEADER}
        import { exported } from "./handlers";
        async function mount() {
          const { lazy } = await import("./handlers");
          app.post("/e", exported);
          app.post("/f", lazy);
        }`,
      "handlers.ts": `import type { Request, Response } from "express";
        export const exported = ${unguarded};
        export async function lazy(req: Request, res: Response) { await work(); res.end(); }`,
    });
    expect(found.map(e => [e.route, e.kind, path.basename(e.file)])).toEqual([
      ["POST /e", "await", "handlers.ts"],
      ["POST /f", "await", "handlers.ts"],
    ]);
  });

  it("should report what it cannot see into, never assume it safe", () => {
    const sample = `${HEADER}
      import { mystery } from "some-package";
      export function mount(handler: (req: Request, res: Response) => Promise<void>) {
        app.post("/g", handler);
        app.post("/h", mystery());
      }`;
    expect(scanFile(path.resolve("/virtual/a.ts"), sample).map(e => [e.route, e.kind])).toEqual([
      ["POST /g", "opaque"],
      ["POST /h", "opaque"],
    ]);
  });

  it("should take apart arrays and spreads of handlers — Express flattens them", () => {
    const sample = `${HEADER}import { asyncHandler } from "./_core/asyncHandler";
      const mw = (req: Request, res: Response, next: () => void) => next();
      const chain = [mw, async (req: Request, res: Response) => { await work(); res.end(); }];
      app.get("/a1", [mw, async (req, res) => { await work(); res.end(); }]);
      app.get("/a2", [mw, asyncHandler(async (req, res) => { await work(); res.end(); })]);
      app.post("/a3", chain);
      app.post("/a4", ...chain);
      app.get(["/a5", "/a6"], async (req, res) => { await work(); res.end(); });
      app.get("/a7", flag ? mw : async (req, res) => { await work(); res.end(); });`;
    expect(scanFile(path.resolve("/virtual/a.ts"), sample).map(e => [e.route, e.kind, e.wrapped])).toEqual([
      ["GET /a1", "await", false],
      ["GET /a2", "await", true],
      ["POST /a3", "await", false],
      ["POST /a4", "await", false],
      ["GET /a5,/a6", "await", false],
      ["GET /a7", "await", false],
    ]);
  });

  it("should accept Express's own middleware and a router, which cannot reject", () => {
    const sample = `${HEADER}
      import { Router as createRouter } from "express";
      const router = createRouter();
      function buildRouter() { return router; }
      app.use(express.json());
      app.use(express.static("dist"));
      app.use(buildRouter());`;
    expect(scanFile(path.resolve("/virtual/a.ts"), sample)).toEqual([]);
  });
});

describe("when the receiver is not an obvious `app`", () => {
  it("should check an Express-typed parameter, a router, and app.route()", () => {
    const sample = `import express, { type Express } from "express";
      const api = express.Router();
      export function register(server: Express) {
        server.get("/i", async (req, res) => { await work(); res.end(); });
        api.post("/j", async (req, res) => { await work(); res.end(); });
        server.route("/k").get(async (req, res) => { await work(); res.end(); });
      }`;
    expect(scanFile(path.resolve("/virtual/a.ts"), sample).map(e => e.route)).toEqual(["GET /i", "POST /j", "GET <middleware>"]);
  });

  it("should still check a '/path' route when the receiver's type cannot be traced", () => {
    const sample = `type App = import("express").Express;
      export function register(server: App) {
        server.get("/l", async (req, res) => { await work(); res.end(); });
      }`;
    expect(scanFile(path.resolve("/virtual/a.ts"), sample).map(e => e.route)).toEqual(["GET /l"]);
  });

  it("should leave a Map's get and delete alone", () => {
    const sample = `const cache = new Map<string, () => Promise<void>>();
      const hit = cache.get("key");
      cache.delete("key");`;
    expect(scanFile(path.resolve("/virtual/a.ts"), sample)).toEqual([]);
  });
});
