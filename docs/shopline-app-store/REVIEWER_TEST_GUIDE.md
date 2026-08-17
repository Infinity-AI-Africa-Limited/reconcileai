# ReconcileAI × SHOPLINE Reviewer Test Guide

## Purpose

This guide gives a SHOPLINE reviewer a safe, repeatable way to assess the
ReconcileAI Tier 1 merchant workflow. ReconcileAI is a **Redirected public app**
that uses read-only scopes. It does not write products, initiate payments, or ask
for bank credentials.

> Use only the designated SHOPLINE developer-store test account supplied through
> the review arrangement. Do not enter a real merchant store, personal customer
> information, production payment credentials, or bank data. Before submission,
> ReconcileAI must confirm the account configured in the Partner Portal can enter
> the provisioned retail tenant; a stored email/password is not presented as proof
> of an authenticated ReconcileAI merchant session.

## What the reviewer should validate

| Step | Reviewer action | Expected outcome |
|---|---|---|
| 1 | Start installation from the App Store listing and approve the requested read-only scopes. | The app opens in a browser tab through the configured Redirected flow. |
| 2 | Complete SHOPLINE authorisation. | ReconcileAI verifies the callback and provisions the authorised store connection. |
| 3 | Open **Settlement Monitor** from the authenticated provisioned retail tenant. | The merchant home shows settlement status, sync state, and the information available for the authorised test store. |
| 4 | Open **Dashboard** beneath Settlement Monitor. | The merchant receives a summary view without financial-services, bank, or core-banking controls. |
| 5 | Open **SHOPLINE Sync Status**. | The reviewer can see the store connection, recent sync/webhook state, and a controlled manual-sync action where enabled. |
| 6 | Open **Orders & Payments** and **Payment Exceptions**. | The reviewer sees retail-relevant records and exceptions only. |
| 7 | For a store without available payout data, use the documented settlement-file import path. | The product clearly explains that a file is used instead of claiming native payout coverage. |

## Scope rationale

ReconcileAI requests only `read_orders`, `read_payment`, `read_store_information`,
`read_returns`, and `read_gift_card`. These scopes are needed to reconcile order,
payment, refund, store-currency, and split-tender records. No write scope is
requested.

## Billing and privacy behaviour

Subscription changes are handled through SHOPLINE app subscription lifecycle
webhooks. ReconcileAI acknowledges signed lifecycle events and reflects the
subscription state in the merchant experience. The configured privacy routes handle
customer data, customer redaction, and shop redaction requests; unsigned requests
are rejected.

## Support

For review assistance, contact **support@reconcileaiafrica.com**. The public support
page is available at <https://www.reconcileaiafrica.com/support>, with privacy and
terms pages at <https://www.reconcileaiafrica.com/privacy> and
<https://www.reconcileaiafrica.com/terms>.

## Release evidence to attach internally

Before submitting the review, ReconcileAI retains the following evidence in its
release record: a developer-store install and signed callback, first historical-sync
completion, one developer-store order reconciled in Settlement Monitor, signed GDPR
route acknowledgements, verified app-subscription webhook deliveries, and the final
Portal listing screenshots.
