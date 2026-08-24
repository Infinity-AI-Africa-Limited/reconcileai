# Bank Pilot Security and Identity Decision Record

**Purpose:** Capture the decisions that must be made jointly with the bank before a read-only pilot processes approved data.

## Session and step-up policy

| Control | Proposed default | Bank decision | Evidence / approver |
|---|---|---|---|
| Session duration | Bounded configuration; no year-long sessions |  |  |
| MFA / conditional access | Bank IdP policy |  |  |
| Step-up actions | Change data route, role, AI setting, export, retention or privileged configuration |  |  |
| Session revocation | Bank JML / incident process |  |  |
| CSRF protection | Assessment and mutation-level evidence required for cookie-authenticated flows |  |  |

## Identity and access model

| Area | Required decision / evidence |
|---|---|
| Identity provider | Bank IdP and federation protocol; no shared operational accounts. |
| Roles | Least-privilege role matrix for Operations, Finance Control, Risk, Audit, Technology, DPO and support. |
| Service accounts | Read-only source access; purpose-bound scopes; credential rotation; no production database credentials. |
| Privileged access | Named administrators, approval, logging, periodic review and emergency access process. |
| Joiner-mover-leaver | Bank-owned account lifecycle, removal SLA and access-review frequency. |

## Security evidence request

The bank and ReconcileAI must agree test ownership for vulnerability review, penetration testing, secret management, network segmentation, logs, incident notification and residual risk acceptance. Completion requires signed evidence, not a verbal statement.
