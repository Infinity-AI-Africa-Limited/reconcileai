# Maintenance lifecycle — increment 1

## Status and purpose

Lifecycle increment 1 and startup-recovery preservation were merged and hardened through Claude's PR #214 and #215 reviews. Railway's active deployment identifies the #215 merge. These released controls address false drain proof and age-only abandonment of uncertain work; they are not an approved maintenance window, all-runtime stop/replay rehearsal or completed backup control. The test-only subprocess rehearsal in the next review increment does not change runtime behavior or authorize production actions.

ReconcileAI remains read-only evidence/control software at the financial boundary. This change does not authorise funds movement, autonomous exception closure, customer-data exports or destructive operations.

## Supported entrypoint and cold boot

The supported development/build entrypoint is `server/_core/bootstrap.ts`; production still executes `dist/index.js`. An absent `RECONCILEAI_STARTUP_MODE`, or the exact value `normal`, selects the normal app. The exact value `maintenance` selects a minimal HTTP-only server **without importing normal application routers, database/storage clients, queue workers, seeders or periodic producers**. Any other supplied value fails before the normal application loader runs. Neither control echoes invalid values.

The ESM build uses code splitting: normal-only external dependencies stay behind the dynamic import boundary. Generated server chunks remain beside `dist/index.js`, preserving the existing `dist/public` resolution. Deployments must retain the entire `dist` output, not copy the entrypoint alone. The compiled cold smoke checks its static dependency graph as well as liveness, operational refusals and forbidden outbound sockets.

The cold server serves a dependency-free `GET /api/healthz` liveness response. Operational paths, including `/api/health`, `/api/readyz`, authentication, tRPC, scheduled sync and inbound webhooks, return HTTP 503 and a retry indication. It neither acknowledges an operational delivery nor offers an unauthenticated maintenance-control endpoint.

Cold startup is not a runtime toggle. Changing a production variable or restarting an application remains a separately approved deployment action. Directly executing the legacy source entrypoint is not a supported deployment path.

## Process-local drain

In normal mode the admission middleware is mounted before body parsers, authentication and dependency-touching routes. On SIGTERM/SIGINT, admission is fenced synchronously and registered producer stops run. The sole exact GET probe exceptions are `/api/healthz` and `/api/readyz`; readiness reports **admission only**, not dependency health or the absence of database writers.

Explicitly tracked request, procedure, startup, queue and background promises remain counted until their real lifetimes end. An early HTTP response or disconnected client does not end a separately tracked handler. Live tasks may launch tracked descendants needed to finish their accepted operation. Expired asynchronous contexts may not use an unrelated active task as permission to start new work.

The HTTP admission lease ends when the client disconnects, so it is never the only thing holding work open:

- **tRPC context creation** is tracked on its own (`createContext`). Authentication writes `lastSignedIn`, and a client that disconnects mid-authentication must not let the drain report idle under that write. The procedure that follows is tracked separately.
- **Every asynchronous Express handler** is wrapped in `asyncHandler`, which holds its promise in the lifecycle. `asyncHandlerRatchet.test.ts` fails CI on an unwrapped one; the dev-only Vite fallback is the single reviewed exception.
- **Every detached promise** in server code (a `void` call, or a `.then`/`.catch`/`.finally` chain nobody awaits) is launched through `runBackgroundWork`/`deferBackgroundWork`, or is listed with its reason in `maintenance/detachedWorkRatchet.test.ts`. Review found nine untracked in procedures: four flywheel learning captures and retractions, both launches of the exception-closure effects, two owner notifications, and a manual Woodcore batch sync that writes for minutes after returning.

**Startup is tracked root work** (`runRoot`). The signal handler is attached before startup begins, and the drain cannot finish, nor the pools close, while startup is still importing, choosing a port or binding. Startup does not lend admission to what it launches: once the fence is up it starts no background work and never listens (`[boot] startup_fenced`). A listen already in flight is awaited, so shutdown closes a bound server rather than racing the bind. A server that never listened is treated as closed. A startup that fails sets exit code 1 and runs the same fence and drain, because `routers.ts` starts its producer loops at import.

A signal that arrives while Node is still loading and evaluating the bundle, before the handler exists, meets Node's default action and exits with code 143. No application write can be in flight then: evaluation is synchronous, and nothing it schedules has run.

Periodic producers stop creating new ticks. Existing runs remain tracked. Deferred work is reserved before `setImmediate`, and response-completion effects are reserved before the response finishes. The normal matching, ownership, tenant, read-only and human-approval rules remain unchanged.

`RECONCILEAI_DRAIN_TIMEOUT_MS` is an optional bounded **wait** setting: default 90,000 ms; accepted range 1,000–300,000 ms. It is not an export outage estimate or cancellation deadline. A timeout or stop failure reports `incomplete`, remains fenced and must never be treated as completed work. This increment does not force `process.exit()`.

The application wait setting does not configure Railway's termination grace. Signal forwarding, replica count and the host's actual stop allowance must be evidenced separately; a host-forced termination is not a successful drain result.

Only after tracked work and producer stops settle successfully does the signal adapter attempt HTTP, queue and database-pool closure. Close failures/timeouts also produce `incomplete`. Queue stop/pause operations are local to this process; no global queue purge, Redis deletion or worker-state obliteration is introduced. Pending in-process-only work cannot be counted as durably preserved.

BullMQ local stop awaits acquisition/main-loop quiescence with `pause(false)`. A worker cleanup `error` emitted while `close()` resolves is still treated as unproved closure; the registry entry and cached failure are retained. The lifecycle proof is rechecked before database-pool closure and after resource closure, so a late fenced acquisition cannot turn an invalidated proof into `stopped`. Async route failures log fixed codes only, without incoming URLs or arbitrary rejection text.

## Startup recovery preservation — released control

More than two hours without a heartbeat during downtime or a long queue wait does **not** prove that accepted durable reconciliation work was abandoned. `recoverStuckReconciliationJobs()` now defers before database access, candidate selection, abandonment updates or queue construction when Redis is configured, durability is required, the deployment is not explicitly cloud, `NODE_ENV` is not explicitly development/test, `DATABASE_URL` does not name a provably local database (`server/dbTarget.ts`: loopback only), or the reconciliation queue already has a cached promise. This includes on-premise mode, production with missing current Redis configuration, configured Redis outages or optional fallbacks, an in-progress queue initialization, and a development server whose `.env` names a shared or production database: that database's stale rows may belong to another deployment's durable queue, which a development process cannot see. A cached queue is not awaited or inspected to justify abandonment. Policy is rechecked after candidate selection before a legacy update, so queue initialization during the database awaits also vetoes abandonment.

Deferral returns the unchanged `{ recovered: 0 }` contract and logs only the fixed non-secret code `[reconciliationQueue] recovery_deferred_unproven_orphanhood` with the first condition that applied as a fixed `reason`: `redis_configured`, `durability_required`, `deployment_not_cloud`, `environment_not_development_or_test`, `database_not_local` or `queue_cached`. It performs no abandonment or artifact writes, queue removal, marker clearing, re-enqueue, automatic replay or purge. Current missing configuration, an absent queue entry, or a test's lack of queue presence cannot establish historical orphanhood or authorise disposal of previously accepted work.

The original two-hour, last-activity-based legacy orphan sweep remains limited to a fresh process-local development/test cloud context with no Redis configuration, no required durability, a provably local database and no cached reconciliation queue. Its `pending`/`running`, `COALESCE(heartbeatAt, startedAt, createdAt)`, and null-abandonment predicates remain reasserted in the conditional update. Recovery reports actual affected rows and preserves the completion/heartbeat race protections. Handler claim, retry, abandonment refusal, late-completion artifact preservation and normal queue behavior are unchanged; this limitation is not a new production in-process recovery guarantee.

**Deferring ambiguous durable orphans can leave unresolved rows for separate reviewed disposition.** This is protection against false termination, not complete replay/resume, backlog repair or outage approval. Existing abandonment markers are not retroactively cleared. Held PR #209 and catch-up beyond the existing lookback remain separate, unresolved review gates.

An idle-only maintenance window may avoid backlog recovery only if separately approved evidence proves every ingress/producer across every deployed copy is fenced and there are zero unresolved reconciliation rows and zero runnable/active/delayed retained entries, including retries, accepted outboxes, terminal hooks and acknowledgement gaps. Missing or incomplete evidence means no-go; local readiness, constructed-queue health and `tracked_process_only` drain results do not prove cluster-wide idle. Upstream retry/catch-up handling and any replay remain separately reviewed and approved.

## Coverage to review

- Cold boot selection before normal writer-bearing imports.
- Admission before parsing, including GET paths with audit or probe effects.
- Async route, tRPC context-creation and procedure lifetimes; post-ack and post-response effects; detached effects launched by procedures.
- Startup as tracked root work: fenced startup launches nothing and never listens; a bind in flight completes before closure.
- Scheduled reconciliation, SFTP, bucket ingestion, SLA, due-date monitoring, demo timeline and Shopify recovery/backstop timers.
- Reconciliation descendant effects, heartbeat writes, queue factories and operations, local worker acquisition and terminal hooks.
- Idempotent signal handling, bounded waits and pool closure after—not before—settled tracked work.
- Synthetic stale pending/running preservation before dependency access for durable/uncertain configurations and cached queues; unchanged legacy update predicates, affected-row counts and completion/heartbeat race protections.

## Gates this increment does not close

A `stopped` result has scope **`tracked_process_only`**. It is not a distributed lock or proof that every writer is absent. The following remain mandatory before a production export:

1. Claude review/hardening, approved release and synthetic cross-replica stop/drain/retry validation.
2. Complete inventory and fencing of every deployed replica, scheduled caller, maintenance script and the separate Manus-hosted copy. Disable its Auto publish before owner-approved Unpublish; never assume a checkpoint or saved version cannot republish it.
3. Private, cluster-wide TiDB session verification with restricted fields withheld from logs, chat and artefacts. No session query is executed by this branch.
4. Native TiDB TTL/background-writer and active-transaction assessment; row counts are reconciliation checks, not no-write proof.
5. Outage/replay correctness: queued/running jobs, acknowledgement gaps, late completion, final hooks and catch-up outside an existing lookback window. Existing held Claude PRs are not silently incorporated or deemed reviewed by this branch.
6. Protected owner-only credential entry, encrypted export/transfer, owner-approved isolated restore target, full validation and separately approved maintenance window.

No production variables, deployment, DB export, restore target, credentials, Redis state, S3 settings, Manus publish setting or scheduled workflow enablement are changed while preparing this branch. No schema migration is introduced.

## Cross-process adapter rehearsal — test-only increment

`server/maintenance/subprocessRehearsal.test.ts` exercises the shipped lifecycle, HTTP admission, async route wrapper, queue factory and shutdown-signal adapters in separate Node processes. It uses an actual parent-owned disposable Redis fixture, Express listeners bound only to loopback, fixed IPC handshakes and injected synthetic HTTP/job effects. It does not load the normal app bootstrap, routers, financial reconciliation runners, customer records or a database.

The actual-Redis cases prove:

- A response sent before its synthetic async effect finishes does not release the handler's tracked work. SIGTERM synchronously fences later HTTP and enqueue admission; the process waits for accepted HTTP descendants, active queue work and Redis acknowledgement before resource closure and natural exit.
- A waiting job remains in Redis after the first process stops. An **explicitly constructed replacement worker** consumes it; a separate synthetic failure retries to its second attempt. This does not prove the lazy production reconciliation worker automatically starts or resumes a backlog after boot.
- A second worker sharing the unique fixture queue remains able to accept and execute work after the first worker reports `stopped`. This is a counterexample to treating process-local drain as cluster-wide quiescence.
- Expiring the bounded wait reports `incomplete`, leaves resources open and admission fenced, and never becomes `stopped` merely because held work later finishes. A test cleanup kill is not drain proof.

The two always-on safety tests reject non-exact loopback Redis URLs, mismatched fixture variables, non-synthetic queue names, unexpected child environment keys and arbitrary IPC payloads. The three actual-Redis cases opt in only with `RECONCILEAI_TEST_REDIS_URL` set to the exact `redis://127.0.0.1:<ephemeral-port>` of an independently created disposable fixture and an equal `REDIS_URL`. A loopback address alone does not prove disposability: do not point these tests at an existing developer, production or provider queue. The child environment is an exact five-key test allowlist, without inherited service credentials or loader arguments. Tests kill and await all their own children before obliterating only their UUID-named fixture queue, never FLUSHDB or a shared/global pause.

Synthetic job IDs are namespaced (`synthetic-*`) so they cannot collide with BullMQ's reserved internal queue keys such as `active`. Initial bare-ID test-fixture collisions were corrected without modifying shipped runtime behavior or weakening assertions. Timeouts and cleanup errors emit only typed fixed-phase diagnostics, never arbitrary request, job, environment or provider data.

Validation on 4 November 2026: all five new tests passed in three consecutive executions; combined actual-Redis validation passed 28 tests across five files. Source/test typechecks and compiled cold-mode checks are recorded in the review handoff. These are **controlled cross-process adapter** results, not full-bootstrap, integrated-database, provider-grace, sustained all-writer freeze, actual backlog-resume, export/restore, RTO or financial-correctness proof. This test-only increment is not a new runtime prerequisite for collecting the private inventory, nor permission to stop production.

Final review gate on the unchanged runtime source: committed migrations and drift passed on a new disposable loopback MySQL instance; full regression passed **5,261 tests with 21 conditional skips and no failures**. The separate actual-Redis run passed **28/28**, and the new five-test suite passed in two further executions. Source/test typechecks, lint, build and compiled cold-mode smoke all passed. The existing route/detached-work ratchets remain unchanged. Both fixture servers were stopped and their synthetic data directories removed. No production connection or managed Manus publish/checkpoint action occurred.

## Railway launch and grace proposal — review only, 4 November 2026

This recipe-only operational increment proposes three changes in `railway.json`: direct launch with `NODE_ENV=production exec node dist/index.js`, host `drainingSeconds: 120`, and `overlapSeconds: 0`. It preserves build, pre-deploy migrations, liveness path/timeout, restart policy and retry count. It adds no schema, runtime handler, dependency or production variable. The supported compiled bootstrap and complete adjacent server chunks remain required. `package.json` remains unchanged; pnpm is still used for build and migration, not as the deployed runtime launcher.

Upstream Nixpacks emits a bash command entrypoint. Shell `exec` replaces that shell with Node instead of retaining a package-manager launcher. A synthetic local process test can check command parsing, production mode and direct SIGTERM delivery; it does **not** prove the live Railway image's PID hierarchy, signal delivery or successful production drain. Those require separately approved runtime evidence.

The proposed host allowance is finite. With no application override, `RECONCILEAI_DRAIN_TIMEOUT_MS` defaults to 90,000 ms. The shutdown adapter shares that deadline across tracked-work settling and HTTP/resource closure; cleanup only receives the remaining application budget. A 120-second host allowance does not cancel long-running work, add a separate cleanup deadline, automatically replay jobs, or turn `incomplete` into `stopped`. Any later forced kill is failed drain evidence. Zero overlap avoids an intentional post-promotion overlap delay but does not prevent startup coexistence, fence a second deployment or certify global idle.

### HOLD — first promotion and merge must be coordinated

Railway's documented default shutdown grace is zero seconds. A Railway-labelled support response says an old deployment uses its original creation-time draining snapshot; adding a new grace setting is not a retroactive fix for the running process. The new deployment's overlap setting governs first replacement, but overlap is not old-process shutdown grace. This external guidance has not been measured against the current production deployment, and manual Remove applicability remains unverified.

Because `main` auto-deploys, **Claude must not merge this configuration PR as an ordinary uncoordinated deployment**. Code review may proceed, but first merge/promotion remains on HOLD until the owner approves its exact production action and there is private evidence that accepted work can survive the first replacement without assuming the old process has the newly proposed grace. Do not disable CI or deployment controls to bypass that gate. A reviewed PR is not an outage/export approval.

Required before first promotion and later export:

1. Record the active image/source, actual start command, effective old/new deployment timing snapshots, replicas and any relevant shared overrides without exposing variable values, raw logs or provider payloads. Owner-supplied screenshots on 4 November show the four requested service-variable searches as absent; this is not a scan of every scope.
2. Obtain protected aggregate workload/idleness and upstream retry/catch-up evidence. Fence or coordinate every ingress and producer through separately approved controls before relying on zero unresolved work; a single momentary zero count is insufficient. If accepted/in-flight work cannot be accounted for, do not proceed. The old process may receive no useful grace on first replacement.
3. After an owner-approved first promotion, verify the new deployment's actual command, stored 120-second allowance, zero intentional overlap delay and normal startup; recheck liveness, admission and dependency health. Verify direct signal delivery/drain during a separately approved controlled action, not by stopping the live service during preflight.
4. Keep TiDB background writers, both repository schedulers, Manus Auto publish/unpublish, private cluster-wide session proof, encrypted private export, isolated restore and the maintenance window as separate gates. No backup or all-writer quiescence is claimed by this recipe.

Railway's current legacy Config as Code page states that existing files keep working until 1 December 2026. This is an interim change for the existing service, not a broader infrastructure migration. Review effective parsing now and plan the provider's separate migration before that cutoff; do not silently combine it with the emergency recovery scope.

Sources reviewed on 4 November 2026:

- [Railway deployment reference — default zero-second shutdown grace](https://docs.railway.com/deployments/reference)
- [Railway Config as Code — precedence, timing fields and legacy cutoff](https://docs.railway.com/config-as-code/reference)
- [Railway-labelled reply — creation-time draining snapshot and first replacement](https://station.railway.com/questions/which-draining-configuration-applies-to-4b18d1d8)
- [Nixpacks Dockerfile generation — bash entrypoint](https://github.com/railwayapp/nixpacks/blob/main/src/nixpacks/builder/docker/dockerfile_generation.rs)

No live Railway setting, secret, workflow enablement, Manus publish state, production record, Redis object or S3 object is changed by preparing this branch. Validation and final PR state belong in the non-secret review handoff; no successful live drain, deployment, export, restore or RTO is asserted here.
