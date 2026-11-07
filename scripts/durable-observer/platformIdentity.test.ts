import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlatformIdentityObserver,
  inspectPlatformIdentity,
  type ApprovedPlatformRequest,
  type PlatformIdentityManifest,
  type PlatformIdentityResult,
  type PlatformIdentityStatus,
  type PlatformIdentityTuple,
} from "./platformIdentity";

/** Offline contract excerpt: Railway CLI immutable schema
 * 4a13c465c18097b362cbfbd632f016424d764de2, as verified in
 * Railway_Identity_Contract_Assessment.md. Not live introspection or permission
 * evidence. These independently pinned documents and fixture types exercise the
 * actual module queries/parser; ONLY the authenticated request transport is fake.
 */
const SCOPE_DOCUMENT = `query ObserverTokenScope {
  projectToken { projectId environmentId }
}`;
const IDENTITY_DOCUMENT = `query ObserverTargetIdentity(
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
interface SnapshotDeployment {
  id: string; // ID!
  projectId: string; // String!
  environmentId: string; // String!
  serviceId: string | null; // String
  status: string; // DeploymentStatus!
  deploymentStopped: boolean; // Boolean!
}
interface SnapshotIdentityEnvelope {
  data: {
    deployment: SnapshotDeployment;
    service: { id: string; name: string; projectId: string };
    environment: { id: string; projectId: string; name: string };
    serviceInstance: {
      id: string;
      serviceId: string;
      environmentId: string;
      serviceName: string;
      source: { repo: string | null; image: string | null } | null;
      latestDeployment: { id: string; status: string } | null;
      activeDeployments: SnapshotDeployment[]; // [Deployment!]!
    };
  };
}
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
const SENTINEL = "PRIVATE_SYNTHETIC_DIAGNOSTIC_DO_NOT_RELEASE";
function manifest(
  change: Partial<PlatformIdentityManifest> = {}
): Readonly<PlatformIdentityManifest> {
  return Object.freeze({
    target,
    observer,
    sourceRepo: "Example-Approved/observer-target",
    approvedAtMs: 10_000,
    expiresAtMs: 910_000,
    ...change,
  });
}
function running(change: Partial<SnapshotDeployment> = {}): SnapshotDeployment {
  return {
    id: target.deploymentId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    serviceId: target.serviceId,
    status: "SUCCESS",
    deploymentStopped: false,
    ...change,
  };
}
function scope(): unknown {
  return {
    data: {
      projectToken: {
        projectId: target.projectId,
        environmentId: target.environmentId,
      },
    },
  };
}
function identity(): SnapshotIdentityEnvelope {
  return {
    data: {
      deployment: running(),
      service: {
        id: target.serviceId,
        name: "approved-app",
        projectId: target.projectId,
      },
      environment: {
        id: target.environmentId,
        projectId: target.projectId,
        name: "approved-isolation",
      },
      serviceInstance: {
        id: "77777777-7777-4777-8777-777777777777",
        serviceId: target.serviceId,
        environmentId: target.environmentId,
        serviceName: "approved-app",
        source: { repo: manifest().sourceRepo, image: null },
        latestDeployment: { id: target.deploymentId, status: "SUCCESS" },
        activeDeployments: [running()],
      },
    },
  };
}
function transport(...responses: readonly unknown[]) {
  const scopeResponse: unknown = responses.length > 0 ? responses[0] : scope();
  const identityResponse: unknown =
    responses.length > 1 ? responses[1] : identity();
  return vi.fn((request: ApprovedPlatformRequest): Promise<unknown> => {
    expect([SCOPE_DOCUMENT, IDENTITY_DOCUMENT]).toContain(request.query);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.variables)).toBe(true);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal.aborted).toBe(false);
    if (request.query === SCOPE_DOCUMENT) {
      expect(request.variables).toEqual({});
      return Promise.resolve(scopeResponse);
    }
    expect(request.query).toBe(IDENTITY_DOCUMENT);
    expect(request.variables).toEqual(target);
    return Promise.resolve(identityResponse);
  });
}
function assertHeld(
  value: PlatformIdentityResult,
  status: PlatformIdentityStatus
): void {
  expect(value).toEqual({
    status,
    platformIdentityObserved: status === "platform_identity_observed",
    hold: true,
    liveEnabled: false,
    blockers: ["deployed_commit_unverified", "reference_source_unverified"],
  });
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.blockers)).toBe(true);
  expect(JSON.stringify(value)).not.toContain(SENTINEL);
  expect(JSON.stringify(value)).not.toContain(target.serviceId);
}
function added(value: object, key: PropertyKey, enumerable = true): object {
  return Object.defineProperty(value, key, { value: SENTINEL, enumerable });
}
function getter(value: object, key: string, read: () => unknown): object {
  return Object.defineProperty(value, key, { enumerable: true, get: read });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(20_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("when a trusted request capability observes the approved platform target", () => {
  it("should issue exactly the two schema-pinned queries and retain every unresolved blocker", async () => {
    const request = transport();
    assertHeld(
      await inspectPlatformIdentity(manifest(), request),
      "platform_identity_observed"
    );
    expect(request.mock.calls.map(([value]) => value.query)).toEqual([
      SCOPE_DOCUMENT,
      IDENTITY_DOCUMENT,
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [value] of request.mock.calls) {
      expect(value.query).not.toMatch(
        /\b(?:meta|variables|references|logs|mutation|me|workspaces|projects|deployments)\b/
      );
      expect(value.signal.aborted).toBe(true);
    }
  });
  it("should re-observe rather than cache a prior success or allow observation overrides", async () => {
    const request = transport();
    const pinned = createPlatformIdentityObserver(manifest(), request);
    assertHeld(await pinned.observe(), "platform_identity_observed");
    assertHeld(await pinned.observe(), "platform_identity_observed");
    expect(request).toHaveBeenCalledTimes(4);
    const invoke = pinned.observe as (
      ...inputs: unknown[]
    ) => Promise<PlatformIdentityResult>;
    assertHeld(
      await invoke({ target: observer, facts: identity() }),
      "platform_parameters_refused"
    );
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("should not substitute latestDeployment for the single active running deployment", async () => {
    const response = identity();
    response.data.serviceInstance.latestDeployment = {
      id: observer.deploymentId,
      status: "FAILED",
    };
    assertHeld(
      await inspectPlatformIdentity(manifest(), transport(scope(), response)),
      "platform_identity_observed"
    );
  });
  it("should capture the trusted capability and manifest before the first await", async () => {
    let approved: unknown = manifest();
    let request = transport();
    const original = request;
    const pending = inspectPlatformIdentity(approved, request);
    approved = manifest({ target: observer });
    request = transport(undefined, { callerFacts: true });
    assertHeld(await pending, "platform_identity_observed");
    expect(original).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
    expect(Object.isFrozen(approved)).toBe(true);
  });
});

describe("when the manifest or injection is not the exact immutable approved shape", () => {
  it.each([
    undefined,
    null,
    [],
    {},
    { ...manifest() },
    manifest({ target: { ...target } }),
    manifest({ observer: { ...observer } }),
    manifest({ observer: target }),
    manifest({
      observer: Object.freeze({ ...observer, serviceId: target.serviceId }),
    }),
    manifest({
      observer: Object.freeze({
        ...observer,
        deploymentId: target.deploymentId,
      }),
    }),
    manifest({ target: Object.freeze({ ...target, projectId: "not-uuid" }) }),
    manifest({
      target: Object.freeze({
        ...target,
        serviceId: "00000000-0000-0000-0000-000000000000",
      }),
    }),
    manifest({
      target: Object.freeze({
        ...target,
        environmentId: target.environmentId.toUpperCase() + " ",
      }),
    }),
    manifest({
      sourceRepo: "https://github.com/Example-Approved/observer-target",
    }),
    manifest({ sourceRepo: "Example-Approved/observer-target.git" }),
    manifest({ sourceRepo: "Example-Approved/observer-target@main" }),
    manifest({ sourceRepo: "Example/../target" }),
    manifest({ sourceRepo: "Example/target?token=synthetic" }),
    manifest({ approvedAtMs: -0 }),
    manifest({ approvedAtMs: NaN }),
    manifest({ approvedAtMs: 1.5 }),
    manifest({ expiresAtMs: Infinity }),
    manifest({ expiresAtMs: 10_000 }),
    manifest({ expiresAtMs: 910_001 }),
  ])(
    "should refuse malformed or mutable setup without invoking the transport",
    value => {
      const request = transport();
      expect(() => createPlatformIdentityObserver(value, request)).toThrow(
        "platform_manifest_refused"
      );
      expect(request).not.toHaveBeenCalled();
    }
  );
  it.each(["credentials", Symbol("extra"), "hidden"])(
    "should refuse reflected extra approval keys %s",
    key => {
      const value = Object.freeze(
        added({ ...manifest() }, key, key !== "hidden")
      );
      expect(() => createPlatformIdentityObserver(value, transport())).toThrow(
        "platform_manifest_refused"
      );
    }
  );
  it("should never execute manifest getters, proxy traps or inherited fields", () => {
    const read = vi.fn(() => target);
    const trapped = new Proxy(manifest(), {
      ownKeys: () => {
        read();
        return [];
      },
    });
    const accessed = Object.freeze(getter({ ...manifest() }, "target", read));
    const inherited: unknown = Object.freeze(
      Object.assign(Object.create({ token: SENTINEL }) as object, manifest())
    );
    for (const value of [
      trapped,
      accessed,
      inherited,
      manifest({ target: trapped as unknown as PlatformIdentityTuple }),
    ])
      expect(() => createPlatformIdentityObserver(value, transport())).toThrow(
        "platform_manifest_refused"
      );
    expect(read).not.toHaveBeenCalled();
  });
  it("should refuse a nonfunction or proxy request without touching it", () => {
    const trap = vi.fn(() => undefined);
    const callable = new Proxy(transport(), { apply: trap });
    expect(() => createPlatformIdentityObserver(manifest(), callable)).toThrow(
      "platform_capability_refused"
    );
    expect(() =>
      createPlatformIdentityObserver(
        manifest(),
        null as unknown as typeof callable
      )
    ).toThrow("platform_capability_refused");
    expect(trap).not.toHaveBeenCalled();
  });
});

describe("when authenticated scope does not match the independently approved project and environment", () => {
  it.each([
    { projectId: observer.serviceId, environmentId: target.environmentId },
    { projectId: target.projectId, environmentId: observer.serviceId },
  ])(
    "should fail closed before querying a target outside token scope",
    projectToken => {
      const request = transport({ data: { projectToken } });
      return inspectPlatformIdentity(manifest(), request).then(value => {
        assertHeld(value, "platform_scope_mismatch");
        expect(request).toHaveBeenCalledTimes(1);
      });
    }
  );
  it.each([
    null,
    undefined,
    [],
    { callerFacts: true },
    { data: null },
    { data: { projectToken: null } },
    {
      data: {
        projectToken: { projectId: target.projectId, environmentId: null },
      },
    },
    {
      data: {
        projectToken: { projectId: 12, environmentId: target.environmentId },
      },
    },
    { data: { projectToken: { projectId: target.projectId } } },
    {
      data: {
        projectToken: {
          projectId: target.projectId,
          environmentId: target.environmentId,
          token: SENTINEL,
        },
      },
    },
    {
      data: {
        projectToken: {
          projectId: target.projectId,
          environmentId: target.environmentId,
        },
      },
      extensions: { diagnostic: SENTINEL },
    },
  ])(
    "should reject malformed scope envelopes without releasing the second query",
    async response => {
      const request = transport(response);
      assertHeld(
        await inspectPlatformIdentity(manifest(), request),
        "platform_response_refused"
      );
      expect(request).toHaveBeenCalledTimes(1);
    }
  );
});

describe("when a transport or GraphQL error includes untrusted diagnostics", () => {
  it.each([null, [], [{ message: SENTINEL }], SENTINEL])(
    "should reject any errors key without returning its contents",
    async errors => {
      const request = transport({ data: { projectToken: null }, errors });
      assertHeld(
        await inspectPlatformIdentity(manifest(), request),
        "platform_request_failed"
      );
      expect(request).toHaveBeenCalledTimes(1);
    }
  );
  it("should classify a synchronous throw and late rejection without reading the error", async () => {
    const read = vi.fn(() => SENTINEL);
    const error = getter({}, "message", read);
    const sync = vi.fn(
      (_request: ApprovedPlatformRequest): Promise<unknown> => {
        throw error;
      }
    );
    assertHeld(
      await inspectPlatformIdentity(manifest(), sync),
      "platform_request_failed"
    );
    const asyncRequest = vi.fn(
      (_request: ApprovedPlatformRequest): Promise<unknown> =>
        Promise.reject(error)
    );
    assertHeld(
      await inspectPlatformIdentity(manifest(), asyncRequest),
      "platform_request_failed"
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("should sanitize second-query GraphQL errors and never retry", async () => {
    const request = transport(scope(), {
      data: identity().data,
      errors: [{ message: SENTINEL }],
    });
    assertHeld(
      await inspectPlatformIdentity(manifest(), request),
      "platform_request_failed"
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("when deployment ownership, activity or configured source differs", () => {
  it.each([
    { id: observer.deploymentId },
    { projectId: observer.serviceId },
    { environmentId: observer.serviceId },
    { serviceId: observer.serviceId },
    { status: "FAILED" },
    { status: "BUILDING" },
    { deploymentStopped: true },
  ])(
    "should refuse each changed owning field or non-running deployment in both selections",
    async change => {
      for (const selection of ["deployment", "active"] as const) {
        const response = identity();
        if (selection === "deployment")
          response.data.deployment = running(change);
        else
          response.data.serviceInstance.activeDeployments = [running(change)];
        assertHeld(
          await inspectPlatformIdentity(
            manifest(),
            transport(scope(), response)
          ),
          "platform_identity_mismatch"
        );
      }
    }
  );
  it.each([
    { serviceId: null },
    { serviceId: "not-uuid" },
    { status: null },
    { status: 1 },
    { deploymentStopped: "false" },
    { deploymentStopped: null },
  ])(
    "should refuse nullable or type-mismatched deployment fields",
    async change => {
      const response = identity();
      const deployment: unknown = { ...running(), ...change };
      assertHeld(
        await inspectPlatformIdentity(
          manifest(),
          transport(scope(), { data: { ...response.data, deployment } })
        ),
        "platform_response_refused"
      );
    }
  );
  it.each([
    { repo: "Example-Approved/other-repository", image: null },
    { repo: "example-approved/observer-target", image: null },
    { repo: manifest().sourceRepo, image: "registry.invalid/image" },
    { repo: manifest().sourceRepo, image: "" },
  ])(
    "should reject different source repositories and every present image",
    async source => {
      const response = identity();
      response.data.serviceInstance.source = source;
      assertHeld(
        await inspectPlatformIdentity(manifest(), transport(scope(), response)),
        "platform_identity_mismatch"
      );
    }
  );
  it.each([
    null,
    { repo: null, image: null },
    { repo: 12, image: null },
    { repo: manifest().sourceRepo, image: {} },
  ])("should reject missing or invalid source information", async source => {
    const response = identity();
    const serviceInstance = { ...response.data.serviceInstance, source };
    assertHeld(
      await inspectPlatformIdentity(
        manifest(),
        transport(scope(), { data: { ...response.data, serviceInstance } })
      ),
      "platform_response_refused"
    );
  });
  it("should reject zero active deployments and never select the first of multiple active deployments", async () => {
    for (const active of [
      [],
      [running(), running({ id: observer.deploymentId })],
      [running(), running()],
    ]) {
      const response = identity();
      response.data.serviceInstance.activeDeployments = active;
      assertHeld(
        await inspectPlatformIdentity(manifest(), transport(scope(), response)),
        active.length === 0
          ? "platform_identity_mismatch"
          : "platform_active_deployments_ambiguous"
      );
    }
  });
  it("should reject substitution of the observer for the app even when all returned records agree", async () => {
    const response = identity();
    response.data.deployment = running({
      id: observer.deploymentId,
      serviceId: observer.serviceId,
    });
    response.data.service.id = observer.serviceId;
    response.data.serviceInstance.serviceId = observer.serviceId;
    response.data.serviceInstance.activeDeployments = [
      response.data.deployment,
    ];
    assertHeld(
      await inspectPlatformIdentity(manifest(), transport(scope(), response)),
      "platform_identity_mismatch"
    );
  });
  it.each([
    (response: SnapshotIdentityEnvelope) => {
      response.data.service.id = observer.serviceId;
    },
    (response: SnapshotIdentityEnvelope) => {
      response.data.service.projectId = observer.serviceId;
    },
    (response: SnapshotIdentityEnvelope) => {
      response.data.environment.id = observer.serviceId;
    },
    (response: SnapshotIdentityEnvelope) => {
      response.data.environment.projectId = observer.serviceId;
    },
    (response: SnapshotIdentityEnvelope) => {
      response.data.serviceInstance.serviceId = observer.serviceId;
    },
    (response: SnapshotIdentityEnvelope) => {
      response.data.serviceInstance.environmentId = observer.serviceId;
    },
    (response: SnapshotIdentityEnvelope) => {
      response.data.serviceInstance.serviceName = "other-app";
    },
  ])(
    "should cross-check every service, environment and instance identity",
    async change => {
      const response = identity();
      change(response);
      assertHeld(
        await inspectPlatformIdentity(manifest(), transport(scope(), response)),
        "platform_identity_mismatch"
      );
    }
  );
});

describe("when response projections contain reflected extras, nulls or executable properties", () => {
  const locations = [
    "root",
    "data",
    "deployment",
    "service",
    "environment",
    "instance",
    "source",
    "latest",
    "active",
  ] as const;
  function at(
    response: SnapshotIdentityEnvelope,
    location: (typeof locations)[number]
  ): object {
    const instance = response.data.serviceInstance;
    switch (location) {
      case "root":
        return response;
      case "data":
        return response.data;
      case "deployment":
        return response.data.deployment;
      case "service":
        return response.data.service;
      case "environment":
        return response.data.environment;
      case "instance":
        return instance;
      case "source":
        return instance.source!;
      case "latest":
        return instance.latestDeployment!;
      case "active":
        return instance.activeDeployments[0];
    }
  }
  it.each(locations)(
    "should refuse all extra keys at projected location %s",
    async location => {
      for (const key of ["meta", Symbol("extra"), "nonenumerable"]) {
        const response = identity();
        added(at(response, location), key, key !== "nonenumerable");
        assertHeld(
          await inspectPlatformIdentity(
            manifest(),
            transport(scope(), response)
          ),
          "platform_response_refused"
        );
      }
    }
  );
  it.each(["deployment", "service", "environment", "serviceInstance"] as const)(
    "should reject a null mandatory projected object %s",
    async key => {
      const response = identity();
      assertHeld(
        await inspectPlatformIdentity(
          manifest(),
          transport(scope(), { data: { ...response.data, [key]: null } })
        ),
        "platform_response_refused"
      );
    }
  );
  it("should reject getters and proxy traps without executing them at nested response boundaries", async () => {
    const read = vi.fn(() => SENTINEL);
    for (const location of locations) {
      const response = identity();
      getter(at(response, location), "injectedGetter", read);
      assertHeld(
        await inspectPlatformIdentity(manifest(), transport(scope(), response)),
        "platform_response_refused"
      );
    }
    const response = identity();
    const proxy = new Proxy(response.data.service, { ownKeys: read });
    response.data.service = proxy;
    assertHeld(
      await inspectPlatformIdentity(manifest(), transport(scope(), response)),
      "platform_response_refused"
    );
    const revoked = Proxy.revocable(identity(), {});
    revoked.revoke();
    // Promise.resolve in the transport rejects while assimilating the revoked
    // value; the parser never receives it, so this is a transport failure.
    assertHeld(
      await inspectPlatformIdentity(
        manifest(),
        transport(scope(), revoked.proxy)
      ),
      "platform_request_failed"
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("should bound active lists before inspecting elements and reject holes, proxies and reflected extras", async () => {
    const read = vi.fn(() => running());
    const oversized = [running(), running(), running()];
    getter(oversized, "0", read);
    const accessor = [running()];
    getter(accessor, "0", read);
    const extra = added([running()], "secret");
    const hidden = added([running()], "hidden", false);
    const symbol = added([running()], Symbol("hidden"));
    const proxy = new Proxy([running()], {
      get: read,
      ownKeys: () => {
        read();
        return [];
      },
    });
    for (const activeDeployments of [
      oversized,
      accessor,
      extra,
      hidden,
      symbol,
      proxy,
      new Array(1),
      null,
      [null],
      "not-a-list",
    ]) {
      const response = identity();
      const serviceInstance = {
        ...response.data.serviceInstance,
        activeDeployments,
      };
      assertHeld(
        await inspectPlatformIdentity(
          manifest(),
          transport(scope(), { data: { ...response.data, serviceInstance } })
        ),
        "platform_response_refused"
      );
    }
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(129), "line\nbreak", 12, null])(
    "should reject malformed nonsecret name fields",
    async name => {
      const response = identity();
      const service = { ...response.data.service, name };
      assertHeld(
        await inspectPlatformIdentity(
          manifest(),
          transport(scope(), { data: { ...response.data, service } })
        ),
        "platform_response_refused"
      );
    }
  );
  it("should reject null latestDeployment rather than relabel incomplete projection as proof", async () => {
    const response = identity();
    response.data.serviceInstance.latestDeployment = null;
    assertHeld(
      await inspectPlatformIdentity(manifest(), transport(scope(), response)),
      "platform_response_refused"
    );
  });
});

describe("when approval or observation deadlines expire", () => {
  it("should reject newline-suffixed UUIDs and source repositories rather than normalize approval", () => {
    for (const approval of [
      manifest({
        target: Object.freeze({
          ...target,
          projectId: target.projectId + "\n",
        }),
      }),
      manifest({ sourceRepo: manifest().sourceRepo + "\n" }),
    ]) {
      const request = transport();
      expect(() => createPlatformIdentityObserver(approval, request)).toThrow(
        "platform_manifest_refused"
      );
      expect(request).not.toHaveBeenCalled();
    }
  });
  it("should reject reflected extras inside either frozen identity tuple before transport use", () => {
    for (const key of ["target", "observer"] as const) {
      for (const extra of ["token", Symbol("hidden"), "hidden"]) {
        const tuple = Object.freeze(
          added({ ...target }, extra, extra !== "hidden")
        );
        const request = transport();
        expect(() =>
          createPlatformIdentityObserver(manifest({ [key]: tuple }), request)
        ).toThrow("platform_manifest_refused");
        expect(request).not.toHaveBeenCalled();
      }
    }
  });
  it("should never promote a timed-out observation when the transport later returns matching identity", async () => {
    let resolveLate: ((value: unknown) => void) | undefined;
    const request = vi.fn(
      (value: ApprovedPlatformRequest): Promise<unknown> => {
        if (value.query === SCOPE_DOCUMENT) return Promise.resolve(scope());
        return new Promise(resolve => {
          resolveLate = resolve;
        });
      }
    );
    const pending = inspectPlatformIdentity(manifest(), request);
    await vi.advanceTimersByTimeAsync(5_000);
    const value = await pending;
    assertHeld(value, "platform_request_timeout");
    resolveLate?.(identity());
    await vi.advanceTimersByTimeAsync(0);
    assertHeld(value, "platform_request_timeout");
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    manifest({ approvedAtMs: 20_001, expiresAtMs: 100_000 }),
    manifest({ expiresAtMs: 20_000 }),
    manifest({ approvedAtMs: 0, expiresAtMs: 10_000 }),
  ])(
    "should refuse stale or future approval before invoking a request",
    async approval => {
      const request = transport();
      assertHeld(
        await inspectPlatformIdentity(approval, request),
        "platform_approval_expired"
      );
      expect(request).not.toHaveBeenCalled();
    }
  );
  it("should recheck pinned expiry after scope and avoid the target query", async () => {
    const approval = manifest({ expiresAtMs: 20_100 });
    const request = vi.fn(
      async (_fixed: ApprovedPlatformRequest): Promise<unknown> => {
        vi.setSystemTime(20_100);
        return scope();
      }
    );
    assertHeld(
      await inspectPlatformIdentity(approval, request),
      "platform_approval_expired"
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("should recheck pinned expiry after successful target parsing without lifting hold", async () => {
    const fixed = transport();
    const request = vi.fn(
      async (value: ApprovedPlatformRequest): Promise<unknown> => {
        const response = await fixed(value);
        if (value.query === IDENTITY_DOCUMENT) vi.setSystemTime(20_100);
        return response;
      }
    );
    assertHeld(
      await inspectPlatformIdentity(manifest({ expiresAtMs: 20_100 }), request),
      "platform_approval_expired"
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("should conservatively reject a backward clock during observation", async () => {
    const request = vi.fn(
      async (_value: ApprovedPlatformRequest): Promise<unknown> => {
        vi.setSystemTime(19_999);
        return scope();
      }
    );
    assertHeld(
      await inspectPlatformIdentity(manifest(), request),
      "platform_observation_stale"
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("should detect a blocked event loop even if its request deadline timer has not run", async () => {
    const request = vi.fn(
      async (_value: ApprovedPlatformRequest): Promise<unknown> => {
        vi.setSystemTime(25_000);
        return scope();
      }
    );
    assertHeld(
      await inspectPlatformIdentity(manifest(), request),
      "platform_request_timeout"
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("should abort a hanging scope request after the fixed bound with no retry", async () => {
    let captured: ApprovedPlatformRequest | undefined;
    const request = vi.fn(
      (value: ApprovedPlatformRequest): Promise<unknown> => {
        captured = value;
        return new Promise(() => {});
      }
    );
    const pending = inspectPlatformIdentity(manifest(), request);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(captured?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    assertHeld(await pending, "platform_request_timeout");
    expect(captured?.signal.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("should abort a hanging second query and swallow its late rejection without diagnostics", async () => {
    let rejectLate: ((reason: unknown) => void) | undefined;
    let targetRequest: ApprovedPlatformRequest | undefined;
    const request = vi.fn(
      (value: ApprovedPlatformRequest): Promise<unknown> => {
        if (value.query === SCOPE_DOCUMENT) return Promise.resolve(scope());
        targetRequest = value;
        return new Promise((_, reject) => {
          rejectLate = reject;
        });
      }
    );
    const pending = inspectPlatformIdentity(manifest(), request);
    await vi.advanceTimersByTimeAsync(5_000);
    assertHeld(await pending, "platform_request_timeout");
    expect(targetRequest?.signal.aborted).toBe(true);
    rejectLate?.(new Error(SENTINEL));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("should reject approval expired since observer construction before re-observation", async () => {
    const request = transport();
    const pinned = createPlatformIdentityObserver(manifest(), request);
    vi.setSystemTime(910_000);
    assertHeld(await pinned.observe(), "platform_approval_expired");
    expect(request).not.toHaveBeenCalled();
  });
});
