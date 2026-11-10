# Maintenance workload check

**Status: draft, on HOLD.** Prepared for review on 10 November 2026. Not merged,
not deployed, never run against production. Merging to `main` deploys, so this
change waits for the owner's separate approval of the first deployment below.

## What it is

A super-admin-only reading of the work the platform has in flight, for the
person deciding whether maintenance can start. It replaces the separate
"observer" service and its Railway management key (PRs #225–#229). The app
already holds its own database and Redis connections, so no key is needed.

The counting rules are the reviewed observer's (catalogue and verdicts from
`scripts/durable-observer` at `e7dc06c`), unchanged:

- **24 database surfaces**: rows a replacement could cut off (jobs pending or
  running, deliveries pending, privacy and redaction work in progress, and so
  on), each with the age of its oldest item. Three are *parked*: they wait on a
  person, so they are shown but are not running work.
- **13 intake sources**: rows created in the last six minutes. New intake means
  the app is still taking in work, so a quiet reading cannot be trusted.
- **6 BullMQ queues × 8 states**, plus a SCAN of queue metadata keys for queues
  the catalogue does not know. Failed jobs and repeat schedules are shown but
  are not running work.

## How to read the verdict

| Verdict | Meaning |
|---|---|
| `no_go_unfinished_work` | Work is in flight in the areas checked. |
| `no_go_incomplete_evidence` | Something was not read, was cut short or looked wrong, or new work arrived. A value not read is shown as unknown, never as zero. |
| `zero_observed_not_proof` | Nothing was observed in the areas checked. |

**No verdict is permission.** Every reading carries `hold: true`.
`zero_observed_not_proof` does not mean "safe to deploy", "backup complete" or
"maintenance approved"; a person still decides, and every other gate stays where
it is. One reading is one moment: take several, a minute or more apart.

Each reading also states what it cannot see (`notCollected`): other replicas'
memory, other deployments sharing the database, database-native writers and
open transactions, external schedulers, and more.

## How it is bounded

| Rule | Where |
|---|---|
| Super admins only, enforced on the server; read-only sessions (reviewer links) refused | `superAdminProcedure` mutation; the global read-only ban refuses non-query operations |
| Runs only when someone presses the button; never on a schedule or on page load | a mutation, not a query |
| One check at a time per server process, at most one every ten seconds | `server/routers/maintenanceCheck.ts` |
| Only the catalogue's statements: `SELECT @@session.time_zone`, one `START TRANSACTION WITH CONSISTENT SNAPSHOT`, `SELECT COUNT(*)` reads with `MAX_EXECUTION_TIME(1000)`, `ROLLBACK` | `server/maintenance/workloadCatalogue.ts`; proved in its test |
| Only `LLEN`, `ZCARD` and `SCAN … MATCH bull:*:meta`; never a BullMQ Queue, which writes its metadata key when constructed | `server/maintenance/workloadReaders.ts` |
| Every statement 1.5 s, every Redis command 1 s, the whole reading 45 s | `LIMITS` |
| A connection whose operation failed or timed out is destroyed, never pooled | `server/maintenance/workloadCheck.ts` |
| Aggregate output only: counts, ages and fixed codes; never a row, id, key or queue name | tests |
| Writes nothing: no audit row and no storage probe. It does not call `/api/health`, which writes an S3 probe | — |

The database account is the app's own. TiDB refuses read-only transactions, so
the protection is statement-level, as it was for the observer.

## Verified (synthetic only)

- Catalogue: only SELECTs apart from opening and ending the snapshot, and every
  table named exists in the schema. The coverage ratchets carried over from the
  preflight: every queue the code creates, and every migration since the
  catalogue was last reconciled (`0119_shopline_billing_charges`).
- Verdicts against controlled connections: 35 cases, including timeouts, the run
  budget, malformed results and unknown queues.
- Real MySQL 8.0 with the committed migrations: every statement runs, a seeded
  open item is counted with its age, and the pool stays usable.
- Real Redis 7: counts per state, an unknown queue found across SCAN pages, and
  the keyspace unchanged after the reading. Unreachable Redis: a fixed code in
  under five seconds, with no part of the connection string in the report.
- Access: unauthenticated, tenant admin, tenant operations and read-only reviewer
  sessions are refused before anything is read. A second check while one is
  running is refused, as is one within ten seconds.

Never run against TiDB or production Redis.

## First deployment — needs its own approval

The check cannot vouch for its own first deployment, and that deployment carries
the same risk as any deploy made now.

1. **What the deploy runs.** Railway builds, then runs `pnpm db:migrate` before
   starting. This change adds no migration, so that step applies nothing; it
   reads `__drizzle_migrations` as on every deploy. Startup is the normal boot:
   workers, schedulers and recovery sweeps. The check adds no boot-time work; it
   is idle until a super admin presses the button.
2. **The risk.** Per #218's notes (Railway's documentation), a deployment made
   without a draining setting is stopped with no useful grace, and that setting
   is fixed in each deployment's own snapshot. So the next replacement, whatever
   it carries, can cut off work in progress on the running deployment. BullMQ
   returns stalled jobs to their queues, and the boot sweeps recover abandoned
   reconciliation runs, but neither is proof that every accepted item survives.
3. **Recommendation: one coordinated promotion.** Ship this with #218 (direct
   Node launch, 120 s draining) as a single, owner-approved first promotion, so
   only ONE replacement happens under the current zero-grace snapshot. Every
   later replacement then drains, and can be preceded by this check. Two
   separate deploys would cost two unprotected replacements.
4. **Timing.** Deploy only these changes on top of the running commit (`4efaac2`
   as of 10 November), nothing else merged in between. Choose a quiet window:
   between SHOPLINE's 15-minute polls, away from the daily batch and the Woodcore
   sync.
5. **Validation, after deploy.** Railway's health check passes; the app loads;
   a super admin runs the check three times, a minute apart. Expect a consistent
   snapshot, clean cleanup and complete discovery each time. Anything left
   unfinished by the replacement (stale heartbeats, pending deliveries) shows up
   here, which is the first real evidence about that replacement. Confirm a
   non-super-admin account is refused.
6. **Rollback.** Railway's Rollback to the previous deployment. No schema or data
   changes, so rollback is code-only. It is itself a replacement, with the
   draining setting of the deployment being stopped.
7. **Recovery gates.** The promotion changes no schema and no data, and needs no
   export or restore. But TiDB recovery is still unproven, so any damage during
   a deploy would have no proven way back. That has been true of every deploy
   since the October outage. It is a residual risk the owner must accept
   explicitly; calling the deploy routine does not waive it. Backup, export,
   restore, write freezes and the Shopify submission remain separate decisions.

## Files

- `server/maintenance/workloadCatalogue.ts`: what is counted, and the only statements and commands.
- `server/maintenance/workloadCheck.ts`: one reading, bounded, with the verdict rules.
- `server/maintenance/workloadReaders.ts`: the real database and Redis connections.
- `server/routers/maintenanceCheck.ts`: the super-admin mutation, mounted as `maintenanceCheck`.
- The private page is a separate, stacked change.
