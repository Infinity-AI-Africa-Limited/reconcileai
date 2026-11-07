import { types } from "node:util";

/** PREPARATION ONLY: no transport, environment, logging, runtime or proof-gate wiring.
 * A separately reviewed trusted composition root must supply the owner-approved,
 * frozen manifest, clock and bounded projections (NOT raw Railway/GitHub payloads).
 * Completeness/latest-status/provenance assertions cannot be authenticated here.
 * Reference scope is ONLY the observer's own unrendered map: never query the app's
 * variables or resolved values. Stored expressions do not prove loaded credentials.
 * Correlation is not binary attestation. Neither result clears platformIdentity's
 * blockers or authorises execution; even success retains production_hold.
 */
export interface AssuranceManifest {
  readonly projectId: string;
  readonly environmentId: string;
  readonly targetServiceId: string;
  readonly targetDeploymentId: string;
  readonly observerServiceId: string;
  readonly sourceServiceName: string;
  readonly sourceRepo: string;
  readonly expectedSha: string;
  readonly githubContext: string;
  readonly maxSkewMs: number;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
}
export interface ObserverReferenceProjection {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly sourceServiceId: string;
  readonly sourceServiceName: string;
  readonly unrendered: true;
  readonly observedAt: string;
  readonly variables: unknown;
}
export interface AppDeploymentProjection {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly status: string;
  readonly deploymentStopped: boolean;
  readonly createdAt: string;
}
export interface AppSnapshotProjection {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly sourceRepo: string;
  readonly observedAt: string;
  readonly deploymentsComplete: true;
  readonly activeDeployments: readonly AppDeploymentProjection[];
  readonly deployments: readonly AppDeploymentProjection[];
}
export interface GithubDeploymentProjection {
  readonly id: string;
  readonly repo: string;
  readonly context: string;
  /** Trusted projector must take the GitHub deployment's payload.environmentId;
   * never derive this flat field from display context, manifest or caller claims.
   */
  readonly environmentId: string;
  readonly sha: string;
  readonly creator: string;
  readonly createdAt: string;
  readonly latestStatus: Readonly<{
    repo: string;
    context: string;
    state: string;
    createdAt: string;
    creator: string;
  }>;
}
export interface DeploymentCorrelationProjection {
  readonly before: AppSnapshotProjection;
  readonly github: Readonly<{
    repo: string;
    context: string;
    observedAt: string;
    deploymentsComplete: true;
    deployments: readonly GithubDeploymentProjection[];
  }>;
  readonly after: AppSnapshotProjection;
}
export type AssuranceCode =
  | "reference_expressions_observed"
  | "reference_evidence_refused"
  | "deployment_correlation_observed"
  | "deployment_evidence_refused";
export interface AssuranceResult {
  readonly code: AssuranceCode;
  readonly assurance:
    | "stored_reference_expressions_only"
    | "deployment_correlated_not_binary_attested"
    | "unverified";
  readonly production_hold: true;
  readonly execution_authorized: false;
}
type Fields = Record<string, unknown>;
const MANIFEST_KEYS = [
  "projectId",
  "environmentId",
  "targetServiceId",
  "targetDeploymentId",
  "observerServiceId",
  "sourceServiceName",
  "sourceRepo",
  "expectedSha",
  "githubContext",
  "maxSkewMs",
  "approvedAtMs",
  "expiresAtMs",
] as const;
const APP_KEYS = [
  "id",
  "projectId",
  "environmentId",
  "serviceId",
  "status",
  "deploymentStopped",
  "createdAt",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-fA-F]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const REPO =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
// Railway's GitHub environment includes a project name, spaces and a slash.
// Exact manifest equality still binds every projected record to this context.
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9 _./-]{0,127}$/;
const APP_STATES = [
  "SUCCESS",
  "FAILED",
  "BUILDING",
  "DEPLOYING",
  "CRASHED",
  "REMOVED",
  "SKIPPED",
  "WAITING",
  "QUEUED",
  "INITIALIZING",
  "NEEDS_APPROVAL",
  "SLEEPING",
];
const GH_STATES = [
  "success",
  "failure",
  "error",
  "pending",
  "queued",
  "in_progress",
  "inactive",
];
function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new Error("assurance_evidence_refused");
}
function result(code: AssuranceCode): Readonly<AssuranceResult> {
  return Object.freeze({
    code,
    assurance:
      code === "reference_expressions_observed"
        ? "stored_reference_expressions_only"
        : code === "deployment_correlation_observed"
          ? "deployment_correlated_not_binary_attested"
          : "unverified",
    production_hold: true,
    execution_authorized: false,
  });
}
/** Closed, nonrecursive schemas bound depth and reject cycles at primitive leaves.
 * Proxy detection precedes every reflective operation; no input getters/coercion.
 */
function exact(
  input: unknown,
  keys: readonly string[],
  frozen = false
): Fields {
  requireEvidence(
    input &&
      typeof input === "object" &&
      !types.isProxy(input) &&
      Object.getPrototypeOf(input) === Object.prototype &&
      !Array.isArray(input)
  );
  const own = Reflect.ownKeys(input);
  requireEvidence(
    own.length === keys.length &&
      own.every(key => typeof key === "string" && keys.includes(key))
  );
  const captured: Fields = Object.create(null) as Fields;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    requireEvidence(
      descriptor && descriptor.enumerable && "value" in descriptor
    );
    captured[key] = descriptor.value as unknown;
  }
  requireEvidence(!frozen || Object.isFrozen(input));
  return captured;
}
function list(input: unknown, cap = 50): unknown[] {
  requireEvidence(
    input &&
      typeof input === "object" &&
      !types.isProxy(input) &&
      Array.isArray(input) &&
      Object.getPrototypeOf(input) === Array.prototype
  );
  const length: unknown = Object.getOwnPropertyDescriptor(
    input,
    "length"
  )?.value;
  requireEvidence(
    typeof length === "number" &&
      Number.isSafeInteger(length) &&
      length >= 0 &&
      length <= cap
  );
  requireEvidence(Reflect.ownKeys(input).length === length + 1);
  const captured: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    requireEvidence(
      descriptor && descriptor.enumerable && "value" in descriptor
    );
    captured.push(descriptor.value as unknown);
  }
  return captured;
}
function integer(input: unknown): number {
  requireEvidence(
    typeof input === "number" &&
      Number.isSafeInteger(input) &&
      input >= 0 &&
      !Object.is(input, -0)
  );
  return input;
}
function matches(
  input: unknown,
  pattern: RegExp,
  cap: number
): input is string {
  return (
    typeof input === "string" &&
    input.length <= cap &&
    pattern.test(input) &&
    !/\s/.test(input)
  );
}
function uuid(input: unknown): void {
  requireEvidence(
    matches(input, UUID, 36) && input !== "00000000-0000-0000-0000-000000000000"
  );
}
function utc(input: unknown): number {
  requireEvidence(
    typeof input === "string" &&
      (input.length === 20 || input.length === 24) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input)
  );
  const ms = Date.parse(input);
  requireEvidence(Number.isFinite(ms) && ms >= 0);
  requireEvidence(
    new Date(ms).toISOString() ===
      (input.length === 20 ? input.slice(0, -1) + ".000Z" : input)
  );
  return ms;
}
function manifest(input: unknown, nowInput: unknown): Fields {
  const m = exact(input, MANIFEST_KEYS, true),
    now = integer(nowInput);
  for (const key of [
    "projectId",
    "environmentId",
    "targetServiceId",
    "targetDeploymentId",
    "observerServiceId",
  ])
    uuid(m[key]);
  requireEvidence(
    m.observerServiceId !== m.targetServiceId &&
      matches(m.sourceServiceName, NAME, 63) &&
      matches(m.sourceRepo, REPO, 140) &&
      !m.sourceRepo.endsWith(".git") &&
      !m.sourceRepo.includes("..") &&
      matches(m.expectedSha, SHA, 40) &&
      typeof m.githubContext === "string" &&
      CONTEXT.test(m.githubContext) &&
      m.githubContext.trim() === m.githubContext
  );
  const approved = integer(m.approvedAtMs),
    expires = integer(m.expiresAtMs);
  requireEvidence(
    approved <= now &&
      now < expires &&
      expires - approved <= 900_000 &&
      integer(m.maxSkewMs) <= 600_000
  );
  return m;
}
function fresh(input: unknown, m: Fields, now: number): number {
  const observed = utc(input);
  requireEvidence(
    observed >= integer(m.approvedAtMs) &&
      observed <= now &&
      now - observed <= 300_000
  );
  return observed;
}
function owner(fields: Fields, m: Fields, service: unknown): void {
  requireEvidence(
    fields.projectId === m.projectId &&
      fields.environmentId === m.environmentId &&
      fields.serviceId === service
  );
}
/** Allow only ASCII space/tab/CR/LF around the WHOLE expression, never inside it.
 * Missing/sealed values, extra map keys and literal/concatenated secrets all refuse
 * generically. No input key/value/map/exception ever enters output or diagnostics.
 */
export function reduceObserverReferences(
  manifestInput: unknown,
  input: unknown,
  nowMs: unknown
): Readonly<AssuranceResult> {
  try {
    const m = manifest(manifestInput, nowMs);
    const p = exact(input, [
      "projectId",
      "environmentId",
      "serviceId",
      "sourceServiceId",
      "sourceServiceName",
      "unrendered",
      "observedAt",
      "variables",
    ]);
    owner(p, m, m.observerServiceId);
    requireEvidence(
      p.sourceServiceId === m.targetServiceId &&
        p.sourceServiceName === m.sourceServiceName &&
        p.unrendered === true
    );
    fresh(p.observedAt, m, integer(nowMs));
    const values = exact(p.variables, ["DATABASE_URL", "REDIS_URL"]);
    for (const key of ["DATABASE_URL", "REDIS_URL"]) {
      const value = values[key];
      requireEvidence(typeof value === "string" && value.length <= 512);
      requireEvidence(
        value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") ===
          "${{" + m.sourceServiceName + "." + key + "}}"
      );
    }
    return result("reference_expressions_observed");
  } catch {
    return result("reference_evidence_refused");
  }
}
function app(input: unknown, m: Fields, observed: number): Fields {
  const d = exact(input, APP_KEYS);
  uuid(d.id);
  owner(d, m, m.targetServiceId);
  requireEvidence(
    typeof d.status === "string" &&
      APP_STATES.includes(d.status) &&
      typeof d.deploymentStopped === "boolean"
  );
  requireEvidence(utc(d.createdAt) <= observed);
  return d;
}
function snapshot(
  input: unknown,
  m: Fields,
  now: number
): { observed: number; active: Fields } {
  const p = exact(input, [
    "projectId",
    "environmentId",
    "serviceId",
    "sourceRepo",
    "observedAt",
    "deploymentsComplete",
    "activeDeployments",
    "deployments",
  ]);
  owner(p, m, m.targetServiceId);
  requireEvidence(
    p.sourceRepo === m.sourceRepo && p.deploymentsComplete === true
  );
  const observed = fresh(p.observedAt, m, now),
    activeList = list(p.activeDeployments, 2);
  requireEvidence(activeList.length === 1);
  const active = app(activeList[0], m, observed);
  requireEvidence(
    active.id === m.targetDeploymentId &&
      active.status === "SUCCESS" &&
      active.deploymentStopped === false
  );
  const deployments = list(p.deployments).map(d => app(d, m, observed)),
    ids = new Set<unknown>();
  requireEvidence(deployments.length > 0);
  let found = false;
  for (const d of deployments) {
    requireEvidence(!ids.has(d.id));
    ids.add(d.id);
    if (d.id === active.id) {
      requireEvidence(APP_KEYS.every(key => d[key] === active[key]));
      found = true;
    } else requireEvidence(utc(d.createdAt) < utc(active.createdAt)); // Equal timestamps are ambiguous too.
  }
  requireEvidence(found);
  return { observed, active };
}
/** Trusted projections must include complete capped histories and actual latest
 * GitHub status. No sorting/first-record shortcut or selection of a past success.
 * Every relevant GitHub record must project payload.environmentId to the flat
 * environmentId field; matching display context or caller claims cannot replace it.
 * Observation freshness is distinct from record age: an older active app is valid.
 */
export function reduceDeploymentCorrelation(
  manifestInput: unknown,
  input: unknown,
  nowMs: unknown
): Readonly<AssuranceResult> {
  try {
    const m = manifest(manifestInput, nowMs),
      now = integer(nowMs),
      p = exact(input, ["before", "github", "after"]);
    const before = snapshot(p.before, m, now),
      after = snapshot(p.after, m, now);
    requireEvidence(
      APP_KEYS.every(key => before.active[key] === after.active[key])
    );
    const gh = exact(p.github, [
      "repo",
      "context",
      "observedAt",
      "deploymentsComplete",
      "deployments",
    ]);
    requireEvidence(
      gh.repo === m.sourceRepo &&
        gh.context === m.githubContext &&
        gh.deploymentsComplete === true
    );
    const observed = fresh(gh.observedAt, m, now);
    requireEvidence(before.observed <= observed && observed <= after.observed);
    const ids = new Set<unknown>(),
      records = list(gh.deployments).map(inputRecord => {
        const d = exact(inputRecord, [
          "id",
          "repo",
          "context",
          "environmentId",
          "sha",
          "creator",
          "createdAt",
          "latestStatus",
        ]);
        requireEvidence(
          matches(d.id, /^[1-9][0-9]{0,19}$/, 20) && !ids.has(d.id)
        );
        ids.add(d.id);
        uuid(d.environmentId);
        requireEvidence(
          d.repo === m.sourceRepo &&
            d.context === m.githubContext &&
            d.environmentId === m.environmentId &&
            matches(d.sha, SHA, 40) &&
            typeof d.creator === "string" &&
            d.creator.length > 0 &&
            d.creator.length <= 128
        );
        const created = utc(d.createdAt),
          status = exact(d.latestStatus, [
            "repo",
            "context",
            "state",
            "createdAt",
            "creator",
          ]);
        requireEvidence(
          status.repo === m.sourceRepo &&
            status.context === m.githubContext &&
            typeof status.state === "string" &&
            GH_STATES.includes(status.state) &&
            typeof status.creator === "string" &&
            status.creator.length > 0 &&
            status.creator.length <= 128 &&
            created <= utc(status.createdAt) &&
            utc(status.createdAt) <= observed
        );
        return { d, created, status };
      });
    requireEvidence(records.length > 0);
    const latestTime = Math.max(...records.map(d => d.created)),
      latest = records.filter(d => d.created === latestTime);
    requireEvidence(latest.length === 1);
    const selected = latest[0],
      activeCreated = utc(before.active.createdAt);
    requireEvidence(
      selected.d.creator === "railway-app[bot]" &&
        selected.d.sha === m.expectedSha &&
        selected.status.state === "success" &&
        selected.status.creator === "railway-app[bot]" &&
        // The deployment GitHub's success describes existed before that success
        // was recorded. One created afterwards (a dashboard rollback, a CLI
        // deploy, a redeploy) has no GitHub record of its own; inside the skew
        // window it would otherwise inherit the newer commit.
        activeCreated <= utc(selected.status.createdAt) &&
        Math.abs(selected.created - activeCreated) <= integer(m.maxSkewMs)
    );
    return result("deployment_correlation_observed");
  } catch {
    return result("deployment_evidence_refused");
  }
}
