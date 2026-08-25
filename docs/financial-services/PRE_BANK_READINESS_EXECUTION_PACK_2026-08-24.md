# Financial Services Pre-Bank Readiness Execution Pack

**Purpose:** Complete the maximum defensible amount of pilot readiness before a bank is selected, without representing templates, sandbox drills or software controls as bank acceptance evidence.

## Executive decision

ReconcileAI can complete significant **platform, evidence-preparation and repeatable-onboarding work now**. It cannot unilaterally close a bank's data, identity, environment, operational-owner or release-approval gates. The correct pre-bank objective is therefore a reusable pilot package that makes the first bank control-fit workshop, private deployment and parallel run faster and less bespoke.

> **Non-negotiable boundary:** No raw bank data enters Railway, a public SaaS environment, external AI service or a local development machine. All pre-bank drills use generated, synthetic or approved masked data only.

## What ReconcileAI can complete before selecting a pilot bank

| Action | ReconcileAI can complete now | Evidence we can produce now | What remains bank-dependent |
|---|---|---|---|
| **1. Select workflow and owner** | Create the workshop pack, use-case scoring method, source-data questionnaire, success-scorecard template and RACI. Define default candidate workflows. | This pack and a blank bank-specific control-fit record. | Bank selects the actual workflow, names its daily-close owner, approves sources and baselines success measures. |
| **2. Bank-controlled boundary** | Harden and test the on-prem/private-VPC deployment pack, egress guard, no-write controls and environment acceptance checklist. | Configuration test results, deployment manifests and acceptance checklist. | Bank provides network, VPC/on-prem hosting, IdP, certificates, secrets, backups and approval to deploy. |
| **3. Durable processing** | Add/maintain durable-queue fail-closed enforcement; create a repeatable Redis/BullMQ drill protocol and synthetic drill data. Run local/sandbox engineering drills where infrastructure exists. | Source code, automated tests and a synthetic drill record. | Provision and operate Redis/BullMQ in the approved pilot environment; execute the bank-environment drill record. |
| **4. Security and identity** | Generate SBOM and reachability register; define session/step-up/CSRF decision record; prepare bank IdP, role-matrix and security-review questionnaires. | SBOM, triage register, design record and completed internal checks. | Bank selects IAM policy, performs integration/security review and approves residual risk. |
| **5. Data and AI treatment** | Maintain fail-closed AI-off controls; prepare the three deployment-option decision pack and DPA/data-flow/retention questionnaires. | Tested AI-off control, prompt-minimisation design and approval templates. | Bank chooses AI-off, private inference or approved processor, then approves the resulting data route and DPA. |
| **6. Keys, audit and resilience** | Package KMS/HSM, immutable-audit, backup/restore, RTO/RPO, monitoring, incident and support templates; test control-plane configuration guards. | Configuration tests and reusable operational evidence templates. | Bank configures/proves its KMS/HSM, WORM/write-deny store, backup target, monitoring and recovery controls. |
| **7. Parallel pilot and release** | Prepare runbook, daily control-total template, exception-review protocol, UAT scripts and go/no-go record. | Blank controlled-pilot operational pack. | Bank supplies data, operates the run, accepts reconciled results and signs the release decision. |

## ReconcileAI pre-bank workstream sequence

### Workstream A — prove software and engineering posture

1. **Generate and maintain an SBOM and reachability register.** The current audit posture must be decomposed into server-reachable, browser-only, build-only and not-reachable findings. Each item needs an owner, remediation state and decision record.
2. **Create the durable-queue drill harness.** The harness must exercise worker termination, restart, duplicate delivery, concurrent workers, retry and dead-letter handling using synthetic reconciliation jobs. The same harness becomes the pilot environment acceptance test.
3. **Complete design-bound controls.** Produce a CSRF assessment, a step-up re-authentication design with configurable sensitive actions, and a storage-link migration decision that avoids six-day direct presigned bank-report links.
4. **Regression-test the bank boundary.** Keep the on-prem egress, AI-off, key-custody and immutable-audit startup tests current. These are guardrails, not bank evidence.

### Workstream B — prepare the reusable bank-pilot evidence pack

The following artefacts should be ready before the first workshop:

| Artefact | Minimum contents |
|---|---|
| **Control-fit workshop agenda** | Selected reconciliation decision; source systems; daily cut-off; accountable owner; exception classes; no-write boundary; desired evidence. |
| **Source-data and interface questionnaire** | API/file route; service-account model; field dictionary; control totals; reversal/cut-off rules; replay/idempotency; expected volume and availability. |
| **Bank pilot RACI** | Technology, InfoSec, Operations, Finance Control, Internal Audit, Risk, DPO, support and—for a non-interest bank—Shariah governance. |
| **AI and data treatment decision record** | AI-off/private inference/approved processor option; classification; lawful basis; residency; retention; DPA; model-call minimisation; approvers. |
| **Security and identity evidence request** | IdP/SSO, MFA, conditional access, least-privilege service account, network, certificates, logging, vulnerability review and test ownership. |
| **Resilience and audit evidence request** | KMS/HSM, WORM/write-deny, backup target, RTO/RPO, restore test, monitoring/alerting, incident notification and support escalation. |
| **Parallel-run control pack** | Synthetic onboarding dry run, daily control-total record, exception review, replay/restore drill, UAT scripts and go/no-go record. |

### Workstream C — actions that must wait for the bank

The following cannot truthfully be completed in advance because the proof is specific to the institution and deployment environment:

1. Named bank workflow owner, executive sponsor and control authorities.
2. Approved production-like data source, field mapping, data classification, interface, network route and service account.
3. Private VPC/on-prem deployment, egress, bank IdP, KMS/HSM, WORM/write-deny, monitoring and backup evidence.
4. Bank security, legal/DPO, risk, audit and—where applicable—Shariah approvals.
5. Production-like durable queue, resilience, recovery and incident drills in the bank environment.
6. Read-only parallel-run results, UAT, reconciliation control-total acceptance and signed go/no-go.

## Default first-workflow candidates for discovery

These are **discussion starters, not approved pilot scopes**:

| Candidate | Decision to control | Typical accountable owner | Source evidence | Why it is suitable for a first no-write pilot |
|---|---|---|---|---|
| Instant-payment settlement break | Is the settlement/ledger position complete by cut-off? | Payments Operations / Finance Control | Payment switch extract, settlement file, GL/control account | High-frequency, measurable, readily parallelled. |
| Card/POS settlement exception | Which batches are outstanding, reversed or disputed? | Card Operations / Reconciliation | Acquirer/processor file, settlement report, GL | Bounded data model and strong exception ownership. |
| Core-to-ledger reconciliation | Which daily postings did not reach the corresponding control account? | Finance Control | Core banking extract, GL, reversals schedule | Close-critical and auditable if read-only. |
| NIFI control exception | Which identified non-interest control variance needs human review? | Finance Control / Shariah Compliance | Product/ledger extract, approved rules, evidence attachment | Use only with explicit Shariah-governance involvement; ReconcileAI surfaces evidence, not opinions. |

## Pre-bank exit criteria

ReconcileAI may describe itself as **pilot-pack ready** only when the following internal artefacts exist and are tested:

- Current SBOM and dependency reachability register.
- Synthetic durable-queue drill harness and a recorded non-bank drill.
- CSRF assessment, configurable step-up design and storage-link migration decision.
- Current on-prem/private-boundary, AI-off, key-custody and audit-immutability regression evidence.
- Complete reusable security, data/AI, resilience, source-interface, RACI, UAT and parallel-run templates.

This is not a G1 bank-pilot approval. It is the point at which ReconcileAI can enter a bank control-fit workshop prepared, without asking the bank to invent the programme for us.

## Immediate implementation sequence

1. Generate the SBOM and dependency reachability register from the current lockfile and production audit.
2. Build and execute a synthetic durable-queue drill harness against a non-bank Redis environment.
3. Write the step-up/CSRF and storage-link migration design decisions, including explicit residual-risk ownership.
4. Assemble the bank-pilot evidence templates into a single reusable pack.
5. Submit the internal artefacts and any code changes through the dual-repository review process. Do not merge or deploy to a bank environment until an approved pilot institution closes its joint gates.
