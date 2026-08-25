# Synthetic Durable Queue Smoke Drill Record

**Date:** 24 August 2026
**Environment:** Ephemeral local Redis 7 (container, port-mapped); no bank, customer or production data.
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

Re-run 25 August 2026 after the drill was corrected — see *Correction* below.

```json
{
  "backend": "bullmq",
  "retry":  { "attempts": [1, 2], "state": "completed" },
  "dedupe": { "attempts": [1] },
  "poison": { "attempts": [1, 2], "state": "failed", "attemptsMade": 2, "inFailedSet": true },
  "counts": { "waiting": 0, "active": 0, "completed": 2, "failed": 1, "delayed": 0 },
  "result": "pass"
}
```

Every claim is read back from BullMQ after the fact, not inferred from the
worker's own counters:

| Claim | Confirmed by |
|---|---|
| BullMQ was selected, not the in-process fallback | `requireDurable: true` plus an explicit backend assertion |
| A transient failure retries and then succeeds | the retry job's persisted state is `completed` |
| A repeated unique job runs once | one delivery, re-checked after a settle window |
| A poison record exhausts its attempts **durably** | the job is in the FAILED set, `state: "failed"`, `attemptsMade: 2` |

## Correction (25 August 2026)

The first version of this drill reported a pass on the handler's in-memory
attempt counters alone. Those are recorded **before** the handler throws, so the
poison counter reached `[1, 2]` while its second attempt was still running — the
process could exit before BullMQ persisted anything, and the drill would claim
"durable exhausted-failure handling" that had never been written down.

The counters say what the WORKER saw; only the queue's own state says what
SURVIVED. The drill now reads both, and the difference was demonstrated rather
than argued: making the poison record succeed on its second attempt keeps the
counters at `[1, 2]` — the exact shape the old version accepted — and the
corrected drill fails on it:

```json
{ "result": "fail",
  "reason": "the poison record's terminal failure was not persisted by BullMQ",
  "poison": { "state": "completed", "inFailedSet": false } }
```

The drill also now releases its Redis connections and removes its own keys on
every exit path, rather than calling `process.exit` mid-run.

## What this does not prove

The drill does **not** evidence worker termination recovery, concurrent workers, durable dead-letter retention, monitoring, backup, network resilience, bank tenancy or a bank-controlled Redis deployment. Those scenarios remain required in the target pilot environment using `DURABLE_QUEUE_DRILL_PROTOCOL.md`.
