# Session, Step-Up Re-Authentication and CSRF Design

**Status:** Pre-bank design record. This document does not claim that a bank's identity policy or security approval has been obtained.

## Objective

The bounded session policy is a necessary control, but a bank pilot also needs a documented decision for sensitive actions, re-authentication, CSRF protection and audit evidence. The initial pilot must default to the bank’s IdP, MFA and conditional-access policy where available.

## Proposed sensitive-action categories

| Category | Examples | Proposed policy | Bank decision required |
|---|---|---|---|
| Data-route control | Add/change source, service account, mapping, network route | Step-up immediately before save; named Technology/InfoSec approver | Yes |
| Privilege control | Role change, support access, break-glass access | Step-up; dual control where bank policy requires | Yes |
| Data-governance control | Enable AI, alter retention, export evidence, change residency | Step-up; DPO/InfoSec audit event | Yes |
| Security/key control | Key reference, audit mode, environment/secrets configuration | Step-up; restrict to privileged administrators | Yes |
| Operational workflow | Assign/reassign exception, approve a resolution | Bank-defined; at minimum standard authenticated session plus audit | Yes |

## Implementation design

1. Store a **recent authentication timestamp** in the authenticated session and require it to be within the configured step-up window before a sensitive mutation.
2. If stale, redirect/fail with an explicit `STEP_UP_REQUIRED` result; never silently execute after a session refresh.
3. Re-authenticate using the bank IdP/MFA mechanism; do not introduce a ReconcileAI password path for federated bank users.
4. Record the action, actor, target tenant, prior re-authentication timestamp, policy version and approval metadata in the audit trail.
5. Make sensitive-action policy tenant-configurable but use a secure default that cannot be weakened by an ordinary operator.

## CSRF assessment and acceptance method

| Check | Required evidence |
|---|---|
| Cookie attributes | `HttpOnly`, `Secure`, `SameSite` setting and domain/path scope for every auth cookie. |
| Origin enforcement | Mutating endpoint rejects cross-origin requests unless the specific supported flow is documented. |
| Token strategy | For any cookie-authenticated state change that remains susceptible, validate an anti-CSRF token or equivalent framework control. |
| Negative tests | Record cross-site form/fetch attempts against representative protected mutations. |
| Exception handling | Document OAuth/webhook routes that are intentionally cross-site and their compensating signature/state controls. |

## Exit criterion

The design becomes a bank-pilot control only after it is implemented, tested against the selected authentication path, reviewed by the bank, and mapped to the bank’s conditional-access/MFA policy. Until then, it is an implementation-ready design, not P4 closure evidence.
