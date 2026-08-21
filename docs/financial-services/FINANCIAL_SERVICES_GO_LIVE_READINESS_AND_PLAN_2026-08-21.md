# ReconcileAI Financial Services Go-Live Readiness Assessment and Bank Deployment Plan

**Prepared for:** Richard Anwanakak, Founder & CEO, Infinity AI Africa Limited  
**Prepared by:** Manus AI  
**Assessment date:** 21 August 2026  
**Authoritative source baseline reviewed:** Infinity AI `main` at commit `51ac8eb` (merged PR #95)  
**Status:** **Demo-safe; not yet pilot-safe with real bank data; not yet bank-production ready**

> **Compliance note:** This is a technical and operational readiness assessment, not formal legal advice or a certification. The target institution's Legal, Compliance, Information Security, Data Protection, Risk, Internal Audit and, where relevant, Shariah governance functions must validate the applicable regulatory, contractual, data-residency and retention requirements before live customer data is processed.

---

## 1. Executive conclusion

ReconcileAI has a credible **working Financial Services product**: the production service is live; automated regression coverage and TypeScript compilation passed in this assessment; the product has multi-tenant controls, deterministic reconciliation, exception workflows, audit logging, CBS connector patterns, and a technically meaningful private/on-premise deployment path. The current public production health endpoint reported a healthy database, object storage, and direct LLM configuration on 21 August 2026.

That is not the same as being ready to process a bank's live data. The current Railway deployment should remain a **demonstration and controlled-development environment**. It presently reports a direct connection to Anthropic for AI processing; that is incompatible with a bank deployment unless the institution explicitly approves the documented data flow, processor terms and control design. For the first bank, ReconcileAI should launch as a **read-only, segregated parallel-reconciliation pilot** inside a bank-approved private environment. It must not post to a ledger, initiate a payment, close an exception automatically, or write back to the core banking system.

| Readiness gate | Status on 21 August 2026 | Meaning |
|---|---|---|
| **G0 — Demo-safe** | **Met** | Live demo tenant, controlled data, Financial Services workflows and production service availability are evidenced. |
| **G1 — Pilot-safe** | **Not met** | Real bank data should not yet be processed. Tenant hardening, durable processing, approved AI/data boundary, session/storage hardening, isolated hosting, dependency remediation and named bank owners require evidence. |
| **G2 — Bank-production** | **Not met** | The bank-specific interface, SSO/MFA, independent security assurance, immutable audit, key custody, DR, UAT and formal go-live approval remain future gates. |
| **G3 — Multi-bank scale** | **Not assessed as met** | Repeatable connector onboarding, capacity evidence, quota enforcement and managed secret operations must follow the first bank release. |

The most important operational decision is straightforward: **do not attempt a cloud-Railway go-live with raw bank data.** Use the current platform to demonstrate capability and conduct discovery. Use a bank-controlled VPC or on-premise deployment for a real-data pilot, with the deterministic engine as the only source of truth and the AI layer restricted to explanation, classification and recommendations.

---

## 2. What is proven today — and what that proof does not establish

The table below deliberately separates direct evidence from the inference that can safely be drawn from it.

| Area | Evidence observed | What can be claimed now | What cannot be claimed yet |
|---|---|---|---|
| **Live service** | `https://www.reconcileaiafrica.com/api/health` reported `healthy` on 21 August 2026, with database latency of 63 ms and healthy storage/LLM checks. | The demonstration platform is live and its reported dependencies were available at the time checked. | Availability at one point is not an RTO/RPO, capacity, DR or bank SLA claim. |
| **Regression quality** | Local `pnpm test -- --run` completed **113 test files / 1,838 tests**; `pnpm exec tsc --noEmit` completed successfully. | The assessed checkout has substantial automated coverage and passed compilation. | Test success does not prove a target bank interface, real-volume load, failover, pen-test, access-control configuration or user acceptance. |
| **Reconciliation control model** | The product exposes deterministic reconciliation, exception queues, owner/ageing concepts, review workflows and audit logging. | ReconcileAI can be positioned as a governed reconciliation and exception-control layer. | It must not be positioned as a ledger, payment processor, automated write-off engine or regulator-certified reporting service. |
| **CBS integration pattern** | WoodCore is the only currently evidenced live/tested connector; T24, Mambu and FLEXCUBE are registry profiles. | The connector architecture supports a repeatable onboarding pattern and CSV/API fallback. | A target bank's CBS integration is not proven until its contract, mappings, credentials, test data and volume behaviour are jointly tested. |
| **Private deployment design** | The on-premise profile has a fail-closed egress guard, local-model path, immutable image/model controls and preflight tests. | ReconcileAI has a viable private-deployment design for regulated institutions. | Air-gap, restore, security, capacity and model-quality acceptance must be executed in the target institution's environment. |
| **AI boundary** | The public health endpoint reports direct mode against Anthropic; the dual-tier plan supports CPU/Ollama and GPU/vLLM private serving. | The product can run with an approved private model deployment and deterministic controls remain authoritative. | No real bank data should be sent to a public LLM endpoint without documented institutional approval, data-flow review, processor agreement and a per-tenant kill switch. |

The Central Bank of Nigeria describes payments-system supervision in terms of soundness, safety, internal controls, transparency, accountability and effective monitoring. [1] That is the right framing for ReconcileAI: it should strengthen the bank's controls, not substitute for the bank's control ownership.

---

## 3. Critical gap register

### 3.1 Pilot blockers — close before any raw bank data is processed

| ID | Gap or decision | Evidence | Required closure evidence | Primary owner |
|---|---|---|---|---|
| **P1** | **Strict tenant ownership of exception data** | `exceptions.organizationId` remains nullable in the assessed schema. The security brief also records nullable legacy ownership fields. | Migration and backfill; RLS/authorization regression suite; two-tenant negative test; security sign-off that every Financial Services read/write is tenant-scoped. | ReconcileAI engineering; independent reviewer |
| **P2** | **Durable job processing** | The queue falls back to an in-process backend when `REDIS_URL` is absent; in-process jobs are lost on restart and are single-instance only. | Bank-approved Redis/BullMQ or equivalent; restart, duplicate delivery, retry, concurrent-worker and dead-letter tests recorded. | ReconcileAI engineering; bank infrastructure |
| **P3** | **Approved data and AI boundary** | Public production reports direct Anthropic use. On-premise egress code can fail closed, but this is not evidence of a bank deployment. | Decision record: private CPU/Ollama, private GPU/vLLM, or approved external processor. Include data-flow diagram, prompt minimisation, DPA/processor review where relevant, tenant AI-off switch and test evidence. | Bank DPO, InfoSec, Risk; ReconcileAI |
| **P4** | **Identity/session hardening** | The current magic-link handler creates one-year session tokens and cookies. | Short session policy, step-up re-authentication for sensitive actions, CSRF review, bank IdP SSO, MFA/conditional-access configuration, JML evidence and privileged-access logging. | ReconcileAI engineering; bank IAM |
| **P5** | **Software supply-chain remediation** | `pnpm audit --prod` returned **25 high, 36 moderate and 6 low** findings; no critical finding was reported. | Server-reachable dependency upgrades or risk acceptance; SBOM; clean/reduced audit result; signed release/image provenance. | ReconcileAI engineering; bank InfoSec |
| **P6** | **Segregated environment and residency proof** | Private profiles contain a fail-closed application egress guard, but Railway production is cloud mode and currently reaches an external LLM endpoint. | Bank VPC/on-prem environment; network egress control in addition to application guard; no production data in non-approved tenancy; boot, runtime egress and network-monitor evidence. | Bank infrastructure/InfoSec; ReconcileAI |
| **P7** | **Named operational owners** | Owners are not yet a per-bank signed control model. | Named Technology, Operations, Finance Control, Risk, InfoSec, Internal Audit, DPO and business sponsors with on-call/escalation terms. | Target institution; Richard |

### 3.2 Production blockers — close before an operating bank release

| ID | Gap or decision | Required closure evidence | Primary owner |
|---|---|---|---|
| **G2.1** | **Approved bank interface** | Read-only API/file design; least-privilege service account; mTLS or bank-approved equivalent; HMAC/replay/deduplication design; field mapping; source-to-control-total reconciliation; expected-volume benchmark. | Joint bank/ReconcileAI integration team |
| **G2.2** | **Independent security assurance** | Threat model, secure-code review, external fintech-focused penetration test, remediation/re-test report and current dependency/SBOM report. | Independent assessor; ReconcileAI |
| **G2.3** | **Dedicated key custody** | Bank-approved KMS/HSM or dedicated tenant keys; rotation, access logs, emergency recovery and separation from generic session secrets. | Bank InfoSec; ReconcileAI |
| **G2.4** | **Immutable audit evidence** | Current hash chaining is tamper-evident, not immutable. Use WORM/append-only storage or DB write-deny control, plus retention/export/verification procedure. | Bank security/data platform; ReconcileAI |
| **G2.5** | **Operational resilience** | RTO/RPO agreed; backup/restore test; DR test; alerting; incident playbook; support hours; change/vulnerability management and service review cadence. | ReconcileAI operations; bank operations/risk |
| **G2.6** | **Business-control acceptance** | Signed UAT; control totals reconcile; sampled exception decisions are correct; audit evidence is complete; role access is approved; business owner signs go-live. | Bank Finance Control/Ops/Internal Audit |
| **G2.7** | **Model-risk evidence** | Institution-owned labelled evaluation set; quality, safety, latency and rollback results. The existing synthetic-only model results are useful smoke evidence, not bank acceptance evidence. | Bank model-risk/business owner; ReconcileAI |

> **Critical safety boundary:** The deterministic reconciliation engine retains authority for amounts, matching, balances, settlement status and any consequential state. The AI layer may explain, classify, retrieve comparable patterns and draft recommendations. It must not post a journal, initiate a payment, change a ledger, approve a write-off, close an exception or issue a Shariah opinion.

---

## 4. Recommended deployment decision

### 4.1 First bank: choose a private, read-only parallel pilot

The recommended first Financial Services release is a **segregated, read-only parallel-reconciliation pilot**. It should use either a bank VPC/private cloud environment or the bank's on-premise environment. The initial interface should be an approved API or signed/batched file export using a least-privilege read-only service account. Direct production database access is not the recommended first interface.

The choice between the two supported AI serving profiles is an infrastructure and evidence decision, not a product fork.

| Institution condition | Recommended profile | Minimum decision evidence |
|---|---|---|
| No approved GPU; modest AI throughput requirement; strong residency constraint | **CPU/Ollama** with the approved quantized local model | Offline start, checksum proof, planned-concurrency latency test, rollback rehearsal and bank-approved private network. |
| Approved NVIDIA GPU estate; higher concurrency or model-capability requirement | **GPU/Qwen/vLLM** behind the institution gateway | Immutable model/image version, authentication, GPU capacity/concurrency benchmark, gateway/identity controls and rollback rehearsal. |
| Bank cannot yet approve AI data processing | **Deterministic engine with AI disabled** | Per-tenant AI switch demonstrated; reconciliation, exception routing and audit flow operate without model calls. |

The on-premise runbook makes clear that the application-level egress guard must be paired with network controls: isolated VLAN/firewall/no default route, not merely an application configuration. This dual layer is important for both Nigerian and Ugandan institutions. The CBN has also issued a 2026 payments-system circular covering data localisation and systemic oversight, while the Uganda cyber-risk requirements described by PwC apply to supervised financial institutions from 1 December 2024. [2] [4]

---

## 5. Step-by-step launch plan

### Phase 0 — establish the bank control boundary (days 0–5)

Run a one-day control-fit workshop before requesting credentials or data. Participants must include the bank's Technology, Operations, Finance Control, Information Security, Risk, Internal Audit, DPO, procurement/vendor-risk and, for a non-interest institution, Shariah governance. The workshop should select one bounded use case, such as settlement-versus-GL reconciliation for one payment rail, and explicitly exclude posting, payment initiation and automated closure.

| Step | Output | Exit criterion |
|---|---|---|
| 0.1 | Named executive sponsor and control owners | RACI accepted by bank and Infinity AI. |
| 0.2 | One use-case charter | Defined rail, source systems, frequency, population, volumes, currency, materiality, exceptions and success metrics. |
| 0.3 | Data classification and data-flow map | Bank DPO/InfoSec identify whether each field may be processed, masked, retained and used in AI prompts. |
| 0.4 | Hosting/model decision record | Bank selects VPC/on-prem and CPU/GPU/AI-off route. |
| 0.5 | Pilot safety charter | Read-only, segregated, no payment/posting/write-back, human approval mandatory, explicit rollback and incident contacts. |

### Phase 1 — close pilot platform blockers (weeks 1–3)

No client data is required for this phase. ReconcileAI engineering should first close the platform defects that make a real-data pilot unsafe. Every code change must follow Richard's standing dual-repository PR discipline: an authoritative Infinity AI PR, a matching MistaRichMan mirror PR, review/hardening, passing CI, then merge.

| Priority | Work item | Required test or artefact |
|---|---|---|
| 1 | Make exception tenancy non-null and complete the legacy ownership remediation relevant to the pilot. | Migration/backfill report; two-tenant access-negative tests; independent review. |
| 2 | Provision and enforce the durable queue. | Redis/BullMQ health evidence; worker-kill, retry, dedupe, concurrent-worker and DLQ test record. |
| 3 | Remediate or formally risk-accept production dependency findings. | Updated production audit, SBOM, reachability classification and security approval. |
| 4 | Replace year-long sessions with bank-approved session/step-up control. | Auth design, re-auth tests, CSRF results and security sign-off. |
| 5 | Implement the bank-required storage/key posture. | Dedicated key/KMS design, short presign policy, access logs, scoped storage-key migration and recovery test. |
| 6 | Add a per-tenant AI-off switch and enforce data minimisation. | Tenant-level test evidence proving no model call occurs when disabled. |
| 7 | Convert audit evidence from merely tamper-evident to infrastructure-immutable. | WORM/append-only design, write-deny test and audit-export verification. |

### Phase 2 — build the isolated pilot environment (weeks 2–4, in parallel)

The bank should provide a non-production but production-like network segment. ReconcileAI supplies a signed/pinned release package, deployment guide, SBOM, model provenance, environment configuration matrix and operator runbook. The institution provides the private endpoint, reverse proxy/TLS, network rules, identity integration, secrets/KMS and internal monitoring destination.

| Control | Required evidence before integration data arrives |
|---|---|
| **Network** | Application and dependencies restricted to bank-approved routes; outbound egress denied except documented in-VPC allowlist; evidence from firewall or network monitor. |
| **Identity** | Bank IdP SSO; MFA/conditional access; mapped roles; JML workflow; privileged access log. |
| **Secrets** | Bank secret store/KMS; no plaintext configuration; secret rotation and break-glass procedure. |
| **Resilience** | Backups configured to bank destination; restore to scratch environment demonstrated; RTO/RPO draft agreed. |
| **AI** | Selected CPU/GPU/AI-off profile starts only from approved, pinned artefacts; egress and no-raw-data-out controls tested. |
| **Observability** | Health, queue, connector, error, audit, security and capacity signals routed to a bank-approved monitoring path. |

### Phase 3 — design and prove the read-only interface (weeks 3–6)

Begin with historical or masked extracts if the bank requires that order. When live data is approved, ingest only into the segregated pilot boundary. Define a canonical mapping for transaction, GL, settlement, counterparty, currency, status and timestamp fields. The mapping specification must be versioned, signed off by Finance Control and testable.

| Step | Test | Pass condition |
|---|---|---|
| 3.1 | Connectivity and service account | Least-privilege account accesses only approved read endpoints/files. |
| 3.2 | Contract/mapping | Field-level mapping, source-of-truth designation and data-quality rules are accepted. |
| 3.3 | Replay/idempotency | Replayed file/event produces no duplicate canonical transactions or exceptions. |
| 3.4 | Reconciliation control total | Source totals, ingest totals and ReconcileAI totals reconcile to agreed tolerance. |
| 3.5 | Failure handling | Invalid file, late file, missing settlement, connector timeout and duplicate delivery become visible exceptions/alerts. |
| 3.6 | Volume | Test at forecast peak daily volume plus agreed headroom; document latency, backlog and recovery. |

### Phase 4 — execute the read-only parallel pilot (weeks 6–12)

Run the selected scope alongside the bank's existing reconciliation process. The existing process remains the legal and financial system of record. The goal is not to replace it in the first pilot; the goal is to prove that ReconcileAI finds, classifies, routes and evidences the same issues reliably and faster.

| Pilot control | Evidence to collect every week |
|---|---|
| Reconciliation accuracy | Control-total comparison, match/disagreement population, false-positive/false-negative sample and root-cause log. |
| Exception governance | Owner, ageing, reviewer action, escalation, final outcome and audit record for selected critical/high items. |
| User acceptance | Structured feedback from Operations, Finance Control, Compliance/Audit and Technology. |
| AI safety/quality | Institution-owned labelled set; structured-output validity, classification quality, unsafe-action test, deterministic disagreement review and latency. |
| Security/resilience | Queue/restart evidence, alert exercise, restore evidence, access-review result and incident tabletop. |
| Data compliance | DPA/data-flow record, access logs, retention/deletion result and egress-monitoring evidence. |

The AI acceptance scorecard should require at least 99% structured-response validity, at least 95% exception-category quality on institution-labelled cases, zero unsafe consequential actions, documented review of deterministic disagreements, bank-agreed latency/capacity, and a rehearsed rollback. These are product gates, not regulatory certification claims.

### Phase 5 — formal production decision and controlled cutover (weeks 12–16 or later)

The bank and Infinity AI should convene a formal go/no-go board only after all G2 evidence is complete. A green dashboard is not adequate; each gate needs a dated artefact, named approver and residual-risk decision.

| Go/no-go gate | Mandatory approver | Minimum evidence |
|---|---|---|
| Interface and data mapping | Bank Technology + Finance Control | Signed interface/mapping specification and successful replay/load test. |
| Security and privacy | Bank InfoSec + DPO | Pen-test/retest, vulnerability decision, DPA/data-flow approval, access control and egress evidence. |
| Operating resilience | Bank Operations + Risk | RTO/RPO, restore, DR/tabletop, alerting, incident and support runbook. |
| Control effectiveness | Finance Control + Internal Audit | UAT, control totals, exception/audit samples and approval workflow evidence. |
| AI/model governance | Model-risk owner + business owner | Approved model tier, evaluation scorecard, prohibited-action tests and AI-off/rollback evidence. |
| Final release | Executive sponsor + Infinity AI | Signed acceptance, release manifest, change record and cutover/rollback decision. |

The first production cutover should be deliberately narrow: one institution, one agreed use case, one or few rails, read-only ingestion, human approvals and a defined initial hypercare period. Expanding to more rails or enabling downstream operational integration should be a separate approved change.

---

## 6. Cutover, hypercare and rollback

### 6.1 Cutover checklist

| Timing | Action | Owner |
|---|---|---|
| **T-30 days** | Freeze production scope, release manifest, model version and mapping version; complete UAT and evidence review. | ReconcileAI + bank control owners |
| **T-14 days** | Run full restore, connector replay, rollback and incident-contact drill. | Bank operations + ReconcileAI |
| **T-7 days** | Change Advisory approval; enable production service account but retain controlled start window; confirm monitoring. | Bank CAB/Technology |
| **T-0** | Enable read-only scheduled ingestion; reconcile first control totals jointly; run access/audit check. | Bank operations + Finance Control |
| **T+1–7 days** | Daily control-total review, exception sampling, queue/latency monitoring, incident review and executive status. | Joint hypercare team |
| **T+30 days** | Formal hypercare exit review; decide whether scope expansion is justified. | Executive sponsor + Risk |

### 6.2 Rollback rules

Rollback must not depend on a developer improvising during an incident. The release pack should contain tested steps to: disable the connector schedule; revoke the read-only service account or network route; disable the AI per tenant; preserve audit logs and raw evidence; revert to the prior signed app/model release; and restore the prior database/application state if needed. Because the recommended pilot is read-only, rollback must **never require reversing a bank posting or payment**.

Trigger rollback when any of the following occurs: unexplained control-total discrepancy above the bank-approved tolerance; duplicate ingest that cannot be safely remediated; cross-tenant access indication; unauthorised egress attempt; material availability/recovery breach; suspected secret compromise; or a model output that violates the agreed prohibited-action boundary.

---

## 7. Institution-specific notes

### 7.1 Nigeria and Taj Bank

The current first Financial Services strategy should be anchored on a controlled Taj Bank or comparable bank pilot, not a generic SaaS rollout. The first workshop needs Technology, InfoSec, Operations, Finance Control, Internal Audit, Risk, DPO and Shariah governance because Taj is a non-interest bank. ReconcileAI may surface evidence for impermissible income, commingling, profit-distribution variance and related exception families, but it must not claim to issue Shariah opinions; those remain the responsibility of the bank's approved governance functions.

CBN describes its supervision objective as the soundness and safety of payment systems, including strong internal controls, transparency, accountability and monitoring. [1] The CBN's official circular feed also records recent payment-system data-localisation/systemic-oversight and cybersecurity self-assessment initiatives. [2] This makes a bank-controlled data boundary, credible supplier assurance and repeatable control evidence prerequisites rather than nice-to-have documentation.

### 7.2 Uganda

The Uganda beachhead should use the same private-first deployment approach. PwC's summary of the Bank of Uganda cyber-risk requirements says they apply to supervised financial institutions from 1 December 2024. [4] The target Ugandan institution should confirm its own technology-risk, outsourcing, data-protection and residency requirements during Phase 0. The Nigeria plan cannot simply be copied without that local sign-off.

---

## 8. What Richard should do next

Richard should not approve a bank production go-live now. He should instead nominate **one first pilot institution and one bounded reconciliation use case**, then convene the Phase 0 control-fit workshop within the next two weeks. The immediate commercial ask is a **paid, read-only parallel POC**, not a production contract with unqualified readiness claims.

In parallel, Richard should authorise the G1 platform-hardening work as a discrete programme, starting with strict exception tenancy, durable processing, approved AI-off/data-boundary control, session hardening and dependency remediation. Each remediation must be raised as PRs to both repositories and must carry its own test evidence. The external security review should be commissioned after the tenant-ownership remediation, so it validates the fixed state rather than merely documenting a known gap.

When a target institution chooses its private deployment route, ReconcileAI should prepare a bank-specific delivery pack: release manifest and checksums; SBOM; architecture/data-flow; interface spec; role matrix; vulnerability and pen-test status; DPA and data-retention matrix; backup/DR runbook; incident/support runbook; model card/evaluation/rollback record; and signed UAT/go-live forms. The completed pack—not a software demo—is the evidence needed for a bank production decision.

---

## 9. Assessment limitations

This assessment reviewed the available local codebase, existing deployment/security documentation, public production health endpoints, the authenticated authoritative GitHub view, automated test/TypeScript results and production dependency audit. The command-line GitHub credential could not refresh the local checkout, so the final authoritative commit was confirmed through the authenticated GitHub interface rather than by rebasing the sandbox. The report therefore distinguishes clear code/document evidence from unverified environment configuration.

No bank environment, real bank interface, production data sample, bank contract, DPA, bank IAM configuration, external penetration-test report, DR exercise, Bank UAT result or bank risk acceptance was available for review. None should be inferred from this document.

---

## References

[1] [Central Bank of Nigeria, Payments System Supervision](https://www.cbn.gov.ng/PaymentsSystem/)

[2] [Central Bank of Nigeria, Official Circulars Feed](https://www.cbn.gov.ng/RSS/CircularsRSS.html)

[3] [Nigeria Data Protection Commission, Nigeria Data Protection Act 2023](https://ndpc.gov.ng/download/nigeria-data-protection-act-2023)

[4] [PwC Uganda, Key Reflections on the Bank of Uganda's Cyber Risk Management Guidelines](https://www.pwc.com/ug/en/publications/key-reflections-bou-cyber-risk-management-guidelines.html)

## Internal Evidence Reviewed

- `docs/FINANCIAL_SERVICES_PRODUCTION_PLAN.md`
- `docs/deployment/LOCAL_DEPLOYMENT_AND_MODEL_TRAINING.md`
- `docs/deployment/ACCELERATED_DUAL_TIER_EXECUTION.md`
- `docs/security/SECURITY_REVIEW_BRIEF.md`
- `server/jobQueue.ts`
- `server/_core/egress.ts`
- `server/_core/index.ts`
- `drizzle/schema.ts`
- `docs/research/financial_services_prod_dependency_audit_2026-08-21.json`
- `docs/research/financial_services_go_live_sources_2026-08-21.md`
