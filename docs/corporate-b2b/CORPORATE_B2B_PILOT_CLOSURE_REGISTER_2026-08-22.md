# Corporate B2B Pilot Closure Register

**Date:** 22 August 2026  
**Scope:** First controlled, read-only FMCG/distributor reconciliation pilot in Uganda or Nigeria  
**Decision owner:** Richard Anwanakak, Founder & CEO, Infinity AI Africa Limited

## Decision summary

**No — Corporate B2B is not yet 100% pilot-ready.** The platform-controlled pilot foundation is substantially ready: the B0–B8 controls exist, B6 is closed because the P1–P7 foundation release is merged and proven, and the Corporate B2B Pilot Controls policy is in the merged code path. That is not the same as pilot readiness.

Unlike SHOPLINE, where the ReconcileAI Dev Store supplied a real connected test environment and controlled paid-order evidence, Corporate B2B has no named anchor-customer tenant, no signed source contract, no customer-authorised source delivery, no approved distributor roster, no operating-policy attestation, no recovery-drill record, no executed data-processing agreement, and no controlled parallel-run evidence. These are **required evidence gates**, not placeholders to be waived.

> **Pilot boundary:** ReconcileAI may ingest customer-authorised evidence, reconcile it, route exceptions, retain audit evidence and export proposals. It must not initiate or approve a payment, access a bank account, post to ERP, create a credit note, or send a customer-facing operational action.

## 1. Comparison with the SHOPLINE closure standard

| Readiness discipline | Retail Commerce / SHOPLINE example | Corporate B2B equivalent | Current Corporate B2B status |
|---|---|---|---|
| Platform implementation | Tenant-scoped OAuth, Settlement Monitor and read-only order/payment paths | Tenant-scoped Pilot Controls, Distributor Registry, source contracts, no-write guardrails, reconciliation and exception workflow | **Platform complete** |
| Connected real-world test surface | ReconcileAI Dev Store connected through SHOPLINE | Named FMCG/distributor customer tenant | **Open** |
| Controlled source-to-result evidence | Order #1004 paid, synced, matched to synthetic remittance | Customer-authorised invoice/AR plus receipt evidence delivered, reconciled and investigated | **Open** |
| Recovery / idempotency proof | Bounded re-sync processed one source order without duplicates | Duplicate-file, retry, replay and restore drill completed against the selected customer route | **Open** |
| Data / privacy evidence | GDPR callback signature evidence and documented customer-data handling | DPA/privacy annex, country-specific data-route approval and source-owner authority | **Open** |
| Support / incident proof | Merchant support and escalation runbooks | Named customer support contacts, severity routing, customer-visible incident drill | **Open** |
| Release approval | Six explicit submission gates and owner sign-off | Pilot acceptance pack and explicit Richard + customer pilot-go decision | **Open** |

The correct conclusion is that the Corporate B2B platform is **pilot-capable**, but the first customer pilot is **not authorised to start** until the closure register below is evidenced.

## 2. Definitive pilot closure register

| Gate | Requirement | Evidence that closes it | Owner | Status |
|---|---|---|---|---|
| **C0 — Anchor and scope** | One customer, country, legal entity, named finance sponsor and one bounded receivable flow | Signed one-page pilot scope confirming no-write boundary, channels, volume band, start/end dates and success metric | Customer sponsor + Richard | **Open** |
| **C1 — Tenant and access** | Real customer tenant and least-privilege user access | Customer tenant created; CFO/operations/auditor roles assigned; access review signed | ReconcileAI + customer IT | **Open** |
| **C2 — Data contract** | Canonical invoice/AR and receipt evidence semantics | Field-level mapping, source hierarchy, cut-off rules, reversals, returns, deductions, fees and credit-note treatment approved | Customer Finance + IT | **Open** |
| **C3 — Source routes** | Two customer-authorised, read-only evidence routes | Invoice/AR plus bank, PSP or mobile-money receipt source delivered through tested SFTP, bucket, API or export route; control totals agree | Customer IT + provider + ReconcileAI | **Open** |
| **C4 — Distributor master data** | Active distributor identities and aliases are safe to reconcile | Roster imported; unresolved, duplicate and flagged identities resolved; customer signs off the active population | Customer Sales Ops + Finance | **Open** |
| **C5 — Operating policy** | Human decision policy for allocation and exceptions | Approved allocation/write-off rules, reviewer limits, escalation path, daily-close owner and evidence retention period recorded | Customer Finance Controller | **Open** |
| **C6 — Platform foundation** | Secure, tenant-scoped and no-write control foundation | P1–P7 release merged and proven; Corporate B2B Pilot Controls merged; B6 closed | ReconcileAI | **Closed** |
| **C7 — AI boundary** | AI use is deliberate and does not expose data to an unapproved model route | AI remains disabled, **or** customer records a private approved route and model/data-boundary approval | Customer InfoSec / ReconcileAI | **Open decision** |
| **C8 — Resilience and support** | Recovery, replay, support and retention controls work on the customer route | Duplicate-file, retry/replay, restore and escalation drills completed; evidence retained | ReconcileAI + customer IT/Ops | **Open** |
| **C9 — Legal and privacy** | Customer permits the pilot data route | Executed or formally approved NDA, SOW, DPA/privacy annex and country-specific review; Nigeria requires NDPA role/lawful-basis/retention/incident approval | Customer Legal / DPO + ReconcileAI | **Open** |
| **C10 — Parallel-run result** | Reconciliation is useful and operationally safe | Minimum agreed observation period completed against the customer’s existing close; variance, exceptions and review outcomes accepted | Customer Finance + ReconcileAI | **Open** |
| **C11 — Pilot go decision** | Both parties approve continued limited use | Acceptance report, support owner, rollback trigger, incident contacts and explicit customer + Richard sign-off | Customer sponsor + Richard | **Open** |

## 3. Required sequence to achieve closure

### Step 1 — Select the first customer and schedule the control-fit workshop

Run two country tracks in parallel: the Uganda FMCG/distributor path through Movit Products and a Nigerian FMCG distributor/manufacturer path. Award the first pilot only to the customer that provides a named finance sponsor, a bounded no-write use case and safe sample files first. Do not select a customer solely because of brand value or verbal interest.

The 90-minute workshop must close C0 at minimum. Participants are the finance sponsor, daily reconciliation owner, sales/distributor operations lead, IT/integration lead, data-protection/legal contact and ReconcileAI pilot owner.

### Step 2 — Close C1–C5 through a controlled onboarding pack

Create the customer tenant, issue least-privilege roles and use Pilot Controls to record the no-write scope. The customer supplies masked or approved historical extracts first. ReconcileAI produces the canonical data contract, registers two source contracts, records the roster state and captures the operating policy. No live operational file should be accepted before both the field mapping and control totals are approved.

### Step 3 — Decide the AI boundary and legal route

The default is AI **off**. If the customer wants AI-assisted diagnosis, it must provide private-route and data-boundary approval; the platform will otherwise fail closed. Legal/DPO sign-off must approve the data route, duration, retention, support access and incident process. The Nigerian track requires explicit NDPA role, lawful-basis, retention and incident-path approval before live data is ingested.

### Step 4 — Conduct technical dry runs and resilience drills

Run three non-destructive cycles with approved data: initial delivery, duplicate/retry delivery and corrected/replay delivery. ReconcileAI and the customer must compare source control totals, document every exception class, test escalation and perform a restore/replay drill. Evidence closes C3 and C8; a toggle in Pilot Controls does not.

### Step 5 — Complete the parallel reconciliation pilot

Operate read-only alongside the customer’s existing monthly or daily close for the agreed observation period. ReconcileAI may produce matched records, exception queues and proposed actions, but the customer completes any payment, ERP, ledger or communications action outside ReconcileAI. The pilot report should show the volume received, control totals, matched records, exception population, aged exceptions, manual decisions, reconciliation variance, incidents and recovery outcomes. It should not claim a production match rate without customer-approved evidence.

### Step 6 — Hold the go/no-go review

The customer and Richard close C10–C11 only after reviewing the parallel-run report, support drill, rollback steps and retained evidence. **Failure or uncertainty means remain in parallel mode or stop the pilot; it never means silently widen scope.**

## 4. What can happen now and what cannot

| Action | Permitted now? | Condition |
|---|---|---|
| Demonstrate the Corporate B2B portal with controlled/synthetic data | Yes | Clearly label the data as controlled or synthetic |
| Start customer discovery and issue a pilot onboarding pack | Yes | No data transfer before C0–C2 are approved |
| Configure a real customer tenant | Yes | C0 scope and named customer authority |
| Ingest masked / approved historical samples | Yes | C1–C3 and legal approval for the selected data route |
| Start a live parallel reconciliation run | No | C0–C9 must be closed with evidence |
| Initiate, approve or post a payment / ERP action | No | Outside the first pilot’s no-write scope |
| Claim 100% pilot-ready status | No | Only after C0–C11 are closed |

## 5. Immediate action list

1. **Richard:** choose the first discovery meeting: Movit Products Uganda path, Nigeria FMCG path, or both in parallel.
2. **ReconcileAI:** send the customer a pilot onboarding pack: scope template, data-source questionnaire, data-processing questionnaire, source-contract template, roster template, allocation policy template and support/escalation contacts.
3. **Customer sponsor:** nominate finance, IT, distributor operations, legal/DPO and daily-close owners.
4. **ReconcileAI + customer:** run the control-fit workshop and complete C0.
5. **Do not call the vertical 100% ready** until the closure register is supported by customer-specific evidence and both parties sign C11.

## Authority and source records

This register is derived from the existing Corporate B2B pilot-control implementation status, the Corporate B2B go-live plan, and the evidence-first SHOPLINE final submission assessment. Those source records remain authoritative where they specify a stricter control.
