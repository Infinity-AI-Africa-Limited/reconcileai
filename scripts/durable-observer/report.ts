import { types } from "node:util";
import { ERROR_CODES, NOT_COLLECTED, type ObserverReport, type ObserverVerdict } from "./contracts";
import { DB_SURFACES as SURFACES, INTAKE_SOURCES as INTAKE, QUEUE_IDS as QUEUES, QUEUE_STATES, LIMITS } from "./catalogue";

export const MAX_REPORT_BYTES = 131_072;
export const MAX_REPORT_SAMPLES = LIMITS.samples;
export const REFUSED_REPORT = '{"schema":"reconcileai_durable_observer_v1","execution":"synthetic_only","hold":true,"verdict":"no_go_incomplete_evidence","error":"report_refused"}';
type Captured = null | boolean | number | string | Captured[] | { [key: string]: Captured };
type RecordValue = { [key: string]: Captured };
const refuse = (): never => { throw new Error("report_refused"); };

/** Never stringify caller objects or evaluate their getters/toJSON. Reject proxies
 * before reflection. Capture only own enumerable data descriptors with bounds. */
function capture(input: unknown): Captured {
  const seen = new Set<object>();
  let nodes = 0;
  function visit(value: unknown, depth: number): Captured {
    if (++nodes > 20_000 || depth > 10) return refuse();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return value.length <= 128 ? value : refuse();
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : refuse();
    }
    if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) return refuse();
    seen.add(value);
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && (array || prototype !== null)) return refuse();
    const keys = Reflect.ownKeys(value);
    if (keys.length > (array ? 65 : 32) || keys.some(key => typeof key !== "string")) return refuse();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (!("value" in descriptor) || (!descriptor.enumerable && !(array && key === "length"))) return refuse();
    }
    if (array) {
      const length: unknown = descriptors.length.value;
      if (typeof length !== "number" || length > 64 || keys.length !== length + 1) return refuse();
      const result: Captured[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) return refuse();
        result.push(visit(descriptor.value as unknown, depth + 1));
      }
      return result;
    }
    const result: RecordValue = Object.create(null) as RecordValue;
    for (const key of keys as string[]) result[key] = visit(descriptors[key].value as unknown, depth + 1);
    return result;
  }
  return visit(input, 0);
}

function record(value: Captured, keys: readonly string[]): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return refuse();
  return value;
}
function list(value: Captured, maximum: number): Captured[] {
  if (!Array.isArray(value) || value.length > maximum) return refuse();
  return value;
}
function choice<const T extends string>(value: Captured, choices: readonly T[]): T {
  const fixed = choices.find(item => item === value);
  return fixed === undefined ? refuse() : fixed;
}
function count(value: Captured): number | null {
  if (value === null || typeof value === "number") return value;
  return refuse();
}
function coverage<T>(value: Captured, ids: readonly string[], build: (row: RecordValue, id: string) => T): T[] {
  const rows = list(value, ids.length);
  if (rows.length !== ids.length) return refuse();
  const byId = new Map<string, RecordValue>();
  for (const entry of rows) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return refuse();
    const id = choice(entry.id, ids);
    if (byId.has(id)) return refuse();
    byId.set(id, entry);
  }
  return ids.map(id => build(byId.get(id) ?? refuse(), id));
}

function rebuild(input: Captured): ObserverReport {
  const root = record(input, ["schema", "execution", "hold", "verdict", "databaseControl", "samples", "notCollected", "errors"]);
  choice(root.schema, ["reconcileai_durable_observer_v1"]);
  choice(root.execution, ["synthetic_only"]);
  if (root.hold !== true) return refuse();
  choice(root.verdict, ["zero_observed_not_proof", "no_go_unfinished_work", "no_go_incomplete_evidence"]);
  choice(root.databaseControl, ["statement_guard_only"]);
  const notCollected = list(root.notCollected, NOT_COLLECTED.length);
  if (notCollected.length !== NOT_COLLECTED.length || notCollected.some((value, index) => value !== NOT_COLLECTED[index])) return refuse();
  const errors = list(root.errors, ERROR_CODES.length).map(value => choice(value, ERROR_CODES));
  if (new Set(errors).size !== errors.length) return refuse();
  let unfinished = false;
  let incomplete = errors.length > 0;
  const observe = (value: Captured, work = true, required = true): number | null => {
    const result = count(value);
    if (result === null && required) incomplete = true;
    else if (result !== null && result > 0 && work) unfinished = true;
    return result;
  };
  const rawSamples = list(root.samples, MAX_REPORT_SAMPLES);
  if (rawSamples.length !== LIMITS.samples) incomplete = true;
  let lastElapsed = 0;
  const samples = rawSamples.map((value, index) => {
    const sample = record(value, ["database", "redis", "elapsedMs"]);
    const database = record(sample.database, ["snapshot", "cleanup", "surfaces", "intake"]);
    const snapshot = choice(database.snapshot, ["consistent_snapshot", "unavailable"]);
    const cleanup = choice(database.cleanup, ["ok", "failed"]);
    if (snapshot !== "consistent_snapshot" || cleanup !== "ok") incomplete = true;
    const surfaces = coverage(database.surfaces, SURFACES.map(surface => surface.id), (entry, id) => {
      const row = record(entry, ["id", "count", "oldestAgeSeconds"]);
      const observedCount = observe(row.count);
      const oldestAgeSeconds = count(row.oldestAgeSeconds);
      if (observedCount === 0 && oldestAgeSeconds !== null) return refuse();
      if (observedCount === null && oldestAgeSeconds !== null) return refuse();
      if (observedCount !== null && observedCount > 0 && oldestAgeSeconds === null) incomplete = true;
      return { id: choice(id, SURFACES.map(surface => surface.id)), count: observedCount, oldestAgeSeconds };
    });
    const intake = coverage(database.intake, INTAKE.map(item => item.id), (entry, id) => {
      const row = record(entry, ["id", "count"]);
      const observedCount = observe(row.count, false, index > 0);
      if (index === 0 && observedCount !== null) return refuse();
      if (observedCount !== null && observedCount > 0) incomplete = true;
      return { id: choice(id, INTAKE.map(item => item.id)), count: observedCount };
    });
    const redis = record(sample.redis, ["queues", "discovery", "unknownQueues"]);
    const discovery = choice(redis.discovery, ["complete", "incomplete"]);
    if (discovery !== "complete") incomplete = true;
    const unknownQueues = observe(redis.unknownQueues, false);
    if (unknownQueues !== null && unknownQueues > LIMITS.unknownQueues) return refuse();
    if (unknownQueues !== 0) incomplete = true;
    const queues = coverage(redis.queues, QUEUES, (entry, id) => {
      const row = record(entry, ["id", "states"]);
      const rawStates = record(row.states, QUEUE_STATES);
      const states = Object.fromEntries(QUEUE_STATES.map(state => [state, observe(rawStates[state])])) as ObserverReport["samples"][number]["redis"]["queues"][number]["states"];
      return { id: choice(id, QUEUES), states };
    });
    const elapsedMs = count(sample.elapsedMs);
    if (elapsedMs === null || elapsedMs > LIMITS.runMs || elapsedMs < lastElapsed) return refuse();
    lastElapsed = elapsedMs;
    return { database: { snapshot, cleanup, surfaces, intake }, redis: { queues, discovery, unknownQueues }, elapsedMs };
  });
  const verdict: ObserverVerdict = unfinished ? "no_go_unfinished_work" : incomplete ? "no_go_incomplete_evidence" : "zero_observed_not_proof";
  return {
    schema: "reconcileai_durable_observer_v1", execution: "synthetic_only", hold: true,
    verdict, databaseControl: "statement_guard_only", samples,
    notCollected: NOT_COLLECTED, errors: ERROR_CODES.filter(code => errors.includes(code)),
  };
}

/** Encode ONLY our rebuilt primitives/keys. This avoids inherited toJSON hooks,
 * including global prototype pollution; no caller object reaches stringify. */
function encode(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry: unknown) => encode(entry)).join(",")}]`;
  if (typeof value !== "object") return refuse();
  return `{${Object.entries(value).map(([key, entry]: [string, unknown]) => `${JSON.stringify(key)}:${encode(entry)}`).join(",")}}`;
}

/** In-process release boundary, NOT a transport parser or stdout interceptor.
 * Object input is descriptor-captured, schema-checked, and canonicalized. Text
 * must already equal canonical output: duplicate keys, escapes, numeric aliases,
 * unknown fields, alternate ordering, and caller verdict mismatches are refused.
 * Every rejection is identical; no exception text, labels, ids, or payload leaks. */
export function serializeReport(input: unknown): string {
  try {
    const text = typeof input === "string" ? input : undefined;
    if (text !== undefined && (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES || text.includes("\\"))) return REFUSED_REPORT;
    const parsed: unknown = text === undefined ? input : JSON.parse(text);
    const canonical = encode(rebuild(capture(parsed)));
    if (Buffer.byteLength(canonical, "utf8") > MAX_REPORT_BYTES || (text !== undefined && text !== canonical)) return REFUSED_REPORT;
    return canonical;
  } catch {
    return REFUSED_REPORT;
  }
}
