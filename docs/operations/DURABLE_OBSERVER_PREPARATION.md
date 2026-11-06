# Separate durable-store observer — preparation contract

Status: offline engineering for Claude review. Not a deployed service, not an approval to connect to production, and not completion of the existing production-workload preflight Part B.

## Why a separate observer

The proposed observer is a separate, temporary, non-public Railway job. It must not enter, replace, restart, import or impersonate the live ReconcileAI application. Production database and Redis connections, if later approved, remain provider-side. The observer reads only a fixed catalogue of aggregate queries and queue cardinalities; it does not reconcile records or resolve exceptions.

This first increment supplies the fixed-read core and closed result contract. A separate packaging/test increment supplies an executable synthetic artifact and loopback fixture adapters. **The supplied artifact has no production-enabled execution path.** The test adapters are not a production transport. No Railway configuration in the normal application is changed.

## Evidence semantics

Counts describe the backing stores, not work belonging exclusively to one application deployment. The observer must not infer the production app's process settings from its own environment. Target application memory, in-flight HTTP, actual process environment, signal delivery, shutdown grace, other-writer quiescence and replay/resume are not collected.

Every report retains `hold: true`. Positive unfinished-work counts mean no-go. Incomplete reads, snapshots, discovery or cleanup also mean no-go. Complete zero samples mean only zero observed in that interval, never readiness to deploy, freeze, export, restore or submit to Shopify. Intake totals are observations, not proof of no writes; updates can leave counts unchanged and cross-store samples are not atomic.

The SQL catalogue is pinned to the reviewed source/schema. No user-selected table, filter, SQL, key, queue, timeout or arbitrary output label is accepted. Future source/schema changes require renewed coverage review, not an assertion that this catalogue covers every writer. The query catalogue excludes customer records, business payloads, keys and identifiers from output. Counts and bounded ages remain operationally sensitive aggregates and still require explicit disclosure approval.

## Protection limits

TiDB read-only transaction labels do not enforce read-only access. With an application identity, the honest protection label is `statement_guard_only`; fixed code is not a database permission boundary. Prefer an existing SELECT-restricted identity where available, subject to provider and owner approval. This operation does not create, rotate, widen or export an identity.

Snapshot failure has no silent successful fallback. Failed rollback, timeout or uncertain cleanup invalidates the sample and requires disposal of the observer's own connection. Killing an observer connection does not prove other writers stopped. Redis discovery is capped and non-atomic. The cap is at most 100 `SCAN` calls of `COUNT 1000` per sample, which covers about 100,000 keys. That is enough for the keyspace the application itself retains: every queue keeps up to 1,000 completed and 5,000 failed jobs, about 36,000 job keys, which a real Redis 7 walked in 37 calls. The earlier cap of 10 calls of `COUNT 100` covered about 1,000 keys, so it could not finish on any Redis that had run more than about 150 jobs per queue. No reconnect, retry, queue construction, lock acquisition, enqueue or data cleanup is permitted in the future live job.

## Before any live adapter or launch

Claude must review the catalogue, schema coverage, query plans/read load, strict output guard and failed-cleanup semantics. A later separately reviewed production adapter must verify TLS identity, use only separately approved provider references, and refuse stale or ambiguous source/target/store mapping before connection. This preparation has no runtime reference mechanism and cannot attest such a mapping.

The owner must separately approve the exact target, artifact pins, provider reference grants, read/output scope, costs/cap, launch time, maximum lifetime and disposal authority. Configure one replica, manual launch only, no cron, no autodeploy, no public network/port, Never restart and independent provider kill limits. Process-local single-use state is not provider-enforced exactly-once operation; a failed run consumes approval. An authorised operator can still redeploy, and that must remain prohibited without renewed approval.

Build a reviewed standalone image without production credentials, application install hooks, migrations or instrumentation. Do not point Railway at the normal repository build recipe. Provider variable masking is secondary only: fixed, validated output must be screened inside the observer before logging. No raw driver diagnostics, stack traces, connection URLs, environment, key names or customer data may be released. The synthetic artifact tests normal/error paths but cannot attest provider instrumentation or infrastructure crash handling.

## Unchanged production gates

This does not authorise retirement of existing records, cleanup of old jobs, production shutdown, merging held grace PRs, export/restore, resource purchase or Shopify submission. The existing recovery and Shopify no-go gates remain in force.

## Synthetic target-binding guard

The separate artifact increment includes a pure approval/facts comparison guard. It rejects changed source or deployment, a target service substituted by the observer, inconsistent reference-source service IDs, stale or future-dated facts, expired approval, extra fields and accessor/proxy inputs. Even matching inputs return `synthetic_only`, `liveEnabled:false`, `hold:true`. This is tested syntax/equality/recency checking, not authenticated retrieval of Railway facts, inspection of the provider reference graph or a granted credential path. It is not an assertion that the production binding or transport gate is closed.

## Decoder-memory limit is not proven

The core rejects capped/malformed SCAN results, and the loopback adapter checks decoded key counts and lengths before passing results to it. ioredis has already received and decoded the response at that point. These are **post-decode acceptance bounds**, not a wire-byte or parser-allocation cap. A later live adapter and its independent provider memory/lifetime controls must address that gap before a runtime resource-bound claim is made; Redis COUNT is only a hint. The current adapter remains test-only and absent from the executable artifact.
