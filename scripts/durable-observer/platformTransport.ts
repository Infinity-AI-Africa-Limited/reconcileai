import { request as httpsRequest } from "node:https";
import { types } from "node:util";
import { TextDecoder } from "node:util";
import {
  createPlatformIdentityObserver,
  type ApprovedPlatformRequest,
  type PlatformIdentityManifest,
  type PlatformIdentityStatus,
} from "./platformIdentity";
import { reduceObserverReferences, type AssuranceManifest } from "./assurance";

/** PREPARATION ONLY. No CLI, environment reads, credential lookup or import-time IO.
 * Only a separately reviewed trusted composition root may invoke this factory and
 * later observe with explicitly approved setup. A mode/name/frozen manifest is NOT
 * proof of approval, gateway replacement, operation confinement or host privacy.
 * The placeholder is an administrative capability, not a read-only credential.
 * Synthetic driver tests establish application-boundary behavior, NOT gateway proof.
 * Node HTTPS activation is unavailable to the existing public CLI (no wiring here).
 * Inbound host instrumentation, diagnostics channels, dumps and process access are
 * outside this module's guarantees. Memory reference clearing is not zeroization.
 * No deployed-SHA/correlation attestation or runtime credential-target proof here.
 * A later first approved authenticated metadata read must measure correlation
 * skew; this module introduces no guessed skew default or GitHub evidence read.
 */
const SCOPE_QUERY = `query ObserverTokenScope {
  projectToken { projectId environmentId }
}` as const;
// Independently pinned allowlist matches platformIdentity's immutable documents.
const IDENTITY_QUERY = `query ObserverTargetIdentity(
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
const REFERENCES_QUERY = `query ObserverStoredReferences(
  $projectId: String!, $environmentId: String!, $serviceId: String!
) {
  variables(projectId: $projectId, environmentId: $environmentId,
    serviceId: $serviceId, unrendered: true)
}` as const;
const MAX_RESPONSE_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 3_000;
const OBSERVATION_TIMEOUT_MS = 10_000;
// Native typed-array slots ignore own Buffer metadata/accessors. set copies the
// source's actual view without consulting its length, buffer, offset or species.
const nativeByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength"
)?.get as (this: Uint8Array) => number;
const nativeSet = Uint8Array.prototype.set;
const REFERENCE_MANIFEST_KEYS = [
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

export type PlatformTransportCode =
  | PlatformIdentityStatus
  | "platform_references_observed"
  | "reference_evidence_refused"
  | "transport_parameters_refused"
  | "transport_http_unauthorized"
  | "transport_http_forbidden"
  | "transport_http_refused"
  | "transport_encoding_refused"
  | "transport_content_type_refused"
  | "transport_response_refused"
  | "transport_response_oversize"
  | "transport_graphql_refused"
  | "transport_request_failed"
  | "transport_request_timeout";
export interface PlatformTransportResult {
  readonly code: PlatformTransportCode;
  readonly production_hold: true;
  readonly execution_authorized: false;
}
export interface PlatformTransportObserver {
  /** No raw request, credential, response, selectors or hooks are exposed. */
  observe(): Promise<Readonly<PlatformTransportResult>>;
}
/** Trusted low-level IO seam, NOT an application hook. Tests inject a fake ONLY.
 * Implementations must not log/expose request headers, replies or thrown errors.
 * Raw IO exists exclusively within this trusted composition boundary.
 */
export interface FixedRailwayHttpsRequest {
  readonly protocol: "https:";
  readonly hostname: "backboard.railway.com";
  readonly port: 443;
  readonly path: "/graphql/v2";
  readonly method: "POST";
  readonly rejectUnauthorized: true;
  readonly minVersion: "TLSv1.2";
  readonly agent: false;
  readonly headers: Readonly<{
    "Project-Access-Token": string;
    "Content-Type": "application/json";
    Accept: "application/json";
    "Accept-Encoding": "identity";
    "Content-Length": number;
  }>;
  readonly body: string;
}
export interface PrivateHttpsReceiver {
  headers(
    status: unknown,
    contentType: unknown,
    contentEncoding: unknown,
    contentLength: unknown
  ): void;
  chunk(bytes: unknown): void;
  end(): void;
  error(): void;
  timeout(): void;
}
export type TrustedPlatformHttpsDriver = (
  request: Readonly<FixedRailwayHttpsRequest>,
  receiver: Readonly<PrivateHttpsReceiver>
) => Readonly<{ cancel(): void }>;
export type TrustedPlatformTransportSetup =
  | Readonly<{
      mode: "synthetic";
      tokenPlaceholder: string;
      driver: TrustedPlatformHttpsDriver;
    }>
  | Readonly<{
      mode: "trusted_node_https";
      tokenPlaceholder: string;
    }>;

const failures = new WeakMap<object, PlatformTransportCode>();
class Refusal extends Error {
  constructor(code: PlatformTransportCode) {
    super(code);
    failures.set(this, code);
  }
}
function failureCode(error: unknown): PlatformTransportCode {
  return error !== null && typeof error === "object"
    ? (failures.get(error) ?? "transport_request_failed")
    : "transport_request_failed";
}
function refuse(code: PlatformTransportCode): never {
  throw new Refusal(code);
}
function result(
  code: PlatformTransportCode
): Readonly<PlatformTransportResult> {
  return Object.freeze({
    code,
    production_hold: true,
    execution_authorized: false,
  });
}
/** Descriptor-only closed records: no caller getters, proxy traps or coercion. */
function fields(
  input: unknown,
  keys: readonly string[],
  frozen = false
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    return refuse("transport_response_refused");
  const own = Reflect.ownKeys(input);
  if (
    own.length !== keys.length ||
    own.some(key => typeof key !== "string" || !keys.includes(key))
  )
    return refuse("transport_response_refused");
  const captured: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      return refuse("transport_response_refused");
    captured[key] = descriptor.value as unknown;
  }
  if (frozen && !Object.isFrozen(input))
    return refuse("transport_response_refused");
  return captured;
}

/** No redirects, retries, decompression, debug, tracing or error introspection.
 * Node verifies certificate chains and hostname by default; never override them.
 * No caller agent, TLS option, URL, header, lookup or selector can enter this driver.
 */
const nodeDriver: TrustedPlatformHttpsDriver = (fixed, receiver) => {
  let response: import("node:http").IncomingMessage | undefined;
  const request = httpsRequest(
    {
      protocol: fixed.protocol,
      hostname: fixed.hostname,
      port: fixed.port,
      path: fixed.path,
      method: fixed.method,
      agent: false,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      headers: fixed.headers,
    },
    incoming => {
      response = incoming;
      incoming.on("error", () => receiver.error());
      incoming.on("aborted", () => receiver.error());
      incoming.on("data", (bytes: unknown) => receiver.chunk(bytes));
      incoming.on("end", () => receiver.end());
      incoming.on("close", () => {
        if (!incoming.complete) receiver.error();
      });
      const distinct = incoming.headersDistinct;
      const single = (key: string): unknown => {
        const values = distinct[key];
        return values === undefined
          ? undefined
          : values.length === 1
            ? values[0]
            : null;
      };
      receiver.headers(
        incoming.statusCode,
        single("content-type"),
        single("content-encoding"),
        single("content-length")
      );
    }
  );
  request.on("error", () => receiver.error());
  request.setTimeout(REQUEST_TIMEOUT_MS, () => receiver.timeout());
  request.end(fixed.body);
  return Object.freeze({
    cancel: () => {
      response?.destroy();
      request.destroy();
    },
  });
};

/** Internal reusable fixed request client. Raw envelopes never escape the factory.
 * Every chunk is bounded BEFORE copying, decoding, concatenation or JSON.parse.
 * Settled callbacks ignore late events; cancellation is advisory for injected IO.
 */
function fixedRequest(
  driver: TrustedPlatformHttpsDriver,
  placeholder: string,
  query: typeof SCOPE_QUERY | typeof IDENTITY_QUERY | typeof REFERENCES_QUERY,
  variables: Readonly<object>,
  signal: AbortSignal
): Promise<unknown> {
  if (![SCOPE_QUERY, IDENTITY_QUERY, REFERENCES_QUERY].includes(query))
    return Promise.reject(new Refusal("transport_parameters_refused"));
  const body = JSON.stringify({ query, variables });
  const fixed: Readonly<FixedRailwayHttpsRequest> = Object.freeze({
    protocol: "https:",
    hostname: "backboard.railway.com",
    port: 443,
    path: "/graphql/v2",
    method: "POST",
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    agent: false,
    headers: Object.freeze({
      "Project-Access-Token": placeholder,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "Content-Length": Buffer.byteLength(body),
    }),
    body,
  });
  return new Promise<unknown>((resolve, reject) => {
    const started = Date.now(),
      monotonic = performance.now();
    let settled = false,
      headersReceived = false,
      total = 0;
    let expectedLength: number | undefined;
    let cancel: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const expired = (): boolean =>
      Date.now() < started ||
      Date.now() - started >= REQUEST_TIMEOUT_MS ||
      performance.now() - monotonic >= REQUEST_TIMEOUT_MS;
    const stop = (): void => {
      try {
        cancel?.();
      } catch {
        /* no raw errors */
      }
    };
    const finish = (code?: PlatformTransportCode, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      if (code) reject(new Refusal(code));
      else resolve(value);
      stop();
    };
    const abort = (): void => finish("transport_request_timeout");
    const guard = (): boolean => {
      if (settled) return false;
      if (expired() || signal.aborted) {
        abort();
        return false;
      }
      return true;
    };
    const receiver: Readonly<PrivateHttpsReceiver> = Object.freeze({
      headers: (
        status: unknown,
        contentType: unknown,
        encoding: unknown,
        length: unknown
      ): void => {
        if (!guard()) return;
        if (headersReceived) {
          finish("transport_response_refused");
          return;
        }
        headersReceived = true;
        if (status !== 200) {
          finish(
            status === 401
              ? "transport_http_unauthorized"
              : status === 403
                ? "transport_http_forbidden"
                : "transport_http_refused"
          );
          return;
        }
        if (encoding !== undefined) {
          finish("transport_encoding_refused");
          return;
        }
        if (
          typeof contentType !== "string" ||
          contentType.length > 64 ||
          /[\x00-\x1f\x7f]/.test(contentType.replace(/\t/g, "")) ||
          !/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(
            contentType
          )
        ) {
          finish("transport_content_type_refused");
          return;
        }
        if (length !== undefined) {
          if (
            typeof length !== "string" ||
            length.length > 8 ||
            /\s/.test(length) ||
            !/^(?:0|[1-9][0-9]*)$/.test(length)
          ) {
            finish("transport_response_refused");
            return;
          }
          expectedLength = Number(length);
          if (expectedLength > MAX_RESPONSE_BYTES)
            finish("transport_response_oversize");
        }
      },
      chunk: (bytes: unknown): void => {
        if (!guard()) return;
        if (
          !headersReceived ||
          !bytes ||
          typeof bytes !== "object" ||
          types.isProxy(bytes) ||
          !types.isUint8Array(bytes) ||
          !Buffer.isBuffer(bytes) ||
          Object.getPrototypeOf(bytes) !== Buffer.prototype
        ) {
          finish("transport_response_refused");
          return;
        }
        const size = nativeByteLength.call(bytes);
        if (size > MAX_RESPONSE_BYTES - total) {
          finish("transport_response_oversize");
          return;
        }
        if (size === 0) return;
        const copy = Buffer.allocUnsafe(size);
        nativeSet.call(copy, bytes);
        total += size;
        chunks.push(copy);
      },
      end: (): void => {
        if (!guard()) return;
        if (
          !headersReceived ||
          total === 0 ||
          (expectedLength !== undefined && total !== expectedLength)
        ) {
          finish("transport_response_refused");
          return;
        }
        const joined = Buffer.concat(chunks, total);
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            joined
          );
          const parsed: unknown = JSON.parse(decoded);
          if (!guard()) return;
          if (
            parsed &&
            typeof parsed === "object" &&
            Object.hasOwn(parsed, "errors")
          ) {
            finish("transport_graphql_refused");
            return;
          }
          fields(parsed, ["data"]);
          finish(undefined, parsed);
        } catch {
          finish("transport_response_refused");
        } finally {
          joined.fill(0);
        }
      },
      error: (): void => {
        if (guard()) finish("transport_request_failed");
      },
      timeout: (): void => {
        if (guard()) finish("transport_request_timeout");
      },
    });
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
    try {
      const handle = driver(fixed, receiver);
      // A trusted driver's return is IO authority, never exposed to callers.
      cancel = () => handle.cancel();
      if (settled) stop();
    } catch {
      finish("transport_request_failed");
    }
  });
}

/** Trusted factory only. No raw credential accepted, no env fallback on failure.
 * Construction is passive. The caller must NOT expose this injection to routes,
 * application assertions, public CLI inputs or an agent-accessible generic broker.
 * Existing identity and reference reducers remain authoritative; no key filtering.
 */
export function createPlatformTransport(
  identityManifestInput: unknown,
  referenceManifestInput: unknown,
  trustedSetupInput: unknown
): Readonly<PlatformTransportObserver> {
  let identity: Readonly<PlatformIdentityManifest>;
  let references: Readonly<AssuranceManifest>;
  let placeholder: string;
  let driver: TrustedPlatformHttpsDriver;
  try {
    // The existing identity factory validates/captures the closed frozen manifest.
    createPlatformIdentityObserver(
      identityManifestInput,
      async () => undefined
    );
    identity = identityManifestInput as Readonly<PlatformIdentityManifest>;
    const captured = fields(
      referenceManifestInput,
      REFERENCE_MANIFEST_KEYS,
      true
    );
    if (
      Object.values(captured).some(
        value => typeof value !== "string" && typeof value !== "number"
      )
    )
      return refuse("transport_response_refused");
    references = Object.freeze({
      ...captured,
    }) as unknown as Readonly<AssuranceManifest>;
    if (
      identity.observer.projectId !== identity.target.projectId ||
      identity.observer.environmentId !== identity.target.environmentId ||
      references.projectId !== identity.target.projectId ||
      references.environmentId !== identity.target.environmentId ||
      references.targetServiceId !== identity.target.serviceId ||
      references.targetDeploymentId !== identity.target.deploymentId ||
      references.observerServiceId !== identity.observer.serviceId ||
      references.sourceRepo !== identity.sourceRepo ||
      references.approvedAtMs !== identity.approvedAtMs ||
      references.expiresAtMs !== identity.expiresAtMs
    )
      return refuse("transport_response_refused");
    // Determine mode through descriptors without evaluating untrusted properties.
    if (
      !trustedSetupInput ||
      typeof trustedSetupInput !== "object" ||
      types.isProxy(trustedSetupInput)
    )
      return refuse("transport_response_refused");
    const mode = Object.getOwnPropertyDescriptor(trustedSetupInput, "mode")
      ?.value as unknown;
    const setup = fields(
      trustedSetupInput,
      mode === "synthetic"
        ? ["mode", "tokenPlaceholder", "driver"]
        : ["mode", "tokenPlaceholder"],
      true
    );
    const token = setup.tokenPlaceholder;
    if (
      typeof token !== "string" ||
      token.length > 256 ||
      !/^mtr_fake_[A-Za-z0-9_-]{8,200}$/.test(token) ||
      /\s/.test(token)
    )
      return refuse("transport_response_refused");
    placeholder = token;
    if (mode === "synthetic") {
      if (typeof setup.driver !== "function" || types.isProxy(setup.driver))
        return refuse("transport_response_refused");
      driver = setup.driver as TrustedPlatformHttpsDriver;
    } else if (mode === "trusted_node_https") driver = nodeDriver;
    else return refuse("transport_response_refused");
  } catch {
    throw new Error("platform_transport_setup_refused");
  }

  return Object.freeze({
    observe: async (
      ...overrides: readonly unknown[]
    ): Promise<Readonly<PlatformTransportResult>> => {
      if (overrides.length) return result("transport_parameters_refused");
      let ioFailure: PlatformTransportCode | undefined;
      try {
        const started = Date.now(),
          monotonic = performance.now();
        let previous = started;
        const fresh = (): number => {
          const now = Date.now();
          if (
            !Number.isSafeInteger(now) ||
            now < previous ||
            now - started >= OBSERVATION_TIMEOUT_MS ||
            performance.now() - monotonic >= OBSERVATION_TIMEOUT_MS
          )
            return refuse("platform_observation_stale");
          previous = now;
          if (now < identity.approvedAtMs || now >= identity.expiresAtMs)
            return refuse("platform_approval_expired");
          return now;
        };
        const project = (
          variables: unknown,
          now: number,
          sourceName: unknown
        ) => ({
          projectId: identity.observer.projectId,
          environmentId: identity.observer.environmentId,
          serviceId: identity.observer.serviceId,
          sourceServiceId: identity.target.serviceId,
          sourceServiceName: sourceName,
          unrendered: true,
          observedAt: new Date(now).toISOString(),
          variables,
        });
        // Validate the unchanged reducer's manifest contract BEFORE any IO. This
        // hypothetical map is setup validation only, never observation evidence.
        const validSetup = reduceObserverReferences(
          references,
          project(
            {
              DATABASE_URL:
                "${{" + references.sourceServiceName + ".DATABASE_URL}}",
              REDIS_URL: "${{" + references.sourceServiceName + ".REDIS_URL}}",
            },
            fresh(),
            references.sourceServiceName
          ),
          previous
        );
        if (validSetup.code !== "reference_expressions_observed")
          return result("reference_evidence_refused");
        let sourceName: unknown;
        const identityObserver = createPlatformIdentityObserver(
          identity,
          async (approved: ApprovedPlatformRequest): Promise<unknown> => {
            fresh();
            if (
              approved.query !== SCOPE_QUERY &&
              approved.query !== IDENTITY_QUERY
            )
              return refuse("transport_parameters_refused");
            try {
              const envelope = await fixedRequest(
                driver,
                placeholder,
                approved.query,
                approved.variables,
                approved.signal
              );
              fresh();
              if (approved.query === IDENTITY_QUERY) {
                const root = fields(envelope, ["data"]);
                const data = fields(root.data, [
                  "deployment",
                  "service",
                  "environment",
                  "serviceInstance",
                ]);
                sourceName = fields(data.service, [
                  "id",
                  "name",
                  "projectId",
                ]).name;
              }
              return envelope;
            } catch (error: unknown) {
              ioFailure = failureCode(error);
              throw new Refusal(ioFailure);
            }
          }
        );
        const observed = await identityObserver.observe();
        if (!observed.platformIdentityObserved)
          return result(ioFailure ?? observed.status);
        fresh();
        const controller = new AbortController();
        try {
          const envelope = await fixedRequest(
            driver,
            placeholder,
            REFERENCES_QUERY,
            Object.freeze({
              projectId: identity.observer.projectId,
              environmentId: identity.observer.environmentId,
              serviceId: identity.observer.serviceId,
            }),
            controller.signal
          );
          const data = fields(fields(envelope, ["data"]).data, ["variables"]);
          // Pass the WHOLE observer map. Extra RAILWAY_* entries refuse; never filter.
          const reduced = reduceObserverReferences(
            references,
            project(data.variables, fresh(), sourceName),
            previous
          );
          fresh();
          return result(
            reduced.code === "reference_expressions_observed"
              ? "platform_references_observed"
              : "reference_evidence_refused"
          );
        } finally {
          controller.abort();
        }
      } catch (error: unknown) {
        return result(failureCode(error));
      }
    },
  });
}
