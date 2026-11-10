import { MutationObserver, QueryClient, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginAttempt,
  CheckController,
  completeAttempt,
  describeSession,
  evidenceOf,
  failureMessage,
  FRESH_FOR_MS,
  GENERIC_FAILURE,
  KEPT_READINGS,
  MAINTENANCE_MUTATION_OPTIONS,
  newSession,
  OFFLINE_MESSAGE,
  resetSession,
  type CheckSession,
  type ReadingResult,
} from "./maintenanceCheckSession";

type Report = ReadingResult & { tag: string };
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const report = (at: number, verdict: Report["verdict"] = "zero_observed_not_proof", tag = "r"): Report => ({
  checkedAt: new Date(at).toISOString(),
  verdict,
  tag,
});

/** Start an attempt that must start; fail the test otherwise. */
function start(session: CheckSession<Report>, now: number) {
  const begun = beginAttempt(session, now, true);
  if (!begun.started) throw new Error(`refused: ${begun.reason}`);
  return begun;
}
/** One complete, successful reading. */
function reading(session: CheckSession<Report>, at: number, verdict?: Report["verdict"]) {
  const begun = start(session, at);
  return completeAttempt(begun.session, begun.generation, begun.id, { ok: true, report: report(at, verdict) }, at);
}

afterEach(() => {
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe("when the button is pressed", () => {
  it("should refuse a second press while a reading is running, before anything is sent", () => {
    const first = start(newSession<Report>(), T0);
    const second = beginAttempt(first.session, T0 + 5, true);
    expect(second).toMatchObject({ started: false, reason: "running" });
    expect(second.session).toBe(first.session);
  });

  it("should refuse an offline press, record it, and leave nothing to replay", () => {
    const begun = beginAttempt(newSession<Report>(), T0, false);
    expect(begun).toMatchObject({ started: false, reason: "offline" });
    expect(begun.session.attempt).toMatchObject({ kind: "failed", message: OFFLINE_MESSAGE });
    // A later press starts afresh rather than resuming anything.
    expect(beginAttempt(begun.session, T0 + 1, true)).toMatchObject({ started: true });
  });
});

describe("when an answer arrives", () => {
  it("should drop an answer for an attempt from before a reset, a page exit or an account change", () => {
    const old = start(newSession<Report>(), T0);
    const fresh = start(resetSession(old.session), T0 + 1);
    // Both are attempt 1, in different generations: the old answer must not land.
    expect(fresh.id).toBe(old.id);
    const afterOld = completeAttempt(fresh.session, old.generation, old.id, { ok: true, report: report(T0, "zero_observed_not_proof", "old") }, T0 + 2);
    expect(afterOld).toBe(fresh.session);
    const afterFresh = completeAttempt(afterOld, fresh.generation, fresh.id, { ok: true, report: report(T0 + 1, "no_go_unfinished_work", "new") }, T0 + 3);
    expect(afterFresh.readings.map(r => r.report.tag)).toEqual(["new"]);
  });

  it("should drop a second answer for an attempt that already finished", () => {
    const begun = start(newSession<Report>(), T0);
    const done = completeAttempt(begun.session, begun.generation, begun.id, { ok: false, code: "CONFLICT" }, T0 + 1);
    expect(completeAttempt(done, begun.generation, begun.id, { ok: true, report: report(T0) }, T0 + 2)).toBe(done);
  });

  it("should keep only the latest readings", () => {
    let session = newSession<Report>();
    for (let i = 0; i < KEPT_READINGS + 3; i++) session = reading(session, T0 + i * 61_000);
    expect(session.readings).toHaveLength(KEPT_READINGS);
  });
});

describe("when a failure is shown", () => {
  it.each(["CONFLICT", "TOO_MANY_REQUESTS", "FORBIDDEN", "UNAUTHORIZED"])("should give a fixed sentence for %s", code => {
    expect(failureMessage(code)).not.toBe(GENERIC_FAILURE);
  });

  it("should never pass on the server's own words", () => {
    expect(failureMessage("INTERNAL_SERVER_ERROR")).toBe(GENERIC_FAILURE);
    expect(failureMessage(undefined)).toBe(GENERIC_FAILURE);
    expect(failureMessage("toString")).toBe(GENERIC_FAILURE);
    const begun = start(newSession<Report>(), T0);
    const failed = completeAttempt(begun.session, begun.generation, begun.id, { ok: false, code: "connect ECONNREFUSED 10.0.0.5" }, T0 + 1);
    expect(failed.attempt).toEqual({ kind: "failed", id: begun.id, at: T0 + 1, message: GENERIC_FAILURE });
  });
});

describe("when the page decides whether a reading is current", () => {
  it("should call a fresh reading current", () => {
    expect(evidenceOf(reading(newSession<Report>(), T0), T0 + 1000).kind).toBe("current");
  });

  it("should call it history while a new reading runs, and after one fails", () => {
    const one = reading(newSession<Report>(), T0);
    const running = start(one, T0 + 61_000);
    expect(evidenceOf(running.session, T0 + 62_000)).toMatchObject({ kind: "pending", last: { attemptId: 1 } });
    const failed = completeAttempt(running.session, running.generation, running.id, { ok: false, code: undefined }, T0 + 63_000);
    expect(evidenceOf(failed, T0 + 64_000)).toMatchObject({ kind: "failed", last: { attemptId: 1 } });
    expect(describeSession(failed, T0 + 64_000)).toContain("history");
  });

  it("should call it history once the five-minute window expires, without asking the server", () => {
    const one = reading(newSession<Report>(), T0);
    expect(evidenceOf(one, T0 + FRESH_FOR_MS - 1).kind).toBe("current");
    expect(evidenceOf(one, T0 + FRESH_FOR_MS).kind).toBe("stale");
    expect(evidenceOf(one, T0 + FRESH_FOR_MS + 1).kind).toBe("stale");
    expect(describeSession(one, T0 + FRESH_FOR_MS + 1)).toContain("history");
  });

  it("should immediately classify an old observation delivered late as history", () => {
    const begun = start(newSession<Report>(), T0);
    const delivered = T0 + FRESH_FOR_MS + 1;
    const session = completeAttempt(begun.session, begun.generation, begun.id, { ok: true, report: report(T0) }, delivered);
    expect(session.readings[0].receivedAt).toBe(delivered);
    expect(evidenceOf(session, delivered).kind).toBe("stale");
    expect(describeSession(session, delivered)).toContain("history");
  });

  it("should never extend freshness beyond local request age when the server clock is ahead", () => {
    const begun = start(newSession<Report>(), T0);
    const delivered = T0 + FRESH_FOR_MS + 1;
    const session = completeAttempt(begun.session, begun.generation, begun.id, { ok: true, report: report(delivered - 1) }, delivered);
    expect(evidenceOf(session, delivered).kind).toBe("stale");
  });

  it("should reject an older observation even when it is delivered within a fresh local request", () => {
    const begun = start(newSession<Report>(), T0);
    const session = completeAttempt(begun.session, begun.generation, begun.id, { ok: true, report: report(T0 - FRESH_FOR_MS) }, T0);
    expect(evidenceOf(session, T0).kind).toBe("stale");
  });

  it.each(["not-a-timestamp", "2026-02-31T12:00:00.000Z", new Date(T0 + 1).toISOString()])(
    "should treat an invalid, normalized or future observation timestamp as history: %s", stamp => {
      const begun = start(newSession<Report>(), T0);
      const session = completeAttempt(begun.session, begun.generation, begun.id, { ok: true, report: { ...report(T0), checkedAt: stamp } }, T0);
      expect(evidenceOf(session, T0).kind).toBe("stale");
    },
  );

  it("should treat client clock reversal and a non-finite clock as history", () => {
    const session = reading(newSession<Report>(), T0);
    expect(evidenceOf(session, T0 - 1).kind).toBe("stale");
    expect(evidenceOf(session, Number.NaN).kind).toBe("stale");
  });

  it("should judge three quiet readings only while they are current, and never as permission", () => {
    let session = newSession<Report>();
    for (const at of [T0, T0 + 61_000, T0 + 122_000]) session = reading(session, at);
    expect(describeSession(session, T0 + 123_000)).toContain("not permission");
    expect(describeSession(session, T0 + 122_000 + FRESH_FOR_MS + 1)).not.toContain("observed nothing");
  });

  it("should restart the run of quiet readings after a failed attempt", () => {
    let session = newSession<Report>();
    session = reading(session, T0);
    session = reading(session, T0 + 61_000);
    const begun = start(session, T0 + 122_000);
    session = completeAttempt(begun.session, begun.generation, begun.id, { ok: false, code: "CONFLICT" }, T0 + 122_500);
    session = reading(session, T0 + 183_000);
    expect(describeSession(session, T0 + 184_000)).toBe("Take 2 more readings, each at least a minute after the last.");
  });

  it("should forget every reading on reset", () => {
    const cleared = resetSession(reading(newSession<Report>(), T0));
    expect(cleared.readings).toEqual([]);
    expect(evidenceOf(cleared, T0 + 1).kind).toBe("none");
  });
});

describe("when the page's mutation options meet the query library", () => {
  async function observe(options: Record<string, unknown>, mutationFn: () => Promise<string>) {
    const client = new QueryClient();
    client.mount();
    const observer = new MutationObserver<string, Error, void>(client, { mutationFn, ...options });
    return { client, observer };
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));

  it("should not hold an offline press to replay on reconnect, as the library's default does", async () => {
    const calls = { defaults: 0, check: 0 };
    onlineManager.setOnline(false);

    const defaults = await observe({}, async () => String(++calls.defaults));
    const queued = defaults.observer.mutate();
    await tick();
    expect(calls.defaults).toBe(0);
    expect(defaults.observer.getCurrentResult().isPaused).toBe(true);

    const check = await observe({ ...MAINTENANCE_MUTATION_OPTIONS }, async () => String(++calls.check));
    await check.observer.mutate();
    expect(calls.check).toBe(1);
    expect(check.observer.getCurrentResult().isPaused).toBe(false);

    onlineManager.setOnline(true);
    await queued;
    await tick();
    expect(calls.defaults).toBe(1); // the default replays later; the check never waited to
    expect(calls.check).toBe(1);
    defaults.client.unmount();
    check.client.unmount();
  });

  it("should not retry a failed check", async () => {
    let calls = 0;
    const { client, observer } = await observe({ ...MAINTENANCE_MUTATION_OPTIONS }, async () => {
      calls++;
      throw new Error("refused");
    });
    await expect(observer.mutate()).rejects.toThrow("refused");
    await tick();
    expect(calls).toBe(1);
    client.unmount();
  });

  it("should drop a finished reading from the client's cache once nothing observes it", async () => {
    const check = await observe({ ...MAINTENANCE_MUTATION_OPTIONS }, async () => "report");
    await check.observer.mutate();
    check.observer.reset();
    await tick();
    expect(check.client.getMutationCache().getAll()).toHaveLength(0);

    const defaults = await observe({}, async () => "report");
    await defaults.observer.mutate();
    defaults.observer.reset();
    await tick();
    expect(defaults.client.getMutationCache().getAll()).toHaveLength(1); // kept five minutes by default
    check.client.unmount();
    defaults.client.unmount();
  });
});

describe("when the page's controller runs the lifecycle", () => {
  /** A controller whose requests the test answers by hand. */
  function harness(online = true) {
    const pending: { resolve: (r: Report) => void; reject: (e: unknown) => void }[] = [];
    const seen: CheckSession<Report>[] = [];
    let clock = T0;
    let forgotten = 0;
    let isOnline = online;
    const controller = new CheckController<Report>({
      send: () => new Promise<Report>((resolve, reject) => void pending.push({ resolve, reject })),
      online: () => isOnline,
      now: () => clock,
      codeOf: error => (error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined),
      forget: () => void forgotten++,
      changed: session => void seen.push(session),
    });
    return {
      controller,
      pending,
      seen,
      advance: (ms: number) => (clock += ms),
      forgotten: () => forgotten,
      goOnline: () => (isOnline = true),
    };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it("should send once for a rapid double press", () => {
    const h = harness();
    h.controller.run();
    h.controller.run();
    expect(h.pending).toHaveLength(1);
    expect(h.controller.session.attempt.kind).toBe("running");
  });

  it("should show only the newer answer when an older one arrives after a clear", async () => {
    const h = harness();
    h.controller.run();
    h.controller.clear();
    h.controller.run();
    h.pending[1].resolve(report(T0, "no_go_unfinished_work", "new"));
    await settle();
    h.pending[0].resolve(report(T0, "zero_observed_not_proof", "old"));
    await settle();
    expect(h.controller.session.readings.map(r => r.report.tag)).toEqual(["new"]);
  });

  it("should drop an answer that arrives after the page closed, and say nothing more", async () => {
    const h = harness();
    h.controller.run();
    const told = h.seen.length;
    h.controller.detach();
    h.pending[0].resolve(report(T0));
    await settle();
    expect(h.seen).toHaveLength(told);
    expect(h.controller.session.readings).toEqual([]);
    expect(h.forgotten()).toBe(1);
    h.controller.run();
    expect(h.pending).toHaveLength(1); // a closed page sends nothing
  });

  it("should work again if the page reopens, as a remount does", async () => {
    const h = harness();
    h.controller.detach();
    h.controller.attach();
    h.controller.run();
    h.pending[0].resolve(report(T0));
    await settle();
    expect(h.controller.session.readings).toHaveLength(1);
  });

  it("should clear readings and drop answers in flight when the account changes", async () => {
    const h = harness();
    h.controller.run();
    h.pending[0].resolve(report(T0));
    await settle();
    h.controller.run();
    h.controller.changeAccount();
    h.pending[1].resolve(report(T0, "zero_observed_not_proof", "for the previous account"));
    await settle();
    expect(h.controller.session.readings).toEqual([]);
    expect(h.controller.session.attempt.kind).toBe("none");
  });

  it("should send nothing while offline, and nothing later when the connection returns", async () => {
    const h = harness(false);
    h.controller.run();
    expect(h.pending).toHaveLength(0);
    expect(h.controller.session.attempt).toMatchObject({ kind: "failed", message: OFFLINE_MESSAGE });
    h.goOnline();
    await settle();
    expect(h.pending).toHaveLength(0);
  });

  it("should show a fixed sentence for a failure, chosen by its code alone", async () => {
    const h = harness();
    h.controller.run();
    h.pending[0].reject({ code: "CONFLICT", message: "internal detail that must not show" });
    await settle();
    expect(h.controller.session.attempt).toMatchObject({ kind: "failed", message: failureMessage("CONFLICT") });
    expect(JSON.stringify(h.controller.session)).not.toContain("internal detail");
  });

  it("should treat a request that cannot even be sent as a failed attempt", async () => {
    const h = harness();
    const controller = new CheckController<Report>({
      send: () => {
        throw new Error("no client");
      },
      online: () => true,
      now: () => T0,
      codeOf: () => undefined,
      forget: () => {},
      changed: () => {},
    });
    controller.run();
    await settle();
    expect(controller.session.attempt).toMatchObject({ kind: "failed", message: GENERIC_FAILURE });
    expect(h.pending).toHaveLength(0);
  });
});
