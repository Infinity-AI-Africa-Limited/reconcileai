import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkStorageHealth, STORAGE_LIST_PROBE_TIMEOUT_MS, type StorageHealthDeps } from "./storageHealth";

/** In-memory storage that lists like S3, with each step replaceable. */
function storage(overrides: Partial<StorageHealthDeps> = {}) {
  const objects = new Set<string>();
  let clock = 1_000;
  const deps: StorageHealthDeps = {
    put: vi.fn(async (key: string) => {
      objects.add(key);
      return { key };
    }),
    get: vi.fn(async (key: string) => ({ key, url: `https://signed.example/${key}` })),
    list: vi.fn(async (prefix: string) => [...objects].filter((key) => key.startsWith(prefix))),
    remove: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
    now: () => (clock += 5),
    ...overrides,
  };
  return { deps, objects };
}

const awsError = (name: string, httpStatusCode: number) =>
  Object.assign(new Error(`${name}: bucket reconcileai-storage, key health-checks/x`), { name, $metadata: { httpStatusCode } });

afterEach(() => {
  vi.useRealTimers();
});

describe("when storage can write, read and list", () => {
  it("should report ok with the listing's time, and clean the probe up", async () => {
    const { deps, objects } = storage();

    const health = await checkStorageHealth(deps);

    expect(health).toMatchObject({ status: "ok", list: "ok" });
    expect(health).toHaveProperty("listMs");
    expect(objects.size).toBe(0);
  });

  it("should list exactly the folder the probe was written to", async () => {
    const { deps } = storage();

    await checkStorageHealth(deps);

    const [written] = vi.mocked(deps.put).mock.calls[0];
    const [folder] = vi.mocked(deps.list).mock.calls[0];
    expect(folder).toMatch(/^health-checks\/[^/]+\/$/);
    expect(written).toBe(`${folder}probe.txt`);
  });

  it("should write each probe to a folder of its own", async () => {
    const { deps } = storage();

    await checkStorageHealth(deps);
    await checkStorageHealth(deps);

    const folders = vi.mocked(deps.list).mock.calls.map(([folder]) => folder);
    expect(new Set(folders).size).toBe(2);
  });
});

describe("when storage can write but not list", () => {
  it("should report degraded and denied, and still clean the probe up", async () => {
    const { deps, objects } = storage({ list: vi.fn(async () => Promise.reject(awsError("AccessDenied", 403))) });

    const health = await checkStorageHealth(deps);

    expect(health).toMatchObject({ status: "degraded", list: "denied", listError: "AccessDenied" });
    expect(objects.size).toBe(0);
  });

  it("should treat a bare 403 as denied whatever the error is called", async () => {
    const { deps } = storage({ list: vi.fn(async () => Promise.reject(awsError("Forbidden", 403))) });

    expect(await checkStorageHealth(deps)).toMatchObject({ status: "degraded", list: "denied" });
  });

  it("should report a listing that answers without the probe as missing", async () => {
    const { deps } = storage({ list: vi.fn(async () => []) });

    expect(await checkStorageHealth(deps)).toMatchObject({ status: "degraded", list: "missing" });
  });

  it("should report any other listing failure as failed, by the error's name only", async () => {
    const { deps } = storage({ list: vi.fn(async () => Promise.reject(awsError("NoSuchBucket", 404))) });

    const health = await checkStorageHealth(deps);

    expect(health).toMatchObject({ status: "degraded", list: "failed", listError: "NoSuchBucket" });
    // A public endpoint: no bucket, key or error text.
    expect(JSON.stringify(health)).not.toMatch(/reconcileai-storage|health-checks/);
  });

  it("should not pass on an error name that is not a plain identifier", async () => {
    const odd = Object.assign(new Error("x"), { name: "bucket reconcileai-storage denied" });
    const { deps } = storage({ list: vi.fn(async () => Promise.reject(odd)) });

    expect(await checkStorageHealth(deps)).toMatchObject({ list: "failed", listError: "error" });
  });

  it("should stop waiting for a listing that does not answer in time", async () => {
    vi.useFakeTimers();
    const { deps } = storage({ list: vi.fn(() => new Promise<string[]>(() => undefined)) });

    const health = checkStorageHealth(deps);
    await vi.advanceTimersByTimeAsync(STORAGE_LIST_PROBE_TIMEOUT_MS);

    await expect(health).resolves.toMatchObject({ status: "degraded", list: "failed", listError: "TimeoutError" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("when storage cannot write", () => {
  it("should report error as before, and never try to list", async () => {
    const { deps } = storage({ put: vi.fn(async () => Promise.reject(new Error("Storage not configured"))) });

    const health = await checkStorageHealth(deps);

    expect(health).toEqual({ status: "error", message: "Storage not configured" });
    expect(deps.list).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });
});

describe("when GET /api/health runs", () => {
  /** The handler of `app.get("/api/health", …)`, read as syntax from the server entry. */
  function healthHandler(): ts.Node {
    const file = path.join(__dirname, "_core", "index.ts");
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
    let handler: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "get" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "/api/health"
      ) {
        handler = node.arguments[1];
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!handler) throw new Error("GET /api/health not found");
    return handler;
  }

  it("should report storage from checkStorageHealth", () => {
    const assignments: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.getText() === "checks.storage"
      ) {
        assignments.push(node.right.getText());
      }
      ts.forEachChild(node, visit);
    };
    visit(healthHandler());
    // The check itself, and the error a throw from it becomes — never a fixed "ok".
    expect(assignments[0]).toBe("await checkStorageHealth()");
    expect(assignments.slice(1).every((value) => /status: "error"/.test(value))).toBe(true);
  });
});
