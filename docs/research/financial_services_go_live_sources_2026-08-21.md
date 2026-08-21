# Financial Services Go-Live Assessment — Source Register

**Purpose:** Preserve primary and institution-grade evidence used for the Financial Services vertical readiness assessment and launch plan.

## Current Authoritative Code Baseline

| Evidence | Finding | Use in assessment |
|---|---|---|
| [Infinity AI authoritative repository main](https://github.com/Infinity-AI-Africa-Limited/reconcileai) | The private repository main branch displayed commit `51ac8eb` (merged PR #95) as its latest commit when reviewed on 21 August 2026. The repository contains Financial Services, on-premise, CBS connector, CI and deployment artefacts. | Treat `51ac8eb` as the evidence baseline for release-state statements. This establishes source availability, not that a bank deployment is ready. |
| [Commit `51ac8eb`](https://github.com/Infinity-AI-Africa-Limited/reconcileai/commit/51ac8eb08ceeae1f3a0a26a0fd47547b1dc5c654) | PR #95 merged a TypeScript-config fix and cleared stale release items. | Do not imply that this merge alone closes security, resilience, integration, UAT or institution approval gates. |

**Operational observation (21 August 2026):** The authoritative GitHub Actions overview showed repeated successful `SHOPLINE scheduled sync` runs on `main`, including runs #645 and #644. This confirms that the retail scheduled workflow is executing; it does **not** evidence Financial Services connector durability, bank disaster recovery, or current full-suite CI status. The CI workflow must be checked separately before any release candidate is accepted.

## Regulatory and Control Context

| Source | Verified finding | Relevance to ReconcileAI |
|---|---|---|
| [Central Bank of Nigeria — Payments System Supervision](https://www.cbn.gov.ng/PaymentsSystem/) | CBN states that its payments-system supervision mandate includes soundness and safety, sound internal controls, transparency, accountability and monitoring/early-warning capability. | The Financial Services go-live plan must include read-only control operation, auditable exception handling, monitoring, incident response, and no unsupported payment-posting capability. |
| [CBN circulars feed](https://www.cbn.gov.ng/RSS/CircularsRSS.html) | The official circular feed records the 15 June 2026 circular on market structure, data localisation, UBO disclosure and systemic oversight in the Nigerian payments system, plus the March 2026 CSAT deployment notice. | Data residency, third-party risk, security assurance and supervisory evidence should be treated as live bank go-live gates. The legal/compliance interpretation must be confirmed with the bank and counsel. |
| [Nigeria Data Protection Commission — Nigeria Data Protection Act 2023](https://ndpc.gov.ng/download/nigeria-data-protection-act-2023) | NDPC provides the Nigeria Data Protection Act as Nigeria’s personal-data legal framework and operates registration, audit and breach-reporting services. | ReconcileAI must use a bank-approved data-processing role allocation, DPA, lawful-basis/data-flow record, access controls, retention/deletion process, and tested incident path before live bank data is processed. |
| [PwC Uganda — BoU Cyber Risk Management Guidelines](https://www.pwc.com/ug/en/publications/key-reflections-bou-cyber-risk-management-guidelines.html) | PwC reports that BoU requirements for supervised financial institutions took effect on 1 December 2024 and require robust cybersecurity and technology-risk-management practices. | For the Uganda expansion, the same deployment pack should carry technology-risk, resilience, vendor-control and data-protection evidence, validated against the target institution’s obligations and Uganda counsel. |

## Usage Boundaries

This register supports product-readiness planning, not legal certification. Specific regulatory applicability, localisation scope, reporting thresholds, contractual obligations and residual-risk acceptance require confirmation by the target institution’s legal, compliance, information-security and data-protection teams.
