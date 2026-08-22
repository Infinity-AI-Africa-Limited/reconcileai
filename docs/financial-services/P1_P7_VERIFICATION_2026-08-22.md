# P1–P7 Verification — what is actually closed, and what is not

**Verified by:** Claude Code (production engineering), 22 August 2026
**Against:** *ReconcileAI Financial Services Go-Live Readiness and Bank Deployment Plan*, 21 August 2026 (Manus AI)
**Branch:** `manus/fs-go-live-foundations` — [PR #96](https://github.com/Infinity-AI-Africa-Limited/reconcileai/pull/96)

> **Bottom line: no, P1–P7 are not fully completed, and most of them cannot be completed by this PR.**
> The change set closes the *code-enforceable* portion of each item. The majority of the plan's
> stated exit criteria are infrastructure, evidence artefacts, or bank sign-offs that no pull
> request can produce. One item — the durable queue — is materially incomplete even in the parts
> we control.

---

## 0. First, a naming collision that will cause a misunderstanding

The plan uses **P1–P7 twice, for two different things**, and the PR implements the second list
while being labelled with the first.

| Plan §3.1 — *pilot blocker* register | Plan Phase 1 — *work items 1–7* (weeks 1–3) |
|---|---|
| P1 Strict tenant ownership of exception data | 1 Exception tenancy non-null + legacy remediation |
| P2 Durable job processing | 2 Provision **and** enforce the durable queue |
| P3 Approved data and AI boundary | 3 Remediate or risk-accept dependency findings |
| P4 Identity/session hardening | 4 Replace year-long sessions + step-up control |
| P5 Software supply-chain remediation | 5 Bank-required storage/key posture |
| P6 Segregated environment and residency proof | 6 Per-tenant AI-off switch + data minimisation |
| P7 Named operational owners | 7 Audit evidence → infrastructure-immutable |

**The PR implements Phase 1 work items 1–7.** Read against the §3.1 register instead, "P1–P7 done"
would claim that the segregated bank environment (P6) and the named operational control owners (P7)
are closed. **Neither is touched by this PR, and neither is engineering work.**

Everything below is assessed against the **Phase 1 work items**, since that is what was built.

---

## 1. Item-by-item verification

Legend: **Code** = enforceable in the application and shipped here. **Evidence** = the artefact or
test record the plan names as the exit criterion. **External** = bank or infrastructure action.

### Item 1 — Exception tenancy non-null + legacy ownership remediation

*Exit criterion: migration/backfill report; two-tenant access-negative tests; independent review.*

| | Status |
|---|---|
| Code | **Done.** `exceptions.organizationId` is `NOT NULL`; writes assert a valid owner; reads are org-scoped and the ratchet exemption is gone. Migration `0084` derives ownership **from the parent reconciliation job only** and refuses to guess. |
| Evidence | **Partial.** Measured against production directly: **543 exceptions, 0 unowned, 0 quarantined, 0 transaction/job tenant mismatches.** That is a measurement, not the formal backfill report the plan asks for. Two-tenant negative tests exist for channels, jobs, guest privilege and the public API; there is no dedicated two-tenant negative test for `exceptions` specifically. |
| External | **Open.** Bank runs its own tenant-isolation acceptance test against integration data. |

**Not fully closed.** Code is done; the named artefacts are partial.

### Item 2 — Provision **and** enforce the durable queue

*Exit criterion: Redis/BullMQ health evidence; worker-kill, retry, dedupe, concurrent-worker and DLQ test record.*

| | Status |
|---|---|
| Code | **Done.** `RECONCILIATION_REQUIRE_DURABLE_QUEUE=true` (and on-premise mode) refuses a run before the job row is created rather than silently falling back in-process. Deterministic BullMQ job ids give dedupe; abandoned entries are removed. |
| Evidence | **Missing.** None of the named tests exist. Queue tests use injected fakes — they prove the handler's decisions, not BullMQ behaviour. No worker-kill, concurrent-worker, or DLQ test record exists. |
| External | **Missing. Redis is not provisioned.** `REDIS_URL` is unset; the platform runs the in-process fallback today. |

**This is the least complete item and the one most likely to be misread.** The flag *refuses*
unsafe processing; it does not *provide* safe processing. Until Redis exists, setting the flag turns
reconciliation off rather than making it durable. Tracked in CLAUDE.md §10 as still open.

### Item 3 — Dependency remediation or formal risk acceptance

*Exit criterion: updated production audit, SBOM, reachability classification, security approval.*

| | Status |
|---|---|
| Code | **Done.** tRPC, Axios, Drizzle and NanoID updated within compatible majors. |
| Evidence | **Partial.** `pnpm audit --prod` re-run independently: **10 high, 19 moderate, 5 low (34 total)** — the claimed reduction from 25 high is confirmed. **No SBOM exists in the repository.** No reachability classification exists. |
| External | **Open.** Bank InfoSec approval of the residual findings. |

**Not fully closed.** The audit improved and is verified; three of the four named artefacts are absent.

### Item 4 — Replace year-long sessions with bank-approved session/step-up control

*Exit criterion: auth design, re-auth tests, CSRF results, security sign-off.*

| | Status |
|---|---|
| Code | **Done.** `SESSION_TTL_MINUTES`, default 8h, clamped to 15 min–24 h, applied on magic-link and SSO. **Additionally closed in review:** `sdk.signSession` still defaulted to `ONE_YEAR_MS`. Every current caller passed an explicit TTL so behaviour was unchanged, but a future caller that omitted it would have silently minted a one-year bank session. The default is now the bounded policy. |
| Evidence | **Partial.** `sessionPolicy.test.ts` covers the TTL policy. No CSRF test record. |
| External | **Open.** Bank selects the TTL, MFA/conditional access, and which actions require step-up. |

**Not fully closed. Step-up re-authentication is not implemented at all** — there is no such code
path in the repository. The plan lists it as part of this item.

### Item 5 — Bank-required storage/key posture

*Exit criterion: dedicated key/KMS design, short presign policy, access logs, scoped storage-key migration, recovery test.*

| | Status |
|---|---|
| Code | **Done.** On-premise boot refuses JWT-derived tenant-key wrapping; requires a dedicated 64-hex `TENANT_MASTER_KEY` or an explicit `TENANT_KMS_KEY_ID`. |
| Evidence | **Missing. Presigned URLs live for 6 days** (`PRESIGN_TTL_SECONDS` in `server/storage.ts`). That is the opposite of the "short presign policy" this item requires. It is *not* a one-line fix: CFO report URLs are emailed, so shortening the TTL without moving those recipients to the token-gated proxy route would break already-delivered links. Flagged rather than silently changed. Legacy non-org-scoped storage keys still exist (e.g. `reports/cfo/…`) per CLAUDE.md §10. No recovery test. |
| External | **Open.** Customer generates, escrows and rotates the key, and evidences the lifecycle. |

**Not fully closed**, and the presign lifetime is a concrete bank-readiness defect worth scheduling.

### Item 6 — Per-tenant AI-off switch + data minimisation

*Exit criterion: tenant-level test evidence proving no model call occurs when disabled.*

| | Status |
|---|---|
| Code | **Done.** `organizations.aiAssistanceEnabled`, super-admin toggle under an audit event, one decision in `server/aiGate.ts`, fail-closed on absent tenancy. **The switch as originally written guarded 1 of 5 model entry points.** Review found four more (`superAgent.query`, `superAgent.diagnose`, `anomalies.detect`, the public API diagnose endpoint) and a fifth later (`assessment.submit`). All are now gated. |
| Evidence | **Done — closed in review.** `aiGateBehaviour.test.ts` mocks the transport and proves no model call occurs when disabled, each case paired with its enabled counterpart so the assertion cannot pass vacuously. `aiGateRatchet.test.ts` fails the build if a new model call site appears ungated — verified to fail when a gate is removed. |
| External | **Open.** Customer approves AI mode per environment. |
| Data minimisation | **Missing.** The plan lists it in this item; no prompt-minimisation work was done. |

**Closest to complete.** The test-evidence criterion is genuinely met; data minimisation is not.

### Item 7 — Audit evidence → infrastructure-immutable

*Exit criterion: WORM/append-only design, write-deny test, audit-export verification.*

| | Status |
|---|---|
| Code | **Done.** On-premise boot requires `AUDIT_IMMUTABILITY_MODE` to be `worm_s3` or `db_write_deny`, and explicitly refuses to treat application hash-chaining as immutability. |
| Evidence | **Missing.** No WORM design document, no write-deny test, no export-verification procedure. |
| External | **Open.** Customer provides object-lock evidence, or DB grants denying the application identity `UPDATE`/`DELETE`. |

**Not fully closed.** The code enforces that a mode has been *declared*; it cannot verify the
storage actually is immutable. That distinction is the whole point of the item. The code is honest
about it — but a declaration is not the property.

---

## 2. Summary

| Item | Code shipped | Named evidence produced | Blocked on external action |
|---|---|---|---|
| 1 Exception tenancy | Yes | Partial | Bank acceptance test |
| 2 Durable queue | Enforce only | None | **Redis not provisioned** |
| 3 Dependencies | Yes | Audit only; no SBOM | Bank InfoSec approval |
| 4 Sessions | Yes | No CSRF record; **no step-up** | Bank IAM policy |
| 5 Storage/keys | Yes | 6-day presign; legacy keys | Customer key lifecycle |
| 6 AI boundary | Yes | Yes | Customer AI-mode approval |
| 7 Immutable audit | Declaration only | None | Customer WORM/grant evidence |

**One of seven items has its stated exit criterion met.** The rest are partially closed, and item 2
is the one to watch: it is the only place where the code's enforcement could be mistaken for the
capability itself.

None of this contradicts the PR. Its own description says it implements "the code-enforceable
portions" and that "Redis/BullMQ, KMS/WORM evidence, external pen testing, and bank approval remain
deployment gates". That framing is accurate. The risk lies only in the shorthand "P1–P7 done".

---

## 3. What this PR does not change

The plan's gate assessment stands unaltered: **G0 demo-safe — met. G1 pilot-safe — not met.
G2 bank-production — not met.** This PR moves work *inside* G1; it does not close G1.

The plan's own safety boundary also still holds, and should be restated in any bank conversation:
the deterministic engine retains authority for amounts, matching, balances and settlement status.
The AI layer explains, classifies and drafts recommendations. It does not decide.

---

## 4. Recommended next actions, in order

1. **Provision Redis** on Railway and in the pilot environment, then produce the worker-kill,
   concurrent-worker, retry and DLQ test record. This unblocks item 2 and is a prerequisite for
   horizontal scaling regardless of the bank track.
2. **Generate an SBOM** and classify the 10 remaining high findings by server reachability, so the
   bank is asked to accept a short, argued list rather than a raw audit dump.
3. **Decide the presigned-URL policy** — either move emailed report links to the token-gated proxy
   route and shorten the TTL to minutes, or document the 6-day lifetime as an accepted risk.
4. **Scope step-up re-authentication** with the bank: which actions require it, before it is built.
5. Treat data minimisation (item 6) and the WORM/write-deny evidence (item 7) as joint design work
   with the institution, not as engineering backlog.
