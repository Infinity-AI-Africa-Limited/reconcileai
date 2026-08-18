# SHOPLINE Partner Portal Evidence — 17–18 August 2026

## Verified application context

| Field | Recorded value |
| --- | --- |
| Partner workspace | InfinityAI Africa Limited |
| App | ReconcileAI |
| App type | Public app |
| Portal status | Draft — not submitted for review |
| Loading mode | Redirected |
| Sales channel | Not enabled |
| Primary developer store | `reconcileai-dev.myshopline.com` (ReconcileAI Dev Store) |

## Configuration completed in the authorised Portal session

| Partner Portal field | Configured value |
| --- | --- |
| App contact name | Richard Anwanakak |
| App contact email | `richard@infinityaiafrica.ai` — retained by Richard’s direction until final go-live |
| Customer-data GDPR endpoint | `https://www.reconcileaiafrica.com/api/shopline/gdpr/customers-data-request` |
| Store-data GDPR endpoint | `https://www.reconcileaiafrica.com/api/shopline/gdpr/shop-data-request` |
| Privacy Policy | `https://www.reconcileaiafrica.com/privacy` |
| FAQ | `https://www.reconcileaiafrica.com/support` |

## Verification boundary

The production GDPR routes already reject unsigned requests with HTTP 401. A
correctly signed, non-destructive customer-data request remains required before App
Store submission. Customer-redaction and shop-redaction tests must not be pointed at
live merchant data because they intentionally modify retained data or offboard a
store.

The public `https://reconcileai-dev.myshopline.com/` storefront was checked on
18 August 2026 and presents an **“Opening soon”** page. It must not be represented
as a self-service product demonstration. Keep the Demo store URL blank unless a
reviewer-safe storefront becomes available; the designated review path is the
controlled developer-store installation flow in `REVIEWER_TEST_GUIDE.md`.

## Submission controls observed

The authorised app overview exposes **App details**, **Payment plan**, **App
extension**, **App version**, **Review management**, and a **Webhook delivery
dashboard**. These are the remaining Portal controls needed to complete the listing
package, verify native billing, record delivery evidence, and submit the public app
for SHOPLINE review.

The reviewer Operating instructions were replaced with the accurate Tier 1
read-only workflow and saved successfully on 17 August 2026. The review-account
tenant-entry preflight remains a P0 release gate.

## App Details recheck — 18 August 2026

An authenticated recheck of the English App Details form confirmed that the public
120×120 App Store icon shows the approved standalone Infinity AI circular mark,
without the former wordmark. Richard approved and the Partner Portal saved the three
required public Product Features:

1. **Order, payment & settlement matching**
2. **Actionable payment exceptions**
3. **Settlement monitoring that keeps you ahead**

The entries are limited to the verified Tier 1 read-only reconciliation workflow and
settlement-file fallback. The subsequent form recheck showed all three descriptions
persisted at 178/400, 187/400, and 176/400 characters respectively.

Richard also approved a corrected **About** description. A subsequent Portal recheck
displayed the revised text at 668/5,000 characters. It limits claims to read-only
order/payment reconciliation, linked payment exceptions, and the settlement-file
fallback where native payout data is unavailable. It makes no unsupported claim of
universal payout coverage, write access, payment initiation, or access to bank
credentials.

No 1920×1080 product-preview screenshots are uploaded. Those images must be
authentic captures of the deployed retail experience; generated or mock screen
images are prohibited.

At final go-live, replace the current public contact email with
`support@reconcileaiafrica.com` and verify the monitored inbox before submission.

## Payment plan verification — 18 August 2026

The authorised Payment plan settings page confirms that in-app purchase is enabled
with a **7-day free trial** and all five approved Tier 1 plans enabled:

| Plan | 30-day price | Annual price |
| --- | ---: | ---: |
| Starter | $29.00 | $290.00 |
| Growth | $79.00 | $790.00 |
| Professional | $149.00 | $1,490.00 |
| Scale | $299.00 | $2,990.00 |
| Enterprise | $499.00 | $4,990.00 |

The Portal shows five plans configured out of the permitted twenty. No payment-plan
setting was changed during this verification.
