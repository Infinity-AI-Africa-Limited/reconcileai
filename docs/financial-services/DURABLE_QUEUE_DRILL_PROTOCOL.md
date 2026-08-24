# Durable Queue Drill Protocol

**Purpose:** Evidence that an approved Redis/BullMQ deployment processes read-only reconciliation jobs durably and does not duplicate, lose or silently resurrect work.

## Preconditions

1. Use synthetic, masked or explicitly approved non-production data only.
2. Set `RECONCILIATION_REQUIRE_DURABLE_QUEUE=true` and verify that the service refuses a new reconciliation job when Redis/BullMQ is unavailable.
3. Capture the Redis version, BullMQ version, worker count, job ID, input checksum, tenant identifier and test timestamp.
4. Run the test only in a non-bank or bank-approved pilot environment. Do not use this protocol to justify raw bank data in Railway.

## Required drills

| Drill | Action | Expected control result | Evidence to retain |
|---|---|---|---|
| Queue unavailable | Start a reconciliation while Redis is unavailable. | Run is rejected before job creation; no in-process fallback. | Request/response, application log and database query showing no job created. |
| Worker termination | Terminate a worker after it claims but before it completes a synthetic job. | Job is retried/recovered once according to policy; no result is lost. | Worker log, job transitions, final outcome and input/output control totals. |
| Duplicate delivery | Submit/replay the same idempotency key or queue entry. | One reconciliation outcome only; duplicate is refused or deduplicated. | Job IDs, idempotency record, final reconciliation count and audit record. |
| Concurrent workers | Run two or more workers against the same synthetic batch. | Exactly one worker claims each unit; no conflicting writes. | Worker logs, claim events, database evidence and audit chain. |
| Retry / poison input | Introduce a controlled recoverable failure and a deliberately invalid record. | Retry follows policy; invalid record reaches DLQ or explicit exception state. | Retry schedule, error record, DLQ evidence and operator action. |
| Restart / replay | Restart service and worker after a partial run; replay an approved batch. | Recovery is deterministic; control totals remain consistent; replay is auditable. | Before/after control totals, job states, replay audit entry and operator sign-off. |

## Pass criteria

Every drill must preserve control totals, produce a tenant-scoped audit record, avoid duplicate reconciliation results and leave an operator-visible failure state where automatic recovery is not safe. A failure must be remediated and the drill rerun; a code-path unit test is not a substitute for this environment evidence.

## Sign-off

| Role | Name | Date | Accept / reject | Comments |
|---|---|---|---|---|
| ReconcileAI engineering |  |  |  |  |
| Bank technology |  |  |  |  |
| Bank operations / Finance Control |  |  |  |  |
| Bank InfoSec / Risk |  |  |  |  |
