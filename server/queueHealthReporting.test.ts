/**
 * Queue durability reporting: the states `/api/health` and the corporate-B2B
 * pilot gate may claim.
 *
 * This one small piece of logic has now drawn four separate review findings,
 * each a swing to a wrong answer:
 *
 *   1. Asked "are all live queues durable?" of an EMPTY set, so a
 *      Redis-configured instance advertised `durable: false` moments after boot.
 *   2. Fixed by trusting configuration, so an instance with a WRONG or
 *      unreachable REDIS_URL advertised `durable: true` having connected to
 *      nothing.
 *   3. The resolution: before a queue exists neither boolean is honest, so the
 *      state is NAMED rather than guessed.
 *   4. (#167) A queue built on BullMQ whose Redis stopped answering still
 *      counted as durable, so the endpoint said `durability: "confirmed"` while
 *      reporting the queue error beside it.
 *
 * Until #167 the rule was duplicated here, as a mirror of the inline health
 * code, and again in the pilot gate. It now lives in one function
 * (server/queueDurability.ts) that both callers use, and these tests exercise
 * that function, not a copy of it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { classifyQueueDurability } from "./queueDurability";

const bullmq = { durable: true };
const inProcess = { durable: false };
const unanswered = { durable: true, error: "count read timed out" };

describe("when no queue has been built yet", () => {
  it("should NOT claim durability merely because REDIS_URL is set", () => {
    // A wrong or unreachable URL is indistinguishable from a good one until
    // something connects. Claiming `durable` here is an assertion about a
    // connection nobody has made.
    const r = classifyQueueDurability({}, "redis://unreachable-host:6379");
    expect(r.durable).toBe(false);
    expect(r.durability).toBe("configured_unverified");
    expect(r.status).toBe("degraded");
  });

  it("should NOT report plain non-durable either, which contradicts the config", () => {
    // The distinction the boolean cannot carry: this is not the same state as
    // an instance that has no Redis configured at all.
    const configured = classifyQueueDurability({}, "redis://localhost:6379");
    const unconfigured = classifyQueueDurability({}, undefined);
    expect(configured.durability).toBe("configured_unverified");
    expect(unconfigured.durability).toBe("fallback");
    expect(configured.durability).not.toBe(unconfigured.durability);
  });

  it("should report the fallback plainly when no Redis is configured", () => {
    expect(classifyQueueDurability({}, undefined)).toEqual({ durable: false, durability: "fallback", status: "degraded" });
  });

  it("should treat an empty REDIS_URL as unconfigured, not as configured", () => {
    expect(classifyQueueDurability({}, "   ").durability).toBe("fallback");
  });
});

describe("when queues exist", () => {
  it("should confirm durability only when every queue is durable and answered", () => {
    expect(classifyQueueDurability({ a: bullmq, b: bullmq }, "redis://x")).toEqual({
      durable: true,
      durability: "confirmed",
      status: "ok",
    });
  });

  it("should not confirm when any queue fell back to in-process", () => {
    // One queue on the fallback means work in THAT queue is lost on restart,
    // whatever the others do.
    expect(classifyQueueDurability({ a: bullmq, b: inProcess }, "redis://x")).toEqual({
      durable: false,
      durability: "fallback",
      status: "degraded",
    });
  });

  it("should not confirm a BullMQ queue whose Redis did not answer", () => {
    // #167: built on BullMQ is not evidence. A queue that cannot be counted is
    // a queue whose Redis is unwell, and "confirmed" beside that error was a
    // contradiction on the endpoint an institution reads as evidence.
    expect(classifyQueueDurability({ a: bullmq, b: unanswered }, "redis://x")).toEqual({
      durable: false,
      durability: "unreachable",
      status: "error",
    });
  });

  it("should still call a fallback a fallback when it also errors", () => {
    expect(classifyQueueDurability({ a: { durable: false, error: "x" } }, "redis://x")).toEqual({
      durable: false,
      durability: "fallback",
      status: "error",
    });
  });
});

describe("when the health endpoint and the pilot gate report durability", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");

  it("should both use the one rule rather than keep their own", () => {
    for (const rel of ["_core/index.ts", "routers/corporateB2BPilot.ts"]) {
      const source = read(rel);
      expect(source, rel).toContain("classifyQueueDurability(");
      expect(source, rel).not.toMatch(/names\.every\(\s*\(\w+\)\s*=>\s*queues\[\w+\]\.durable\)/);
    }
  });

  it("should not let a degraded queue turn the whole endpoint into a 503", () => {
    // Production runs the fallback today. Alarming on it would turn a known,
    // accepted state into a page; only a broken dependency is fatal.
    expect(read("_core/index.ts")).toContain('(c as { status: string }).status !== "error"');
  });
});
