# P2 — Durable processing: evidence pack

**Produced by:** Claude Code, 22 August 2026
**Against:** *Financial Services Go-Live Readiness and Bank Deployment Plan*, Phase 1 work item 2
**Exit criterion:** *"Redis/BullMQ health evidence; worker-kill, retry, dedupe, concurrent-worker and dead-letter tests recorded."*

> **Status: the engineering half is closed. The provisioning half is not.**
> The tests below ran against a real Redis and pass. `REDIS_URL` is still unset in
> production and in the pilot environment, so the platform runs the in-process
> fallback today and item 2 remains open until an addon is provisioned.

---

## 1. Health evidence

Before this work, production **could not report which queue backend was live**. An
instance running BullMQ and one running the in-process fallback were
indistinguishable from outside — so nobody could tell whether a reconciliation
run would survive a restart. That is the exact evidence the criterion asks for.

`/api/health` now carries a `queue` check. Verified in both states:

| Environment | Reported |
|---|---|
| `REDIS_URL` set | `status: "ok"`, `durable: true`, live counts `{waiting, active, completed, failed, delayed}` |
| `REDIS_URL` unset | `status: "degraded"`, `durable: false` |

**`degraded` is deliberately not fatal.** Production runs the fallback today, so
treating it as an error would have flipped `/api/health` to 503 on deploy —
turning a known, accepted state into a page. The durability fact is machine-
readable in `checks.queue.durable`; only a genuinely broken dependency is fatal.
Railway's own probe (`/api/healthz`) is untouched.

## 2. Failure-mode tests

`server/jobQueue.durability.test.ts`. Skipped unless `REDIS_URL` is set, so CI
stays green today and the suite **activates automatically** the moment the addon
exists. Run locally with:

```bash
docker run -d --rm --name reconcileai-test-redis -p 6380:6379 redis:7-alpine
```

| Criterion | Test | Result |
|---|---|---|
| health evidence | reports backend + counts | ✅ |
| dedupe | same job name enqueued twice → runs **once** | ✅ |
| dedupe (negative) | different names → runs **twice** | ✅ |
| dedupe (scope) | `webhook-delivery` names repeat by design → **not** de-duplicated | ✅ |
| retry | failing job attempts exactly its limit, then stops | ✅ |
| dead letter | exhausted job retained in the failed set and inspectable | ✅ |
| queue-entry removal | a waiting entry can be removed | ✅ |
| concurrent worker | two workers, one job → delivered to exactly **one** | ✅ |
| worker-kill | worker dies holding a job → redelivered to another worker | ✅ |

**9/9 against a real Redis.**

Every "did not happen" assertion is paired with its positive counterpart. A
dedupe test that only checks "ran once" passes just as happily when the queue is
broken and runs nothing at all; the pair is what makes it evidence.

## 3. Two findings from actually running it

**a. The premise of the whole recovery design is now verified, not assumed.**
Seven review rounds on PR #96 turned on one claim about the platform: *a durable
entry can be delivered to a worker after the recovery sweep has already declared
that job dead*. Every guard — `abandonedAt`, the atomic claim, the completion
reclaim — exists to handle that. Nobody had ever run it. The worker-kill test
does, and the claim holds.

**b. Redelivery is gated by `lockDuration`, not `stalledInterval`.**
This corrected a wrong assumption of mine mid-test. `stalledInterval` only sets
how often BullMQ *checks*; the job's lock must have actually expired before
another worker may take it. BullMQ's default `lockDuration` is **30 seconds**.

*Operational consequence:* a crashed worker's job is not redelivered instantly —
it waits out the lock. Anyone tuning `STUCK_JOB_MAX_AGE_MS` (currently 2h) or
reasoning about recovery latency needs that number. It is a platform default we
have not changed and should not change without measuring.

## 4. What remains open

1. **Provision Redis** — Railway addon, then the pilot environment's own instance.
   The suite runs itself once `REDIS_URL` exists.
2. **Run it against the pilot's Redis**, not just a local container. Managed Redis
   differs in eviction policy, TLS and failover; BullMQ requires
   `maxmemory-policy noeviction` — an evicting Redis silently drops jobs.
3. **A 500k-transaction run against the 2-hour staleness window.** This is the
   open question from PR #96 that no amount of review could settle:
   `runMatchingEngine` is synchronous and blocks the event loop, so the liveness
   heartbeat cannot fire during it. Only a real run at real volume shows whether
   a single matching pass can approach the window.
4. **Bank-approved instance** — for the pilot, P2's Redis is the institution's
   infrastructure (see P6), not ours. This evidence pack transfers; the
   provisioning does not.

## 5. Honest scope

This closes what engineering controls. It does **not** make the platform durable
in production — that needs step 1. And per the plan's own gate definitions, G1
(pilot-safe) stays open regardless: P3, P6 and P7 require a named institution,
its DPO and its infrastructure, none of which can be closed from this repository.
