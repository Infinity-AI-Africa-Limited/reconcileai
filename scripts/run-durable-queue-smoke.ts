import { setTimeout as delay } from "node:timers/promises";

type SyntheticJob = { scenario: "retry" | "dedupe" | "poison" };

const redisUrl = process.env.REDIS_URL?.trim();
if (!redisUrl) {
  throw new Error("Set REDIS_URL before running the synthetic durable-queue smoke drill.");
}

const { createQueue } = await import("../server/jobQueue");
const attempts = new Map<string, number[]>();

const queue = await createQueue<SyntheticJob>(
  `prebank-durable-smoke-${Date.now()}`,
  async (job) => {
    const recorded = attempts.get(job.name) ?? [];
    recorded.push(job.attempt);
    attempts.set(job.name, recorded);

    if (job.data.scenario === "retry" && job.attempt === 1) {
      throw new Error("Synthetic retryable failure");
    }
    if (job.data.scenario === "poison") {
      throw new Error("Synthetic poison record");
    }
  },
  { requireDurable: true, uniqueJobNames: true, attempts: 2, backoffMs: 25 },
);

if (queue.backend !== "bullmq") {
  throw new Error(`Expected BullMQ backend; received ${queue.backend}.`);
}

await queue.enqueue("retry", { scenario: "retry" });
await queue.enqueue("dedupe", { scenario: "dedupe" });
await queue.enqueue("dedupe", { scenario: "dedupe" });
await queue.enqueue("poison", { scenario: "poison" });

const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  const retry = attempts.get("retry") ?? [];
  const dedupe = attempts.get("dedupe") ?? [];
  const poison = attempts.get("poison") ?? [];
  if (
    JSON.stringify(retry) === JSON.stringify([1, 2]) &&
    JSON.stringify(dedupe) === JSON.stringify([1]) &&
    JSON.stringify(poison) === JSON.stringify([1, 2])
  ) {
    console.log(
      JSON.stringify(
        {
          backend: queue.backend,
          retryAttempts: retry,
          dedupeAttempts: dedupe,
          poisonAttempts: poison,
          result: "pass",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  await delay(50);
}

console.error(JSON.stringify({ backend: queue.backend, attempts: Object.fromEntries(attempts), result: "timeout" }, null, 2));
process.exit(1);
