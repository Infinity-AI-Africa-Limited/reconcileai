# ReconcileAI × SHOPLINE Merchant Onboarding Runbook

## Purpose

This runbook governs the Tier 1 merchant journey from App Store installation to a
usable Settlement Monitor. It is deliberately limited to SHOPLINE retail commerce;
it does not introduce financial-services, banking, or manual data-ingestion
workflows to a merchant tenant.

| Stage | ReconcileAI responsibility | Merchant outcome | Required evidence |
|---|---|---|---|
| Install | Verify the signed installation request and initiate OAuth with the declared read-only scopes. | The merchant understands the requested access before authorisation. | Installation audit event and callback correlation ID. |
| Authorise | Exchange the code, encrypt the token, provision the retail organisation, store connection, and settlement channel. | The authorised store becomes available to the merchant tenant. | Provisioning record, encrypted-token reference, tenant membership proof. |
| Initial sync | Run bounded historical recovery and reconcile available orders, payments, refunds, and SHOPLINE Payments legs. | Settlement Monitor presents current information without claiming unavailable payout data. | Sync batch outcome and reconciliation statistics. |
| Orientation | Present Settlement Monitor first, Dashboard second, then Sync Status, Orders & Payments, and Payment Exceptions. | The merchant understands the retail-only navigation. | Reviewer or merchant acceptance note. |
| Exception path | Explain order/payment exceptions and the settlement-file path where payout data is unavailable. | The merchant has an actionable next step rather than a fabricated match. | Exception record and, if used, uploaded authorised settlement file. |
| Support | Route support to `support@reconcileaiafrica.com`. | The merchant receives an accountable response channel. | Ticket ID and resolution record. |

## Preflight controls

The operator must confirm that the installing merchant can authenticate into the
provisioned ReconcileAI retail tenant. A SHOPLINE callback alone is not an identity
session. Until the production merchant-identity hand-off is complete, the
super-admin portal-context feature is restricted to support and developer-store
testing and must not be represented as the merchant login solution.

## Merchant communication

The merchant-facing onboarding message should state that ReconcileAI reads the
authorised SHOPLINE retail data necessary for reconciliation, does not initiate
payments, and requires a settlement-file path when SHOPLINE Payment payout data is
not available for the store.
