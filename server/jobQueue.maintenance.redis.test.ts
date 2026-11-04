import { afterAll, describe, expect, it } from "vitest";
import type { JobQueue } from "./jobQueue";
import type { Queue } from "bullmq";

// Run only on a dedicated disposable Redis fixture, never a shared/provider URL.
const fixtureUrl = process.env.RECONCILEAI_TEST_REDIS_URL;
if (fixtureUrl && !/^redis:\/\/127\.0\.0\.1:\d+\/?$/.test(fixtureUrl)) {
  throw new Error("maintenance_test_requires_isolated_loopback_redis");
}
const name = `test-maintenance-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let queue: JobQueue<{ synthetic: boolean }> | undefined;
let inspector: Queue | undefined;
let release: (() => void) | undefined;

afterAll(async () => {
  release?.();
  await queue?.close();
  if (inspector) {
    // Only the unique name on the dedicated synthetic fixture is removed.
    await inspector.obliterate({ force: true });
    await inspector.close();
  }
});
async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("fixture_wait_timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe.skipIf(!fixtureUrl)("when an actual BullMQ worker drains on a dedicated local Redis fixture", () => {
  it("should wait for active work and acknowledgement, refuse new admission, and retain queued work", async () => {
    const { createQueue } = await import("./jobQueue");
    const { applicationLifecycle, MaintenanceAdmissionError } = await import("./maintenance/lifecycle");
    const { Queue } = await import("bullmq");
    let started = 0;
    if (process.env.REDIS_URL !== fixtureUrl) throw new Error("isolated_redis_fixture_mismatch");
    queue = await createQueue<{ synthetic: boolean }>(name, async () => {
      started += 1;
      await new Promise<void>(resolve => { release = resolve; });
    }, { attempts: 1, requireDurable: true });
    inspector = new Queue(name, { connection: { url: fixtureUrl } as never });
    await queue.enqueue("active", { synthetic: true });
    await until(() => started === 1);
    await inspector.add("retained", { synthetic: true });
    const drain = applicationLifecycle.drain(3000);
    let settled = false;
    void drain.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(applicationLifecycle.snapshot().active).toBeGreaterThan(0);
    await expect(queue.enqueue("refused", { synthetic: true })).rejects.toBeInstanceOf(MaintenanceAdmissionError);
    release?.();
    expect(await drain).toEqual({ status: "drained", active: 0, stopFailures: 0 });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(started).toBe(1);
    const counts = await inspector.getJobCounts("waiting", "active", "completed");
    expect(counts.waiting).toBe(1);
    expect(counts.active).toBe(0);
    expect(counts.completed).toBe(1);
    await queue.close();
    queue = undefined;
    expect((await inspector.getJobCounts("waiting")).waiting).toBe(1);
  }, 10_000);
});
