# Corporate B2B — Production Hardening Review

**Date:** 25 August 2026
**Scope:** The `corporate_b2b` vertical, reviewed against the three go-live records dated 22 August 2026:
the B0–B8 Platform Implementation Status, the Go-Live Readiness & Deployment Plan, and the Pilot Closure Register.
**Reviewer:** Claude Code (acting CTO role, CLAUDE.md §0)
**Standing conclusion, unchanged:** Corporate B2B is **not** pilot-ready. C0–C5 and C7–C11 remain
open on customer evidence. Nothing in this review closes a customer gate, and nothing here should be
read as doing so.

---

## 1. Why this review exists

The three source documents describe a set of platform controls as delivered. CLAUDE.md §0.1 says
those descriptions are evidence to check, not facts. Six of them did not survive the check. Each is
recorded below with what was actually true, because the gap between a document and the code is
exactly what a first customer pilot would have discovered on the customer's data.

---

## 2. Claims that did not hold, and what was done

### 2.1 The AI boundary (B5) closed one door out of five — **fixed**

> *B0–B8 status, gate B5:* "Corporate B2B AI-assisted diagnosis now fails closed unless a tenant
> records a `private_approved` AI route and approval reference… This is server-side policy, not a
> UI-only indicator."

Server-side, yes. One procedure, also yes. The check was written inline inside `superAgent.diagnose`.
Every other org-scoped model entry point ignored it, and the platform already had a register of
exactly what those are (`server/aiGateRatchet.test.ts`):

| Surface | Reached a model for a corporate_b2b tenant with no recorded route |
|---|---|
| `superAgent.query` | yes — exception and job context plus institutional memory |
| `anomalies.detect` | yes — transaction descriptions |
| `POST /api/v1/exceptions/analyze` | yes — exception plus network guidance |
| deferred background AI pass | yes |
| `superAgent.diagnose` | no — the one guarded path |

A boundary honoured on one of five doors is, from the customer's side, indistinguishable from no
boundary. That is the same argument that put the organisation-level switch into `server/aiGate.ts`
in the first place, so the pilot boundary now lives there too, and every gated entry point inherits
it. The refusal names its own reason: telling an operator to "re-enable it in organisation settings"
is wrong advice when the organisation switch is already on and the missing thing is a recorded route.

*Evidence:* `server/aiGateCorporateB2B.test.ts` (11 tests). Deleting the rule from `aiGate.ts` fails
6 of them plus a ratchet assertion — verified, not assumed.

### 2.2 B6 was hardcoded green while stating a condition it never tested — **fixed**

> *B0–B8 status, gate B6:* "The pilot page records the merged and proven Financial Services
> foundation release… durable queue / deployment profile evidence remains required where enabled."

The gate read `ready: true`, unconditionally, with that sentence as its description. Reconciliation
runs go through the job queue, and production has no `REDIS_URL`, so it runs the in-process fallback
and **loses queued work on restart**. B6 now reads the live queue backend and reports three states,
matching what `/api/health` already reports:

| State | Meaning | B6 |
|---|---|---|
| `confirmed` | a queue was built and is on BullMQ | closed |
| `configured_unverified` | `REDIS_URL` is set, nothing has connected — a wrong or unreachable URL looks identical | open |
| `fallback` | in-process; queued work lost on restart | open |

**Consequence to expect:** on the current production deployment B6 now shows **open**. That is the
correct reading. Provisioning Redis (CLAUDE.md §10, still the only open item there) closes it.

### 2.3 Many-to-many allocation is cited as a capability and has never run — **partly addressed, decision needed**

> *Go-Live plan §2.1:* "Complex allocation reasoning — `runM2MMatching` supports one-to-many,
> many-to-one and many-to-many allocation suggestions, including invoice-reference grouping."

`runM2MMatching` has **zero call sites**. It is imported into `server/routers.ts` and never invoked;
before this review it had no tests either. The Control Fit Brief's default corporate_b2b workflow is
"Distributor receipt to invoice allocation" — the pilot's headline promise is delivered by a function
nothing calls.

Worse, it was not safe to wire as written. `findSubsetSum` returned the **first** subset it reached
by sort order and the caller published it as an allocation at ~85% confidence. Three invoices of 100
against a receipt of 200 admits three equally valid splits; the engine picked one. On a receivables
ledger that is not a match, it is a fabricated allocation — found later as two wrong distributor
statements. It also accepted a single-item "subset", reporting a plain 1:1 near-match as a
one-to-many split, and divided by a zero-value receipt when scoring confidence.

**Done:** the allocator now distinguishes four outcomes — `unique`, `ambiguous`, `indeterminate`
(search budget exhausted, which is not the same as "no match exists") and `none` — proposes nothing
for the middle two, and reports them as `unresolvedAmbiguities` so a refusal is distinguishable from
finding nothing. Non-positive and non-finite amounts are excluded. 21 tests in
`server/m2mAllocation.test.ts`; reverting to first-hit-wins fails the two ambiguity tests, verified.

**Not done — owner decision:** the function is still not wired to any procedure. Wiring it is feature
work, not hardening, and it must land as a **read-only proposal** surface to stay inside B4 ("every
non-exact or many-to-many candidate stays proposed until a named human approves it"). Until then,
**do not describe many-to-many allocation as an available pilot capability.**

### 2.4 Deep diagnosis ran with no candidates, so it could never quantify a shortfall — **fixed**

> *Go-Live plan §2.1:* "FMCG deduction interpretation — the Super Agent recognises partial payments,
> promotional deductions, damage deductions, bank-fee deductions, tax deductions, split payments and
> duplicate invoices."

The classifier does recognise them. It was being called as `diagnoseException(txn, [], …)` — an empty
candidate list — commented "no target txns needed for standalone diagnosis". They are needed:

- `shortfall` was **structurally always null**, and the shortfall is the number a financial controller
  acts on. `agentActionDrafts.shortfallAmount` was therefore always null too.
- The narratives said "against an invoice of approximately NGN unknown".
- `bank_fee_deduction` and `fx_variance` are decided by comparing against a candidate, so **two of
  the twelve categories were unreachable** at the only call site.

The procedure now loads counterparty candidates — same tenant, same currency, restricted to the
channels this tenant's jobs actually pair this feed with, within the diagnosis date window and
capped (`db.getDiagnosisCandidates`). The first cut of that pool was too loose and was caught in
review; see §3A.1.

### 2.5 Configuration changes were audit-logged where the tenant cannot see them — **fixed**

> *B0–B8 status, gate B8:* "each configuration and source change is audit logged."

All four pilot mutations used the positional `logAudit`, which carries **no `organizationId`**. The
repo's own `logAuditStrict` docblock explains why that matters: the audit chain is scoped on
`organizationId ?? null`, so an event without one joins the **global** chain and is absent from the
tenant's audit listing, export and chain verification. The write looks audited and is not.

All four now use `logAuditStrict` with the resolved tenant, inside a transaction so the change and
its record commit or roll back together — the pattern PR #105 established for the Control Fit Brief.
The creation event also carried a null entity id (it read the row id *before* the insert).

### 2.6 The pilot state could be advanced past its own gates — **fixed**

> *Closure register §4:* "Start a live parallel reconciliation run — **No** — C0–C9 must be closed
> with evidence." And: failure "never means silently widen scope."

`pilotState` accepted `parallel_run` and `limited_control` from any admin or CFO regardless of gate
state. The state field is the claim a customer or examiner reads first, and it could contradict the
nine gates printed directly above it. Transitions are now refused server-side, with the open gate
ids named in the message:

- `dry_run` — requires B0, B1, B2, B8 (closure register: masked/approved samples need C1–C3 plus
  legal approval of the data route).
- `parallel_run` — requires **every** gate.
- `limited_control` — requires every gate **and** must follow `parallel_run`, not jump to it.
- `suspended` and any step backwards — never gated. A control that can be entered but not left is
  not a safety control.

---

## 3. Other production hardening in this change

| Area | Finding | Change |
|---|---|---|
| **Vertical intelligence (§9A)** | Corporate B2B shipped with **no exception taxonomy**. Its exceptions were diagnosed under a persona describing itself as a Nigerian payment-systems expert, given the NIP/POS/ATM catalogue, and instructed to cite CBN circulars and NIBSS rules. The go-live plan's **first** launch geography is Uganda. | New `server/exceptions/corporate-b2b.ts` — 26 FMCG/distributor categories across receipt-to-invoice allocation, trade deductions, tax and rail costs, timing, and master-data/run integrity. Selected **by segment**, replacing (not supplementing) the bank catalogue. Regulatory framing follows the pilot country: URA + Bank of Uganda NPS for Uganda, FIRS for Nigeria, generic when unknown. |
| **Super-admin operability** | `canManagePilot` allowed `super_admin`, but the org lookup read the super admin's *own* organisation, whose segment is `super_admin` — so the role was refused every time. A permission that could never be exercised. | `resolveOrgScope` override, matching the CBS connector and Control Fit Brief routers. Infinity AI staff can now operate a client's pilot register from inside that client's portal, and the audit record names the client tenant. |
| **Register integrity** | Select-then-insert against a UNIQUE `organizationId` raced into a duplicate-key 500. Omitted optional fields were dropped by drizzle on UPDATE, so a cleared field silently retained its old value. | Single upsert; omitted free-text fields normalised to null so the stored register and the readiness projection cannot disagree. |
| **Roster governance (B3)** | "No pending and no flagged" is satisfied by a roster of entirely **inactive** distributors. Duplicate canonical names — the thing that produces false match candidates — were not checked at all. | B3 now requires at least one active identity and zero duplicated canonical names. |
| **Tenancy** | `superAgent.diagnose` used `ctx.user.organizationId ?? 0`, filing agent memory and action drafts against organisation 0 — the phantom-tenant pooling of CLAUDE.md §9C. | `orgId` is taken from the AI gate's return value, which has already refused a caller with no organisation. |
| **UI honesty** | The source list printed "credentials customer-owned · control total required" as **fixed text**, regardless of the stored flags. Gate B2 is decided by exactly those flags, so a source that failed B2 displayed the words describing passing it. | Renders the actual values, with failures highlighted. Mutation errors are surfaced as toasts instead of being swallowed. |

---

## 3A. Two defects this review introduced, caught in code review

Recorded rather than quietly fixed (CLAUDE.md §0.6). Both were raised as P1 by Greptile on PR #112
and both were valid.

### 3A.1 The new candidate pool ignored currency and channel pairing

Restoring candidates to `diagnoseException` (§2.4) moved the shortfall from *always null* to
*sometimes wrong*, which is the worse failure: `findNearestTarget` compares **numbers**, so a UGX
receipt could be paired with a USD invoice of similar magnitude and a confident shortfall persisted
onto a credit-note draft and narrated by the model.

The core engine already had the rule, stated at all three of its passes — *"within-currency only
(WS-6): numeric closeness across currencies is meaningless"* — and the new helper did not follow it.
The candidate pool is now constrained the same way the engine constrains itself:

- **same currency**, per WS-6;
- **approved channel pairing only** — the channels this tenant's reconciliation jobs actually pair
  this feed with (`db.getCounterpartyChannelIds`), rather than "every other channel". The `jobId`
  already on the procedure's input, and until now unused, narrows it to a single run;
- no pairing on record ⇒ **no candidates**, which restores the null-shortfall answer for that case.
  That is the correct answer, not a fallback.

### 3A.1b …and narrowing it by currency and channel was still not enough

Second review round, same file. Currency and channel pairing narrow the pool; they do not make its
members **related**. `findNearestTarget` then picks by amount alone, so a distributor paying 950,000
against a 1,000,000 invoice is scored against whichever open invoice in the window is numerically
nearest — possibly another distributor's — and a 5,000 shortfall is narrated where the real one is
50,000.

Candidates are now additionally restricted to the **same counterparty**. A transaction with no
counterparty yields none, deliberately: `missing_counterparty` is the correct diagnosis for it, and
inventing a comparison would produce exactly the fabricated figure the filter exists to prevent. The
same applies when a distributor is spelled differently on the two feeds — no candidates, no
shortfall, and the alias defect is itself a catalogued exception
(`b2b_distributor_alias_ambiguity`) rather than something to paper over in a query.

### 3A.1c …and even one distributor's own invoices needed a determined answer

Third review round, same file, and the sharpest version of the point. Currency, channel pairing and
counterparty remove the grossly unrelated comparisons. They cannot remove the last one, because every
remaining candidate is a genuinely plausible invoice for that payer — and `findNearestTarget` still
chooses among them **by amount**. A receipt of 950,000 against a 1,000,000 invoice lands on a 955,000
invoice standing next to it, and reports a 5,000 shortfall.

`determinateCandidates` now reduces the pool to what the evidence actually pins down:

1. the invoice(s) the payment reference names — `"INV-2847 less promo"` is not a guess, it is the
   distributor stating which invoice it paid and why it paid less;
2. otherwise a single remaining candidate, which is unambiguous by definition;
3. otherwise **nothing**.

Case 3 is the common one, and returning nothing is the correct answer rather than a capitulation:
several open invoices with no reference is precisely `b2b_unallocated_receipt` /
`b2b_aggregated_remittance_no_advice`, whose recommended action is to obtain the remittance advice.
It is the same discipline as `findSubsetSum` — when the evidence does not determine an answer,
produce none.

Fourth round caught the matcher itself: identifying the named invoice by normalised **substring**
made `INV-2847` match `INV-28470`, so a receipt whose real invoice was absent from the open pool
silently attached to a longer one. Both sides now go through the same identifier extractor and are
compared identifier-to-identifier.

Fifth round: a reference naming two invoices where only one was still open was read as determined,
so the whole receipt was diagnosed against that one. A multi-invoice reference is now refused
outright — a split remittance is an allocation question, and allocation is `runM2MMatching`'s job,
not a shortfall calculation's.

Sixth round: a `candidates.length <= 1` short-circuit sat one line **above** the split guard, so a
two-invoice reference against a one-invoice pool still returned that invoice. The reference is now
read before any short-circuit on pool size.

**The honest summary of §2.4, after six rounds:** the shortfall is no longer structurally null, and
it is now computed only where the invoice is determined. Where it is not, the diagnosis says so
instead of quantifying a guess. That is a narrower capability than "the Super Agent quantifies the
shortfall", and it is the one that is actually true.

### 3A.2 The gate check raced the state write

The transition check read readiness *outside* the transaction that wrote the state, so a source or
roster mutation committing in between let an advanced state be persisted against gates that had
since reopened. The check now runs **inside** the transaction with a `FOR UPDATE` read on the source
contracts and the roster — the only two tables the gates depend on — and only when the state is
advancing, so an ordinary save does not hold a roster lock.

**Serialising the write does not make the claim permanently true, and pretending otherwise would be
the same error this review is about.** The lock holds the rows that exist when it runs; production is
TiDB, which does not gap-lock the way InnoDB does, so a concurrently **inserted** distributor is not
held back by it either. Neither residual matters much, because they are the same operating condition
as a distributor flagged the next morning: B3 reopens under a pilot already recorded as
`parallel_run`, and the closure register's answer is a human decision — stop, or stay in parallel. So
the readiness output carries `stateContradictsGates` and the workspace shows a red banner naming the
open gates, instead of displaying an operational state over red evidence.

---

## 4. Attestation is not verification — now stated on the screen

Six of the nine gates are green because an authorised customer owner ticked a box. Three report
something the platform read. Rendering nine identical ticks invites precisely the reading the closure
register forbids: *"a toggle in Pilot Controls does not close C3/C8."*

Every gate now carries a `basis` and the workspace says how many closed gates rest on an attestation
alone:

| Basis | Gates | What a green tick means |
|---|---|---|
| `platform_verified` | B3, B5, B6 | The platform read it: roster rows, the live AI boundary, the live queue backend |
| `customer_attested` | B0, B1, B2, B4, B7, B8 | An authorised person recorded a claim here. Auditable, not proof |

**B2 and B7 deserve naming explicitly.** `controlTotalRequired` is a boolean with **no mechanism
behind it** — nothing anywhere records an expected control total or compares one to an ingested
batch. `operationalRecoveryStatus: "passed"` is a dropdown. Both gate texts now say so. The real
evidence for each is a dry run against the customer's route (C3, C8), which is where the closure
register already put it.

---

## 5. What remains open

### 5.1 Platform items — ReconcileAI owns these

1. **Provision Redis (`REDIS_URL`) on Railway.** B6 is now honest and therefore red. This is the
   long-standing CLAUDE.md §10 item; it is now a visible pilot gate rather than a footnote.
2. **Wire many-to-many allocation, as a read-only proposal surface** (§2.3), or stop citing it.
3. **Seed the Corporate B2B taxonomy as resolution templates.** `resolution_templates.category` is a
   MySQL ENUM, so this needs a migration widening it — deliberately not bundled here, given the
   migration-ordering failures in CLAUDE.md §10/§12. The keys are already live in
   `EXCEPTION_REGISTRY`, `ALL_EXCEPTIONS` and the diagnosis prompt.
4. **Control-total verification.** If the pilot is to claim the "source completeness" and "data
   integrity" acceptance tests, an expected control total has to be recorded per delivery and
   compared on ingest. Today the run cannot fail that test because nothing evaluates it.

### 5.2 Customer evidence — unchanged, and still the release gate

C0–C5 and C7–C11 are open exactly as the closure register states. No anchor customer, signed data
contract, authorised source delivery, approved roster, operating-policy attestation, recovery-drill
record, executed DPA or parallel-run evidence exists. **This review does not move any of them.**

---

## 6. Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| Corporate B2B pilot readiness | 27 tests pass |
| Corporate B2B AI boundary | 11 tests pass; 6 fail when the rule is removed (verified) |
| Corporate B2B taxonomy | 16 tests pass |
| Super Agent segment prompt | 6 tests pass; 4 fail when the segment wiring is disabled (verified) |
| M2M allocation + candidate selection | 21 tests pass; every guard was reverted and confirmed to fail (verified) |
| Full suite | 2023 passing (was 1977); CI green on Tests, Typecheck & Build, Greptile Review |

> **Local-run caveat, stated rather than glossed.** `vitest` loads no `.env` and the config sets no
> `setupFiles`, so `DATABASE_URL` is unset in a local run and `getDb()` returns null. Five tests in
> `server/modules.test.ts` therefore fail locally with "Database unavailable". They fail the same way
> on unmodified `main` and are unrelated to this change; CI supplies `DATABASE_URL`. Everything else
> passes locally.

---

## 7. What this review does not claim

- It does not make Corporate B2B pilot-ready. The closure register governs that, and it is unchanged.
- It does not prove any control end-to-end on customer data. Every test here is unit or behavioural
  against mocks and fixtures; none has seen a distributor's file.
- B6 turning red is not a regression. It is the first accurate report of a deployment condition that
  was always true.
