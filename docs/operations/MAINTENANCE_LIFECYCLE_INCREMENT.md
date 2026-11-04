# Maintenance lifecycle — increment 1

## Status and purpose

Lifecycle increment 1 was merged and hardened through Claude's PR #214 review. That foundation addresses the unsafe assumption that stopping admission or reaching a timeout means background writes have finished. The narrow startup-recovery preservation increment described below remains a **review-only engineering prerequisite**, not a deployment, approved maintenance window, recovery rehearsal or completed backup control.

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

## Startup recovery preservation — review-only increment

More than two hours without a heartbeat during downtime or a long queue wait does **not** prove that accepted durable reconciliation work was abandoned. `recoverStuckReconciliationJobs()` now defers before database access, candidate selection, abandonment updates or queue construction when Redis is configured, durability is required, the deployment is not explicitly cloud, `NODE_ENV` is not explicitly development/test, `DATABASE_URL` does not name a provably local database (`server/dbTarget.ts`: loopback only), or the reconciliation queue already has a cached promise. This includes on-premise mode, production with missing current Redis configuration, configured Redis outages or optional fallbacks, an in-progress queue initialization, and a development server whose `.env` names a shared or production database: that database's stale rows may belong to another deployment's durable queue, which a development process cannot see. A cached queue is not awaited or inspected to justify abandonment. Policy is rechecked after candidate selection before a legacy update, so queue initialization during the database awaits also vetoes abandonment.

Deferral returns the unchanged `{ recovered: 0 }` contract and logs only the fixed non-secret code `[reconciliationQueue] recovery_deferred_unproven_orphanhood` with the first condition that applied as a fixed `reason`: `redis_configured`, `durability_required`, `deployment_not_cloud`, `environment_not_development_or_test`, `database_not_local` or `queue_cached`. It performs no abandonment or artifact writes, queue removal, marker clearing, re-enqueue, automatic replay or purge. Current missing configuration, an absent queue entry, or a test's lack of queue presence cannot establish historical orphanhood or authorise disposal of previously accepted work.

The original two-hour, last-activity-based legacy orphan sweep remains limited to a fresh process-local development/test cloud context with no Redis configuration, no required durability, a provably local database and no cached reconciliation queue. Its `pending`/`running`, `COALESCE(heartbeatAt, startedAt, createdAt)`, and null-abandonment predicates remain reasserted in the conditional update. Recovery reports actual affected rows and preserves the completion/heartbeat race protections. Handler claim, retry, abandonment refusal, late-completion artifact preservation and normal queue behavior are unchanged; this limitation is not a new production in-process recovery guarantee. On a durable backend the reconciliation worker is built at boot (`startReconciliationWorker`), so runs retained in Redis through a restart are delivered normally rather than waiting for someone to create another run. Before this review the worker was built only by job creation, or incidentally by the sweep's cleanup, which no longer runs where work is retained. Nothing is re-enqueued or replayed.

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
