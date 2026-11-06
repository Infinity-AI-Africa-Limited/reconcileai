import { describe, expect, it, vi } from "vitest";
import { DB_SURFACES, INTAKE_SOURCES, QUEUE_IDS, QUEUE_STATES, LIMITS, type QueueState } from "./catalogue";
import { ERROR_CODES, NOT_COLLECTED, type ObserverReport } from "./contracts";
import { MAX_REPORT_BYTES, REFUSED_REPORT, serializeReport } from "./report";

function fixture(): ObserverReport {
  return {
    schema: "reconcileai_durable_observer_v1", execution: "synthetic_only", hold: true,
    verdict: "zero_observed_not_proof", databaseControl: "statement_guard_only",
    samples: Array.from({ length: LIMITS.samples }, (_, index) => ({
      database: {
        snapshot: "consistent_snapshot", cleanup: "ok",
        surfaces: DB_SURFACES.map(surface => ({ id: surface.id, count: 0, oldestAgeSeconds: null })),
        intake: INTAKE_SOURCES.map(source => ({ id: source.id, count: index === 0 ? null : 0 })),
      },
      redis: {
        queues: QUEUE_IDS.map(id => ({ id, states: Object.fromEntries(QUEUE_STATES.map(state => [state, 0])) as Record<QueueState, number | null> })),
        discovery: "complete", unknownQueues: 0,
      },
      elapsedMs: index * LIMITS.intervalMs,
    })),
    notCollected: NOT_COLLECTED, errors: [],
  };
}
function decoded(input: unknown): ObserverReport {
  const output = serializeReport(input);
  expect(output).not.toBe(REFUSED_REPORT);
  return JSON.parse(output) as ObserverReport;
}
function unfinished(report: ObserverReport): void {
  report.samples[0].database.surfaces[0].count = 1;
  report.samples[0].database.surfaces[0].oldestAgeSeconds = 0;
}

describe("when all synthetic durable observations are zero", () => {
  it("should preserve hold and synthetic scope without granting GO or app identity claims", () => {
    const output = decoded(fixture());
    expect(output.verdict).toBe("zero_observed_not_proof");
    expect(output.hold).toBe(true);
    expect(output.execution).toBe("synthetic_only");
    expect(output.schema).toBe("reconcileai_durable_observer_v1");
    expect(output.notCollected).toEqual([...NOT_COLLECTED]);
    expect(Object.keys(output)).toEqual(["schema", "execution", "hold", "verdict", "databaseControl", "samples", "notCollected", "errors"]);
  });
  it("should revalidate its canonical text and keep output byte-bounded", () => {
    const output = serializeReport(fixture());
    expect(serializeReport(output)).toBe(output);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_REPORT_BYTES);
  });
  it("should canonicalize catalogue and error order without forwarding input labels", () => {
    const report = fixture();
    report.samples[0].database.surfaces.reverse();
    report.samples[0].redis.queues.reverse();
    report.errors = [ERROR_CODES[2], ERROR_CODES[0]];
    const output = decoded(report);
    expect(output.samples[0].database.surfaces.map(row => row.id)).toEqual(DB_SURFACES.map(row => row.id));
    expect(output.samples[0].redis.queues.map(row => row.id)).toEqual(QUEUE_IDS);
    expect(output.errors).toEqual([ERROR_CODES[0], ERROR_CODES[2]]);
  });
});

describe("when unfinished work and incomplete evidence overlap", () => {
  it("should recompute no-go work ahead of errors and the caller verdict", () => {
    const report = fixture();
    unfinished(report);
    report.samples[0].database.cleanup = "failed";
    report.errors = ["database_cleanup_failed"];
    expect(decoded(report).verdict).toBe("no_go_unfinished_work");
  });
  it("should never trust a caller no-go verdict as proof of work", () => {
    const report = fixture();
    report.verdict = "no_go_unfinished_work";
    expect(decoded(report).verdict).toBe("zero_observed_not_proof");
  });
  it.each(["snapshot", "rollback", "scan", "count", "sample", "intake", "unknown", "age"])(
    "should make %s evidence gaps incomplete rather than grant GO", kind => {
      const report = fixture();
      if (kind === "snapshot") report.samples[0].database.snapshot = "unavailable";
      if (kind === "rollback") report.samples[0].database.cleanup = "failed";
      if (kind === "scan") report.samples[0].redis.discovery = "incomplete";
      if (kind === "count") report.samples[0].database.surfaces[0].count = null;
      if (kind === "sample") report.samples.pop();
      if (kind === "intake") report.samples[1].database.intake[0].count = 1;
      if (kind === "unknown") report.samples[0].redis.unknownQueues = 1;
      if (kind === "age") {
        const parked = DB_SURFACES.findIndex(surface => surface.kind === "parked");
        report.samples[0].database.surfaces[parked].count = 1;
      }
      expect(decoded(report).verdict).toBe(kind === "age" ? "no_go_unfinished_work" : "no_go_incomplete_evidence");
    },
  );
  it("should count positive parked surfaces as unfinished work", () => {
    const report = fixture();
    const parked = DB_SURFACES.findIndex(surface => surface.kind === "parked");
    report.samples[0].database.surfaces[parked].count = 1;
    report.samples[0].database.surfaces[parked].oldestAgeSeconds = 10;
    report.verdict = "no_go_unfinished_work";
    expect(decoded(report).verdict).toBe("no_go_unfinished_work");
  });
  it.each(QUEUE_STATES)("should count positive %s queue state as unfinished work", state => {
    const report = fixture();
    report.samples[0].redis.queues[0].states[state] = 1;
    expect(decoded(report).verdict).toBe("no_go_unfinished_work");
  });
  it("should retain a zero-sample failure as incomplete evidence", () => {
    const report = fixture();
    report.samples = [];
    expect(decoded(report).verdict).toBe("no_go_incomplete_evidence");
  });
});

describe("when counts or numeric fields are poisoned", () => {
  it.each([NaN, Infinity, -Infinity, -1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", "1e3", "\\u0031", null, true, 1n])(
    "should refuse unsafe non-count values except explicit unknown null (%s)", value => {
      const report = fixture();
      Object.defineProperty(report.samples[0].redis.queues[0].states, "wait", { value, enumerable: true, configurable: true });
      if (value === null) expect(decoded(report).verdict).toBe("no_go_incomplete_evidence");
      else expect(serializeReport(report)).toBe(REFUSED_REPORT);
    },
  );
  it("should reject run overflow, discovery overflow, and nonmonotonic sample time", () => {
    for (const kind of ["run", "discovery", "clock"]) {
      const report = fixture();
      if (kind === "run") report.samples[0].elapsedMs = LIMITS.runMs + 1;
      if (kind === "discovery") report.samples[0].redis.unknownQueues = LIMITS.unknownQueues + 1;
      if (kind === "clock") report.samples[2].elapsedMs = 1;
      expect(serializeReport(report)).toBe(REFUSED_REPORT);
    }
  });
  it("should handle safe maximal counts without summing into overflow", () => {
    const report = fixture();
    report.samples[0].redis.queues[0].states.wait = Number.MAX_SAFE_INTEGER;
    report.samples[0].redis.queues[1].states.wait = Number.MAX_SAFE_INTEGER;
    expect(decoded(report).verdict).toBe("no_go_unfinished_work");
  });
});

describe("when payloads or arbitrary vocabulary sneak into report objects", () => {
  it.each(["payload", "host", "url", "message", "environment", "appIdentity", "processId"])(
    "should refuse extra %s fields without reflecting their content", key => {
      const report = fixture();
      Object.defineProperty(report.samples[0].database.surfaces[0], key, { value: "synthetic-sensitive-marker", enumerable: true });
      expect(serializeReport(report)).toBe(REFUSED_REPORT);
    },
  );
  it("should reject unknown errors, labels, states, live mode, and hold false", () => {
    for (const kind of ["error", "label", "state", "live", "hold", "verdict", "notCollected"]) {
      const report = fixture();
      if (kind === "error") Object.defineProperty(report, "errors", { value: ["synthetic-sensitive-marker"] });
      if (kind === "label") Object.defineProperty(report.samples[0].database.surfaces[0], "id", { value: "unknown_surface" });
      if (kind === "state") Object.defineProperty(report.samples[0].redis.queues[0].states, "stalled", { value: 0, enumerable: true });
      if (kind === "live") Object.defineProperty(report, "execution", { value: "live" });
      if (kind === "hold") Object.defineProperty(report, "hold", { value: false });
      if (kind === "verdict") Object.defineProperty(report, "verdict", { value: "GO" });
      if (kind === "notCollected") Object.defineProperty(report, "notCollected", { value: [...NOT_COLLECTED].reverse() });
      expect(serializeReport(report)).toBe(REFUSED_REPORT);
    }
  });
  it("should require bounded unique exact surface, intake, queue, state, and sample coverage", () => {
    for (const kind of ["surface", "intake", "queue", "state", "duplicate", "samples", "errors"]) {
      const report = fixture();
      if (kind === "surface") report.samples[0].database.surfaces.pop();
      if (kind === "intake") report.samples[0].database.intake.pop();
      if (kind === "queue") report.samples[0].redis.queues.pop();
      if (kind === "state") Reflect.deleteProperty(report.samples[0].redis.queues[0].states, "wait");
      if (kind === "duplicate") report.samples[0].database.surfaces[1].id = report.samples[0].database.surfaces[0].id;
      if (kind === "samples") report.samples.push(fixture().samples[0]);
      if (kind === "errors") report.errors = [ERROR_CODES[0], ERROR_CODES[0]];
      expect(serializeReport(report)).toBe(REFUSED_REPORT);
    }
  });
});

describe("when objects contain executable descriptors or invalid structure", () => {
  it("should never invoke getters, toJSON, proxy traps, or error messages", () => {
    const invoked = vi.fn(() => { throw new Error("synthetic-sensitive-marker"); });
    const getter = fixture();
    Object.defineProperty(getter, "samples", { get: invoked });
    const hook = fixture();
    Object.defineProperty(hook, "toJSON", { value: invoked, enumerable: false });
    const proxy = new Proxy(fixture(), { ownKeys: invoked, getPrototypeOf: invoked });
    const deepGetter = fixture();
    Object.defineProperty(deepGetter.samples[0].redis.queues[0].states, "wait", { get: invoked });
    const arrayGetter = fixture();
    Object.defineProperty(arrayGetter.samples, "0", { get: invoked });
    for (const input of [getter, hook, proxy, deepGetter, arrayGetter]) expect(serializeReport(input)).toBe(REFUSED_REPORT);
    expect(invoked).not.toHaveBeenCalled();
  });
  it("should refuse symbols, nonplain objects, cycles, hidden extras, and sparse arrays", () => {
    const symbol = fixture();
    Object.defineProperty(symbol, Symbol("secret"), { value: 0 });
    const hidden = fixture();
    Object.defineProperty(hidden, "extra", { value: 0 });
    const cyclic = fixture();
    Object.defineProperty(cyclic, "extra", { value: cyclic, enumerable: true });
    const sparse = fixture();
    Reflect.deleteProperty(sparse.samples, "1");
    for (const input of [symbol, hidden, cyclic, sparse, new Date(), Object.create(fixture()) as unknown]) expect(serializeReport(input)).toBe(REFUSED_REPORT);
  });
  it("should emit no log or stdout content for either acceptance or refusal", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let counts: number[];
    try {
      serializeReport(fixture());
      serializeReport(new Error("synthetic-sensitive-marker"));
      counts = [log.mock.calls.length, error.mock.calls.length, stdout.mock.calls.length];
    } finally { log.mockRestore(); error.mockRestore(); stdout.mockRestore(); }
    expect(counts!).toEqual([0, 0, 0]);
  });
  it("should encode rebuilt primitives without using inherited toJSON", () => {
    const inherited = vi.fn(() => "synthetic-sensitive-marker");
    Object.defineProperty(Object.prototype, "toJSON", { value: inherited, configurable: true });
    let output: string;
    try { output = serializeReport(fixture()); }
    finally { Reflect.deleteProperty(Object.prototype, "toJSON"); }
    expect(output!).not.toBe(REFUSED_REPORT);
    expect(output!).not.toContain("synthetic-sensitive-marker");
    expect(inherited).not.toHaveBeenCalled();
  });
});

describe("when text was not produced by the canonical boundary", () => {
  it("should refuse duplicate keys, escapes, numeric aliases, padding, invalid JSON, and text verdict mismatch", () => {
    const output = serializeReport(fixture());
    const report = fixture();
    unfinished(report);
    const mismatch = serializeReport(report).replace("no_go_unfinished_work", "zero_observed_not_proof");
    for (const text of [
      output.replace('"hold":true', '"hold":true,"hold":true'),
      output.replace("synthetic_only", "synthetic_\\u006fnly"),
      output.replace('"elapsedMs":0', '"elapsedMs":0e0'),
      ` ${output}`, "{", mismatch, "x".repeat(MAX_REPORT_BYTES + 1),
    ]) expect(serializeReport(text)).toBe(REFUSED_REPORT);
  });
});
