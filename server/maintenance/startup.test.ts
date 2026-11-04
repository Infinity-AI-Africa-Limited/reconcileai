import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationLifecycle, MaintenanceAdmissionError } from "./lifecycle";
import { attachShutdownSignals } from "./shutdown";
import { listenUnlessFenced } from "./startup";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const servers: Server[] = [];
function fixtureServer(): Server {
  const server = createServer((_req, res) => { res.end(); });
  servers.push(server);
  return server;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    if (server.listening) server.close(() => resolve());
    else resolve();
  })));
});

describe("when a shutdown signal arrives while startup is still running", () => {
  it("should not bind after the fence, and should close the pools only once startup has settled", async () => {
    const lifecycle = new ApplicationLifecycle();
    const server = fixtureServer();
    const order: string[] = [];
    const closeResources = vi.fn(async () => { order.push("resources_closed"); });
    const hook = attachShutdownSignals(server, { timeoutMs: 1000, closeResources }, lifecycle, new EventEmitter());
    const portSearch = deferred();
    let bound: boolean | undefined;
    const startup = lifecycle.runRoot("startup", async () => {
      await portSearch.promise; // the signal lands during an import or the port search
      bound = await listenUnlessFenced(server, 0, "127.0.0.1", lifecycle);
      order.push("startup_settled");
    });
    const outcome = hook.shutdown();
    await Promise.resolve();
    expect(closeResources).not.toHaveBeenCalled();
    portSearch.resolve();
    await startup;
    expect(bound).toBe(false);
    expect(server.listening).toBe(false);
    expect(await outcome).toEqual({ status: "stopped", scope: "tracked_process_only" });
    expect(order).toEqual(["startup_settled", "resources_closed"]);
    hook.detach();
  });

  it("should finish a bind already in flight, then close the listening server", async () => {
    const lifecycle = new ApplicationLifecycle();
    const server = fixtureServer();
    const closeResources = vi.fn(async () => {});
    const hook = attachShutdownSignals(server, { timeoutMs: 1000, closeResources }, lifecycle, new EventEmitter());
    let bound: boolean | undefined;
    const startup = lifecycle.runRoot("startup", async () => {
      bound = await listenUnlessFenced(server, 0, "127.0.0.1", lifecycle);
    });
    // listen() has been called but the socket is not bound yet.
    expect(server.listening).toBe(false);
    const outcome = hook.shutdown();
    await startup;
    expect(bound).toBe(true);
    expect(await outcome).toEqual({ status: "stopped", scope: "tracked_process_only" });
    expect(server.listening).toBe(false);
    expect(closeResources).toHaveBeenCalledOnce();
    hook.detach();
  });

  it("should refuse startup outright once shutdown has begun", async () => {
    const lifecycle = new ApplicationLifecycle();
    lifecycle.beginDrain();
    const startServer = vi.fn(async () => {});
    await expect(lifecycle.runRoot("startup", startServer)).rejects.toBeInstanceOf(MaintenanceAdmissionError);
    expect(startServer).not.toHaveBeenCalled();
  });
});

describe("when the port cannot be bound", () => {
  it("should reject rather than hang, and leave no listener behind", async () => {
    const holder = fixtureServer();
    await new Promise<void>(resolve => holder.listen(0, "127.0.0.1", () => resolve()));
    const { port } = holder.address() as AddressInfo;
    const server = fixtureServer();
    await expect(listenUnlessFenced(server, port, "127.0.0.1", new ApplicationLifecycle()))
      .rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(server.listening).toBe(false);
    expect(server.listenerCount("error")).toBe(0);
  });
});

describe("when the production entrypoint starts the server", () => {
  const source = readFileSync(new URL("../_core/index.ts", import.meta.url), "utf8");

  it("should run startup as tracked root work and bind only through the fence check", () => {
    expect(source).toContain('applicationLifecycle.runRoot("startup", () => startServer(app, server))');
    expect(source).toContain('listenUnlessFenced(server, port, "0.0.0.0")');
    expect(source).not.toContain('server.listen(port, "0.0.0.0"');
  });

  it("should attach the shutdown signals before startup begins", () => {
    const attached = source.indexOf("const shutdownHook = attachShutdownSignals(server");
    const started = source.indexOf('applicationLifecycle.runRoot("startup"');
    expect(attached).toBeGreaterThan(-1);
    expect(attached).toBeLessThan(started);
  });
});
