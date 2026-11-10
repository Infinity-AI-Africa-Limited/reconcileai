# Maintenance workload check

**Status: draft, on HOLD.** Prepared for review on 10 November 2026 and revised
after Manus's review the same day. Not merged, not deployed, never run against
production. Merging to `main` deploys, so this change waits for the owner's
separate approval of a first promotion, planned below. Nothing in this document
authorizes a merge, a deployment, a provider setting or a live reading.

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
| Super admins only, enforced on the server; read-only sessions (reviewer links) refused. Every super admin, not one named person | `superAdminProcedure` mutation; the global read-only ban refuses non-query operations |
| Runs only when someone presses the button; never on a schedule, on page load, on focus or after reconnecting | a mutation, not a query; the page's own rules are in the page change |
| One check at a time per server process, at most one every ten seconds. Per process, not across replicas | `server/routers/maintenanceCheck.ts` |
| Only the catalogue's statements: `SELECT @@session.time_zone`, one `START TRANSACTION WITH CONSISTENT SNAPSHOT`, `SELECT COUNT(*)` reads with `MAX_EXECUTION_TIME(1000)`, `ROLLBACK` | `server/maintenance/workloadCatalogue.ts`; proved in its test |
| At most one request for a database connection outstanding per process. mysql2 cannot withdraw a request from its pool queue, so while an abandoned one waits, a new check is told `database_busy` rather than queuing another. A connection that arrives late was never used, and goes straight back | `server/maintenance/workloadReaders.ts` |
| A connection whose statement failed or was cancelled is taken out of the pool AND its socket destroyed. mysql2 3.15's own `destroy()` only half-closes, which a stalled server can hold open. Closing the socket ends this process's side; it does not prove the server stopped the statement, which `MAX_EXECUTION_TIME(1000)` bounds there | `server/maintenance/workloadReaders.ts` |
| Only `LLEN`, `ZCARD` and `SCAN … MATCH bull:*:meta`; never a BullMQ Queue, which writes its metadata key when constructed | `server/maintenance/workloadReaders.ts` |
| Every statement 1.5 s, every Redis command 1 s, the whole reading 45 s | `LIMITS` |
| Aggregate output only: counts, ages and fixed codes; never a row, id, key or queue name | tests |

**What it writes.** The check writes no business or workload data: no audit row,
no storage object, and it does not call `/api/health`, which writes an S3 probe.
The request around it is not write-free, and nothing should claim it is:

- authenticating any request updates the user's `lastSignedIn`;
- a new pooled database session is pinned to UTC when it opens;
- the Redis connection sends `INFO`, and `AUTH` or `SELECT` when the URL carries
  them, then `QUIT`;
- the server logs one line with the user id and the verdict.

The database account is the app's own, with its full privileges. TiDB refuses
read-only transactions, so the protection is statement-level, as it was for the
observer. It is not database-enforced read-only access.

## Verified (synthetic only)

- Catalogue: only SELECTs apart from opening and ending the snapshot, and every
  table named exists in the schema. The coverage ratchets carried over from the
  preflight: every queue the code creates, and every migration since the
  catalogue was last reconciled (`0119_shopline_billing_charges`).
- Verdicts against controlled connections: 36 cases, including timeouts, the run
  budget, malformed results, unknown queues and a busy pool.
- Real MySQL 8.0 with the committed migrations: every statement runs, a seeded
  open item is counted with its age, and the pool stays usable.
- A stalled server (a relay that stops forwarding and never closes): the check
  destroys its socket at the deadline. A control shows mysql2's own `destroy()`
  leaves the socket open, which is why the forced close is there. A retired
  connection is replaced by a fresh one.
- A pool with no free connection: one request waits at most, a second check is
  told `busy` without queuing, and the late connection is handed back unused.
- Real Redis 7: counts per state, an unknown queue found across SCAN pages, and
  the keyspace unchanged after the reading. Unreachable Redis: a fixed code in
  under five seconds, with no part of the connection string in the report.
- Access through the procedure: unauthenticated, tenant admin, tenant operations
  and read-only sessions are refused before anything is read; a second check
  while one is running is refused, as is one within ten seconds.
- Access through the real door: HTTP with signed session cookies, the real
  context and real user rows. Missing, forged and deactivated sessions, a tenant
  admin and a read-only super admin are refused before any reading starts. An
  account demoted or deactivated mid-session is refused on its next request.
  The one admitted call records `lastSignedIn`, as every signed-in request does.

Never run against TiDB or production Redis.

## First promotion — a plan for review, not approved

This is the plan the owner would be asked to approve later. It is not approved,
and nothing in it may be done now. The check cannot vouch for its own first
deployment.

1. **Migrations.** This change adds no migration. That does not show the
   pre-deploy `pnpm db:migrate` will apply nothing: whether production has any
   migration pending is unknown until the live `__drizzle_migrations` is compared
   with the journal of the exact commit to be promoted, through the separately
   approved private path. Until then, the plan assumes a migration could run.
2. **Shutdown grace.** The running deployment's effective draining setting has
   not been independently verified, so it may give the old process no useful
   grace. #218's 120-second draining applies to deployments created with it: it
   does not protect the first replacement of the current deployment, and even
   then it is an allowance, not a guarantee that work completes. What matters is
   whether #218 is in the FIRST promotion: once a deployment carrying it is
   running, later replacements are stopped under its allowance.
3. **Exactly one promotion.** `main` auto-deploys, so merging #218, #230 and #231
   one after another would deploy after each merge. One promotion needs a
   mechanism, approved separately:
   - **(a) one combined branch**: `main` plus #218, #230 and #231, tested as one
     tree, then merged into `main` with ONE merge and no unrelated merge before
     it; or
   - **(b) Railway's own auto-deploy pause** around the merges, with its
     restoration verified afterwards.

   (a) needs no change to provider settings, so it is the recommendation. Either
   way: name the exact final commit, run the full suite on that exact tree, and
   record who merges and when. Neither is authorized now.
4. **Timing.** Choosing a time window by the clock is not evidence that the
   system is idle. The window is chosen for convenience, nothing more.
5. **After the promotion.**
   - Railway's health check passes and the app loads.
   - A super admin runs the check.
   - #218's own checklist is completed: start command, process, signal
     delivery, effective draining setting.

   Readings taken then may show catalogued leftovers of the replacement, such as
   stale heartbeats or pending deliveries. They cannot prove that all accepted
   work survived, cannot recreate anything lost, and do not show that intake was
   fenced.
6. **Rollback.** Railway's documentation (as cited in Manus's review; it could
   not be re-read from this environment, whose network blocks the docs site)
   says a rollback restores the deployment's image AND its custom variables,
   subject to image retention. So a rollback is not code-only.
   - If a variable such as a database credential changed after the target
     deployment, a rollback restores the old value.
   - A rollback does not undo database writes made by migrations, startup sweeps
     or workers.

   Before any promotion:
   - name the rollback target deployment;
   - confirm it is still retained;
   - confirm, without reading any value, that its variables are still current.

   If that cannot be confirmed, the fallback is a revert commit deployed forward,
   which keeps today's variables. After any rollback, recheck the effective
   draining setting: the restored deployment brings back its own, possibly zero,
   grace.
7. **Gates that stay.** The protected export, isolated restore and
   deployment-validation gates remain unresolved and separately governed. This
   plan does not satisfy, waive or bypass them, and no general acceptance of
   residual risk does either. The same holds for backups, write freezes,
   clearing stuck records and the Shopify submission.

## Files

- `server/maintenance/workloadCatalogue.ts`: what is counted, and the only statements and commands.
- `server/maintenance/workloadCheck.ts`: one reading, bounded, with the verdict rules.
- `server/maintenance/workloadReaders.ts`: the real database and Redis connections.
- `server/routers/maintenanceCheck.ts`: the super-admin mutation, mounted as `maintenanceCheck`.
- The private page is a separate, stacked change.
