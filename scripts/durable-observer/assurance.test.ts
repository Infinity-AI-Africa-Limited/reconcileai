import { describe, expect, it, vi } from "vitest";
import {
  reduceDeploymentCorrelation,
  reduceObserverReferences,
  type AppDeploymentProjection,
  type AppSnapshotProjection,
  type AssuranceCode,
  type AssuranceManifest,
  type AssuranceResult,
  type DeploymentCorrelationProjection,
  type GithubDeploymentProjection,
  type ObserverReferenceProjection,
} from "./assurance";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const OBSERVER = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const SHA = "a".repeat(40);
const REPO = "Example-Approved/observer-target";
const NOW = Date.parse("2026-11-07T06:15:00Z");
const CANARY = "SYNTHETIC_PRIVATE_VALUE_DO_NOT_RELEASE";
const CANARY_KEY = "SYNTHETIC_UNKNOWN_KEY_DO_NOT_RELEASE";
function manifest(
  change: Partial<AssuranceManifest> = {}
): Readonly<AssuranceManifest> {
  return Object.freeze({
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    targetServiceId: TARGET,
    targetDeploymentId: DEPLOYMENT,
    observerServiceId: OBSERVER,
    sourceServiceName: "approved-app",
    sourceRepo: REPO,
    expectedSha: SHA,
    githubContext: "production",
    maxSkewMs: 600_000,
    approvedAtMs: NOW - 300_000,
    expiresAtMs: NOW + 600_000,
    ...change,
  });
}
function reference(
  change: Partial<ObserverReferenceProjection> = {}
): ObserverReferenceProjection {
  return {
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    serviceId: OBSERVER,
    sourceServiceId: TARGET,
    sourceServiceName: "approved-app",
    unrendered: true,
    observedAt: "2026-11-07T06:14:30Z",
    variables: {
      DATABASE_URL: "${{approved-app.DATABASE_URL}}",
      REDIS_URL: "${{approved-app.REDIS_URL}}",
    },
    ...change,
  };
}
function running(
  change: Partial<AppDeploymentProjection> = {}
): AppDeploymentProjection {
  return {
    id: DEPLOYMENT,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    serviceId: TARGET,
    status: "SUCCESS",
    deploymentStopped: false,
    createdAt: "2026-11-05T15:29:00Z",
    ...change,
  };
}
function app(
  change: Partial<AppSnapshotProjection> = {}
): AppSnapshotProjection {
  return {
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    serviceId: TARGET,
    sourceRepo: REPO,
    observedAt: "2026-11-07T06:14:00Z",
    deploymentsComplete: true,
    activeDeployments: [running()],
    deployments: [running()],
    ...change,
  };
}
function githubRecord(
  change: Partial<GithubDeploymentProjection> = {}
): GithubDeploymentProjection {
  return {
    id: "1234567890",
    repo: REPO,
    context: "production",
    sha: SHA,
    creator: "railway-app[bot]",
    createdAt: "2026-11-05T15:25:46Z",
    latestStatus: {
      repo: REPO,
      context: "production",
      state: "success",
      createdAt: "2026-11-05T15:30:00Z",
      creator: "railway-app[bot]",
    },
    ...change,
  };
}
function correlation(): DeploymentCorrelationProjection {
  return {
    before: app(),
    github: {
      repo: REPO,
      context: "production",
      observedAt: "2026-11-07T06:14:30Z",
      deploymentsComplete: true,
      deployments: [githubRecord()],
    },
    after: app({ observedAt: "2026-11-07T06:14:45Z" }),
  };
}
function held(value: Readonly<AssuranceResult>, code: AssuranceCode): void {
  expect(value).toEqual({
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
  expect(Object.isFrozen(value)).toBe(true);
  const output = JSON.stringify(value);
  for (const privateText of [
    CANARY,
    CANARY_KEY,
    PROJECT,
    ENVIRONMENT,
    TARGET,
    DEPLOYMENT,
    OBSERVER,
    SHA,
    REPO,
    "DATABASE_URL",
    "REDIS_URL",
    "approved-app",
    "1234567890",
  ])
    expect(output).not.toContain(privateText);
}
function refusedReference(input: unknown, ...setup: unknown[]): void {
  const approval = setup.length > 0 ? setup[0] : manifest();
  const now = setup.length > 1 ? setup[1] : NOW;
  held(
    reduceObserverReferences(approval, input, now),
    "reference_evidence_refused"
  );
}
function refusedCorrelation(input: unknown, ...setup: unknown[]): void {
  const approval = setup.length > 0 ? setup[0] : manifest();
  const now = setup.length > 1 ? setup[1] : NOW;
  held(
    reduceDeploymentCorrelation(approval, input, now),
    "deployment_evidence_refused"
  );
}
function extra(
  input: object,
  key: PropertyKey = CANARY_KEY,
  enumerable = true
): object {
  return Object.defineProperty(input, key, { value: CANARY, enumerable });
}
function getter(input: object, key: string, read: () => unknown): object {
  return Object.defineProperty(input, key, {
    enumerable: true,
    configurable: true,
    get: read,
  });
}

describe("when the observer's own stored unrendered map has exactly the approved expressions", () => {
  it("should report stored-expression evidence only and keep production held", () => {
    held(
      reduceObserverReferences(manifest(), reference(), NOW),
      "reference_expressions_observed"
    );
  });
  it.each(["", " ", "\t", "\r\n", " \t\r\n"])(
    "should accept only documented ASCII surrounding whitespace without changing the expression",
    whitespace =>
      held(
        reduceObserverReferences(
          manifest(),
          reference({
            variables: {
              DATABASE_URL:
                whitespace + "${{approved-app.DATABASE_URL}}" + whitespace,
              REDIS_URL:
                whitespace + "${{approved-app.REDIS_URL}}" + whitespace,
            },
          }),
          NOW
        ),
        "reference_expressions_observed"
      )
  );
  it("should never inspect unknown map properties or emit diagnostics on valid or failing paths", () => {
    const read = vi.fn(() => {
      throw new Error(CANARY);
    });
    const logging = ["log", "warn", "error", "info", "debug"] as const;
    const spies = logging.map(key =>
      vi.spyOn(console, key).mockImplementation(() => undefined)
    );
    try {
      held(
        reduceObserverReferences(manifest(), reference(), NOW),
        "reference_expressions_observed"
      );
      refusedReference(reference({ variables: getter({}, CANARY_KEY, read) }));
      held(
        reduceDeploymentCorrelation(manifest(), correlation(), NOW),
        "deployment_correlation_observed"
      );
      refusedCorrelation(extra(correlation()));
      expect(read).not.toHaveBeenCalled();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("when stored values are literal, concatenated, sealed, missing or unknown", () => {
  it.each([
    undefined,
    null,
    "",
    CANARY,
    "mysql://" + CANARY,
    "${{other-app.DATABASE_URL}}",
    "${{approved-app.DATABASE_URL}}" + CANARY,
    CANARY + "${{approved-app.DATABASE_URL}}",
    "${{ approved-app.DATABASE_URL }}",
    "${{approved-app.DATABASE_URL}}/${{approved-app.DATABASE_URL}}",
    "\u00a0${{approved-app.DATABASE_URL}}",
    "\v${{approved-app.DATABASE_URL}}",
    "${{approved-app.DATABASE_URL}}\u200b",
    123,
    {},
    "x".repeat(513),
  ])(
    "should fail generically without returning either key or any value",
    value => {
      for (const key of ["DATABASE_URL", "REDIS_URL"]) {
        const values = {
          DATABASE_URL: "${{approved-app.DATABASE_URL}}",
          REDIS_URL: "${{approved-app.REDIS_URL}}",
          [key]: value,
        };
        refusedReference(reference({ variables: values }));
      }
    }
  );
  it("should reject swapped database and Redis reference keys", () => {
    refusedReference(
      reference({
        variables: {
          DATABASE_URL: "${{approved-app.REDIS_URL}}",
          REDIS_URL: "${{approved-app.DATABASE_URL}}",
        },
      })
    );
  });
  it.each([
    null,
    undefined,
    {},
    [],
    { DATABASE_URL: "${{approved-app.DATABASE_URL}}" },
    { REDIS_URL: "${{approved-app.REDIS_URL}}" },
  ])(
    "should reject absent or sealed maps rather than infer endpoint equality",
    variables => refusedReference(reference({ variables }))
  );
  it.each([CANARY_KEY, Symbol("private-key"), "__proto__"])(
    "should reject every unknown map key with no reflected key in the fixed result",
    key => {
      for (const enumerable of [true, false])
        refusedReference(
          reference({
            variables: extra(reference().variables as object, key, enumerable),
          })
        );
    }
  );
  it.each([
    { projectId: OTHER },
    { environmentId: OTHER },
    { serviceId: TARGET },
    { serviceId: OTHER },
    { sourceServiceId: OBSERVER },
    { sourceServiceId: OTHER },
    { sourceServiceName: "other-app" },
    { unrendered: false },
  ])(
    "should require every independently approved observer and source identity",
    change => {
      refusedReference({ ...reference(), ...change });
    }
  );
  it("should refuse coordinated source-name substitution even when both expressions agree", () => {
    refusedReference(
      reference({
        sourceServiceName: "other-app",
        variables: {
          DATABASE_URL: "${{other-app.DATABASE_URL}}",
          REDIS_URL: "${{other-app.REDIS_URL}}",
        },
      })
    );
  });
});

describe("when complete bounded deployment projections correlate the app with Railway's GitHub record", () => {
  it("should label correlation rather than runtime verification even for a days-old active app", () => {
    held(
      reduceDeploymentCorrelation(manifest(), correlation(), NOW),
      "deployment_correlation_observed"
    );
  });
  it("should accept the provider's project slash environment context only when every projection matches exactly", () => {
    const context = "approved-project / production",
      p = correlation();
    const deployed = githubRecord({
      context,
      latestStatus: { ...githubRecord().latestStatus, context },
    });
    const bound = {
      ...p,
      github: { ...p.github, context, deployments: [deployed] },
    };
    held(
      reduceDeploymentCorrelation(
        manifest({ githubContext: context }),
        bound,
        NOW
      ),
      "deployment_correlation_observed"
    );
    refusedCorrelation(bound);
    refusedCorrelation(
      {
        ...bound,
        github: { ...bound.github, context: "other-project / production" },
      },
      manifest({ githubContext: context })
    );
  });
  it.each([
    " production",
    "production ",
    "production\n",
    "production\t",
    "project\u0000 / production",
    "x".repeat(129),
  ])(
    "should refuse unsafe or unbounded approved context names without reflecting them",
    context => {
      refusedCorrelation(correlation(), manifest({ githubContext: context }));
    }
  );
  it("should compare unsorted histories rather than assume the first record is newest", () => {
    const p = correlation(),
      older = running({
        id: OTHER,
        status: "FAILED",
        deploymentStopped: true,
        createdAt: "2026-11-04T15:29:00Z",
      });
    const ghOlder = githubRecord({
      id: "1234567889",
      sha: "b".repeat(40),
      creator: "someone-else",
      createdAt: "2026-11-04T15:25:46Z",
    });
    held(
      reduceDeploymentCorrelation(
        manifest(),
        {
          ...p,
          before: app({ deployments: [older, running()] }),
          after: app({
            observedAt: p.after.observedAt,
            deployments: [running(), older],
          }),
          github: { ...p.github, deployments: [ghOlder, githubRecord()] },
        },
        NOW
      ),
      "deployment_correlation_observed"
    );
  });
  it("should honor a smaller approved skew and accept its exact boundary", () => {
    const p = correlation();
    const record = githubRecord({ createdAt: "2026-11-05T15:19:00Z" });
    const boundary = { ...p, github: { ...p.github, deployments: [record] } };
    held(
      reduceDeploymentCorrelation(manifest(), boundary, NOW),
      "deployment_correlation_observed"
    );
    refusedCorrelation(boundary, manifest({ maxSkewMs: 599_999 }));
    const exact = {
      ...p,
      github: {
        ...p.github,
        deployments: [githubRecord({ createdAt: running().createdAt })],
      },
    };
    held(
      reduceDeploymentCorrelation(manifest({ maxSkewMs: 0 }), exact, NOW),
      "deployment_correlation_observed"
    );
  });
  it("should leave existing platform proof gates untouched and never read a wall clock", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error(CANARY);
    });
    try {
      held(
        reduceObserverReferences(manifest(), reference(), NOW),
        "reference_expressions_observed"
      );
      held(
        reduceDeploymentCorrelation(manifest(), correlation(), NOW),
        "deployment_correlation_observed"
      );
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});

describe("when ownership, active identity, completeness or latest deployment is uncertain", () => {
  it.each([
    { id: OTHER },
    { projectId: OTHER },
    { environmentId: OTHER },
    { serviceId: OBSERVER },
    { status: "BUILDING" },
    { status: "FAILED" },
    { deploymentStopped: true },
    { deploymentStopped: "false" },
    { createdAt: "2026-11-05T14:00:00Z" },
  ])(
    "should refuse each changed deployment field before and after the correlation",
    change => {
      for (const boundary of ["before", "after"]) {
        const p = correlation(),
          changed = { ...running(), ...change };
        refusedCorrelation({
          ...p,
          [boundary]: {
            ...p.before,
            activeDeployments: [changed],
            deployments: [changed],
          },
        });
      }
    }
  );
  it.each([
    { projectId: OTHER },
    { environmentId: OTHER },
    { serviceId: OBSERVER },
    { sourceRepo: "Example-Approved/other" },
    { deploymentsComplete: false },
    { deploymentsComplete: undefined },
    { activeDeployments: [] },
    { activeDeployments: [running(), running()] },
    { deployments: [] },
    { deployments: [running(), running()] },
    { deployments: [running({ id: OTHER })] },
  ])(
    "should refuse ambiguous or incomplete app snapshots on either side",
    change => {
      for (const boundary of ["before", "after"])
        refusedCorrelation({
          ...correlation(),
          [boundary]: { ...app(), ...change },
        });
    }
  );
  it("should compare the active record to its history entry instead of trusting two matching IDs", () => {
    const p = correlation();
    for (const boundary of ["before", "after"])
      refusedCorrelation({
        ...p,
        [boundary]: {
          ...p.before,
          deployments: [running({ deploymentStopped: true })],
        },
      });
  });
  it.each(["FAILED", "BUILDING", "SUCCESS", "CRASHED"])(
    "should refuse any later app deployment regardless of state or stopped flag",
    status => {
      const p = correlation(),
        later = running({
          id: OTHER,
          status,
          deploymentStopped: true,
          createdAt: "2026-11-06T00:00:00Z",
        });
      for (const boundary of ["before", "after"])
        refusedCorrelation({
          ...p,
          [boundary]: { ...p.before, deployments: [running(), later] },
        });
    }
  );
  it("should refuse equal-timestamp app histories as ambiguous", () => {
    refusedCorrelation({
      ...correlation(),
      before: app({ deployments: [running(), running({ id: OTHER })] }),
    });
  });
  it.each([
    { repo: "Example-Approved/other" },
    { context: "staging" },
    { sha: "a".repeat(7) },
    { sha: "g".repeat(40) },
    { sha: "b".repeat(40) },
    { sha: SHA + "\n" },
    { creator: "someone-else" },
    { creator: "railway-app[bot] " },
  ])(
    "should refuse mismatched GitHub repo, context, creator or full expected SHA",
    change => {
      const p = correlation();
      refusedCorrelation({
        ...p,
        github: { ...p.github, deployments: [githubRecord(change)] },
      });
    }
  );
  it.each([
    { repo: "Example-Approved/other" },
    { context: "staging" },
    { state: "failure" },
    { state: "pending" },
    { state: "inactive" },
    { createdAt: "2026-11-05T15:20:00Z" },
    { createdAt: "2026-11-07T06:15:01Z" },
    { creator: "manual-user" },
    { creator: "railway-app[bot] " },
    { creator: undefined },
  ])(
    "should refuse status ownership, nonsuccess latest status and impossible status times",
    change => {
      const p = correlation(),
        record = githubRecord();
      refusedCorrelation({
        ...p,
        github: {
          ...p.github,
          deployments: [
            { ...record, latestStatus: { ...record.latestStatus, ...change } },
          ],
        },
      });
    }
  );
  it.each(["success", "failure", "pending", "error", "inactive"])(
    "should reject a later GitHub deployment in every state instead of selecting an older success",
    state => {
      const p = correlation(),
        later = githubRecord({
          id: "1234567891",
          createdAt: "2026-11-06T00:00:00Z",
          latestStatus: {
            repo: REPO,
            context: "production",
            state,
            createdAt: "2026-11-06T00:01:00Z",
            creator: "railway-app[bot]",
          },
        });
      refusedCorrelation({
        ...p,
        github: { ...p.github, deployments: [githubRecord(), later] },
      });
    }
  );
  it("should refuse duplicate or equal-timestamp GitHub records even when both succeed", () => {
    const p = correlation();
    for (const records of [
      [githubRecord(), githubRecord()],
      [githubRecord(), githubRecord({ id: "1234567891" })],
    ])
      refusedCorrelation({
        ...p,
        github: { ...p.github, deployments: records },
      });
  });
  it.each([
    { deploymentsComplete: false },
    { deploymentsComplete: undefined },
    { deployments: [] },
    { repo: "Example-Approved/other" },
    { context: "staging" },
  ])(
    "should refuse missing or incomplete GitHub history and enclosing ownership",
    change => {
      const p = correlation();
      refusedCorrelation({ ...p, github: { ...p.github, ...change } });
    }
  );
});

describe("when manifests, clocks or observation times are stale or malformed", () => {
  it.each([
    { observerServiceId: TARGET },
    { projectId: "not-uuid" },
    { projectId: PROJECT + "\n" },
    { targetServiceId: "00000000-0000-0000-0000-000000000000" },
    { sourceServiceName: "${{other-app.X}}" },
    { sourceServiceName: "approved-app\n" },
    { sourceRepo: REPO + ".git" },
    { sourceRepo: REPO + "\n" },
    { sourceRepo: "https://github.com/" + REPO },
    { sourceRepo: "Example/../other" },
    { expectedSha: "a".repeat(7) },
    { expectedSha: SHA + "\n" },
    { githubContext: "production\n" },
    { maxSkewMs: 600_001 },
    { maxSkewMs: -1 },
    { maxSkewMs: Infinity },
    { maxSkewMs: 0.5 },
    { approvedAtMs: NOW + 1 },
    { approvedAtMs: -0 },
    { expiresAtMs: NOW },
    { expiresAtMs: NOW + 600_001 },
  ])(
    "should refuse invalid independently approved manifest data on both reducers",
    change => {
      const approval = Object.freeze({ ...manifest(), ...change });
      refusedReference(reference(), approval);
      refusedCorrelation(correlation(), approval);
    }
  );
  it.each([
    {},
    null,
    undefined,
    { ...manifest() },
    Object.freeze(extra({ ...manifest() })),
  ])(
    "should reject mutable, missing or extended manifests without returning setup details",
    approval => {
      refusedReference(reference(), approval);
      refusedCorrelation(correlation(), approval);
    }
  );
  it.each([
    undefined,
    null,
    NaN,
    Infinity,
    -1,
    -0,
    1.5,
    "2026-11-07T06:15:00Z",
  ])("should require an explicit trusted finite integer UTC clock", now => {
    refusedReference(reference(), manifest(), now);
    refusedCorrelation(correlation(), manifest(), now);
  });
  it.each([
    "2026-11-07T06:09:59Z",
    "2026-11-07T06:15:01Z",
    "2026-11-07T06:14:00+00:00",
    "2026-11-07T06:14:00",
    "2026-02-30T06:14:00Z",
    "2026-11-07T24:00:00Z",
    "2026-11-07T06:14:60Z",
    "2026-11-07T06:14:00Z\n",
    CANARY,
    null,
  ])(
    "should reject stale, future, nonUTC and normalized invalid observation timestamps",
    observedAt => {
      refusedReference({ ...reference(), observedAt });
      const p = correlation();
      for (const location of ["before", "github", "after"] as const)
        refusedCorrelation({
          ...p,
          [location]: { ...p[location], observedAt },
        });
    }
  );
  it("should accept exactly five-minute freshness and millisecond UTC timestamps", () => {
    held(
      reduceObserverReferences(
        manifest(),
        reference({ observedAt: "2026-11-07T06:10:00Z" }),
        NOW
      ),
      "reference_expressions_observed"
    );
    held(
      reduceObserverReferences(
        manifest(),
        reference({ observedAt: "2026-11-07T06:14:30.123Z" }),
        NOW
      ),
      "reference_expressions_observed"
    );
  });
  it("should refuse observations predating approval and reversed before-GitHub-after ordering", () => {
    const approval = manifest({ approvedAtMs: NOW - 10_000 });
    refusedReference(reference(), approval);
    refusedCorrelation(correlation(), approval);
    const p = correlation();
    refusedCorrelation({
      ...p,
      before: app({ observedAt: "2026-11-07T06:14:31Z" }),
    });
    refusedCorrelation({
      ...p,
      after: app({ observedAt: "2026-11-07T06:14:29Z" }),
    });
  });
  it.each([
    "2026-02-30T15:29:00Z",
    "2026-11-05T15:29:00+00:00",
    "2026-11-07T06:15:01Z",
  ])(
    "should refuse malformed or future app and GitHub creation timestamps",
    createdAt => {
      const p = correlation(),
        changed = running({ createdAt });
      refusedCorrelation({
        ...p,
        before: app({ activeDeployments: [changed], deployments: [changed] }),
      });
      refusedCorrelation({
        ...p,
        github: { ...p.github, deployments: [githubRecord({ createdAt })] },
      });
    }
  );
});

describe("when any projection contains executable, inherited, cyclic or reflected fields", () => {
  it.each([null, undefined, [], {}, { data: CANARY }, Object.freeze({})])(
    "should refuse missing and raw API shapes without projecting arbitrary contents",
    input => {
      refusedReference(input);
      refusedCorrelation(input);
    }
  );
  it("should reject accessors, proxies and custom prototypes without executing their hooks", () => {
    const read = vi.fn(() => {
      throw new Error(CANARY);
    });
    for (const input of [
      getter(reference(), "variables", read),
      new Proxy(reference(), { ownKeys: read }),
      Object.assign(
        Object.create({ [CANARY_KEY]: CANARY }) as object,
        reference()
      ),
    ])
      refusedReference(input);
    const revoked = Proxy.revocable(reference(), {});
    revoked.revoke();
    refusedReference(revoked.proxy);
    const p = correlation();
    refusedCorrelation(getter(p, "before", read));
    refusedCorrelation(new Proxy(correlation(), { ownKeys: read }));
    refusedCorrelation({
      ...correlation(),
      before: getter(app(), "projectId", read),
    });
    refusedCorrelation({
      ...correlation(),
      github: {
        ...p.github,
        deployments: [getter(githubRecord(), "latestStatus", read)],
      },
    });
    const approval = Object.freeze(
      getter({ ...manifest() }, "sourceServiceName", read)
    );
    refusedReference(reference(), approval);
    refusedCorrelation(correlation(), approval);
    refusedReference(
      reference({
        variables: getter(
          reference().variables as object,
          "DATABASE_URL",
          read
        ),
      })
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("should refuse every unknown key including symbols and nonenumerable fields at all nested boundaries", () => {
    for (const key of [CANARY_KEY, Symbol(CANARY_KEY)])
      for (const enumerable of [true, false]) {
        refusedReference(extra(reference(), key, enumerable));
        const p = correlation();
        const inputs = [
          extra(correlation(), key, enumerable),
          { ...p, before: extra(app(), key, enumerable) },
          { ...p, after: extra(app(), key, enumerable) },
          {
            ...p,
            before: app({
              activeDeployments: [
                extra(running(), key, enumerable),
              ] as readonly AppDeploymentProjection[],
            }),
          },
          {
            ...p,
            before: app({
              deployments: [
                extra(running(), key, enumerable),
              ] as readonly AppDeploymentProjection[],
            }),
          },
          { ...p, github: extra({ ...p.github }, key, enumerable) },
          {
            ...p,
            github: {
              ...p.github,
              deployments: [extra(githubRecord(), key, enumerable)],
            },
          },
          {
            ...p,
            github: {
              ...p.github,
              deployments: [
                githubRecord({
                  latestStatus: extra(
                    { ...githubRecord().latestStatus },
                    key,
                    enumerable
                  ) as GithubDeploymentProjection["latestStatus"],
                }),
              ],
            },
          },
        ];
        for (const input of inputs) refusedCorrelation(input);
      }
  });
  it("should reject cycles at bounded schema leaves without recursion or exception reflection", () => {
    const refs: Record<string, unknown> = { ...reference() };
    refs.variables = refs;
    refusedReference(refs);
    const variables: Record<string, unknown> = {
      REDIS_URL: "${{approved-app.REDIS_URL}}",
    };
    variables.DATABASE_URL = variables;
    refusedReference(reference({ variables }));
    const root: Record<string, unknown> = { ...correlation() };
    root.before = root;
    refusedCorrelation(root);
    const record: Record<string, unknown> = { ...running() };
    record.id = record;
    refusedCorrelation({
      ...correlation(),
      before: app({
        activeDeployments: [record] as unknown as AppDeploymentProjection[],
      }),
    });
  });
  it("should reject holes, reflected array fields, proxy arrays and accessor elements before execution", () => {
    const read = vi.fn(() => {
      throw new Error(CANARY);
    });
    const badArrays = [
      new Array(1),
      getter([running()], "0", read),
      extra([running()]),
      extra([running()], Symbol(CANARY_KEY)),
      extra([running()], CANARY_KEY, false),
      new Proxy([running()], { get: read, ownKeys: read }),
      Object.setPrototypeOf([running()], {}),
      null,
    ];
    for (const array of badArrays) {
      const p = correlation();
      refusedCorrelation({
        ...p,
        before: { ...p.before, activeDeployments: array },
      });
      refusedCorrelation({ ...p, before: { ...p.before, deployments: array } });
      refusedCorrelation({ ...p, github: { ...p.github, deployments: array } });
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("should cap histories at fifty before inspecting oversized accessor elements", () => {
    const read = vi.fn(() => {
      throw new Error(CANARY);
    });
    const oversized = getter(new Array(51), "0", read),
      p = correlation();
    refusedCorrelation({
      ...p,
      before: { ...p.before, deployments: oversized },
    });
    refusedCorrelation({
      ...p,
      github: { ...p.github, deployments: oversized },
    });
    refusedCorrelation({
      ...p,
      before: {
        ...p.before,
        activeDeployments: getter(new Array(3), "0", read),
      },
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("should refuse secret-canary values at nonsecret projection leaves without coercing or logging them", () => {
    const read = vi.fn(() => {
      throw new Error(CANARY);
    });
    const hostile = { toString: read, valueOf: read };
    for (const value of [CANARY, hostile]) {
      refusedReference(
        reference({ variables: { DATABASE_URL: value, REDIS_URL: value } })
      );
      const p = correlation();
      refusedCorrelation({
        ...p,
        github: {
          ...p.github,
          deployments: [{ ...githubRecord(), sha: value }],
        },
      });
      refusedCorrelation({ ...p, before: { ...p.before, sourceRepo: value } });
    }
    expect(read).not.toHaveBeenCalled();
  });
});
