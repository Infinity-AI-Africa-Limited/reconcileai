/** Only the finite parent harness's NEW loopback fixtures. No production config,
 * fixture writes, migrations or application imports in this test. */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { openRuntimeReaders } from "./runtimeAdapters";
import {
  openDatabase,
  prepareRedis,
  connectRedis,
} from "./vendor/production-workload-preflight.mjs";
import { requireLoopbackFixture } from "./loopback.testkit";
import { observeDurableStores } from "./core";
import { serializeReport } from "./report";

const optedIn =
  process.env.DURABLE_OBSERVER_TEST_MYSQL_PORT !== undefined ||
  process.env.DURABLE_OBSERVER_TEST_REDIS_PORT !== undefined;
const fixture = optedIn ? requireLoopbackFixture() : undefined;
const require = createRequire(import.meta.url);

describe.skipIf(!fixture)(
  "when the finite harness supplies a new migrated database and nonpersistent Redis",
  () => {
    it("should reuse Claude’s actual driver openers for every fixed catalogue read and preserve HOLD", async () => {
      if (!fixture) throw new Error("loopback_fixture_refused");
      const abort = new AbortController();
      const readers = await openRuntimeReaders(
        {
          databaseUrl: `mysql://root@127.0.0.1:${fixture.mysqlPort}/reconcileai_test`,
          redisUrl: `redis://127.0.0.1:${fixture.redisPort}`,
          appDir: require
            .resolve("../../package.json")
            .replace(/\/package\.json$/, ""),
          signal: abort.signal,
        },
        {
          isolatedLoopback: true,
          database: openDatabase,
          prepareRedis,
          connectRedis,
        }
      );
      let time = 0;
      const report = await observeDurableStores({
        ...readers,
        clock: {
          now: () => time,
          wait: async (ms, signal) => {
            if (signal.aborted) throw new Error("fixture_aborted");
            time += ms;
          },
        },
      });
      expect(serializeReport(report)).toContain('"hold":true');
      expect(report.execution).toBe("synthetic_only");
      expect(report.databaseControl).toBe("statement_guard_only");
      expect(report.verdict).toBe("zero_observed_not_proof");
      expect(report.errors).toEqual([]);
      expect(report.samples).toHaveLength(3);
      expect(
        report.samples.every(
          sample =>
            sample.database.snapshot === "consistent_snapshot" &&
            sample.database.cleanup === "ok"
        )
      ).toBe(true);
      await expect(
        readers.database.read("session.utc", abort.signal)
      ).rejects.toThrow("connection_unusable");
      await expect(readers.redis.scan("0", abort.signal)).rejects.toThrow(
        "connection_unusable"
      );
    }, 15_000);
  }
);
