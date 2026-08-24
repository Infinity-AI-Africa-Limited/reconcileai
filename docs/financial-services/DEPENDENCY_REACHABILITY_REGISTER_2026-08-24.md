# Financial Services Dependency Reachability Register

**Assessment date:** 24 August 2026
**Purpose:** Turn the raw production dependency audit into a reviewable bank-security artefact. This is a triage register—not a risk acceptance.

## Current evidence

| Artefact | Location | Result |
|---|---|---|
| Production dependency inventory | Generated on demand by `scripts/generate-production-sbom.mjs` using `pnpm list --prod --depth Infinity` | The intermediate dependency tree is intentionally not committed because it is excessively large and reproducible from the lockfile. |
| Production dependency audit | `docs/financial-services/evidence/production_dependency_audit_2026-08-24.json` | Generated on 24 August 2026. |
| Audit severity summary | Same audit record | **10 high, 19 moderate, 5 low, 0 critical.** |

The audit is an inventory of advisories, not a statement that each advisory is exploitable in ReconcileAI’s deployed topology. Conversely, a browser-only or build-only dependency must not be dismissed without an explicit reachability analysis.

## Required classification method

Each advisory must receive one of the following classifications, with a named owner and evidence link:

| Class | Meaning | Required evidence / action |
|---|---|---|
| **Server-reachable runtime** | A deployed server process can reach the vulnerable path with untrusted or bank-controlled input. | Upgrade, patch, compensate or obtain formal bank risk acceptance before raw bank data. |
| **Browser-reachable client** | A browser bundle can reach the vulnerable path with user-controlled/rendered content. | Assess XSS/content exposure; patch or document compensating controls. |
| **Build / development only** | Not included in the deployed runtime artifact. | Lockfile proof, deployment manifest and CI/build-path evidence. |
| **Present but unreachable** | Included in a deployed artifact but vulnerable path is proven unreachable. | Architecture trace, code-path review and negative test where practical. |
| **Pending vendor fix** | No viable remediation yet. | Documented compensating control, expiry date and bank security-risk decision. |

## Review register

| Advisory / package | Severity | Transitive path | Classification | Deployed call path reviewed | Remediation / compensating control | Evidence link | Owner | Decision due | Bank acceptance |
|---|---|---|---|---|---|---|---|---|---|
| _Populate from audit JSON_ |  |  |  |  |  |  |  |  |  |

## Exit criterion

This workstream is complete only when all production advisories have a classification, every server-reachable high finding has a documented disposition, the SBOM/inventory is dated and repeatable, and the target bank’s security function accepts the residual risk. The current **10 high findings mean this criterion is not yet met**.
