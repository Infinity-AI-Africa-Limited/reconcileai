# ReconcileAI × SHOPLINE Operations, Incident, and Rollback Runbook

## Service monitoring

| Signal | Watch condition | Initial response | Escalation point |
|---|---|---|---|
| OAuth callback | Signature failure, code exchange error, or tenant provisioning failure. | Preserve correlation ID; verify callback URL and app credentials; do not bypass signature checks. | Two failed developer-store reproductions or any production merchant impact. |
| Webhook delivery | Signature failure, duplicate, non-2xx, or missing expected event. | Inspect redacted delivery/audit record; use reconciler; preserve idempotency. | Repeated delivery failures or SHOPLINE subscription removal risk. |
| Sync | 429, token refresh failure, partial recovery, or reconciliation error. | Observe per-store pacing; retry only within the bounded recovery policy; inspect token state. | Recovery failure after the defined retry window. |
| Billing lifecycle | Missing create/paid/expiration topic, unexpected entitlement change. | Reconcile topic subscriptions; verify signed payload and current subscription record. | Mismatch persists after reconciliation. |
| Data-rights route | Unsigned request, malformed request, or deletion workflow error. | Reject unsigned traffic; do not replay destructive redaction against live data. | Any verified signed-request failure. |

## Incident response

The on-call operator records the store, organisation, correlation identifier,
redacted payload metadata, start time, impact, and containment action. The team must
not copy access tokens, customer details, or bank data into tickets. If a connector
change is implicated, pause the affected synchronisation path, preserve audit
evidence, and use the last reviewed release as the rollback candidate.

## Rollback exercise

Before broad App Store rollout, run the following developer-store drill: deploy the
reviewed release; create a controlled sync; roll back the application release;
confirm the connector retains no unsafe partial state; re-run the reconciler; and
record that the same order/webhook cannot be duplicated. The exercise must be
performed after the review branch merges—not simulated from documentation alone.

## Change control

Every change to SHOPLINE scopes, callbacks, webhook topics, payment/settlement
mapping, pricing, or merchant-visible navigation requires: a documented reason,
security review, regression evidence, release owner, rollback plan, and a post-
release developer-store verification record.
