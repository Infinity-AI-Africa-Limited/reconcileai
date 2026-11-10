/**
 * The real connections behind the workload check.
 *
 * Always on: the replica's self-description, an app without Redis, and Redis
 * that cannot be reached (port 1 on loopback refuses at once). Redis cases that
 * need a server run only on a disposable loopback fixture named by
 * RECONCILEAI_TEST_REDIS_URL, in a database index no other test uses, and
 * prove the reader changes nothing there.
 */
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_IDS } from "./workloadCatalogue";
import { runWorkloadCheck, type WorkloadCheckDependencies } from "./workloadCheck";
import { appReplica, openAppRedis } from "./workloadReaders";

const FIXTURE = process.env.RECONCILEAI_TEST_REDIS_URL?.trim();
const FIXTURE_DB = 13;
const savedRedisUrl = process.env.REDIS_URL;

function redisOnly(): WorkloadCheckDependencies {
  return {
    openDatabase: async () => null,
    openRedis: openAppRedis,
    monotonicMs: () => performance.now(),
    wallClock: () => new Date(),
    replica: () => appReplica({}),
  };
}

afterEach(() => {
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
});

describe("when the replica describes itself", () => {
  it("should report Railway's commit and ids only in their own shapes", () => {
    const replica = appReplica({
      RAILWAY_GIT_COMMIT_SHA: ` ${"AB".repeat(20)} `,
      RAILWAY_DEPLOYMENT_ID: "11111111-1111-4111-8111-111111111111",
      RAILWAY_REPLICA_ID: "postgres://user:password@host/db",
    });
    expect(replica.commit).toBe("ab".repeat(20));
    expect(replica.deploymentId).toBe("11111111-1111-4111-8111-111111111111");
    expect(replica.replicaId).toBeNull();
    expect(replica.lifecycle).toBe("running");
    expect(Number.isSafeInteger(replica.trackedOperations)).toBe(true);
  });

  it("should report nothing it was not given", () => {
    expect(appReplica({})).toMatchObject({ commit: null, deploymentId: null, replicaId: null });
  });
});

describe("when the app has no Redis", () => {
  it.each([undefined, "", "   "])("should not open a connection for REDIS_URL %j", async value => {
    if (value === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = value;
    await expect(openAppRedis(new AbortController().signal)).resolves.toBeNull();
  });
});

describe("when Redis cannot be reached", () => {
  it("should give up quickly, with a fixed code and nothing else", async () => {
    process.env.REDIS_URL = "redis://:not-a-real-password@127.0.0.1:1";
    const started = Date.now();
    const report = await runWorkloadCheck(redisOnly());
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.errors).toContain("redis_unavailable");
    expect(report.redis.backend).toBe("unavailable");
    expect(JSON.stringify(report)).not.toContain("not-a-real-password");
  });
});

type FixtureClient = {
  select(db: number): Promise<unknown>;
  flushdb(): Promise<unknown>;
  lpush(key: string, ...values: string[]): Promise<number>;
  zadd(key: string, ...members: (string | number)[]): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  set(key: string, value: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  type(key: string): Promise<string>;
  dbsize(): Promise<number>;
  quit(): Promise<unknown>;
};

describe.runIf(Boolean(FIXTURE))("when the check reads a real Redis", () => {
  let fixture: FixtureClient;
  const fixtureUrl = `${FIXTURE?.replace(/\/\d+$/, "")}/${FIXTURE_DB}`;

  beforeAll(async () => {
    // ioredis is BullMQ's dependency, not the app's: load it the way BullMQ does.
    const require = createRequire(import.meta.url);
    const IORedis = createRequire(require.resolve("bullmq"))("ioredis") as new (url: string) => FixtureClient;
    fixture = new IORedis(fixtureUrl);
    await fixture.flushdb();
    await fixture.lpush("bull:reconciliation-runs:wait", "1", "2");
    await fixture.zadd("bull:webhook-delivery:failed", 1, "f1");
    await fixture.zadd("bull:shopify-order-sync:repeat", 1, "r1");
    for (const queue of [...QUEUE_IDS, "tenant-export"]) await fixture.hset(`bull:${queue}:meta`, "opts.maxLenEvents", "10000");
    // Enough job keys that discovery has to page.
    for (let i = 0; i < 2_500; i++) await fixture.set(`bull:reconciliation-runs:${i}`, "x");
  });

  afterAll(async () => {
    if (!fixture) return;
    await fixture.flushdb();
    await fixture.quit();
  });

  async function keyspace(): Promise<string[]> {
    const keys = (await fixture.keys("*")).sort();
    return Promise.all(keys.map(async key => `${key}:${await fixture.type(key)}`));
  }

  it("should count each state, find the unknown queue across pages, and change nothing", async () => {
    process.env.REDIS_URL = fixtureUrl;
    const before = await keyspace();
    const report = await runWorkloadCheck(redisOnly());
    expect(await keyspace()).toEqual(before);
    expect(report.redis).toMatchObject({ backend: "redis", discovery: "complete", unknownQueues: 1 });
    const states = Object.fromEntries(report.redis.queues.map(q => [q.id, q.states]));
    expect(states["reconciliation-runs"].wait).toBe(2);
    expect(states["webhook-delivery"].failed).toBe(1);
    expect(states["shopify-order-sync"].repeat).toBe(1);
    expect(report.errors).toEqual(["database_unavailable", "unknown_queue_observed"]);
    expect(report.verdict).toBe("no_go_unfinished_work");
    expect(JSON.stringify(report)).not.toContain("tenant-export");
  });
});
