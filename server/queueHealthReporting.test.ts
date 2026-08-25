/**
 * Queue durability reporting — the states `/api/health` may claim.
 *
 * This one small piece of logic has now drawn three separate review findings,
 * each a swing to the opposite wrong answer:
 *
 *   1. Asked "are all live queues durable?" of an EMPTY set, so a
 *      Redis-configured instance advertised `durable: false` moments after boot.
 *   2. Fixed by trusting configuration, so an instance with a WRONG or
 *      unreachable REDIS_URL advertised `durable: true` having connected to
 *      nothing.
 *   3. The resolution: before a queue exists neither boolean is honest, so the
 *      state is NAMED rather than guessed.
 *
 * The window is not brief. Queues are built lazily on first use, and the boot
 * sweep only builds one when there are stuck jobs to recover — a healthy idle
 * instance can sit in the unverified state indefinitely.
 *
 * These pin all three states so the next change cannot quietly swing again.
 * The logic is duplicated here rather than imported because it lives inline in
 * the health route; the assertions below are the specification, and
 * `server/_core/index.ts` is asserted to match.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

type Stats = { durable: boolean; error?: string };

/** Mirrors the `checks.queue` branch in server/_core/index.ts. */
function report(queues: Record<string, Stats>, redisUrl: string | undefined) {
  const names = Object.keys(queues);
  const configuredDurable = !!redisUrl?.trim();
  const anyBroken = names.some((n) => queues[n].error);
  const confirmedDurable = names.length > 0 && names.every((n) => queues[n].durable);

  const durability =
    names.length === 0
      ? configuredDurable
        ? "configured_unverified"
        : "fallback"
      : confirmedDurable
        ? "confirmed"
        : "fallback";

  return {
    status: anyBroken ? "error" : confirmedDurable ? "ok" : "degraded",
    durable: confirmedDurable,
    durability,
  };
}

const bullmq: Stats = { durable: true };
const inProcess: Stats = { durable: false };

describe("before any queue has been built", () => {
  it("should NOT claim durability merely because REDIS_URL is set", () => {
    // A wrong or unreachable URL is indistinguishable from a good one until
    // something connects. Claiming `durable` here is an assertion about a
    // connection nobody has made.
    const r = report({}, "redis://unreachable-host:6379");
    expect(r.durable).toBe(false);
    expect(r.durability).toBe("configured_unverified");
    expect(r.status).toBe("degraded");
  });

  it("should NOT report plain non-durable either, which contradicts the config", () => {
    // The distinction the boolean cannot carry: this is not the same state as
    // an instance that has no Redis configured at all.
    const configured = report({}, "redis://localhost:6379");
    const unconfigured = report({}, undefined);
    expect(configured.durability).toBe("configured_unverified");
    expect(unconfigured.durability).toBe("fallback");
    expect(configured.durability).not.toBe(unconfigured.durability);
  });

  it("should report the fallback plainly when no Redis is configured", () => {
    const r = report({}, undefined);
    expect(r).toMatchObject({ durable: false, durability: "fallback", status: "degraded" });
  });

  it("should treat an empty REDIS_URL as unconfigured, not as configured", () => {
    expect(report({}, "   ").durability).toBe("fallback");
  });
});

describe("once queues exist", () => {
  it("should confirm durability only when every queue is durable", () => {
    expect(report({ a: bullmq, b: bullmq }, "redis://x")).toMatchObject({
      durable: true,
      durability: "confirmed",
      status: "ok",
    });
  });

  it("should not confirm when any queue fell back to in-process", () => {
    // One queue on the fallback means work in THAT queue is lost on restart,
    // whatever the others do.
    expect(report({ a: bullmq, b: inProcess }, "redis://x")).toMatchObject({
      durable: false,
      durability: "fallback",
      status: "degraded",
    });
  });

  it("should raise an error, not merely degraded, when a queue cannot be read", () => {
    // A queue whose counts fail is a queue whose Redis is unwell — that is a
    // broken dependency, not an accepted configuration.
    expect(report({ a: { durable: true, error: "ECONNRESET" } }, "redis://x").status).toBe("error");
  });
});

describe("the health route", () => {
  const SOURCE = fs.readFileSync(path.join(__dirname, "_core", "index.ts"), "utf8");

  it("should implement the three-state reporting asserted above", () => {
    expect(SOURCE).toContain('durability === "configured_unverified"');
    expect(SOURCE).toContain("const confirmedDurable = names.length > 0 && names.every");
    // `durable` must be the CONFIRMED value, never the configured one.
    expect(SOURCE).toContain("durable: confirmedDurable");
  });

  it("should not let a degraded queue turn the whole endpoint into a 503", () => {
    // Production runs the fallback today. Alarming on it would turn a known,
    // accepted state into a page; only a broken dependency is fatal.
    expect(SOURCE).toContain('(c as { status: string }).status !== "error"');
  });
});
