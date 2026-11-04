# Maintenance lifecycle — increment 1

## Status and purpose

This branch is a **review-only engineering prerequisite**, not an approved maintenance window, deployment, recovery rehearsal or completed backup control. It addresses the unsafe assumption that stopping admission or reaching a timeout means background writes have finished.

ReconcileAI remains read-only evidence/control software at the financial boundary. This change does not authorise funds movement, autonomous exception closure, customer-data exports or destructive operations.

## Supported entrypoint and cold boot

The supported development/build entrypoint is `server/_core/bootstrap.ts`; production still executes `dist/index.js`. An absent `RECONCILEAI_STARTUP_MODE`, or the exact value `normal`, selects the normal app. The exact value `maintenance` selects a minimal HTTP-only server **without importing normal application routers, database/storage clients, queue workers, seeders or periodic producers**. Any other supplied value fails before the normal application loader runs. Neither control echoes invalid values.

The ESM build uses code splitting: normal-only external dependencies stay behind the dynamic import boundary. Generated server chunks remain beside `dist/index.js`, preserving the existing `dist/public` resolution. Deployments must retain the entire `dist` output, not copy the entrypoint alone. The compiled cold smoke checks its static dependency graph as well as liveness, operational refusals and forbidden outbound sockets.

The cold server serves a dependency-free `GET /api/healthz` liveness response. Operational paths, including `/api/health`, `/api/readyz`, authentication, tRPC, scheduled sync and inbound webhooks, return HTTP 503 and a retry indication. It neither acknowledges an operational delivery nor offers an unauthenticated maintenance-control endpoint.

Cold startup is not a runtime toggle. Changing a production variable or restarting an application remains a separately approved deployment action. Directly executing the legacy source entrypoint is not a supported deployment path.

## Process-local drain

In normal mode the admission middleware is mounted before body parsers, authentication and dependency-touching routes. On SIGTERM/SIGINT, admission is fenced synchronously and registered producer stops run. The sole exact GET probe exceptions are `/api/healthz` and `/api/readyz`; readiness reports **admission only**, not dependency health or the absence of database writers.

Explicitly tracked request, procedure, startup, queue and background promises remain counted until their real lifetimes end. An early HTTP response or disconnected client does not end a separately tracked handler. Live tasks may launch tracked descendants needed to finish their accepted operation. Expired asynchronous contexts may not use an unrelated active task as permission to start new work.

Periodic producers stop creating new ticks. Existing runs remain tracked. Deferred work is reserved before `setImmediate`, and response-completion effects are reserved before the response finishes. The normal matching, ownership, tenant, read-only and human-approval rules remain unchanged.

`RECONCILEAI_DRAIN_TIMEOUT_MS` is an optional bounded **wait** setting: default 90,000 ms; accepted range 1,000–300,000 ms. It is not an export outage estimate or cancellation deadline. A timeout or stop failure reports `incomplete`, remains fenced and must never be treated as completed work. This increment does not force `process.exit()`.

The application wait setting does not configure Railway's termination grace. Signal forwarding, replica count and the host's actual stop allowance must be evidenced separately; a host-forced termination is not a successful drain result.

Only after tracked work and producer stops settle successfully does the signal adapter attempt HTTP, queue and database-pool closure. Close failures/timeouts also produce `incomplete`. Queue stop/pause operations are local to this process; no global queue purge, Redis deletion or worker-state obliteration is introduced. Pending in-process-only work cannot be counted as durably preserved.

BullMQ local stop awaits acquisition/main-loop quiescence with `pause(false)`. A worker cleanup `error` emitted while `close()` resolves is still treated as unproved closure; the registry entry and cached failure are retained. The lifecycle proof is rechecked before database-pool closure and after resource closure, so a late fenced acquisition cannot turn an invalidated proof into `stopped`. Async route failures log fixed codes only, without incoming URLs or arbitrary rejection text.

## Coverage to review

- Cold boot selection before normal writer-bearing imports.
- Admission before parsing, including GET paths with audit or probe effects.
- Async route and tRPC procedure lifetimes; post-ack and post-response effects.
- Scheduled reconciliation, SFTP, bucket ingestion, SLA, due-date monitoring, demo timeline and Shopify recovery/backstop timers.
- Reconciliation descendant effects, heartbeat writes, queue factories and operations, local worker acquisition and terminal hooks.
- Idempotent signal handling, bounded waits and pool closure after—not before—settled tracked work.

## Gates this increment does not close

A `stopped` result has scope **`tracked_process_only`**. It is not a distributed lock or proof that every writer is absent. The following remain mandatory before a production export:

1. Claude review/hardening, approved release and synthetic cross-replica stop/drain/retry validation.
2. Complete inventory and fencing of every deployed replica, scheduled caller, maintenance script and the separate Manus-hosted copy. Disable its Auto publish before owner-approved Unpublish; never assume a checkpoint or saved version cannot republish it.
3. Private, cluster-wide TiDB session verification with restricted fields withheld from logs, chat and artefacts. No session query is executed by this branch.
4. Native TiDB TTL/background-writer and active-transaction assessment; row counts are reconciliation checks, not no-write proof.
5. Outage/replay correctness: queued/running jobs, acknowledgement gaps, late completion, final hooks and catch-up outside an existing lookback window. Existing held Claude PRs are not silently incorporated or deemed reviewed by this branch.
6. Protected owner-only credential entry, encrypted export/transfer, owner-approved isolated restore target, full validation and separately approved maintenance window.

No production variables, deployment, DB export, restore target, credentials, Redis state, S3 settings, Manus publish setting or scheduled workflow enablement are changed while preparing this branch. No schema migration is introduced.
