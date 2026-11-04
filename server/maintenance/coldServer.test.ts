import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { readDrainTimeout, readStartupMode, selectStartup } from "./config";
import { startMaintenanceServer } from "./coldServer";

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});
async function get(path: string, method = "GET") {
  const address = server!.address();
  if (!address || typeof address === "string") throw new Error("fixture_not_listening");
  return await new Promise<{ status: number; body: string; retry: string | undefined; cache: string | undefined }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path, method }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body, retry: res.headers["retry-after"], cache: res.headers["cache-control"] }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("when selecting the supported runtime startup mode", () => {
  it("should default only an absent value to normal startup", () => {
    expect(readStartupMode(undefined)).toBe("normal");
    expect(readStartupMode("normal")).toBe("normal");
    expect(readStartupMode("maintenance")).toBe("maintenance");
  });
  it.each(["", "true", "NORMAL", "maintenance ", "unknown"])("should refuse invalid mode %s without echoing its value", value => {
    expect(() => readStartupMode(value)).toThrow("invalid_startup_mode");
  });
  it("should never invoke the normal application loader during maintenance", async () => {
    const normal = vi.fn(async () => { throw new Error("normal_loader_must_not_run"); });
    const maintenance = vi.fn(async () => {});
    await selectStartup("maintenance", { normal, maintenance });
    expect(normal).not.toHaveBeenCalled();
    expect(maintenance).toHaveBeenCalledOnce();
  });
  it("should keep normal startup lazy and unchanged when explicitly selected", async () => {
    const normal = vi.fn(async () => {});
    const maintenance = vi.fn(async () => {});
    await selectStartup("normal", { normal, maintenance });
    expect(normal).toHaveBeenCalledOnce();
    expect(maintenance).not.toHaveBeenCalled();
  });
  it("should preserve lazy normal-mode chunks beside the production entrypoint", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: { build: string; start: string } };
    expect(manifest.scripts.build).toContain("--splitting");
    expect(manifest.scripts.build).toContain("--entry-names=index");
    expect(manifest.scripts.build).toContain("--chunk-names=server-[name]-[hash]");
    expect(manifest.scripts.start).toContain("dist/index.js");
  });
  it("should validate a bounded shutdown wait without interpreting it as an outage budget", () => {
    expect(readDrainTimeout(undefined)).toBe(90_000);
    expect(readDrainTimeout("1000")).toBe(1000);
    expect(readDrainTimeout("300000")).toBe(300000);
    for (const value of ["", "-1", "999", "300001", "1e5", "Infinity", " 1000"]) {
      expect(() => readDrainTimeout(value)).toThrow("invalid_drain_timeout");
    }
  });
});

describe("when the cold maintenance HTTP server is listening on an isolated fixture", () => {
  it("should expose liveness without creating a dependency health probe", async () => {
    server = await startMaintenanceServer(0, "127.0.0.1");
    const result = await get("/api/healthz");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: "ok", mode: "maintenance" });
    expect(result.cache).toBe("no-store");
  });
  it.each(["/api/health", "/api/readyz", "/api/trpc/auth.me", "/api/webhooks/shopify", "/api/magic-login", "/dashboard", "/api/healthz/", "//api/healthz"])("should refuse operational path %s without false acknowledgement", async path => {
    server = await startMaintenanceServer(0, "127.0.0.1");
    const result = await get(path);
    expect(result.status).toBe(503);
    expect(result.retry).toBe("60");
    expect(JSON.parse(result.body)).toEqual({ status: "maintenance", code: "maintenance_unavailable" });
  });
  it("should refuse non-GET health requests without parsing or persisting their body", async () => {
    server = await startMaintenanceServer(0, "127.0.0.1");
    expect((await get("/api/healthz", "POST")).status).toBe(503);
  });
  it("should keep the cold server source free of application writer imports", () => {
    const source = readFileSync(new URL("./coldServer.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["'].*(?:db|storage|queue|router|sdk|env)["']/i);
    expect(source).not.toMatch(/process\.env|import\(/);
  });
});
