import { describe, expect, it, vi } from "vitest";
import { createResilientPool, isConnectionError, withOneRetry } from "./mysqlPool";

function connError(code: string): Error & { code: string } {
  const err = new Error(`read ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe("isConnectionError", () => {
  it("recognises the stale-connection error codes seen against TiDB serverless", () => {
    expect(isConnectionError(connError("ECONNRESET"))).toBe(true);
    expect(isConnectionError(connError("HANDSHAKE_SSL_ERROR"))).toBe(true);
    expect(isConnectionError(connError("PROTOCOL_CONNECTION_LOST"))).toBe(true);
    expect(isConnectionError(connError("ETIMEDOUT"))).toBe(true);
    expect(isConnectionError(connError("EPIPE"))).toBe(true);
  });

  it("does not match statement-level errors", () => {
    expect(isConnectionError(connError("ER_DUP_ENTRY"))).toBe(false);
    expect(isConnectionError(connError("ER_PARSE_ERROR"))).toBe(false);
    expect(isConnectionError(new Error("plain error"))).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError("ECONNRESET")).toBe(false);
  });
});

describe("withOneRetry", () => {
  it("retries exactly once on a connection error and returns the retry result", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(connError("ECONNRESET"))
      .mockResolvedValueOnce([[{ ok: 1 }], []]);
    const wrapped = withOneRetry(fn, "query");
    await expect(wrapped("SELECT 1")).resolves.toEqual([[{ ok: 1 }], []]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, "SELECT 1");
  });

  it("does not retry statement errors", async () => {
    const fn = vi.fn().mockRejectedValue(connError("ER_DUP_ENTRY"));
    const wrapped = withOneRetry(fn, "execute");
    await expect(wrapped("INSERT …")).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("surfaces the second failure instead of retrying forever", async () => {
    const fn = vi.fn().mockRejectedValue(connError("ECONNRESET"));
    const wrapped = withOneRetry(fn, "query");
    await expect(wrapped("SELECT 1")).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("passes through a first-attempt success untouched", async () => {
    const fn = vi.fn().mockResolvedValue("rows");
    const wrapped = withOneRetry(fn, "query");
    await expect(wrapped()).resolves.toBe("rows");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("createResilientPool", () => {
  it("builds a pool whose config keeps connections below the gateway idle cutoff", async () => {
    // Bogus host — mysql2 pools dial lazily, so no connection is attempted.
    const pool = createResilientPool({ host: "127.0.0.1", port: 1, user: "x" });
    const config = (pool.pool.config as unknown as { connectionConfig: Record<string, unknown> })
      .connectionConfig;
    expect(config.enableKeepAlive).toBe(true);
    expect(config.keepAliveInitialDelay).toBe(10_000);
    expect(pool.pool.config.idleTimeout).toBe(60_000);
    expect(pool.pool.config.maxIdle).toBe(2);
    await pool.end();
  });

  it("lets caller options override the resilience defaults", async () => {
    const pool = createResilientPool({ host: "127.0.0.1", port: 1, user: "x", connectionLimit: 5 });
    expect(pool.pool.config.connectionLimit).toBe(5);
    await pool.end();
  });
});
