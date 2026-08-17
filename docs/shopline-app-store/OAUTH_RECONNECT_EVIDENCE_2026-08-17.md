# ReconcileAI Dev Store OAuth Reconnect Evidence — 17 August 2026

## Controlled developer-store result

The SHOPLINE Partner Portal **Test App** flow was started for the designated
**ReconcileAI Dev Store**. The generated authorisation request used only the
documented read-only scopes:

`read_orders`, `read_payment`, `read_store_information`, `read_returns`, and
`read_gift_card`.

The flow returned to the ReconcileAI welcome page for organisation
`SL_RECONCILEAI_DEV` with the message **“Store Reconnected!”**. The page confirmed
that sync schedules were restored and presented the merchant actions **Go to
Settlement Monitor** and **View Connected Channels**.

## Evidence boundary

This establishes the authorised callback and reconnect path. It does not establish
the remaining end-to-end proof: first historical backfill, signed lifecycle-webhook
delivery, duplicate/missed-webhook recovery, or reconciliation of a new
developer-store order in Settlement Monitor.
