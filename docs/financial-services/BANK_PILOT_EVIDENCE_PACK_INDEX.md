# Financial Services Bank-Pilot Evidence Pack Index

**Status:** ReconcileAI pre-bank preparation. The pack is not a bank approval and must be completed with institution-specific evidence.

## Use this pack in order

| Stage | ReconcileAI artefact | What the bank must return or approve |
|---|---|---|
| **1. Control-fit workshop** | `BANK_PILOT_CONTROL_FIT_WORKSHOP_TEMPLATE.md` | Named workflow, sponsor, daily-close owner, source owners and success scorecard. |
| **2. Data and AI decision** | `DATA_AND_AI_TREATMENT_DECISION_RECORD_TEMPLATE.md` | Data classification, approved route, retention, AI mode and DPA/privacy/security approvals. |
| **3. Security and identity** | `SECURITY_IDENTITY_DECISION_RECORD_TEMPLATE.md` and `SESSION_STEP_UP_AND_CSRF_DESIGN.md` | IdP/MFA/conditional access, role matrix, service accounts, security review and residual-risk decision. |
| **4. Environment and resilience** | `RESILIENCE_AND_AUDIT_EVIDENCE_TEMPLATE.md` | VPC/on-prem deployment evidence, key custody, immutable audit, backup/restore, monitoring and escalation. |
| **5. Durable processing** | `DURABLE_QUEUE_DRILL_PROTOCOL.md` | Redis/BullMQ provisioned in the approved environment and retained drill records. |
| **6. Supply-chain evidence** | `DEPENDENCY_REACHABILITY_REGISTER_2026-08-24.md` and `evidence/reconcileai_production_sbom_2026-08-24.cdx.json` | Reachability review, remediation/risk acceptance and bank InfoSec approval. |
| **7. Parallel run** | `PRE_BANK_READINESS_EXECUTION_PACK_2026-08-24.md` | Approved source routes, daily control totals, exception review, UAT and signed go/no-go. |

## Package acceptance rule

The pilot cannot start merely because every template is filled. Each artefact must carry the approved institution, selected workflow, applicable environment, named owner, date, evidence location and required sign-off. Any unknown, unavailable or unapproved item is a **blocked gate**, not a caveat.

## ReconcileAI-owned pre-bank evidence completed in this pack

- Standardised control-fit, data/AI, identity, resilience, durable-queue and parallel-run templates.
- A reproducible CycloneDX 1.5 production SBOM generated from the project’s production dependency tree.
- A dated production dependency audit and a reachability-review register.
- A pre-bank implementation sequence that preserves the read-only, no-posting and no-external-egress default.

## Explicitly not closed by this pack

- A bank-controlled environment, Redis/BullMQ deployment, KMS/HSM, WORM/write-deny store or backup restore test.
- Bank source-system approval, read-only service account, field mapping, network path or production-like control totals.
- Bank IdP/conditional access, security/InfoSec/DPO/legal/risk approval or named operational-owner register.
- Parallel-run results, UAT or a bank sponsor’s signed release decision.
