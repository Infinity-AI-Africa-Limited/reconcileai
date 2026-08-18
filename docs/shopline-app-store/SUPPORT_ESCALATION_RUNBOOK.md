# ReconcileAI × SHOPLINE Support Escalation and Evidence-Retention Runbook

## Purpose

This runbook defines the pre-launch support path for ReconcileAI Tier 1, the
read-only SHOPLINE reconciliation application. It applies only to merchant order,
payment, settlement, sync, installation, subscription, and data-rights questions.
It must not be used to solicit bank credentials, store passwords, payment-card data,
or customer personal information.

## Supported intake and ownership

Before formal launch, reviewer and developer-store enquiries use the controlled
review arrangement described in `REVIEWER_TEST_GUIDE.md`. At go-live, the public
App Details contact must be changed to `support@reconcileaiafrica.com` and that
inbox must be monitored before the app is submitted for review. The initial support
owner records each case, coordinates product and engineering investigation, and
closes the case only after the merchant or reviewer can repeat the expected workflow.

| Case type | First response | Evidence to retain | Escalate when |
| --- | --- | --- | --- |
| Install or OAuth failure | Confirm store handle, timestamp, callback correlation ID, and read-only scope approval. | Redacted correlation ID and outcome; never authorisation code or token. | Two reproducible developer-store failures, or any merchant impact. |
| Missing, delayed, or duplicate sync | Confirm store connection, redacted webhook ID/topic, sync timestamp, and recovery run outcome. | Redacted delivery metadata, batch ID, and idempotency outcome. | Expected event remains absent after the bounded recovery window. |
| Reconciliation or settlement discrepancy | Confirm the order/reference, amount, settlement status, and whether a settlement-file path is applicable. | Redacted reconciliation record IDs and resolution decision. | The discrepancy affects an entitlement, merchant balance interpretation, or multiple orders. |
| Subscription or plan question | Confirm current subscription state and the matching SHOPLINE plan event. | Plan name, event type, timestamp, and state transition; no payment data. | Signed subscription event is missing, malformed, or produces an incorrect entitlement. |
| Privacy or data-rights request | Verify signed delivery and classify the mandatory request before any action. | Request audit row, subject hash, endpoint, and completion state. | Any signed request fails or a destructive action is proposed outside the documented workflow. |

## Triage and communication controls

Every case must receive a case identifier, store handle or organisation reference,
start time, impact summary, and redacted correlation data. Staff must never place
access tokens, raw customer records, payment credentials, full webhook payloads, or
bank data in tickets, email, chat, screenshots, or issue trackers. Support should
state the application boundary clearly: ReconcileAI reads authorised store data,
does not write to the merchant store, and uses a settlement-file workflow where the
required payout data is unavailable through SHOPLINE.

No public response-time promise is made until ReconcileAI has approved and staffed a
published support service level. For App Store review, the operational requirement is
that each reported issue has an accountable owner, a redacted evidence trail, and a
clear escalation route.

## Evidence retention and review

Retain the minimum evidence necessary to reproduce the operational decision: app
version, store/organisation reference, timestamp, redacted correlation identifier,
event topic, sync or reconciliation batch identifier, outcome, and close rationale.
Do not retain raw request bodies, customer addresses, access tokens, or payment
credentials in the support record. The application audit trail and GDPR request table
remain the system of record for webhook and data-rights processing.

Before each release, the release owner reviews open cases, recurring categories,
pending data-rights requests, and any workaround that could affect a merchant. A
change affecting SHOPLINE scopes, callbacks, webhooks, payment/settlement mapping,
pricing, or retail navigation must follow the change-control process in
`RELEASE_CONTROL_RECORD.md` and the rollback process in `OPERATIONS_RUNBOOK.md`.
