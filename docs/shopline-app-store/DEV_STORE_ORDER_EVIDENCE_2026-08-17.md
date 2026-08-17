# ReconcileAI Dev Store Order Evidence — 17 August 2026

## Confirmed developer-store order

The authorised ReconcileAI Dev Store checkout completed successfully on 17 August
2026 at 15:01 GMT+1. SHOPLINE assigned **order 1003** and displayed an order-confirmed
page. The order used the store's **Cash on delivery** test payment method and the
standard developer-store shipping method.

## Reconciliation implication

The order was manually marked **Paid** at 22:13 in the authorised developer-store
administrator session. The order detail records both “You manually marked this
order as paid” and “SYSTEM processed a payment request” for Cash on Delivery.

This establishes the controlled paid-order source event without using a customer
payment instrument. The remaining acceptance evidence is to observe the
`orders/paid` delivery, confirm the scheduled or real-time sync fetched order
`1003`, and confirm the resulting matched transaction or exception is visible in
ReconcileAI Settlement Monitor.

No customer address, email address, phone number, or payment details are retained
in this evidence record.
