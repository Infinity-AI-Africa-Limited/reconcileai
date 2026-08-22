# Taj Bank Read-Only Parallel Pilot — Readiness Pack

**Version:** 1.0  
**Date:** 22 August 2026  
**Status:** Planning and evidence-request pack; not an approval to process bank data.  
**Audience:** Taj Bank Operations, Technology, Information Security, Risk, Compliance, Internal Audit, Data Protection, Procurement, and ReconcileAI delivery teams.

> **Purpose:** Establish a bounded, read-only reconciliation pilot that demonstrates control value without writing to Taj Bank’s core-banking system, payment systems, general ledger, customer accounts, or production workflow.

## 1. Executive Decision Requested

TAJBank publicly presents digital, mobile, internet-banking, USSD, retail, and business-banking channels. [1] [2] That makes a multi-source reconciliation use case plausible, but it does not reveal the Bank’s source-system architecture or control requirements. The first decision is therefore not an integration decision: it is approval to run a **discovery and control-fit workshop**, followed by a narrowly scoped read-only parallel pilot.

| Decision | Recommended position | Owner | Required output |
|---|---|---|---|
| Pilot objective | Prove that ReconcileAI can reconcile one bounded daily operational flow and govern its exceptions without changing bank records. | Taj Bank Operations + Finance Control | Signed pilot charter |
| First use case | Select one recurring settlement or account-level reconciliation with two or three authoritative extracts. Avoid a broad all-rails implementation. | Taj Bank Operations + Technology | Use-case specification and source inventory |
| Environment | Taj Bank-controlled non-production environment first; then private VPC or on-premise parallel run if the control-fit is accepted. | Taj Bank Technology + Information Security | Environment decision and network diagram |
| Data | Sanitised or masked non-production extract first; only move to tightly controlled production-equivalent data if approved in writing. | Taj Bank DPO + Information Security + Risk | Data-classification and masking approval |
| Authority to progress | No data transfer until Taj Bank security, legal, procurement, and risk owners approve the pilot charter and information pack. | Taj Bank sponsor | Written go/no-go record |

## 2. Non-Negotiable Pilot Boundary

The pilot is **parallel and read-only**. ReconcileAI may ingest approved files or read-only API extracts, calculate matching and exception results, and prepare a review pack. It must not post journals, modify customer or merchant accounts, trigger payments, change settlement instructions, mutate general-ledger balances, or make automatic financial decisions.

Every recommended action remains subject to a Taj Bank operator’s approval. ReconcileAI will record the user, timestamp, evidence source, rationale, and resulting decision, but the Bank retains financial authority.

## 3. Recommended First Use Case

The recommended starting point is a daily **settlement-to-ledger or account-level reconciliation** that has a known operational owner and clear source extracts. Taj Bank should choose the actual rail based on controllability, not novelty. Examples could include an approved payment-switch settlement file against a bank-side ledger extract, or a suspense/clearing account reconciliation against a source-system report. These are examples only; Taj Bank must select the use case after confirming source ownership, data classification, timing, and exception workflow.

| Selection criterion | Pilot condition |
|---|---|
| Frequency | Daily or otherwise recurring, so the pilot can demonstrate repeatability. |
| Sources | Two or three authoritative sources with a stable business key, amount, currency, date/time, and status fields. |
| Volume | Enough records to create a meaningful exception workload, but bounded enough for daily manual validation. |
| Ownership | A named business owner, technical source owner, reviewer, approver, and audit observer. |
| Safety | No payment instruction, account update, or ledger posting is in ReconcileAI’s control path. |
| Success evidence | The Bank can independently compare ReconcileAI’s output to its existing reconciliation result and investigate differences. |

## 4. Taj Bank Evidence Request

### 4.1 Security and Environment Pack

| Evidence requested from Taj Bank | Why it is needed | ReconcileAI output / response |
|---|---|---|
| Deployment standard, cloud policy, and approved hosting location | Determines whether the pilot is non-production, private VPC, or on-premise. | Target architecture, ports/protocols, and deployment artefacts. |
| Network-zone diagram and approved ingress/egress route | Confirms that transfer paths are constrained and inspectable. | IP/FQDN allow-list requirements; no public LLM or third-party egress in bank mode. |
| Identity and privileged-access standard | Determines SSO, MFA, session TTL, role model, and break-glass procedure. | SSO/OIDC/SAML configuration requirements and role mapping. |
| Vulnerability-management, penetration-test, and change-control process | Defines the bank’s evidence standard before system access. | SBOM/dependency report, test evidence, release notes, and remediation register. |
| Key-management / HSM / KMS standard | Determines encryption-key custody and rotation. | Dedicated-key integration configuration; no JWT-derived bank key wrapping. |
| Backup, recovery, monitoring, and incident policy | Defines pilot service SLOs and recovery drill requirements. | Monitoring hooks, queue health indicators, backup/restore test plan, and incident runbook. |

### 4.2 Data and Privacy Pack

| Evidence requested from Taj Bank | Pilot requirement |
|---|---|
| Data classification for each proposed source extract | ReconcileAI cannot receive data before handling rules and approved environment are known. |
| Field-level data dictionary | Each field must be classified as required, optional, or prohibited. Customer PII should be removed or tokenised unless a specific approved purpose requires it. |
| Retention, deletion, legal-hold, and audit-evidence policy | The pilot must implement the Bank’s retention schedule, deletion process, and evidence-preservation rule. |
| Approved masking or tokenisation method | First load should use masked non-production data wherever feasible. Tokens must preserve the matching keys the use case needs. |
| Data-transfer method | Prefer bank-managed secure file transfer or an approved read-only API with mTLS and least privilege; do not connect directly to production databases. |
| Data-protection and vendor-risk questionnaire | Taj Bank’s DPO and procurement teams must confirm the lawful processing, transfer, and vendor-management position. |

## 5. ReconcileAI P1–P7 Controls Required for Taj Bank

The P1–P7 code foundation is in production-hardening review, not yet approved for bank deployment. The following table shows what must be configured and evidenced for a Taj Bank environment.

| Control | Taj Bank acceptance criterion | ReconcileAI action before pilot start |
|---|---|---|
| **P1 — Tenant ownership** | All transactions, jobs, exceptions, review actions, and AI contexts remain in the Taj Bank tenant. | Demonstrate tenant-isolation tests and provide a signed pilot data-flow map. |
| **P2 — Durable processing** | Reconciliation cannot silently disappear during restart or worker failure. | Provision approved Redis/BullMQ, alert on queue failure, and rehearse restart recovery. |
| **P3 — Dependency posture** | Unresolved dependency advisories are remediated or formally risk-accepted by the Bank. | Provide SBOM, current dependency report, remediation dates, and vendor-risk response. |
| **P4 — Session policy** | Short session, MFA/conditional access, role separation, and privileged-operation re-authentication are approved. | Configure Taj Bank’s TTL and SSO policy; test user termination and privileged-access removal. |
| **P5 — Key posture** | Bank-controlled KMS/HSM or dedicated tenant master-key lifecycle is evidenced. | Configure the approved key mechanism and test rotation/recovery in non-production. |
| **P6 — AI boundary** | Taj Bank approves whether assistance is enabled, where inference runs, and what data may reach it. | Default AI assistance to off until the Bank approves the target deployment mode and performs model-risk review. |
| **P7 — Immutable evidence** | Audit records are protected by WORM/object-lock storage or database privileges that deny application `UPDATE` and `DELETE`. | Configure the selected mode, export an audit-evidence sample, and test retention/retrieval. |

## 6. Integration Design for the Pilot

The preferred pilot integration is a bank-managed secure file-transfer or read-only API path. The intake job uses a unique delivery identifier and hash to prevent duplicate processing. Each source record is retained with its source reference, ingestion timestamp, data-quality result, and lineage. ReconcileAI normalises only the fields necessary for matching and retains the source evidence needed to explain each outcome.

| Stage | Taj Bank responsibility | ReconcileAI responsibility | Evidence |
|---|---|---|---|
| Source preparation | Provide approved extracts, data dictionary, delivery schedule, and source owner. | Validate schema, hash files, reject malformed load, and log lineage. | Signed file contract and ingestion log. |
| Reconciliation | Define business tolerance, cut-off time, and exception taxonomy. | Run deterministic matching first; classify only residual exceptions. | Run summary and source-to-result trace. |
| Review | Nominate reviewer and approver roles. | Route exceptions with owner, ageing, context, and evidence. | Review queue export and approval audit trail. |
| Reporting | Define operational and audit recipients. | Produce daily control summary and exception ageing report. | Signed daily report and exception register. |
| Recovery | Approve restart and rollback procedure. | Re-run idempotently from durable queue without duplicate results. | Recovery drill record. |

## 7. Six-Week Read-Only Parallel Pilot

| Week | Objective | Entry gate | Completion evidence | Go / no-go owner |
|---|---|---|---|---|
| **0** | Executive sponsorship and use-case selection | Taj Bank sponsor names Operations, Technology, Security, Risk, DPO, and Audit contacts. | Signed pilot charter; source-owner matrix. | Taj Bank sponsor |
| **1** | Discovery and control fit | Data dictionary and existing reconciliation SOP supplied. | Field mapping, exception taxonomy, target-state data flow, and agreed acceptance criteria. | Operations + Finance Control |
| **2** | Security and environment design | Environment and transfer method approved. | Network diagram, SSO/role design, key posture, retention schedule, and test plan. | Information Security + DPO |
| **3** | Non-production connectivity | Sanitised/masked extracts and access credentials approved. | Successful schema validation, duplicate-load test, and source-lineage sample. | Technology + source owner |
| **4** | Parallel reconciliation | Daily extracts arrive on the agreed schedule. | Side-by-side results, exception register, reviewer feedback, and recovery test. | Operations owner |
| **5** | Control validation | At least five operating days of parallel runs completed. | Audit sample, queue/restart drill, access review, AI-boundary evidence, and residual-gap register. | Risk + Internal Audit |
| **6** | Pilot decision | All acceptance evidence assembled. | Read-only pilot report and a decision either to extend, prepare a production parallel run, or stop. | Taj Bank steering group |

## 8. Acceptance Criteria

The pilot should not claim a target match rate in advance. Its success is whether Taj Bank can independently validate the result set and whether the control workflow is useful. Taj Bank should approve measurable criteria before data loading, including the following.

| Criterion | Evidence standard |
|---|---|
| Completeness | All approved extract rows are accounted for as matched, unmatched, rejected, or pending review. |
| Accuracy | A jointly sampled result set agrees with Taj Bank’s authoritative reconciliation determination. |
| Explainability | Every exception shows source links, reason code, owner, ageing, and review history. |
| Control | ReconcileAI makes no financial posting; every action requiring a decision is approved by an authorised Taj Bank user. |
| Resilience | A planned restart/retry produces no duplicate run, posting, or exception record. |
| Security | Access review, data-transfer controls, key posture, and audit-evidence test are accepted by Taj Bank control owners. |
| Operability | Operations can use the runbook to process one daily cycle and escalate an incident. |

## 9. Rollback and Stop Conditions

The pilot must stop immediately if unauthorised data access, data-classification breach, unintended external egress, failed tenant separation, unauthorised financial write, material audit-evidence gap, or an uncontained security incident is detected. The safe rollback is to disable intake credentials, stop workers, preserve approved audit evidence, notify Taj Bank’s designated incident contact, and continue with Taj Bank’s existing reconciliation process.

No production cutover is implicit in pilot success. Any production proposal requires a separate architecture review, threat model, penetration test, data-protection approval, disaster-recovery test, change advisory approval, and signed production release decision.

## 10. First Meeting Agenda and Immediate Next Actions

The first 90-minute working session should confirm the pilot sponsor; select the single use case; name the operational owner and technical source owner; identify candidate extracts; agree the Bank’s preferred environment; and classify the pilot data. ReconcileAI will then return a completed field-mapping sheet, a target data-flow diagram, an environment bill of materials, and a dated acceptance-test plan.

Richard’s immediate request to Taj Bank should be: **permission to hold the control-fit workshop and nominate the required workstream owners.** ReconcileAI should not request production credentials, unrestricted data, or a production deployment during that first step.

## References

[1] [TAJBank — Official Website](https://tajbank.com/)

[2] [TAJBank — Frequently Asked Questions](https://tajbank.com/faqs/)
