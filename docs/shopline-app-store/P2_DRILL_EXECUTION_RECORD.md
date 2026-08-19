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

On 18 August 2026, the authorised Partner Portal confirmed that **ReconcileAI Dev
Store** (`reconcileai-dev`) remains the primary development store. Its administration
session was opened successfully for the post-merge installation and tenant-context
exercise. This confirms developer-store access only; it is not proof that the
ReconcileAI merchant tenant hand-off, sync, or settlement evidence has succeeded.

The post-merge **Test App** flow subsequently completed the production OAuth callback
and reached `https://www.reconcileaiafrica.com/shopline/welcome?org=SL_RECONCILEAI_DEV&reconnect=true`.
The welcome page correctly displayed the expected organisation code. However, after
using **Go to Settlement Monitor**, the application still displayed the Infinity AI
Staff context, financial-services navigation, and “No active SHOPLINE stores
connected.” The super-admin retail portal context was therefore **not persisted**
across the route transition. This is a P0 defect: no paid-order, sync, or settlement
claim may be treated as valid until the hand-off reaches `SL_RECONCILEAI_DEV` in the
Settlement Monitor.

The production **Super Admin → Organisations** view separately confirmed that
`SL_RECONCILEAI_DEV` exists as active **ReconcileAI Dev Store**, segment **Retail
Commerce**, alongside `SL_RECONCILEAI`. The overview card nevertheless reported
zero retail organisations, which is a separate reporting inconsistency. The tenant
hand-off defect is therefore not evidence of a missing retail organisation or a
non-retail connector binding; the fix must preserve the existing retail record and
make the verified portal context reach the Settlement Monitor.

The same Super Admin table exposes an established **Enter Portal** control for each
retail record. Its behaviour is the authorised, non-destructive comparison path for
the welcome-page context hand-off; no tenant data was changed while observing it.

## Signed GDPR acknowledgement — 18 August 2026

A controlled request was signed with the authorised App Secret and sent only to the
configured `customers-data-request` endpoint for
`reconcileai-dev.myshopline.com`. The payload contained a synthetic request
identifier and no customer name, email, address, payment data, or bank data. The
production endpoint returned **HTTP 200**, `ok: true`,
`kind: customer_data_request`, `status: completed`, and `recordsAffected: 0`.

This verifies signature acceptance, store resolution, the audit-acknowledgement
path, and the non-destructive access-request response. No customer-redaction,
shop-redaction, uninstallation, or production merchant-data mutation was invoked.

## Deployed tenant-context repair recheck — pending route outcome

After Richard confirmed the reviewed repair merged and deployed, the production
welcome URL for `SL_RECONCILEAI_DEV` loaded successfully and displayed the expected
developer-store organisation code. The remaining check is the post-load transition
to Settlement Monitor: it must preserve the Retail Commerce context and display the
connected store. This record must not treat the welcome-page render alone as a
successful tenant-context hand-off.

The route transition was subsequently completed after the deployed repair. Settlement
Monitor now displays **“Viewing as portal: ReconcileAI Dev Store · Retail Commerce ·
SL_RECONCILEAI_DEV”** and the retail-only navigation surface, confirming that the
portal context persists correctly. The page still reports **“No active SHOPLINE stores
connected”** in that organisation. The tenant-context P0 defect is therefore fixed;
the remaining P0 blocker is the connector-store activation/visibility path required
before paid-order and sync evidence can be captured.

The connector row was then read without mutation and confirmed active under
`SL_RECONCILEAI_DEV`, with a successful recent sync timestamp and no recorded sync
error. The visibility gap is therefore a server-side scope defect, not an inactive
store: Settlement Monitor used the authenticated Infinity AI Staff user’s
`organizationId` rather than the verified super-admin portal organisation. The
pending repair carries an explicit organisation override only on the affected
SHOPLINE procedures and resolves it through the existing `resolveOrgScope` guard.
That guard rejects overrides for every non-super-admin user; it does not trust the
browser portal label as an authorisation decision.

## Deployed portal-scope verification — 19 August 2026

After the follow-on portal-scoping release was merged and deployed, the OAuth welcome
route was reopened for `SL_RECONCILEAI_DEV`, then **Go to Settlement Monitor** was
used to establish the portal context. The production Settlement Monitor displayed
the expected Retail Commerce portal banner and an active `reconcileai-dev` store in
USD, with a recent successful sync timestamp. This confirms that the server-side
SHOPLINE reads now honour the authorised super-admin portal organisation rather than
the underlying Infinity AI Staff organisation.

Displayed settlement figures remain product-preview data until they are tied to the
controlled paid-order evidence below; this verification establishes tenant scope and
connector visibility only, not a merchant financial-performance claim.

The tenant-scoped **Sync Status** page was also verified on 19 August 2026. It showed
`reconcileai-dev` as active, fourteen processed webhook deliveries, zero pending
deliveries, and zero failed deliveries. The latest delivery history included
`orders/create`, `order_transactions/create`, `orders/updated`, and `orders/paid`,
all processed for the developer store. This establishes delivery acceptance and
processing health; the separate order/payment reconciliation evidence is documented
from the redacted transaction ledger.

## Controlled paid-order source event — 19 August 2026

A single developer-store cash-on-delivery order, **#1004**, was created at 11:21
GMT+1 using a synthetic ReconcileAI test contact and delivery record. No real payment
method, customer data, or merchant order was used. The order total was the existing
developer-store test product price plus configured test shipping. The next controlled
step is to mark this developer-store order paid through the authorised admin workflow,
then record only the order reference, webhook topic/status, sync result, and
reconciliation outcome.

Order #1004 was then manually marked **Paid** through the developer-store Cash on
Delivery workflow. The order administration record showed the paid status, full test
amount as customer payment and total paid, and a platform event noting that the
payment request was processed. This is the controlled paid-event source; no real
payment was taken. The remaining P0 proof is the resulting SHOPLINE delivery,
tenant-scoped sync, and ReconcileAI reconciliation record.

The tenant-scoped Sync Status view then confirmed the complete delivery sequence for
the controlled paid event: `order_transactions/create` at 11:21, `orders/create` and
`orders/updated` at 11:22, and `orders/paid` at 11:25 on 19 August 2026. All four
were processed for `reconcileai-dev`. The page showed eighteen processed events,
zero pending, zero failed, and a recent successful store sync. This proves delivery,
signature acceptance, store resolution, processing, and the scoped operational
dashboard path; the next check ties the resulting order and payment rows to the
Settlement Monitor reconciliation result.

The redacted reconciliation ledger was queried for the controlled #1004 order
reference. It contains one `sl_orders_reconcileai-dev` row, status `unmatched`, at
the expected test amount, but no corresponding `sl_payments_reconcileai-dev` row.
This is the verified Tier 1 boundary for a Cash on Delivery store rather than an
ingestion defect: SHOPLINE’s optional Payments endpoints return no merchant payment
feed for stores not on SHOPLINE Payments, and Cash on Delivery does not create a
gateway-captured payment record. The live evidence therefore proves the webhook and
order-ingestion path. The correct Tier 1 completion path is a controlled
settlement-file import, which represents the courier or payment-provider remittance
leg and can then reconcile against the ingested order.

The approved one-row synthetic remittance CSV was uploaded in the persisted
`SL_RECONCILEAI_DEV` Settlement Monitor portal and passed browser-side file handling.
Column detection then returned **“No active SHOPLINE store for this organisation.”**
The active store is visible to the same portal in Settlement Monitor and Sync Status,
so this is a separate server-side scope gap in the settlement-file import procedure.
No settlement row was imported and no reconciliation state was changed. The import
procedure must apply the same existing super-admin-only organisation resolution used
by the tenant-scoped SHOPLINE reads before this controlled test is retried.

## Deployed settlement-file import — 19 August 2026

Following deployment of the settlement-import scope repair, the same persisted
`SL_RECONCILEAI_DEV` portal successfully accepted the approved one-row synthetic
remittance CSV. Column detection identified `order_id`, `transaction_id`,
`settlement_amount`, `currency`, `settlement_date`, `fee`, and `description`, then
enabled the one-row import. After import, Settlement Monitor returned to the retail
overview with changed aggregate cards, confirming that the tenant-scoped import
completed. The exact order #1004 reconciliation result must be verified from the
redacted ledger before the P0 match claim is recorded.

The post-import redacted ledger query confirmed the complete two-leg match for the
controlled order. The original SHOPLINE order row and imported remittance row each
hold the same synthetic test amount in USD, both are `matched`, and their reciprocal
`matchId` values link them to one another. The remittance uses the synthetic
`COD-TEST-1004-20260819` reference. This completes the Tier 1 order-to-remittance
reconciliation proof for Cash on Delivery without claiming a native SHOPLINE Payments
gateway record or using merchant/customer payment data.

Before the controlled recovery run, the tenant-scoped Sync Status page showed
`reconcileai-dev` active, 18 processed webhook deliveries, zero pending, and zero
failed. Its recent-event ledger retained the controlled #1004 event sequence,
including `order_transactions/create`, `orders/create`, `orders/updated`, and
`orders/paid`, all marked processed. This is the baseline for the bounded manual-sync
idempotency check; the recovery must not create a duplicate order, remittance,
exception, or webhook side effect.

The same tenant-scoped Sync Status row exposed the authorised **Sync Now** control
for the active developer store. The controlled recovery will run only against that
store and will be compared with the redacted #1004 match pair and the 18-delivery
baseline above.

Richard executed the bounded recovery on 19 August 2026. The live confirmation
reported **“Sync triggered for reconcileai-dev — 1 orders, 0 payments processed.”**
The redacted post-recovery ledger retained exactly two #1004 rows: the source order
and the synthetic remittance, each with a duplicate count of one, `matched` status,
and reciprocal match IDs. No exception rows reference either controlled transaction.
This verifies that the manual recovery read the store safely and preserved the
existing match without duplicate transaction, remittance, exception, or webhook
side effects.

## Fail-closed incident drill — 19 August 2026

A deliberately unsigned, synthetic customer-data request was sent to the configured
production SHOPLINE GDPR endpoint. It returned **HTTP 401**. This confirms the
production boundary rejects unsigned webhook/GDPR traffic before it can reach the
customer-data processing path. The request used only the `reconcileai-dev` store
identifier and a synthetic drill identifier; it contained no customer, payment, or
bank data. No accepted GDPR audit row, redaction, or store action was created.

## Screenshot validation — 19 August 2026

Richard supplied four authentic production captures covering Settlement Monitor, Sync
Status summary, Sync Status store/webhook detail, and SHOPLINE Connection. Their
content supports the reviewer narrative: the ReconcileAI Dev Store retail portal is
active, the controlled `orders/paid` delivery is processed, and the store is
connected. They are not yet valid App Store upload assets because they measure
approximately **1896–1897 × 742–745 pixels**, not 1920×1080, and each includes an
operating-system activation watermark. They must be recaptured at 1920×1080 without
the watermark rather than stretched, padded, or semantically altered.

Richard then supplied clean browser-native 2048×1152 (16:9) captures for Settlement
Monitor, Sync Status, and SHOPLINE Connection. Each was proportionally downscaled
with a Lanczos filter to an exact 1920×1080 PNG without cropping, padding, text
editing, or content generation. The resulting validated App Store assets are:

| Screenshot | Validated export |
| --- | --- |
| Settlement Monitor | `reconcileai-settlement-monitor-1920x1080.png` |
| Sync Status | `reconcileai-sync-status-1920x1080.png` |
| SHOPLINE Connection | `reconcileai-shopline-connection-1920x1080.png` |

The clean captures supersede the earlier non-compliant watermark-bearing image set.

On 19 August 2026, the three final 1920×1080 PNG assets were uploaded to the
SHOPLINE **Product preview** section and the App Details listing returned **“Saved
successfully.”** The listing now displays the three production preview thumbnails;
no app version was created and no review submission was made as part of this save.

## Subscription lifecycle evidence check — 19 August 2026

The ReconcileAI Dev Store connector record was inspected without mutation. No
`sl_connector_subscriptions` record exists for `reconcileai-dev`, and no persisted
delivery exists for the configured app-subscription lifecycle topics. This does not
disprove registration in the connector; it means the developer-store test has not
yet activated a SHOPLINE-managed app subscription lifecycle. The required P0 proof
remains a signed lifecycle delivery and resulting subscription-state row for the
developer store, captured through a controlled test-plan activation rather than a
merchant charge.

The authorised Partner Portal **Test App in development store** screen was opened
for ReconcileAI Dev Store on 19 August 2026. Its only available action is **Test
App**, which invokes the access/OAuth test flow; it exposes no subscription-plan or
trial activation control. The developer-store admin also labels this package as for
app development and access verification only. Therefore a no-charge lifecycle trial
cannot be activated through this development-store package. No subscription, charge,
or billing state was created during this attempt. The lifecycle P0 proof requires a
SHOPLINE-supported billing-test environment or a controlled, cancellable trial in an
eligible non-development store.

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
