import { EventEmitter } from "node:events";
import { request as httpsRequest } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlatformTransport,
  type FixedRailwayHttpsRequest,
  type PrivateHttpsReceiver,
  type PlatformTransportCode,
  type PlatformTransportResult,
  type TrustedPlatformHttpsDriver,
} from "./platformTransport";
import type {
  PlatformIdentityManifest,
  PlatformIdentityTuple,
} from "./platformIdentity";
import type { AssuranceManifest } from "./assurance";

/** APPLICATION-BOUNDARY SYNTHETIC TESTS ONLY — NOT GATEWAY PROOF.
 * Fake header sentinel + injected IO or mocked node:https; no connector, credential,
 * environment, real TLS socket or Railway call. These do not establish replacement,
 * inbound host confidentiality, gateway destination confinement or token permissions.
 */
vi.mock("node:https", () => ({ request: vi.fn() }));
const TOKEN = "mtr_fake_SYNTHETIC_ONLY_DO_NOT_RELEASE";
const SECRET = "SYNTHETIC_RAW_REPLY_DO_NOT_RELEASE";
const NOW = Date.parse("2026-11-07T06:15:00Z");
const target: Readonly<PlatformIdentityTuple> = Object.freeze({
  projectId: "11111111-1111-4111-8111-111111111111",
  environmentId: "22222222-2222-4222-8222-222222222222",
  serviceId: "33333333-3333-4333-8333-333333333333",
  deploymentId: "44444444-4444-4444-8444-444444444444",
});
const observer: Readonly<PlatformIdentityTuple> = Object.freeze({
  projectId: target.projectId,
  environmentId: target.environmentId,
  serviceId: "55555555-5555-4555-8555-555555555555",
  deploymentId: "66666666-6666-4666-8666-666666666666",
});
const identityManifest = (
  changes: Partial<PlatformIdentityManifest> = {}
): Readonly<PlatformIdentityManifest> =>
  Object.freeze({
    target,
    observer,
    sourceRepo: "Example-Approved/observer-target",
    approvedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    ...changes,
  });
const referenceManifest = (
  changes: Partial<AssuranceManifest> = {}
): Readonly<AssuranceManifest> =>
  Object.freeze({
    projectId: target.projectId,
    environmentId: target.environmentId,
    targetServiceId: target.serviceId,
    targetDeploymentId: target.deploymentId,
    observerServiceId: observer.serviceId,
    sourceServiceName: "approved-app",
    sourceRepo: identityManifest().sourceRepo,
    expectedSha: "a".repeat(40),
    githubContext: "approved-project / isolation",
    maxSkewMs: 0,
    approvedAtMs: identityManifest().approvedAtMs,
    expiresAtMs: identityManifest().expiresAtMs,
    ...changes,
  });
const SCOPE = `query ObserverTokenScope {
  projectToken { projectId environmentId }
}`;
const IDENTITY = `query ObserverTargetIdentity(
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
}`;
const REFERENCES = `query ObserverStoredReferences(
  $projectId: String!, $environmentId: String!, $serviceId: String!
) {
  variables(projectId: $projectId, environmentId: $environmentId,
    serviceId: $serviceId, unrendered: true)
}`;
function scope(projectId = target.projectId): object {
  return {
    data: { projectToken: { projectId, environmentId: target.environmentId } },
  };
}
function identity(name = "approved-app"): object {
  const running = {
    id: target.deploymentId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    serviceId: target.serviceId,
    status: "SUCCESS",
    deploymentStopped: false,
  };
  return {
    data: {
      deployment: running,
      service: { id: target.serviceId, name, projectId: target.projectId },
      environment: {
        id: target.environmentId,
        projectId: target.projectId,
        name: "isolation",
      },
      serviceInstance: {
        id: "77777777-7777-4777-8777-777777777777",
        serviceId: target.serviceId,
        environmentId: target.environmentId,
        serviceName: name,
        source: { repo: identityManifest().sourceRepo, image: null },
        latestDeployment: { id: observer.deploymentId, status: "FAILED" },
        activeDeployments: [running],
      },
    },
  };
}
const variableMap = () => ({
  DATABASE_URL: "${{approved-app.DATABASE_URL}}",
  REDIS_URL: "${{approved-app.REDIS_URL}}",
});
const references = (variables: unknown = variableMap()) => ({
  data: { variables },
});
type Action = (receiver: Readonly<PrivateHttpsReceiver>) => void;
function reply(
  input: unknown,
  status: unknown = 200,
  contentType: unknown = "application/json",
  encoding?: unknown
): Action {
  return receiver => {
    receiver.headers(status, contentType, encoding, undefined);
    receiver.chunk(Buffer.from(JSON.stringify(input)));
    receiver.end();
  };
}
function raw(bytes: Buffer, length?: unknown): Action {
  return receiver => {
    receiver.headers(200, "application/json", undefined, length);
    receiver.chunk(bytes);
    receiver.end();
  };
}
function harness(
  actions: readonly Action[] = [
    reply(scope()),
    reply(identity()),
    reply(references()),
  ]
) {
  const cancel = vi.fn(() => undefined);
  const requests: Readonly<FixedRailwayHttpsRequest>[] = [];
  const driver: TrustedPlatformHttpsDriver = vi.fn((fixed, receiver) => {
    const index = requests.length;
    requests.push(fixed);
    actions[index]?.(receiver);
    return Object.freeze({ cancel });
  });
  const build = (
    ids: unknown = identityManifest(),
    refs: unknown = referenceManifest(),
    setup: unknown = Object.freeze({
      mode: "synthetic",
      tokenPlaceholder: TOKEN,
      driver,
    })
  ) => createPlatformTransport(ids, refs, setup);
  return { cancel, driver, requests, build };
}
function held(
  value: Readonly<PlatformTransportResult>,
  code: PlatformTransportCode
): void {
  expect(value).toEqual({
    code,
    production_hold: true,
    execution_authorized: false,
  });
  expect(Object.isFrozen(value)).toBe(true);
  const output = JSON.stringify(value);
  for (const privateText of [
    TOKEN,
    "mtr_fake_",
    SECRET,
    ...Object.values(target),
    ...Object.values(observer),
    "DATABASE_URL",
    "REDIS_URL",
    "approved-app",
    identityManifest().sourceRepo,
  ])
    expect(output).not.toContain(privateText);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(httpsRequest).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("when synthetic approved setup composes identity and observer references privately", () => {
  it("should emit a closed held code after exactly three pinned single POST reads", async () => {
    const h = harness(),
      pinned = h.build();
    expect(h.driver).not.toHaveBeenCalled();
    expect(Object.keys(pinned)).toEqual(["observe"]);
    held(await pinned.observe(), "platform_references_observed");
    expect(h.requests).toHaveLength(3);
    expect(h.cancel).toHaveBeenCalledTimes(3);
    const documents: string[] = [];
    for (const [index, fixed] of h.requests.entries()) {
      expect(Object.isFrozen(fixed)).toBe(true);
      expect(Object.isFrozen(fixed.headers)).toBe(true);
      expect(fixed).toMatchObject({
        protocol: "https:",
        hostname: "backboard.railway.com",
        port: 443,
        path: "/graphql/v2",
        method: "POST",
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        agent: false,
      });
      expect(fixed.headers).toEqual({
        "Project-Access-Token": TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "Content-Length": Buffer.byteLength(fixed.body),
      });
      const document = JSON.parse(fixed.body) as {
        query: string;
        variables: object;
      };
      expect(Object.keys(document)).toEqual(["query", "variables"]);
      documents.push(document.query);
      expect(document.variables).toEqual(
        index === 0
          ? {}
          : index === 1
            ? target
            : {
                projectId: observer.projectId,
                environmentId: observer.environmentId,
                serviceId: observer.serviceId,
              }
      );
      expect(document.query).not.toMatch(
        /\b(?:mutation|__schema|__type|variablesForServiceDeployment|rendered|logs)\b/
      );
    }
    expect(documents).toEqual([SCOPE, IDENTITY, REFERENCES]);
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("should reobserve without accepting cached assertions or mutation arguments", async () => {
    const h = harness([
      reply(scope()),
      reply(identity()),
      reply(references()),
      reply(scope()),
      reply(identity()),
      reply(references()),
    ]);
    const pinned = h.build();
    held(await pinned.observe(), "platform_references_observed");
    held(await pinned.observe(), "platform_references_observed");
    const invoke = pinned.observe as (
      ...args: unknown[]
    ) => Promise<Readonly<PlatformTransportResult>>;
    for (const input of [
      "mutation { variableCollectionUpsert { id } }",
      { query: "mutation { destroy }" },
      {
        url: "https://other.invalid",
        headers: { Authorization: TOKEN },
        serviceId: target.serviceId,
      },
      undefined,
    ])
      held(await invoke(input), "transport_parameters_refused");
    expect(h.driver).toHaveBeenCalledTimes(6);
  });
  it("should not log sentinel replies on success or refusal", async () => {
    const logs = ["log", "info", "warn", "error", "debug", "trace"] as const;
    const spies = logs.map(key =>
      vi.spyOn(console, key).mockImplementation(() => undefined)
    );
    held(await harness().build().observe(), "platform_references_observed");
    held(
      await harness([
        reply(scope()),
        reply(identity()),
        reply(references({ ...variableMap(), unknown: SECRET })),
      ])
        .build()
        .observe(),
      "reference_evidence_refused"
    );
    held(
      await harness([reply({ errors: [{ message: SECRET }] })])
        .build()
        .observe(),
      "transport_graphql_refused"
    );
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("when synthetic replies include unexpected authority or reference values", () => {
  it("should reject mismatched token scope before identity or reference reads", async () => {
    const h = harness([reply(scope(observer.serviceId))]);
    held(await h.build().observe(), "platform_scope_mismatch");
    expect(h.driver).toHaveBeenCalledTimes(1);
  });
  it("should bind the source service name to observed identity rather than approved assertions alone", async () => {
    const h = harness([
      reply(scope()),
      reply(identity("other-app")),
      reply(references()),
    ]);
    held(await h.build().observe(), "reference_evidence_refused");
    expect(h.driver).toHaveBeenCalledTimes(3);
  });
  it.each([
    { ...variableMap(), RAILWAY_PROJECT_ID: target.projectId },
    { ...variableMap(), RAILWAY_ENVIRONMENT_NAME: SECRET },
    { ...variableMap(), unknown: SECRET },
    { DATABASE_URL: "mysql://" + SECRET, REDIS_URL: variableMap().REDIS_URL },
    {
      DATABASE_URL: variableMap().DATABASE_URL,
      REDIS_URL: "redis://" + SECRET,
    },
    { DATABASE_URL: variableMap().DATABASE_URL },
    {
      ...variableMap(),
      DATABASE_URL: "${{approved-app.DATABASE_URL}}" + SECRET,
    },
    { ...variableMap(), REDIS_URL: "${{other-app.REDIS_URL}}" },
    null,
  ])(
    "should refuse the entire stored map without filtering any extra RAILWAY entries",
    async variables => {
      held(
        await harness([
          reply(scope()),
          reply(identity()),
          reply(references(variables)),
        ])
          .build()
          .observe(),
        "reference_evidence_refused"
      );
    }
  );
  it.each([
    { data: { variables: variableMap(), unknown: SECRET } },
    { data: null },
    { data: { variables: null }, extensions: SECRET },
  ])(
    "should refuse malformed reference envelopes privately",
    async envelope => {
      held(
        await harness([reply(scope()), reply(identity()), reply(envelope)])
          .build()
          .observe(),
        "transport_response_refused"
      );
    }
  );
});

describe("when synthetic HTTP errors or response framing are refused", () => {
  it.each([
    [401, "transport_http_unauthorized"],
    [403, "transport_http_forbidden"],
    [301, "transport_http_refused"],
    [302, "transport_http_refused"],
    [307, "transport_http_refused"],
    [308, "transport_http_refused"],
    [429, "transport_http_refused"],
    [500, "transport_http_refused"],
  ] as const)(
    "should return fixed status for HTTP %s without redirects or retries",
    async (status, code) => {
      const h = harness([
        reply(
          { diagnostic: SECRET, location: "https://other.invalid/" + TOKEN },
          status
        ),
      ]);
      held(await h.build().observe(), code);
      expect(h.driver).toHaveBeenCalledTimes(1);
      expect(h.cancel).toHaveBeenCalledTimes(1);
    }
  );
  it.each(["gzip", "br", "identity", "", null, ["identity"]])(
    "should reject every present content encoding",
    async encoding => {
      held(
        await harness([reply(scope(), 200, "application/json", encoding)])
          .build()
          .observe(),
        "transport_encoding_refused"
      );
    }
  );
  it.each([
    undefined,
    null,
    "text/html",
    "text/plain",
    "application/graphql-response+json",
    "application/json; charset=latin1",
    "application/json\n",
    "application/json\r\n",
    SECRET,
  ])(
    "should reject non JSON content type without exposing its text",
    async type => {
      const action: Action = r => {
        r.headers(200, type, undefined, undefined);
        r.chunk(Buffer.from(SECRET));
        r.end();
      };
      held(
        await harness([action]).build().observe(),
        "transport_content_type_refused"
      );
    }
  );
  it("should accept the pinned UTF8 JSON media type", async () => {
    held(
      await harness([
        reply(scope(), 200, "application/json; charset=utf-8"),
        reply(identity()),
        reply(references()),
      ])
        .build()
        .observe(),
      "platform_references_observed"
    );
  });
  it.each([
    "",
    SECRET,
    "{",
    "null",
    "[]",
    '{"data":null,"diagnostic":"' + SECRET + '"}',
  ])(
    "should reject malformed or nonenvelope JSON without a raw parse error",
    async text => {
      held(
        await harness([raw(Buffer.from(text))])
          .build()
          .observe(),
        "transport_response_refused"
      );
    }
  );
  it("should reject invalid UTF8 before JSON parsing", async () => {
    held(
      await harness([raw(Buffer.from([0xff, 0xfe]))])
        .build()
        .observe(),
      "transport_response_refused"
    );
  });
  it.each([null, [], [{ message: SECRET }], SECRET])(
    "should reject any GraphQL errors key without inspecting its contents",
    async errors => {
      held(
        await harness([reply({ ...scope(), errors })])
          .build()
          .observe(),
        "transport_graphql_refused"
      );
    }
  );
  it("should refuse both declared and chunked oversize before JSON.parse", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const declared: Action = r =>
      r.headers(200, "application/json", undefined, "65537");
    const streamed: Action = r => {
      r.headers(200, "application/json", undefined, undefined);
      r.chunk(Buffer.alloc(32_768, 32));
      r.chunk(Buffer.alloc(32_769, 32));
      r.end();
    };
    for (const action of [declared, streamed, raw(Buffer.alloc(65_537, 32))])
      held(
        await harness([action]).build().observe(),
        "transport_response_oversize"
      );
    expect(parse).not.toHaveBeenCalled();
  });
  it.each(["byteLength", "length", "buffer", "byteOffset"])(
    "should bound native bytes despite own data %s without copying or parsing",
    async key => {
      const prefix = Buffer.from(JSON.stringify(scope()));
      const bytes = Buffer.concat([prefix, Buffer.alloc(70_000, 120)]);
      Object.defineProperty(bytes, key, {
        value: key === "buffer" ? prefix.buffer : prefix.byteLength,
      });
      const copy = vi.spyOn(Buffer, "from");
      const allocate = vi.spyOn(Buffer, "allocUnsafe");
      const concat = vi.spyOn(Buffer, "concat");
      const parse = vi.spyOn(JSON, "parse");
      const h = harness([raw(bytes)]);
      held(await h.build().observe(), "transport_response_oversize");
      expect(copy).not.toHaveBeenCalled();
      expect(allocate).not.toHaveBeenCalled();
      expect(concat).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      expect(h.driver).toHaveBeenCalledTimes(1);
      expect(h.cancel).toHaveBeenCalledTimes(1);
      expect(httpsRequest).not.toHaveBeenCalled();
    }
  );
  it.each(["byteLength", "length", "buffer", "byteOffset"])(
    "should refuse the oversized valid-prefix payload without invoking own %s getter",
    async key => {
      const prefix = Buffer.from(JSON.stringify(scope()));
      const bytes = Buffer.concat([prefix, Buffer.alloc(70_000, 120)]);
      expect(bytes.byteLength).toBe(70_133);
      expect(Object.getPrototypeOf(bytes)).toBe(Buffer.prototype);
      const read = vi.fn(() =>
        key === "buffer" ? prefix.buffer : prefix.byteLength
      );
      Object.defineProperty(bytes, key, { get: read });
      const copy = vi.spyOn(Buffer, "from");
      const allocate = vi.spyOn(Buffer, "allocUnsafe");
      const concat = vi.spyOn(Buffer, "concat");
      const parse = vi.spyOn(JSON, "parse");
      const h = harness([raw(bytes), reply(identity()), reply(references())]);
      held(await h.build().observe(), "transport_response_oversize");
      expect(read).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(allocate).not.toHaveBeenCalled();
      expect(concat).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      expect(h.driver).toHaveBeenCalledTimes(1);
      expect(h.cancel).toHaveBeenCalledTimes(1);
      expect(httpsRequest).not.toHaveBeenCalled();
    }
  );
  it("should account native bytes across chunks before copying an over-budget shadowed view", async () => {
    const first = Buffer.alloc(32_768, 32);
    const second = Buffer.from(JSON.stringify(scope()).padEnd(32_769, "x"));
    const read = vi.fn(() => 1);
    for (const bytes of [first, second])
      Object.defineProperty(bytes, "byteLength", { get: read });
    const allocate = vi.spyOn(Buffer, "allocUnsafe");
    const concat = vi.spyOn(Buffer, "concat");
    const parse = vi.spyOn(JSON, "parse");
    const h = harness([
      r => {
        r.headers(200, "application/json", undefined, undefined);
        r.chunk(first);
        r.chunk(second);
        r.end();
      },
    ]);
    held(await h.build().observe(), "transport_response_oversize");
    expect(read).not.toHaveBeenCalled();
    expect(allocate.mock.calls).toEqual([[32_768]]);
    expect(concat).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(h.driver).toHaveBeenCalledTimes(1);
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["data", "getter"])(
    "should copy the actual nonzero-offset view while ignoring own %s metadata and copy hooks",
    async kind => {
      const prefix = Buffer.from(JSON.stringify(scope()));
      const backing = Buffer.alloc(prefix.byteLength + 32, 120);
      backing.set(prefix, 16);
      const bytes = backing.subarray(16, 16 + prefix.byteLength);
      const read = vi.fn(() => {
        throw new Error(SECRET);
      });
      for (const key of [
        "byteLength",
        "length",
        "buffer",
        "byteOffset",
        "offset",
        "parent",
        "copy",
        "slice",
        "subarray",
        "set",
        "constructor",
        "valueOf",
        Symbol.iterator,
        Symbol.toPrimitive,
      ])
        Object.defineProperty(
          bytes,
          key,
          kind === "getter" ? { get: read } : { value: read }
        );
      const copy = vi.spyOn(Buffer, "from");
      held(
        await harness([raw(bytes), reply(identity()), reply(references())])
          .build()
          .observe(),
        "platform_references_observed"
      );
      expect(read).not.toHaveBeenCalled();
      expect(copy.mock.calls.some(args => args[0] === bytes)).toBe(false);
      expect(
        backing.equals(
          Buffer.concat([Buffer.alloc(16, 120), prefix, Buffer.alloc(16, 120)])
        )
      ).toBe(true);
      expect(httpsRequest).not.toHaveBeenCalled();
    }
  );
  it("should accept exactly 65536 raw bytes without increasing the fixed bound", async () => {
    const bytes = Buffer.from(JSON.stringify(scope()).padEnd(65_536, " "));
    held(
      await harness([
        raw(bytes, "65536"),
        reply(identity()),
        reply(references()),
      ])
        .build()
        .observe(),
      "platform_references_observed"
    );
  });
  it.each(["-1", "1.5", "01", "5\n", "5\r\n", SECRET, null])(
    "should refuse malformed length framing",
    async length => {
      held(
        await harness([raw(Buffer.from(JSON.stringify(scope())), length)])
          .build()
          .observe(),
        "transport_response_refused"
      );
    }
  );
  it("should refuse content length mismatch, duplicate headers and body before headers", async () => {
    const actions: Action[] = [
      raw(Buffer.from(JSON.stringify(scope())), "1"),
      r => {
        r.headers(200, "application/json", undefined, undefined);
        r.headers(200, "application/json", undefined, undefined);
      },
      r => {
        r.chunk(Buffer.from(SECRET));
        r.end();
      },
      r => r.end(),
      r => {
        r.headers(200, "application/json", undefined, undefined);
        r.chunk(SECRET);
      },
    ];
    for (const action of actions)
      held(
        await harness([action]).build().observe(),
        "transport_response_refused"
      );
  });
  it("should sanitize a thrown error sentinel without invoking message getters or retrying", async () => {
    const read = vi.fn(() => SECRET);
    const thrown = Object.defineProperty({}, "message", { get: read });
    const h = harness([
      () => {
        throw thrown;
      },
    ]);
    held(await h.build().observe(), "transport_request_failed");
    expect(read).not.toHaveBeenCalled();
    expect(h.driver).toHaveBeenCalledTimes(1);
  });
  it("should reduce injected IO failures to a fixed code", async () => {
    held(
      await harness([r => r.error()])
        .build()
        .observe(),
      "transport_request_failed"
    );
  });
  it("should refuse socket inactivity and hostile thrown proxies without traps or raw diagnostics", async () => {
    held(
      await harness([r => r.timeout()])
        .build()
        .observe(),
      "transport_request_timeout"
    );
    const read = vi.fn(() => {
      throw new Error(SECRET);
    });
    const proxy = new Proxy({}, { get: read, getPrototypeOf: read });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const error of [proxy, revoked.proxy, TOKEN, SECRET])
      held(
        await harness([
          () => {
            throw error;
          },
        ])
          .build()
          .observe(),
        "transport_request_failed"
      );
    expect(read).not.toHaveBeenCalled();
  });
});

describe("when application deadlines or approval windows expire", () => {
  it("should time out once and never promote matching late results or late errors", async () => {
    let late: Readonly<PrivateHttpsReceiver> | undefined;
    const h = harness([
        r => {
          late = r;
        },
      ]),
      pinned = h.build();
    const pending = pinned.observe();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const value = await pending;
    held(value, "transport_request_timeout");
    if (!late) throw new Error("synthetic_receiver_missing");
    reply(scope())(late);
    late.error();
    late.end();
    await vi.advanceTimersByTimeAsync(10_000);
    held(value, "transport_request_timeout");
    expect(h.driver).toHaveBeenCalledTimes(1);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("should time out on reference reads without retrying or retaining raw replies", async () => {
    const h = harness([reply(scope()), reply(identity()), () => undefined]);
    const pending = h.build().observe();
    await vi.advanceTimersByTimeAsync(3_000);
    held(await pending, "transport_request_timeout");
    expect(h.driver).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("should detect event loop delay even before its timer runs", async () => {
    const h = harness([
      r => {
        vi.setSystemTime(NOW + 3_000);
        reply(scope())(r);
      },
    ]);
    held(await h.build().observe(), "transport_request_timeout");
    expect(h.driver).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("should reject expired approval before IO and after a successful identity read", async () => {
    const h = harness(),
      pinned = h.build();
    vi.setSystemTime(NOW + 60_000);
    held(await pinned.observe(), "platform_approval_expired");
    expect(h.driver).not.toHaveBeenCalled();
    vi.setSystemTime(NOW);
    const expires = NOW + 500;
    const late = harness([
      reply(scope()),
      r => {
        vi.setSystemTime(expires);
        reply(identity())(r);
      },
    ]);
    held(
      await late
        .build(
          identityManifest({ expiresAtMs: expires }),
          referenceManifest({ expiresAtMs: expires })
        )
        .observe(),
      "platform_approval_expired"
    );
    expect(late.driver).toHaveBeenCalledTimes(2);
  });
  it("should reject backward clocks conservatively", async () => {
    held(
      await harness([
        r => {
          vi.setSystemTime(NOW - 1);
          reply(scope())(r);
        },
      ])
        .build()
        .observe(),
      "transport_request_timeout"
    );
  });
});

describe("when trusted factory inputs are malformed or contain overrides", () => {
  it.each([
    "actual-looking-token",
    "Bearer synthetic",
    "",
    "mtr_fake_short",
    TOKEN + "\n",
    TOKEN + "\r\nInjected: value",
  ])(
    "should require the placeholder format and return no marker in setup errors",
    placeholder => {
      const h = harness();
      expect(() =>
        h.build(
          undefined,
          undefined,
          Object.freeze({
            mode: "synthetic",
            tokenPlaceholder: placeholder,
            driver: h.driver,
          })
        )
      ).toThrow("platform_transport_setup_refused");
      expect(h.driver).not.toHaveBeenCalled();
    }
  );
  it("should refuse unknown setup keys, raw tokens, query overrides, drivers and accessors", () => {
    const h = harness(),
      read = vi.fn(() => TOKEN);
    const setups: unknown[] = [
      { mode: "synthetic", tokenPlaceholder: TOKEN, driver: h.driver },
      Object.freeze({
        mode: "synthetic",
        tokenPlaceholder: TOKEN,
        driver: h.driver,
        query: "mutation { destroy }",
      }),
      Object.freeze({
        mode: "synthetic",
        tokenPlaceholder: TOKEN,
        driver: h.driver,
        url: "https://other.invalid",
      }),
      Object.freeze({
        mode: "synthetic",
        tokenPlaceholder: TOKEN,
        driver: new Proxy(h.driver, { apply: read }),
      }),
      Object.freeze({
        mode: "synthetic",
        tokenPlaceholder: TOKEN,
        driver: null,
      }),
      Object.freeze(
        Object.defineProperty(
          { mode: "synthetic", driver: h.driver },
          "tokenPlaceholder",
          { get: read, enumerable: true }
        )
      ),
      new Proxy({}, { ownKeys: read }),
      null,
    ];
    for (const setup of setups)
      expect(() =>
        h.build(identityManifest(), referenceManifest(), setup)
      ).toThrow("platform_transport_setup_refused");
    expect(read).not.toHaveBeenCalled();
    expect(h.driver).not.toHaveBeenCalled();
  });
  it("should bind immutable reference setup to identity without selector substitutions", () => {
    const h = harness();
    for (const refs of [
      referenceManifest({ projectId: observer.serviceId }),
      referenceManifest({ observerServiceId: target.serviceId }),
      referenceManifest({ sourceRepo: "Other/repo" }),
      referenceManifest({ expiresAtMs: NOW + 30_000 }),
      Object.freeze({ ...referenceManifest(), mutation: SECRET }),
      { ...referenceManifest() },
    ])
      expect(() => h.build(identityManifest(), refs)).toThrow(
        "platform_transport_setup_refused"
      );
    expect(() =>
      h.build(
        identityManifest({
          observer: Object.freeze({
            ...observer,
            environmentId: observer.serviceId,
          }),
        })
      )
    ).toThrow("platform_transport_setup_refused");
    expect(h.driver).not.toHaveBeenCalled();
  });
  it("should validate reference reducer setup before issuing requests", async () => {
    const h = harness();
    held(
      await h
        .build(
          identityManifest(),
          referenceManifest({ sourceServiceName: "other\napp" })
        )
        .observe(),
      "reference_evidence_refused"
    );
    expect(h.driver).not.toHaveBeenCalled();
  });
  it("should construct trusted Node mode passively with no CLI activation or import side effects", () => {
    const pinned = createPlatformTransport(
      identityManifest(),
      referenceManifest(),
      Object.freeze({ mode: "trusted_node_https", tokenPlaceholder: TOKEN })
    );
    expect(Object.keys(pinned)).toEqual(["observe"]);
    expect(httpsRequest).not.toHaveBeenCalled();
  });
});

describe("when the Node HTTPS adapter is exercised through a mocked socket only", () => {
  it("should preserve fixed TLS options and custom header without a real network call", async () => {
    const sockets: EventEmitter[] = [],
      destroyed = vi.fn(() => undefined),
      timeout = vi.fn((_ms: number, _callback: () => void) => undefined);
    const envelopes = [scope(), identity(), references()];
    vi.mocked(httpsRequest).mockImplementation((...args: unknown[]) => {
      const options = args[0];
      const callback = args[1] as
        | ((incoming: import("node:http").IncomingMessage) => void)
        | undefined;
      const index = sockets.length;
      expect(options).toMatchObject({
        hostname: "backboard.railway.com",
        port: 443,
        path: "/graphql/v2",
        method: "POST",
        agent: false,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        headers: { "Project-Access-Token": TOKEN },
      });
      const incoming = Object.assign(new EventEmitter(), {
        statusCode: 200,
        complete: true,
        headersDistinct: { "content-type": ["application/json"] },
        destroy: destroyed,
      });
      const socket = Object.assign(new EventEmitter(), {
        destroy: destroyed,
        setTimeout: timeout,
        end: (_body: string) => {
          callback?.(
            incoming as unknown as import("node:http").IncomingMessage
          );
          incoming.emit("data", Buffer.from(JSON.stringify(envelopes[index])));
          incoming.emit("end");
        },
      });
      sockets.push(socket);
      return socket as unknown as import("node:http").ClientRequest;
    });
    const pinned = createPlatformTransport(
      identityManifest(),
      referenceManifest(),
      Object.freeze({ mode: "trusted_node_https", tokenPlaceholder: TOKEN })
    );
    held(await pinned.observe(), "platform_references_observed");
    expect(httpsRequest).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenCalledTimes(3);
    for (const [ms] of timeout.mock.calls) expect(ms).toBe(3_000);
    expect(destroyed).toHaveBeenCalledTimes(6);
  });
});
