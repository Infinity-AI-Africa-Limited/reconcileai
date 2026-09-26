/**
 * The wrapper's job is to stop a rejected handler reaching the process.
 *
 * The proof that matters is not "res.status was called" — it is that the
 * process survives. So the headline case runs in a FRESH Node process with the
 * default `--unhandled-rejections=throw`, exactly as production does, with a
 * POSITIVE CONTROL: the same rejecting handler, unwrapped, must kill that
 * process. Without the control the test would pass just as happily against a
 * wrapper that did nothing; running it out of process means the control's
 * deliberate rejection never lands in the test runner's own process.
 *
 * The in-process cases below also run under a `process.on("unhandledRejection")`
 * watch, as a second line — they never emit one unless the wrapper is broken.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asyncHandler } from "./_core/asyncHandler";

/**
 * Call a rejecting handler the way Express 4 does — invoke it, ignore what it
 * returns — in a fresh Node process, then report whether that process lived.
 */
function runInFreshNode(wrap: boolean) {
  const script = `
    const { asyncHandler } = await import(${JSON.stringify(pathToFileURL(path.join(__dirname, "_core", "asyncHandler.ts")).href)});
    const saw = {};
    const res = { headersSent: false, status(c) { saw.status = c; return res; }, json(b) { saw.body = b; return res; }, end() { return res; } };
    const req = { path: "/api/scheduled/sync", method: "POST", originalUrl: "/api/scheduled/sync", headers: {} };
    const failing = async () => { throw new Error("dependency exploded"); };
    console.error = () => {};
    (${wrap} ? asyncHandler(failing) : failing)(req, res, () => {});
    setTimeout(() => process.stdout.write(JSON.stringify({ survived: true, ...saw })), 100);
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    // Production's defaults, not the test runner's: no inherited NODE_OPTIONS.
    env: { ...process.env, NODE_OPTIONS: "" },
    timeout: 30_000,
  });
}

/** What the handler did to the response — kept separate from the response itself. */
interface Recorder {
  statusCode?: number;
  body?: unknown;
  ended: boolean;
}

function fakeRes(headersSent = false): { res: Record<string, unknown>; saw: Recorder } {
  const saw: Recorder = { ended: false };
  const res = {
    headersSent,
    status(code: number) {
      saw.statusCode = code;
      return res;
    },
    json(body: unknown) {
      saw.body = body;
      return res;
    },
    end() {
      saw.ended = true;
      return res;
    },
  };
  return { res, saw };
}

const fakeReq = (path = "/api/woodcore/sync") =>
  ({ path, method: "POST", originalUrl: path, headers: {} }) as never;

/** Run `fn`, then let the microtask queue drain so a rejection would surface. */
async function withRejectionWatch(fn: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (err: unknown) => seen.push(err);
  process.on("unhandledRejection", onRejection);
  try {
    fn();
    // Two macrotask turns: enough for Node to decide a rejection is unhandled.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

describe("when a route handler's promise rejects", () => {
  it("should kill a real Node process unwrapped — the positive control", () => {
    const run = runInFreshNode(false);
    expect(run.error).toBeUndefined();
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain("survived");
    expect(run.stderr).toContain("dependency exploded");
  }, 40_000);

  it("should leave that same process alive, and the caller answered, once wrapped", () => {
    const run = runInFreshNode(true);
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ survived: true, status: 503, body: { error: "internal_error" } });
  }, 40_000);

  it("should answer the caller instead of hanging the request", async () => {
    const { res, saw } = fakeRes();
    await withRejectionWatch(() => {
      asyncHandler(async () => {
        await Promise.reject(new Error("module init failed"));
      })(fakeReq("/developers"), res as never, (() => {}) as never);
    });
    expect(saw.statusCode).toBe(500);
    expect(saw.body).toEqual({ error: "internal_error" });
  });

  it("should tell a scheduler or webhook caller to retry, with 503", async () => {
    for (const path of ["/api/scheduled/shoplineSyncCycle", "/api/webhooks/shopline"]) {
      const { res, saw } = fakeRes();
      await withRejectionWatch(() => {
        asyncHandler(async () => {
          throw new Error("nope");
        })(fakeReq(path), res as never, (() => {}) as never);
      });
      expect(saw.statusCode, path).toBe(503);
    }
  });

  it("should end a stream rather than try to set headers twice", async () => {
    // The SSE monitor has already written headers by the time its work runs.
    // Calling res.status() there throws ERR_HTTP_HEADERS_SENT — which would be
    // the very failure this wrapper exists to prevent.
    const { res, saw } = fakeRes(true);
    const escaped = await withRejectionWatch(() => {
      asyncHandler(async () => {
        throw new Error("jobEvents unavailable");
      })(fakeReq("/api/monitoring/stream"), res as never, (() => {}) as never);
    });
    expect(escaped).toHaveLength(0);
    expect(saw.ended).toBe(true);
    expect(saw.statusCode).toBeUndefined(); // never attempted a second set of headers
  });

  it("should survive a response object that throws while being written to", async () => {
    // Socket destroyed mid-failure. This function is the last line before the
    // process exits, so it must not throw on its way out.
    const hostile = {
      headersSent: false,
      status() {
        throw new Error("socket gone");
      },
    };
    const escaped = await withRejectionWatch(() => {
      asyncHandler(async () => {
        throw new Error("original failure");
      })(fakeReq(), hostile as never, (() => {}) as never);
    });
    expect(escaped).toHaveLength(0);
  });

  it("should log the route, so the next one is diagnosable without a repro", async () => {
    await withRejectionWatch(() => {
      asyncHandler(async () => {
        throw new Error("boom");
      })(fakeReq("/api/woodcore/sync"), fakeRes().res as never, (() => {}) as never);
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("POST /api/woodcore/sync"),
      expect.any(Error),
    );
  });
});

describe("when a route handler behaves", () => {
  it("should leave a resolving handler completely alone", async () => {
    const { res, saw } = fakeRes();
    await withRejectionWatch(() => {
      asyncHandler(async (_req, r) => {
        (r as unknown as { status: (n: number) => { json: (b: unknown) => void } }).status(200).json({ ok: true });
      })(fakeReq(), res as never, (() => {}) as never);
    });
    expect(saw.statusCode).toBe(200);
    expect(saw.body).toEqual({ ok: true });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("should catch a handler that throws synchronously, before any promise exists", async () => {
    const { res, saw } = fakeRes();
    const escaped = await withRejectionWatch(() => {
      asyncHandler((() => {
        throw new Error("sync throw");
      }) as never)(fakeReq(), res as never, (() => {}) as never);
    });
    expect(escaped).toHaveLength(0);
    expect(saw.statusCode).toBe(500);
  });
});
