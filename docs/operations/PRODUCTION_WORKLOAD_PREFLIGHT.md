# Production workload preflight: the command package

> **Status: prepared, NOT run.** No approval to run it exists. The live-run
> hold and the maintenance hold both remain. Nothing in this package has
> touched production: no connection, no data change, no merge, no deploy, no
> restart, no credential.

This is the corrected package that answers Manus's approval review of
5 November 2026. It covers the review's three corrections, the explicit
whole-run budget, a coverage check against the revision production now runs,
and the TLS and route confirmation the review asked for.

The pieces:

| Piece | What it is |
|---|---|
| `scripts/production-workload-preflight.mjs` | The probe. It is read-only and aggregate-only. It counts the unfinished work a deployment replacement could cut off. |
| `scripts/production-workload-preflight.sh` | The operator's routine. It downloads the pinned probe, verifies it, runs it within a time limit, and cleans up. |
| `scripts/productionWorkloadPreflight.test.ts` | The probe's tests: 175 cases. |
| `scripts/productionWorkloadPreflightWrapper.test.ts` | The routine's tests: 33 cases, run under both dash and bash. |

## 1. The pin

| | Value |
|---|---|
| Probe commit | `6c9243f20837ca8ef13c9edacdd39e4234461774` |
| Probe SHA-256 | `9cf0ee931d3643a4b2367e985d2d779d8569a7eea72dffb5c887fb5ee4a31aab` (67,225 bytes) |
| Probe URL | `https://raw.githubusercontent.com/Infinity-AI-Africa-Limited/reconcileai/6c9243f20837ca8ef13c9edacdd39e4234461774/scripts/production-workload-preflight.mjs` |
| Routine commit | `94d0cd1b2a92d76fe16f7592c664e0c4319ac19f` |
| Routine SHA-256 | `a01f2938dceb5016f638fb5855445996cf89ab72c4e65d47392399fff58cdb00` |
| Report schema | `reconcileai_workload_preflight_v2` |

On 2026-11-05, after the push, both URLs were fetched from outside the
repository, and each served bytes with exactly the checksum above. The routine
carries the probe's commit and checksum as constants.
`productionWorkloadPreflightWrapper.test.ts` fails when:

- the routine's checksum differs from the committed probe's bytes;
- or, where the checkout holds the pinned commit, that commit's probe has
  different bytes.

The pinned commits exist only on the branch `claude/production-workload-preflight`.
**Keep that branch until the run is over.** If the branch is deleted, GitHub may
eventually stop serving its commits, and the download step would then fail
closed with exit 15.

## 2. What changed, against the review

### 2.1 The target's identity is proven before anything is loaded or connected

The probe now refuses, with exit 4, a fixed code and zero connections, unless
every one of these holds:

| Check | Refused as |
|---|---|
| `--expect-deployment` is given | `identity_expected_deployment_missing` |
| It is a full lowercase UUID, not a prefix or template text | `identity_expected_deployment_malformed` |
| It is not a placeholder: the nil or example UUIDs, fewer than six distinct digits, a repeating pattern, or a counting run of eight | `identity_expected_deployment_placeholder` |
| The same three checks for `--expect-commit` (a full 40-hex SHA) | `identity_expected_commit_*` |
| With `--env-from-app`: exactly one `node dist/index.js` process, whose environment can be read | `identity_app_process_not_found`, `_ambiguous`, `_unreadable` |
| `RAILWAY_REPLICA_ID` is set, which happens only inside a Railway deployment | `identity_not_railway_runtime` |
| `RAILWAY_DEPLOYMENT_ID` equals the expected deployment | `identity_deployment_missing`, `identity_deployment_mismatch` |
| `RAILWAY_GIT_COMMIT_SHA` equals the expected commit | `identity_commit_missing`, `identity_commit_mismatch` |

The old check compared prefixes, and only reported a mismatch after the queries
had run. There is no longer any fallback to PID 1 or to the operator's shell.

Three kinds of test show "zero connections":

- **Mocked openers.** The connection openers are replaced with counters, and
  every refusal leaves all three at 0.
- **A real socket.** The real script, run as a command against a listening
  socket that counts connections, records 0.
- **Stub drivers.** An application directory whose `mysql2`, `bullmq` and
  `ioredis` record being loaded stays empty on a refusal. A control run shows
  the same stubs do load once the identity matches.

### 2.2 An incomplete Redis queue discovery is incomplete evidence

The scan for queues the code does not know reads `partial` when either:

- it reaches its round limit (500 rounds of `SCAN … COUNT 1000`, which covers
  far more than the roughly 36,000 job keys the retention settings allow);
- or a failure cuts it short.

A partial reading is missing evidence, so the verdict is
`no_go_incomplete_evidence`. Work it did see still counts: known unfinished
work beside a partial scan stays `no_go_unfinished_work`.

Job inspection, which reads retry and stall counters, is now capped at 200 ids
per state, down from 1,000. It is labelled `job_inspection: partial` when capped
or cut short. The runnable counts are exact either way.

### 2.3 The routine replaces the PDF's command block

`reconcileai_preflight` is one scoped routine in POSIX sh. Its body is a
subshell, so none of its settings, traps, variables or directory changes reach
the operator's shell. In order, it:

1. checks its arguments, every tool it uses (node 20 or later, curl, sha256sum,
   mktemp, and GNU `timeout` with its flags), and the application directory: the
   built app, with `mysql2` and `bullmq` resolvable;
2. creates its own directory with `mktemp -d` (mode 0700). There is no fixed
   path: a stale `/tmp/preflight.mjs`, or another run's directory, is never
   read, overwritten or deleted. The tests check both;
3. downloads with `curl -q --fail --proto =https --tlsv1.2`. The `-q` means no
   `.curlrc` applies;
4. compares the pinned SHA-256, then sets the file to 0400 and the directory
   to 0500;
5. runs the probe through a loader that reads the file once, checks the same
   SHA-256 on those bytes, and executes exactly them. A file replaced after
   step 4 is therefore never run;
6. bounds the run: the probe's own 300-second budget, then `timeout` at 360
   seconds, then a kill 10 seconds after that;
7. exits with the probe's own status;
8. removes its directory on success, on failure, and on Ctrl-C, SIGTERM or
   SIGHUP, after stopping the probe. A second Ctrl-C cannot interrupt the
   cleanup.

> **Not claimed:** a SIGKILL, or the loss of the container, can leave the
> directory behind. It holds only the probe's code.

### 2.4 The whole run has a budget

`--budget-seconds`, default 300, bounds the run. The probe refuses a budget too
short for the sampling it was given.

Every statement and Redis command checks the budget first. At the deadline, the
probe:

- drops its own connections, so anything waiting on them fails at once;
- records `budget_exceeded` against each reading it lost;
- reports `sampling.budget_exhausted: true` and incomplete evidence.

Work it had already seen keeps its no-go verdict. Ending the run early stops,
cancels and changes nothing else.

Each wait also has its own limit:

- 15 seconds per statement, with the server-side `MAX_EXECUTION_TIME(10000)`
  hint kept;
- 10 seconds per connection attempt;
- 5 seconds per Redis command.

SIGINT, SIGTERM and SIGHUP print a fixed code and exit 5.

## 3. Exit statuses

| Status | From | Meaning |
|---|---|---|
| 0 | probe | Report printed. Read its `VERDICT`. **0 is never approval.** |
| 2 | probe | Options refused (`usage_error`, `budget_too_short`) |
| 3 | probe or loader | Failed (`preflight_failed`, `output_refused`, `probe_load_failed`) |
| 4 | probe | Target refused before connecting (`identity_*`, `route_*`) |
| 5 | probe | Interrupted |
| 10 | routine | Usage |
| 11 | routine | A tool is missing or unsuitable |
| 12 | routine | An expected identity is malformed |
| 13 | routine | The application directory is unusable |
| 14 | routine | The private directory failed |
| 15 | routine | The download failed |
| 16 | routine or loader | The checksum did not match (`checksum_mismatch`, `probe_checksum_mismatch`, `probe_unreadable`) |
| 17 | routine | The routine itself was interrupted |
| 124 / 137 | routine | The time limit stopped the probe (137: it had to be killed) |

The routine's own failures are one line on stderr, `PREFLIGHT_WRAPPER: <code>`.
Its stdout is the probe's stdout alone.

## 4. How it would be run, once approved

Run it once, as a single three-sample baseline. The operator is Richard, or a
human operator he has explicitly authorised, working in a **private, unshared
terminal**:

- no recorded agent session;
- no tmux or other persistent capture.

Steps:

1. **Read the target's identity.** Immediately before the run, read two values:
   the ACTIVE production deployment's full id (a UUID) from the Railway
   dashboard, and the commit that deployment runs. `main` deploys
   automatically, so the active deployment can change at any time; never reuse
   values from an earlier day.
2. **Get the routine and check it.** On your own machine, fetch the routine at
   its pinned commit:

   ```bash
   curl -q --fail --silent --proto '=https' -o production-workload-preflight.sh https://raw.githubusercontent.com/Infinity-AI-Africa-Limited/reconcileai/94d0cd1b2a92d76fe16f7592c664e0c4319ac19f/scripts/production-workload-preflight.sh
   ```

   ```bash
   sha256sum production-workload-preflight.sh
   ```

   On macOS, use `shasum -a 256` instead. The checksum must read
   `a01f2938dceb5016f638fb5855445996cf89ab72c4e65d47392399fff58cdb00`.
3. **Open a shell in that deployment's container.** Do not register a new SSH
   key as part of this approval.
4. **Define the routine.** Paste the file's contents. This only defines the
   function.
5. **Run it:** `reconcileai_preflight <deployment-id> <commit-sha>`. The
   application directory defaults to `/app`. If it is elsewhere, the routine
   stops with exit 13 before downloading.
6. **Return only stdout's three lines:** the screened JSON report, `VERDICT:`
   and `GROUPS:`. Return nothing else:
   - no terminal transcript or raw logs;
   - no `/proc` contents or connection values;
   - no job ids or payloads;
   - no screenshots.

The download in step 5 is the only test of the container's outbound route to
GitHub. If it fails, the routine stops with exit 15, having run nothing.

### Reading the result

> ⚠️ **Unknown or mismatched identity, or incomplete evidence, keeps the HOLD.**

**An all-zero result is not approval to replace the deployment either.** These
remain separate gates:

- containment of sustained producer and ingress activity;
- evidence about in-memory state and other writers;
- the provider's actual draining and overlap timing. Manus's review cites
  Railway's documentation for a zero-second default grace on a singleton
  replacement; this session could not reach that documentation to confirm it,
  and this deployment's stored allowance has not been measured;
- replay and resume of work interrupted by a replacement.

## 5. What the approval must accept, and what it excludes

Suggested wording for the owner:

> I approve **one** run of the ReconcileAI workload preflight:
>
> - the probe pinned at `6c9243f2…` (SHA-256 `9cf0ee93…`);
> - run by the routine at `94d0cd1b…` (SHA-256 `a01f2938…`);
> - by *\<named operator\>*, in a private, unshared terminal;
> - inside the ACTIVE production deployment *\<deployment id\>*, running
>   commit *\<sha\>*.
>
> I accept:
>
> - **database write prevention by the probe's statement guard only**
>   (`statement_guard_only`), not by the database;
> - **a modest, nonzero read load**, as listed below;
> - **the session controls** named below;
> - **14 named environment fields**, read privately in memory from the
>   application process and never printed;
> - **a global budget of 300 seconds**, with a hard stop at 360;
> - **aggregate-only reporting**.
>
> Excluded:
>
> - cleanup of unfinished records;
> - any production credential change, a SELECT-only database user included;
> - schema changes, merges, restarts, exports and restores.
>
> Only the screened JSON report and its two summary lines come back.

**Database, per run:**

- **Connection:** a TLS handshake with the server's certificate and host name
  verified, then authentication.
- **Session statements:** `SET time_zone = '+00:00'`, and, for each sample,
  `START TRANSACTION WITH CONSISTENT SNAPSHOT` … `ROLLBACK`.
- **Reads:** 104 constant aggregate `SELECT`s, each with `MAX_EXECUTION_TIME(10000)`
  (24 per sample, plus 13 intake counts in each of samples 2 and 3), and one
  `SELECT VERSION()`. That makes 106 statements in all, with the two session
  statements above.
- **Close:** `COM_QUIT`.

**Redis, per sample:**

- **Connection:** `AUTH` if the URL carries credentials, `SELECT` if it names a
  database index, then `PING`. `CLIENT SETINFO` is switched off.
- **Per known queue:** 11 count reads, and 5 range reads of at most 200 ids
  each. Each id gets one `HMGET` of the attempt and stall counters only, plus,
  for active ids, an `EXISTS` on its lock.
- **Discovery:** `SCAN … MATCH bull:*:meta COUNT 1000`, at most 500 rounds.
- **Close:** `QUIT`.

With empty queues, a sample is about 100 commands plus one `SCAN` per thousand
keys. The ceiling is about 7,300 per sample.

**The 14 environment fields:** `DATABASE_URL`, `REDIS_URL`, `RAILWAY_REPLICA_ID`,
`RAILWAY_DEPLOYMENT_ID`, `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_ENVIRONMENT_NAME`,
`RAILWAY_PROJECT_ID`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`,
`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`, `RECONCILEAI_DRAIN_TIMEOUT_MS`,
`RECONCILEAI_STARTUP_MODE`, `NODE_ENV`, `DEPLOYMENT_MODE`,
`RECONCILIATION_REQUIRE_DURABLE_QUEUE`.

## 6. Coverage, against the revision production runs

The probe was first written against the #222 merge (`4498649`). The branch now
contains `main` at `4efaac2`. That is the revision of the deployment that
GitHub's deployment records show Railway marking successful at 15:29 UTC on
2026-11-05.

That ACTIVE status is Railway's own report, read through GitHub. It was not
observed from inside Railway, and it can change with the next merge.

| Merged since #222 | Effect on what the probe must count |
|---|---|
| #220: webhook-delivery and Shopify manual-sync workers start at boot | None. The queues are already counted. Retained jobs now resume when a new deployment boots. |
| #221: SHOPLINE `shop/redact` recorded as open, with owner alerts | Already reflected: `sl_connector_gdpr_requests.received` is *parked*. Nothing processes it, so no replacement can cut it off. |
| #209: catch-up past 24 hours; no duplicate exceptions on re-read | None. Migration 0118 adds a watermark column (`syncedThroughAt`). A catch-up walk that is cut short resumes from it on the next poll. |
| #213: `appsubscription/paid` applied once per charge | None. Migration 0119 adds `sl_connector_billing_charges`, a ledger written inside the webhook's own transaction. It holds no pending state; its deliveries are counted through `sl_connector_webhook_events`. |
| #223: database-test pools in UTC | Tests only |
| #219: reconciliation worker starts at boot | None. `reconciliation-runs` is already counted. |
| #210: documentation | None |

**Queues.** The six `createQueue` call sites in `main` name exactly the six
queues the probe reads.

**Two ratchets keep this true.**

- A test fails when a `createQueue` call appears that the probe does not
  account for.
- Another fails when a migration newer than `0119_shopline_billing_charges`
  lands, until coverage is reconciled again.

**Schema.** The schema-copy tests ran against a database migrated from this
revision. Every state of every enum the predicates read is seeded and counted.

## 7. TLS and route confirmation, without printing configuration

**Database, the probe's own connection.**

- *Off the loopback interface*, the probe always verifies the server's
  certificate chain and its host name, whatever the URL asks. mysql2 3.15
  checks the host name only when `verifyIdentity` is set, and a URL can switch
  certificate checks off; the probe overrides both.
- *Before its first statement*, it confirms the socket is encrypted and
  authorised.
- *Without TLS*, it does not connect.
- *Every refusal is proven against real TLS handshakes.* The fake server's
  certificates are generated for each run, and these are all refused:
  - an untrusted issuer;
  - a trusted certificate for another name;
  - a server offering no TLS;
  - a URL that switches certificate checks off.

  A trusted certificate that names the host is accepted. The real MySQL fixture,
  reached by name, is refused on its self-generated certificate.
- **The report** carries `database_route: tls_verified_identity` with
  `database_connection: ok`.

**Database, the application's own connection.** This is a finding the run will
settle.

- The application connects with `createAppPool({ uri })`. So its host-name
  verification depends on production's `DATABASE_URL` carrying
  `ssl={"verifyIdentity":true}`. Its certificate verification is on unless the
  URL switches it off.
- That URL cannot be inspected from here. The report states its posture as one
  label, `deployment.application.database_tls`, without the value. The possible
  labels are:
  - `verified_certificate_and_hostname`;
  - `verified_certificate_only`;
  - `unverified`;
  - `not_requested`.
- Anything short of `verified_certificate_and_hostname` is worth raising
  separately. It is outside this package's scope.

**Redis.** The probe connects only over one of three routes:

- `*.railway.internal`, Railway's private network;
- `rediss://`, with the chain and host name verified by Node's defaults;
- the loopback interface.

A public plaintext route, such as Railway's TCP proxy, is refused with exit 4
before any connection. ioredis's own reading of the URL must agree with the
check. The report carries `redis_route`.

> **Not verified here:** this session could not reach Railway's documentation,
> because the network policy blocks it. So this package makes **no claim** about
> the private network's own encryption. It establishes only that the probe
> refuses public plaintext.

## 8. Synthetic results

Every scenario ran the real routine with its real pin. Each downloaded the real
pinned probe from GitHub, verified it, and ran it. The exception is F, where a
stand-in curl served altered bytes.

The application was a stand-in `node dist/index.js` process. Its environment
named:

- a synthetic Railway identity;
- disposable local MySQL databases, copied from the migrated schema;
- disposable local Redis databases.

For A, B, C and G, the stand-in application pointed at listeners that count
connections.

| | Scenario | Exit | What it printed | Connections (database / Redis) |
|---|---|---|---|---|
| A | The app is another deployment than the one named | 4 | `identity_deployment_mismatch` | 0 / 0 |
| B | The expected deployment is the nil UUID | 4 | `identity_expected_deployment_placeholder` | 0 / 0 |
| C | No application process is running | 4 | `identity_app_process_not_found` | 0 / 0 |
| G | The app's `REDIS_URL` is Railway's public TCP proxy | 4 | `route_redis_not_private` | 0 / 0 |
| F | The download served altered bytes | 16 | `PREFLIGHT_WRAPPER: checksum_mismatch` (the probe never ran) | 0 / 0 |

**D. Empty database and Redis, full run** (exit 0, 121 s):

```text
VERDICT: zero_observed_not_proof
GROUPS: reconciliation=pass_zero_observed queues=pass_zero_observed accepted=pass_zero_observed producers=no_intake_observed
```

- sampling: 3/3 samples, 60 s apart, budget 300 s, exhausted false, elapsed 120 s
- identity: env_source `app_process`, runtime `railway_runtime`, deployment matches true, commit matches true, checked before connecting true
- routes: database `local_loopback` → `ok` (engine `mysql`, snapshot `consistent_snapshot`, write prevention `statement_guard_only`); Redis `local_loopback` → `ok`
- last sample: non-zero surfaces none; runnable queues none; unknown queues `ok` (0, scan complete true)

**E. Seeded unfinished work, full run** (exit 0, 121 s):

```text
VERDICT: no_go_unfinished_work
GROUPS: reconciliation=fail_unfinished_work queues=fail_unfinished_work accepted=fail_unfinished_work producers=no_intake_observed
```

- sampling: 3/3 samples, 60 s apart, budget 300 s, exhausted false, elapsed 120 s
- identity: env_source `app_process`, runtime `railway_runtime`, deployment matches true, commit matches true, checked before connecting true
- routes: database `local_loopback` → `ok` (engine `mysql`, snapshot `consistent_snapshot`, write prevention `statement_guard_only`); Redis `local_loopback` → `ok`
- last sample: non-zero surfaces `reconciliation_jobs.unfinished=2`, `webhook_deliveries.pending=1`, `sl_connector_gdpr_requests.received=1`; runnable queues `reconciliation-runs=2`; unknown queues `ok` (0, scan complete true)

In E, the parked SHOPLINE erasure is reported but does not drive the verdict.
`accepted=fail_unfinished_work` comes from the pending webhook delivery.

These runs reached their fixtures on the loopback interface, so they do not
exercise TLS. The TLS routes are demonstrated by the test suite against fake
servers (§7). In that test, a full run of the real probe reports
`database_route: tls_verified_identity` and `redis_route: tls_verified`, both
`ok`.

Every run left the private temporary directory empty. That includes a run of D
stopped part-way by SIGTERM, during a first attempt that was discarded: the
harness had misplaced its fixture file, so D and E ran without their fixtures.

The test suites, run locally on 2026-11-05 against a MySQL 8.0 fixture migrated
from this revision and a Redis 7 fixture:

- **The probe:** 167 passed. The 8 skipped are the TiDB-engine cases, because
  no local TiDB was available.
- **The routine:** 33 passed.
- **The whole repository:** typecheck and lint are clean. The suite ran twice,
  because three existing tests need opposite environments: two require
  `REDIS_URL` to equal the Redis fixture, and one requires it unset.
  - With `REDIS_URL` unset, 5,594 passed, and only the two that need it set
    failed. Those two pass when it is set (6 tests).
  - With it set, 5,616 passed, and only the one that needs it unset failed.
  - So every test passed in the environment it requires. None of the three is
    related to this change.

**No PR exists for this branch, so CI has not run on it.**

## 9. Governance

**What was published.** The three commits after `4ee4c55` were pushed to the
already-published branch `claude/production-workload-preflight` on `origin`:

- the merge of `main`;
- the probe, `6c9243f`;
- the routine, `94d0cd1`;

followed by this document. No further publication is needed for the run. The
routine downloads from the pinned commit on GitHub, so it **does not need to be
merged**, and merging would deploy (`main` deploys to production
automatically).

**Not done:**

- no PR was opened;
- nothing was merged or deployed;
- no workflow was dispatched;
- `mirror` (`MistaRichMan/reconcileai`) was not updated. Claude sessions cannot
  reach it, so mirror parity stays with the owner.

**Review.** `origin` is authoritative. Merging any of this would need its normal
review and approval under branch protection. This package asks for neither: it
asks only for the run approval in §5.
