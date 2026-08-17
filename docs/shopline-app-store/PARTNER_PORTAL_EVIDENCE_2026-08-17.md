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

## Submission controls observed

The authorised app overview exposes **App details** for visibility, description,
logo, and contact fields; **Payment plan**; **App extension**; **App version**;
**Review management**; and a **Webhook delivery dashboard**. These are the remaining
Portal controls needed to complete the listing package, verify the native
subscription plan, record delivery evidence, and submit the current public app for
SHOPLINE review.

## Reviewer test-information finding

The App Details page currently presents a reviewer account
`demo@reconcileaiafrica.com` and marked password with the description “Test merchant
account for the SHOPLINE review team.” The **The app can be used without an
account** option is not selected. An **Operating instructions** field is present
with 568 of 5,000 characters already populated. Before submission, the configured
credentials must be tested by the review team’s intended login path and the
instructions must be reconciled with `REVIEWER_TEST_GUIDE.md`; no unverified
credentials should be submitted.

The Partner Portal reviewer **Operating instructions** were replaced with the
accurate Tier 1 read-only workflow and saved successfully on 17 August 2026. The
portal returned **“Update successful.”** The review-account tenant-entry preflight
remains a P0 release gate.
