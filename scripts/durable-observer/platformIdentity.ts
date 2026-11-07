import { types } from "node:util";

/** Verified against Railway CLI schema 4a13c465c18097b362cbfbd632f016424d764de2.
 * This module owns no credentials or HTTP client. Only a separately authorised,
 * trusted composition root may inject an authenticated secure-connector capability
 * and its owner-approved immutable manifest. Do not expose that injection to an
 * application, route, caller assertions or process environment.
 *
 * The connector must enforce these documents/IDs, authenticated TLS, no redirects,
 * no retries, a bounded decoded response, and no response/credential diagnostics.
 * Platform state is point-in-time evidence, NOT route, commit or reference proof.
 */
const TOKEN_SCOPE_QUERY = `query ObserverTokenScope {
  projectToken { projectId environmentId }
}` as const;
const TARGET_IDENTITY_QUERY = `query ObserverTargetIdentity(
  $deploymentId: String!, $serviceId: String!,
  $environmentId: String!, $projectId: String!
) {
  deployment(id: $deploymentId) {
    id projectId environmentId serviceId status deploymentStopped
  }
  service(id: $serviceId) { id name projectId }
  environment(id: $environmentId, projectId: $projectId) {
    id projectId name
  }
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    id serviceId environmentId serviceName
    source { repo image }
    latestDeployment { id status }
    activeDeployments {
      id projectId environmentId serviceId status deploymentStopped
    }
  }
}` as const;

export interface PlatformIdentityTuple {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly deploymentId: string;
}
export interface PlatformIdentityManifest {
  readonly target: Readonly<PlatformIdentityTuple>;
  readonly observer: Readonly<PlatformIdentityTuple>;
  /** Exact canonical GitHub owner/repository, not a URL, tag or artifact claim. */
  readonly sourceRepo: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
}
export type ApprovedPlatformRequest =
  | Readonly<{
      query: typeof TOKEN_SCOPE_QUERY;
      variables: Readonly<Record<string, never>>;
      signal: AbortSignal;
    }>
  | Readonly<{
      query: typeof TARGET_IDENTITY_QUERY;
      variables: Readonly<PlatformIdentityTuple>;
      signal: AbortSignal;
    }>;
/** Raw decoded GraphQL envelope from a trusted authenticated transport, not facts. */
export type TrustedAuthenticatedPlatformRequest = (
  request: ApprovedPlatformRequest
) => Promise<unknown>;
export type PlatformIdentityStatus =
  | "platform_identity_observed"
  | "platform_request_failed"
  | "platform_request_timeout"
  | "platform_response_refused"
  | "platform_scope_mismatch"
  | "platform_identity_mismatch"
  | "platform_active_deployments_ambiguous"
  | "platform_approval_expired"
  | "platform_observation_stale"
  | "platform_parameters_refused";
export interface PlatformIdentityResult {
  readonly status: PlatformIdentityStatus;
  readonly platformIdentityObserved: boolean;
  readonly hold: true;
  readonly liveEnabled: false;
  readonly blockers: readonly [
    "deployed_commit_unverified",
    "reference_source_unverified",
  ];
}
export interface PlatformIdentityObserver {
  /** Always re-observes; no parameters, fact overrides, caching or store access. */
  observe(): Promise<Readonly<PlatformIdentityResult>>;
}

const APPROVAL_WINDOW_MS = 900_000;
const REQUEST_TIMEOUT_MS = 5_000;
const OBSERVATION_WINDOW_MS = 10_000;
const TUPLE_KEYS = [
  "projectId",
  "environmentId",
  "serviceId",
  "deploymentId",
] as const;
const DEPLOYMENT_KEYS = [
  "id",
  "projectId",
  "environmentId",
  "serviceId",
  "status",
  "deploymentStopped",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPO =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const BLOCKERS = Object.freeze([
  "deployed_commit_unverified",
  "reference_source_unverified",
] as const);
class Refusal extends Error {
  constructor(readonly code: PlatformIdentityStatus) {
    super(code);
  }
}
const refuse = (code: PlatformIdentityStatus): never => {
  throw new Refusal(code);
};
const result = (
  status: PlatformIdentityStatus
): Readonly<PlatformIdentityResult> =>
  Object.freeze({
    status,
    platformIdentityObserved: status === "platform_identity_observed",
    hold: true,
    liveEnabled: false,
    blockers: BLOCKERS,
  });

/** Inspect descriptors only. Never invoke input getters, proxies or coercion. */
function record(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    return refuse("platform_response_refused");
  const captured: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const keys = Reflect.ownKeys(input);
  if (keys.length > 7) return refuse("platform_response_refused");
  for (const key of keys) {
    if (typeof key !== "string") return refuse("platform_response_refused");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      return refuse("platform_response_refused");
    captured[key] = descriptor.value as unknown;
  }
  return captured;
}
function exact(
  input: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  const captured = record(input);
  const own = Object.keys(captured);
  if (own.length !== keys.length || own.some(key => !keys.includes(key)))
    return refuse("platform_response_refused");
  return captured;
}
function uuid(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length !== 36 ||
    !UUID.test(input) ||
    input === "00000000-0000-0000-0000-000000000000"
  )
    return refuse("platform_response_refused");
  return input;
}
function time(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    Object.is(input, -0)
  )
    return refuse("platform_response_refused");
  return input;
}
function text(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 128 ||
    /[\x00-\x1f\x7f]/.test(input)
  )
    return refuse("platform_response_refused");
  return input;
}
function immutableTuple(input: unknown): Readonly<PlatformIdentityTuple> {
  const fields = exact(input, TUPLE_KEYS);
  if (!Object.isFrozen(input)) return refuse("platform_response_refused");
  return Object.freeze({
    projectId: uuid(fields.projectId),
    environmentId: uuid(fields.environmentId),
    serviceId: uuid(fields.serviceId),
    deploymentId: uuid(fields.deploymentId),
  });
}
function captureManifest(input: unknown): Readonly<PlatformIdentityManifest> {
  const fields = exact(input, [
    "target",
    "observer",
    "sourceRepo",
    "approvedAtMs",
    "expiresAtMs",
  ]);
  if (!Object.isFrozen(input)) return refuse("platform_response_refused");
  const target = immutableTuple(fields.target),
    observer = immutableTuple(fields.observer);
  const repo = fields.sourceRepo;
  if (
    target.serviceId === observer.serviceId ||
    target.deploymentId === observer.deploymentId ||
    typeof repo !== "string" ||
    !REPO.test(repo) ||
    /\s/.test(repo) ||
    repo.endsWith(".git") ||
    repo.includes("..")
  )
    return refuse("platform_response_refused");
  const approvedAtMs = time(fields.approvedAtMs),
    expiresAtMs = time(fields.expiresAtMs);
  if (
    expiresAtMs <= approvedAtMs ||
    expiresAtMs - approvedAtMs > APPROVAL_WINDOW_MS
  )
    return refuse("platform_response_refused");
  return Object.freeze({
    target,
    observer,
    sourceRepo: repo,
    approvedAtMs,
    expiresAtMs,
  });
}
function current(
  manifest: PlatformIdentityManifest,
  startedAt: number,
  previous: number
): number {
  const now = time(Date.now());
  if (
    now < previous ||
    now < startedAt ||
    now - startedAt >= OBSERVATION_WINDOW_MS
  )
    return refuse("platform_observation_stale");
  if (
    manifest.approvedAtMs > now ||
    now >= manifest.expiresAtMs ||
    now - manifest.approvedAtMs > APPROVAL_WINDOW_MS
  )
    return refuse("platform_approval_expired");
  return now;
}

/** No retry, no raw thrown values; cancellation also bounds an ignoring transport.
 * Abort is advisory for the secure connector: a deadline proves no later identity
 * result, not that an in-flight platform read was physically cancelled.
 */
async function requestBounded(
  capability: TrustedAuthenticatedPlatformRequest,
  query: ApprovedPlatformRequest["query"],
  variables: Readonly<PlatformIdentityTuple> | Readonly<Record<string, never>>
): Promise<unknown> {
  const controller = new AbortController();
  const deadline = time(Date.now()) + REQUEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Refusal("platform_request_timeout"));
        controller.abort(); // No platform error or caller reason enters the signal.
      }, REQUEST_TIMEOUT_MS);
    });
    // The discriminated union is constructed here, never from caller documents.
    const fixed: ApprovedPlatformRequest =
      query === TOKEN_SCOPE_QUERY
        ? Object.freeze({
            query,
            variables: Object.freeze({}),
            signal: controller.signal,
          })
        : Object.freeze({
            query,
            variables: variables as Readonly<PlatformIdentityTuple>,
            signal: controller.signal,
          });
    const work = Promise.resolve()
      .then(() => {
        if (expired) return refuse("platform_request_timeout");
        return capability(fixed);
      })
      .catch(() => refuse("platform_request_failed"));
    const response: unknown = await Promise.race([work, timeout]);
    // A sync/blocking connector or delayed event loop cannot bypass the timer.
    if (time(Date.now()) >= deadline) return refuse("platform_request_timeout");
    return response;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
function envelope(
  input: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  const root = record(input);
  // Even errors:null or errors:[] is refused, without looking at error contents.
  if (Object.hasOwn(root, "errors")) return refuse("platform_request_failed");
  if (Object.keys(root).length !== 1 || !Object.hasOwn(root, "data"))
    return refuse("platform_response_refused");
  return exact(root.data, keys);
}
function deployment(input: unknown, target: PlatformIdentityTuple): void {
  const fields = exact(input, DEPLOYMENT_KEYS);
  const id = uuid(fields.id),
    project = uuid(fields.projectId);
  const environment = uuid(fields.environmentId),
    service = uuid(fields.serviceId);
  text(fields.status);
  if (typeof fields.deploymentStopped !== "boolean")
    return refuse("platform_response_refused");
  if (
    id !== target.deploymentId ||
    project !== target.projectId ||
    environment !== target.environmentId ||
    service !== target.serviceId ||
    fields.status !== "SUCCESS" ||
    fields.deploymentStopped
  )
    return refuse("platform_identity_mismatch");
}
function activeList(input: unknown): readonly unknown[] {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  )
    return refuse("platform_response_refused");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  const length: unknown = lengthDescriptor?.value;
  // Cap BEFORE inspecting elements, even when malformed or accessor-backed.
  if (typeof length !== "number" || length > 2)
    return refuse("platform_response_refused");
  const keys = Reflect.ownKeys(input);
  const expected = [
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ];
  if (
    keys.length !== expected.length ||
    keys.some(key => typeof key !== "string" || !expected.includes(key))
  )
    return refuse("platform_response_refused");
  const captured: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      return refuse("platform_response_refused");
    captured.push(descriptor.value as unknown);
  }
  return captured;
}
function targetIdentity(
  input: unknown,
  manifest: PlatformIdentityManifest
): void {
  const target = manifest.target;
  const data = envelope(input, [
    "deployment",
    "service",
    "environment",
    "serviceInstance",
  ]);
  deployment(data.deployment, target);
  const service = exact(data.service, ["id", "name", "projectId"]);
  const environment = exact(data.environment, ["id", "projectId", "name"]);
  const instance = exact(data.serviceInstance, [
    "id",
    "serviceId",
    "environmentId",
    "serviceName",
    "source",
    "latestDeployment",
    "activeDeployments",
  ]);
  uuid(instance.id);
  const serviceName = text(service.name),
    instanceName = text(instance.serviceName);
  text(environment.name);
  if (
    uuid(service.id) !== target.serviceId ||
    uuid(service.projectId) !== target.projectId ||
    uuid(environment.id) !== target.environmentId ||
    uuid(environment.projectId) !== target.projectId ||
    uuid(instance.serviceId) !== target.serviceId ||
    uuid(instance.environmentId) !== target.environmentId ||
    serviceName !== instanceName
  )
    return refuse("platform_identity_mismatch");
  const source = exact(instance.source, ["repo", "image"]);
  if (
    typeof source.repo !== "string" ||
    (source.image !== null && typeof source.image !== "string")
  )
    return refuse("platform_response_refused");
  if (source.repo !== manifest.sourceRepo || source.image !== null)
    return refuse("platform_identity_mismatch");
  const latest = exact(instance.latestDeployment, ["id", "status"]);
  uuid(latest.id);
  text(latest.status); // Latest is not running-identity evidence; never select it.
  const active = activeList(instance.activeDeployments);
  if (active.length > 1) return refuse("platform_active_deployments_ambiguous");
  if (active.length !== 1) return refuse("platform_identity_mismatch");
  deployment(active[0], target);
}

/** Captures all immutable approval fields and the trusted capability synchronously.
 * Construction does NOT prove provenance/authentication or grant live execution.
 * There is intentionally no built-in transport or caller-provided facts function.
 */
export function createPlatformIdentityObserver(
  manifestInput: unknown,
  authenticatedRequest: TrustedAuthenticatedPlatformRequest
): Readonly<PlatformIdentityObserver> {
  let manifest: Readonly<PlatformIdentityManifest>;
  try {
    manifest = captureManifest(manifestInput);
  } catch {
    throw new Error("platform_manifest_refused");
  }
  if (
    typeof authenticatedRequest !== "function" ||
    types.isProxy(authenticatedRequest)
  )
    throw new Error("platform_capability_refused");
  const request = authenticatedRequest;
  return Object.freeze({
    observe: async (
      ...overrides: readonly unknown[]
    ): Promise<Readonly<PlatformIdentityResult>> => {
      if (overrides.length) return result("platform_parameters_refused");
      try {
        const startedAt = time(Date.now());
        let previous = current(manifest, startedAt, startedAt);
        const scopeResponse = await requestBounded(
          request,
          TOKEN_SCOPE_QUERY,
          Object.freeze({})
        );
        previous = current(manifest, startedAt, previous);
        const scope = exact(
          envelope(scopeResponse, ["projectToken"]).projectToken,
          ["projectId", "environmentId"]
        );
        if (
          uuid(scope.projectId) !== manifest.target.projectId ||
          uuid(scope.environmentId) !== manifest.target.environmentId
        )
          return result("platform_scope_mismatch");
        // Recheck immediately before releasing the second, manifest-bound read.
        previous = current(manifest, startedAt, previous);
        const targetResponse = await requestBounded(
          request,
          TARGET_IDENTITY_QUERY,
          manifest.target
        );
        previous = current(manifest, startedAt, previous);
        targetIdentity(targetResponse, manifest);
        current(manifest, startedAt, previous); // Conservative final freshness check.
        return result("platform_identity_observed");
      } catch (error: unknown) {
        return result(
          error instanceof Refusal ? error.code : "platform_response_refused"
        );
      }
    },
  });
}

/** Single observation convenience for a trusted preparation composition root.
 * Approval and capability are captured before the first await. Invalid setup
 * throws only the two fixed construction errors above; no observations are
 * accepted as input. The pinned factory is preferred for repeated checks.
 */
export function inspectPlatformIdentity(
  manifestInput: unknown,
  authenticatedRequest: TrustedAuthenticatedPlatformRequest
): Promise<Readonly<PlatformIdentityResult>> {
  return createPlatformIdentityObserver(
    manifestInput,
    authenticatedRequest
  ).observe();
}
