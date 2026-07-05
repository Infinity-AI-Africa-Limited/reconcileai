/**
 * Rate limiter — Unit Tests (gap-closure plan WS-2/WS-4)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRateLimiter, publicApiRateKey, PUBLIC_API_RATE_LIMIT } from "./rateLimiter";

afterEach(() => {
  vi.useRealTimers();
});

describe("createRateLimiter", () => {
  it("allows requests up to the limit and blocks the rest", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(true);
    const third = limiter.check("k");
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = limiter.check("k");
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("reset() clears all windows", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    limiter.check("k");
    expect(limiter.check("k").allowed).toBe(false);
    limiter.reset();
    expect(limiter.check("k").allowed).toBe(true);
  });
});

describe("publicApiRateKey", () => {
  it("prefers the API key and stores only a prefix", () => {
    const key = publicApiRateKey("a".repeat(64), "1.2.3.4");
    expect(key).toBe(`key:${"a".repeat(16)}`);
  });

  it("falls back to IP when no usable key is presented", () => {
    expect(publicApiRateKey(undefined, "1.2.3.4")).toBe("ip:1.2.3.4");
    expect(publicApiRateKey("short", "1.2.3.4")).toBe("ip:1.2.3.4");
    expect(publicApiRateKey(undefined, undefined)).toBe("ip:unknown");
  });
});

describe("public API limit configuration", () => {
  it("is 60 requests per minute", () => {
    expect(PUBLIC_API_RATE_LIMIT.max).toBe(60);
    expect(PUBLIC_API_RATE_LIMIT.windowMs).toBe(60_000);
  });
});
