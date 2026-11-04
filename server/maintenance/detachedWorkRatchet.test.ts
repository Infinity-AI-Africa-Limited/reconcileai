/**
 * A promise that server code starts and nobody awaits is invisible to the drain
 * unless it is tracked. Untracked, the drain can report idle and the pools can
 * close while it is still writing. #214's review found the storage proxy's
 * audit write in that state, and the same shape at nine call sites in
 * procedures, among them a manual Woodcore batch sync that writes for minutes
 * after returning.
 *
 * So every detached promise in server code is either TRACKED work
 * (`runBackgroundWork`, `deferBackgroundWork`, or a lifecycle reservation) or a
 * REVIEWED exception below, with the reason it cannot hold a pool, a queue or a
 * write past the drain.
 *
 * "Detached" is read from syntax: a statement that is `void <call>`, or a call
 * chain ending in `.then` / `.catch` / `.finally` whose value nobody takes.
 * A bare floating call (`write();`) needs types to recognise and is not caught
 * here. Node 22 would crash on its rejection, so this codebase writes
 * fire-and-forget with a `.catch`, which is the shape this test does see.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SERVER = path.resolve(__dirname, "..");
const CHAIN = new Set(["then", "catch", "finally"]);

/** The detached promise IS a lifecycle reservation, counted until it settles. */
const TRACKED_ROOTS = new Set(["applicationLifecycle.run", "applicationLifecycle.runRoot"]);

/** file → root of the detached chain → why it cannot outlive the drain unsafely. */
const REVIEWED: Record<string, Record<string, string>> = {
  "_core/bootstrap.ts": {
    bootstrap: "the process entry point; there is nothing above it to await it",
  },
  "_core/index.ts": {
    "shutdownHook.shutdown": "the shutdown itself, logging its own result",
  },
  "_core/llm.ts": {
    "lastResponse.body?.cancel": "discards a failed HTTP response body; no pool, queue or write",
  },
  "connectors/shopify/runtimeQueueReadiness.ts": {
    probe: "queue count reads for /api/health evidence; no write",
  },
  "connectors/shopline/realtimeSync.ts": {
    realtimeQueue: "builds the queue; the jobs its worker runs are tracked queue-handler work",
    requestRealtimeSync: "enqueue reserves its own queue-operation, and is refused once fenced",
  },
  "jobQueue.ts": {
    "finishing.get(bullJob)": "settles a queue-handler reservation the lifecycle already counts",
    work: "observes a bounded queue operation that already holds its own reservation",
  },
  "maintenance/deferredWork.ts": {
    "Promise.resolve": "settles the reservation runBackgroundWork already holds",
  },
  "maintenance/lifecycle.ts": {
    "Promise.resolve": "the lifecycle counting a producer stop it invoked",
  },
  "maintenance/shutdown.ts": {
    work: "a deadline that ends a wait; the work it watches is still tracked",
    shutdown: "the signal handler logging the shutdown result",
  },
  "outboundDestination.ts": {
    permittedAddresses: "DNS answers for a socket's own lookup callback; no write",
  },
  "storageHealth.ts": {
    withDeadline: "best-effort removal of the health probe object, under its own deadline; no pool",
  },
};

type Detached = { file: string; line: number; root: string };

function serverSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) serverSources(full, acc);
    else if (/\.ts$/.test(entry) && !/\.(test|spec|testkit)\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** `void a().then(…)` → `a`; `x.catch(…)` → `x`: what the detached chain hangs off. */
function chainRoot(expression: ts.Expression, sf: ts.SourceFile): string {
  let e = expression;
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && CHAIN.has(e.expression.name.text)) {
    e = e.expression.expression;
  }
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const target = ts.isCallExpression(e) ? e.expression : e;
  return target.getText(sf).replace(/\s+/g, " ");
}

function detachedIn(file: string, source: string): Detached[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const out: Detached[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isExpressionStatement(node)) {
      const e = node.expression;
      const detached = ts.isVoidExpression(e)
        ? ts.isCallExpression(e.expression) ? e.expression : undefined
        : ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && CHAIN.has(e.expression.name.text)
          ? e
          : undefined;
      if (detached) {
        out.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          root: chainRoot(detached, sf),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function unreviewed(found: Detached[]): string[] {
  return found
    .filter(d => !TRACKED_ROOTS.has(d.root) && !(d.root in (REVIEWED[d.file] ?? {})))
    .map(d => `${d.file}:${d.line} ${d.root}`);
}

describe("when the real server code is scanned for detached promises", () => {
  const found = serverSources(SERVER).flatMap(full => {
    const rel = path.relative(SERVER, full).split(path.sep).join("/");
    return detachedIn(rel, readFileSync(full, "utf8"));
  });

  it("should see the tracked reservations, so a clean result means something", () => {
    const roots = found.map(d => `${d.file} ${d.root}`);
    expect(roots).toEqual(expect.arrayContaining([
      "_core/asyncHandler.ts applicationLifecycle.run",
      "_core/index.ts applicationLifecycle.runRoot",
    ]));
  });

  it("should leave no detached work untracked", () => {
    expect(
      unreviewed(found),
      "Launch it with runBackgroundWork(...) from maintenance/lifecycle, or review it into REVIEWED with the reason",
    ).toEqual([]);
  });

  it("should keep every reviewed exception real, so the list cannot rot", () => {
    const present = new Set(found.map(d => `${d.file} ${d.root}`));
    const stale = Object.entries(REVIEWED).flatMap(([file, roots]) =>
      Object.keys(roots).filter(root => !present.has(`${file} ${root}`)).map(root => `${file} ${root}`),
    );
    expect(stale).toEqual([]);
  });
});

describe("when a procedure launches work it does not await", () => {
  it("should flag a detached chain and a void call, and accept tracked launches", () => {
    const source = `
      async function procedure() {
        void (async () => { await write(); })();
        write().catch(() => {});
        void import("./x").then((m) => m.write()).catch(() => {});
        runBackgroundWork(() => write().catch(() => {}));
        void applicationLifecycle.run("background", () => write()).catch(() => {});
        await write().catch(() => {});
        const kept = write().then(() => 1);
        return write().finally(() => {});
      }`;
    expect(unreviewed(detachedIn("routers/fixture.ts", source)).map(s => s.replace(/:\d+/, ""))).toEqual([
      "routers/fixture.ts (async () => { await write(); })",
      "routers/fixture.ts write",
      "routers/fixture.ts import",
    ]);
  });
});
