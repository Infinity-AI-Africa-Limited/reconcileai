# ReconcileAI × SHOPLINE P2 Drill Execution Record

## Purpose and status

This record defines the required live operational drills for the Redirected,
read-only Tier 1 SHOPLINE application. It is intentionally a **pre-execution
control**: the drills must not be marked complete until the reviewed retail release
is merged and deployed, a merchant tenant can enter the correct retail context, and
the resulting evidence is captured without exposing customer, bank, or access-token
data.

On 18 August 2026, the release candidate passed TypeScript validation and the full
automated suite (107 files / 1,662 tests). This supports the drill readiness but does
not substitute for a live production exercise.

## Monitoring and alert-response drill

| Step | Controlled action | Expected evidence | Pass condition |
| --- | --- | --- | --- |
| 1 | Install or reconnect ReconcileAI Dev Store in the correct retail tenant context. | Redacted store handle, organisation identifier, OAuth callback correlation ID, and subscription registration outcome. | Settlement Monitor identifies the connected developer store, not Infinity AI Staff. |
| 2 | Place one controlled developer-store cash-on-delivery order and mark it paid through the developer-store payment flow. | Redacted paid-order reference, webhook ID/topic, received timestamp, and sync batch ID. | `orders/paid` is accepted once and the order is visible in Settlement Monitor within the agreed recovery window. |
| 3 | Trigger one permitted recovery cycle after the original event. | Redacted retry correlation and idempotency outcome. | No duplicate transaction, payment leg, exception, or subscription side effect is created. |
| 4 | Inspect the operational dashboard and log path for delivery, sync, reconciliation, and exception outcome. | Redacted health/metric extract and operator observation. | The operator can identify the store, delivery state, reconciliation result, and any exception without raw customer payloads. |

## Incident and rollback exercise

| Scenario | Safe exercise | Expected outcome | Evidence to retain |
| --- | --- | --- | --- |
| Failed delivery or sync | Use a controlled developer-store event or bounded recovery cycle; do not suppress security verification. | The failure is recorded, no unsigned event is accepted, and the documented recovery path is available. | Redacted event ID, topic, timestamp, error class, recovery action, and result. |
| Incorrect retail tenant context | Use the reviewer/merchant test path after release. Do not use a super-admin context as proof. | Access is denied or directed to the correct tenant; no staff data is displayed. | Redacted user role, organisation code, route, and observation. |
| Release rollback | If a reviewed release regresses the controlled flow, revert through the approved pull-request/release process, then repeat the non-destructive verification. | The prior reviewed version is restored and the controlled order flow is retested. | Release identifier, decision owner, rollback timestamp, and post-rollback validation result. |

## Completion conditions

The release owner must append actual timestamps, redacted identifiers, operator,
outcome, and any corrective action to this record only after each live drill. A
customer-redaction or shop-redaction request is explicitly outside this exercise;
the GDPR proof is limited to a signed, non-destructive customer-data acknowledgement.

The P2 live drills remain blocked until Infinity AI PR #87 receives the required
review and its approved release is deployed. No App Store review submission should
be created before this record contains the completed live evidence.
