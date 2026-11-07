# Durable observer runtime preparation

Status: review-only engineering. No live connection, infrastructure resource, secret connector, token, production change, merge or deployment is authorised by this document. The founder has delegated operation to Manus; the older human-run instructions are a fallback, not an obligation on a non-technical founder.

## Reviewed predecessor

This increment stacks on Claude's reviewed packaging head `5bdd420` and inherits the reviewed core head `e7dc06c`. Waiting, active and runnable work block the unfinished-work verdict; retained failed jobs and parked human-review items remain reported, but are not silently reclassified as running. Delayed work is conservatively treated according to the reviewed catalogue. These semantics are not changed here. HOLD remains unconditional, and zero observed never proves a safe replacement or a write freeze.

## Reuse rather than replace

`runtimeAdapters.ts` imports the exact existing route planners and connection functions from Claude's public preflight, preserved byte-for-byte at `b3b323f759dbe205653847af3ad424ce0e93c95f`. Provenance and SHA256 are in `scripts/durable-observer/vendor/PROVENANCE.md` and `provenance.json`. The adapter exposes fixed catalogue identifiers, not arbitrary SQL, Redis commands or keys. It does not read process credentials, application secrets, dotenv, platform tokens, or customer records.

The connection helpers run their original TLS and private-route checks. The outer adapter tightens host validation, fixes deadlines, owns transports during partial setup, rejects malformed aggregate results, poisons failed connections, propagates snapshot/rollback failures, and disposes late completions. Database read protection is still `statement_guard_only`, not TiDB-enforced read-only access. Setup includes the reviewed version SELECT and session UTC setting. A SELECT-only database identity would add real privilege protection but is not created here.

Redis reply bounds apply after driver decoding; there is no claimed pre-decode RESP memory cap. Runtime DNS-name checks are lexical, not independent DNS-answer/socket-peer attestation. Actual TiDB and production TLS have not been tested.

## Independent platform identity, narrowly scoped

`platformIdentity.ts` contains fixed typed GraphQL query documents for the project-token scope and the target's owning IDs, active-deployment membership and repository configuration. A future authenticated secure connector supplies the request capability. The manifest must be independently approved; the observer's identity must never substitute for the app's identity. Tests replace only the transport and exercise the real query/parser logic.

No query requests variable values, `variables(unrendered: true)`, opaque `Deployment.meta`, logs, process payloads or undocumented reference strings. Railway's published schema does not currently establish a safe projected deployed-commit field or a documented reference-source attestation. Therefore successful platform checks prove platform identity only; they do not unlock data-store access or claim the app artifact and references verified. Freshness, exact identifiers, ambiguity, malformed responses, errors, aborts and expiry fail closed.

The capability is an engineering interface, not an already-configured connector, credential vault or authenticated channel. No platform API has been called with a private token.

## Standalone preparation artifact

`buildRuntimePreparation.mjs` builds a library containing the adapter and identity checks while keeping the original preflight as a separate hash-verified module. Bundling that original module into an executable entry could make its direct-entry check true; this build explicitly refuses that inclusion. Import tests cover the no-side-effect boundary.

The artifact's only default entrypoint is `refuseLive.mjs`, which exits with HOLD. This is not a production-ready Railway image or an enabled production launcher. No app entrypoint, Railway app recipe, automatic deployment, network endpoint, cron, queue worker, token lookup or data reference is added. The original synthetic launcher and its closed output schema remain unchanged.

## Remaining work before a real run

1. Claude review of these source changes and verified tests, including the reused helper provenance and failure disposal.
2. Establish an actually available secure connector-entry mechanism. The key must stay in that connector; do not place it in the app, observer, files, logs, shell arguments, chat or PRs. Prefer an environment-scoped project token. Do not escalate to workspace/account privilege automatically.
3. Obtain independently trusted deployment/artifact and source-reference evidence without retrieving the whole variable map. A successful write-only reference receipt is not resolution or read-back proof.
4. Choose a pre-provisioned approved destination or prove the service-creation scope. Railway's schema warns creation can affect other non-fork environments; do not assume one-environment creation.
5. Build and verify an immutable runtime image with the actual reviewed dependencies, no secret build arguments, no public domain, no automatic deployment or cron, and Never restart.
6. Issue a reviewed live report format and launcher. Do not label a future live run `synthetic_only` merely to reuse the current schema. Keep all coverage gaps and HOLD semantics explicit.
7. Present the founder an exact one-shot plan, access scope, resource boundaries, measured cost estimate/cap, duration and removal procedure. Obtain separate approval for paid resources, credentials/access and the live probe. Preparation approval is not that approval.

## Founder-facing proposed limits, not an approved run

The intended diagnostic is one attempt, three aggregate samples, bounded by the reviewed core's five-minute run budget plus connection/cleanup allowance. Proposed resource lifespan is at most 30 minutes, with a proposed $1 incremental-cost ceiling; these are approval proposals, not a quote or an enforceable Railway billing limit. Confirm live plan rates and allocation before provisioning, and refuse if the estimate cannot stay within the approved cap. Process exit does not remove a Railway service; verify resource removal separately and ask for any required destructive confirmation. No retry or re-run without a new decision.

The production app stays online and unchanged. No data clearing, job retry, queue purge, write freeze, restart, database export, restore, credential rotation or automatic merge is included. A later maintenance/recovery operation requires its own decision even if this diagnostic returns zeros.

## Independent review correction

The focused review found that a timer-only deadline could accept a delayed driver result if response decoding blocked the event loop past the operation budget. `OwnedStore.run` now also compares a monotonic clock after successful promise completion, rejects overdue results, drops the store and preserves cleanup-failure precedence. Deterministic synthetic regressions cover database reads, Redis reads and cleanup without waiting for a real network timeout. This is a source-level correction, not live production evidence.

## Final corrected-source validation — 7 November 2026

Source/test compiler checks, lint and application build passed. Observer suite against new disposable MySQL/Redis: 368 passed; serial real reused-driver integration: 1 passed. Without fixture opt-in: 365 passed with four intentional skips. Full repository regression on new local MySQL: 5,761 passed, 25 skipped; 342 files passed, five skipped. Committed migrations and drift passed. Tests include the distinct-module runtime artifact, import without CLI activation, default refusal, immutable provenance, fixed platform-query parsing and the monotonic late-result correction. Temporary database/Redis processes were stopped and fixture data removed. No live TiDB/TLS handshake, Railway credential, private platform query or production data was involved.
