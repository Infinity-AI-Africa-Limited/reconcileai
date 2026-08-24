# Synthetic Durable Queue Smoke Drill Record

**Date:** 24 August 2026
**Environment:** Local sandbox Redis 7.0.15 on `127.0.0.1:6380`; no bank, customer or production data.
**Purpose:** Pre-bank engineering evidence only. This is not bank-environment acceptance evidence.

## Configuration

| Item | Value |
|---|---|
| Queue implementation | ReconcileAI `server/jobQueue.ts` BullMQ backend |
| Redis route | Ephemeral local Redis instance; stopped after the drill |
| Durable requirement | `requireDurable: true` |
| Unique job names | Enabled for synthetic units of work |
| Retry policy | Two attempts with 25 ms exponential base delay |
| Input data | Synthetic scenario labels only: `retry`, `dedupe`, `poison` |

## Observed result

```json
{
  "backend": "bullmq",
  "retryAttempts": [1, 2],
  "dedupeAttempts": [1],
  "poisonAttempts": [1, 2],
  "result": "pass"
}
```

The smoke drill confirms that the application selected BullMQ when Redis was available, retried a controlled transient failure once, deduplicated a repeated unique job submission and exhausted a synthetic poison record under the configured retry policy.

## What this does not prove

The drill does **not** evidence worker termination recovery, concurrent workers, durable dead-letter retention, monitoring, backup, network resilience, bank tenancy or a bank-controlled Redis deployment. Those scenarios remain required in the target pilot environment using `DURABLE_QUEUE_DRILL_PROTOCOL.md`.
