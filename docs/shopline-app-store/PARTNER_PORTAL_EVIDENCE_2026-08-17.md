# SHOPLINE Partner Portal Evidence — 17 August 2026

## Verified application context

| Field | Recorded value |
|---|---|
| Partner workspace | InfinityAI Africa Limited |
| App | ReconcileAI |
| App type | Public app |
| Portal status | Draft — not submitted for review |
| Loading mode | Redirected |
| Sales channel | Not enabled |
| Primary developer store | `reconcileai-dev.myshopline.com` (ReconcileAI Dev Store) |

## Configuration completed in the authorised Portal session

| Partner Portal field | Configured value |
|---|---|
| App contact name | Richard Anwanakak |
| App contact email | `support@reconcileaiafrica.com` |
| Customer-data GDPR endpoint | `https://www.reconcileaiafrica.com/api/shopline/gdpr/customers-data-request` |
| Store-data GDPR endpoint | `https://www.reconcileaiafrica.com/api/shopline/gdpr/shop-data-request` |

## Verification boundary

The production GDPR routes already reject unsigned requests with HTTP 401. A
correctly signed non-destructive customer-data request remains required before App
Store submission. Customer-redaction and shop-redaction tests must not be pointed at
live merchant data because they intentionally modify retained data or offboard a
store.

## Remaining Portal evidence

The public App Details listing still requires the marketplace logo, developer-store
screenshots, final reviewer test arrangement, and confirmation of subscription plan
and webhook-delivery evidence. The application must remain in **Redirected** mode
for Tier 1.
