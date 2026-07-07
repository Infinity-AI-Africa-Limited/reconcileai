/**
 * WS-4 Developer API — Unit Tests
 * Queue abstraction (in-process backend), sandbox determinism, and the
 * backoff math used by webhook delivery.
 */
import { describe, it, expect } from "vitest";
import { createQueue, backoffDelayMs } from "../jobQueue";
import { runSandboxReconciliation } from "./sandbox";
import { publicApiRateKey } from "../rateLimiter";

describe("jobQueue — in-process backend", () => {
  it("uses the in-process backend when REDIS_URL is unset", async () => {
    expect(process.env.REDIS_URL).toBeFalsy();
    const q = await createQueue("test-q", async () => {});
    expect(q.backend).toBe("in-process");
  });

  it("executes enqueued jobs", async () => {
    const seen: string[] = [];
    const q = await createQueue<string>("test-exec", async (job) => {
      seen.push(`${job.name}:${job.data}:${job.attempt}`);
    });
    await q.enqueue("hello", "world");
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(["hello:world:1"]);
  });

  it("retries failed jobs with attempt numbers", async () => {
    const attempts: number[] = [];
    const q = await createQueue<null>("test-retry", async (job) => {
      attempts.push(job.attempt);
      if (job.attempt < 3) throw new Error("boom");
    }, { attempts: 3, backoffMs: 10 });
    await q.enqueue("job", null);
    await new Promise((r) => setTimeout(r, 300));
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("stops after max attempts", async () => {
    const attempts: number[] = [];
    const q = await createQueue<null>("test-exhaust", async (job) => {
      attempts.push(job.attempt);
      throw new Error("always fails");
    }, { attempts: 2, backoffMs: 10 });
    await q.enqueue("job", null);
    await new Promise((r) => setTimeout(r, 200));
    expect(attempts).toEqual([1, 2]);
  });

  it("backoff grows exponentially and caps at 10 minutes", () => {
    expect(backoffDelayMs(1, 30_000)).toBe(30_000);
    expect(backoffDelayMs(2, 30_000)).toBe(60_000);
    expect(backoffDelayMs(3, 30_000)).toBe(120_000);
    expect(backoffDelayMs(10, 30_000)).toBe(600_000); // capped
  });
});

describe("sandbox reconciliation", () => {
  it("is deterministic — identical results on every call", () => {
    const a = runSandboxReconciliation();
    const b = runSandboxReconciliation();
    expect(a.stats).toEqual(b.stats);
    expect(a.exceptions.map((e) => e.category)).toEqual(b.exceptions.map((e) => e.category));
  });

  it("exercises the interesting engine paths", () => {
    const r = runSandboxReconciliation();
    expect(r.sandbox).toBe(true);
    expect(r.stats.matchedPairs).toBeGreaterThanOrEqual(5); // exact + tolerance + date-window
    expect(r.stats.duplicatesDetected).toBeGreaterThanOrEqual(2);
    const categories = r.exceptions.map((e) => e.category);
    expect(categories).toContain("fx_rate_variance"); // WS-6 category in the demo
    // Every exception carries a diagnosis + suggested resolution (Moat surface)
    for (const exc of r.exceptions) {
      expect(exc.description.length).toBeGreaterThan(10);
      expect(exc.suggestedResolution.length).toBeGreaterThan(10);
    }
  });

  it("matched FX legs never cross-currency match", () => {
    const r = runSandboxReconciliation();
    // The USD/NGN same-ref pair must NOT appear in matches (within-currency guard)
    for (const m of r.matches) {
      expect(m.sourceRef === "FX/B0001" && m.targetRef === "FX/B0001").toBe(false);
    }
  });
});

describe("gateway auth key derivation", () => {
  it("rate-limit key prefers the API key over IP", () => {
    expect(publicApiRateKey("k".repeat(40), "1.2.3.4")).toBe(`key:${"k".repeat(16)}`);
    expect(publicApiRateKey(undefined, "1.2.3.4")).toBe("ip:1.2.3.4");
  });
});
