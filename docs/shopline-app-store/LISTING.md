# SHOPLINE App Store Listing — ReconcileAI

Everything needed to complete the App Store listing and submit for review
(Phase 1, task 1.6). Copy is final; the asset files are the only outstanding
production item.

> **Where this goes:** SHOPLINE Partner Portal → Apps → ReconcileAI → *App
> details* (listing copy, logo, screenshots) and *App settings* (URLs, GDPR
> endpoints, contact). Pricing plans are configured separately — see
> `CLAUDE.md` §2B.1.

---

## 1. Identity

| Field | Value |
|---|---|
| App name | **ReconcileAI** |
| Tagline (≤60 chars) | Automated payment reconciliation for your store |
| Default language | English (`en`) |
| Category | Finance / Accounting |
| Pricing | 7-day free trial, then $29–$499/month (5 plans, annual available) |

## 2. Short description (≤160 chars)

> Reconcile orders against available payment and settlement data. Surface fee,
> refund, and settlement exceptions before they become write-offs.

## 3. Long description

ReconcileAI is a reconciliation workspace for SHOPLINE merchants. It connects
through SHOPLINE's read-only authorisation flow and matches orders against the
payment and payout or settlement data available for the authorised store.

Most reconciliation workflows stop at flagging a mismatch. ReconcileAI
classifies each exception, presents an explanation and supporting records, and
gives the merchant a clear next step for review.

**What it catches:** chargebacks not posted, duplicate authorisations, gateway
fee variances, FX rate mismatches, settlement shortfalls and delays, refunds
not settled, reserve holds, payout discrepancies, and 17 more retail-specific
exception types.

**How it works:** install from the App Store and approve read-only access.
ReconcileAI starts a historical sync of up to 90 days in controlled 30-day
slices, then continues through webhooks and scheduled recovery syncs. For
merchants whose payment provider does not expose the required settlement data
through SHOPLINE, ReconcileAI supports a settlement-file import workflow.

**Your data:** read-only access. ReconcileAI never writes to your store, never
initiates payments, and never sees your bank credentials.

## 4. Three feature bullets (required)

1. **Order, payment and settlement matching** — reconcile the data available
   through authorised SHOPLINE access, with settlement-file import where needed.
2. **Actionable payment exceptions** — review fee variances, refunds,
   chargebacks, capture issues, and settlement shortfalls with the linked records.
3. **Settlement monitoring** — see what settled, what is pending, and what needs
   attention through a merchant-focused operating view.

## 5. Required URLs (live)

| Field | URL |
|---|---|
| App URL | `https://www.reconcileaiafrica.com/api/shopline/install` |
| App callback URL | `https://www.reconcileaiafrica.com/api/shopline/callback` |
| Privacy policy | `https://www.reconcileaiafrica.com/privacy` |
| Terms of service | `https://www.reconcileaiafrica.com/terms` |
| Support | `https://www.reconcileaiafrica.com/support` |
| GDPR — customer data | `https://www.reconcileaiafrica.com/api/shopline/gdpr/customers-data-request` |
| GDPR — store data | `https://www.reconcileaiafrica.com/api/shopline/gdpr/shop-data-request` |

## 6. Asset checklist (to produce)

| Asset | Spec | Status |
|---|---|---|
| App logo | 120×120 px, jpg/jpeg/png, ≤2 MB | ⬜ upload public App Details asset |
| Screenshot — Settlement Monitor | Developer-store settlement summary and sync state | ⬜ capture from live app |
| Screenshot — Payment Exceptions | Retail exception list with category and linked records | ⬜ capture |
| Screenshot — Orders & Payments | Developer-store reconciliation records with no customer PII | ⬜ capture |
| Screenshot — Sync status | Connected store + recent webhook events | ⬜ capture |

Capture at the current Portal-required dimensions on ReconcileAI Dev Store with
synthetic or developer-store data only. Do not show customer PII, credentials,
other marketplace brands, watermarks, or financial-services-only screens.

## 7. Requested scopes — and the one-line justification for review

Read-only, minimum necessary (App Store review scrutinises scope creep):

| Scope | Why we need it |
|---|---|
| `read_orders` | The order leg of reconciliation — what the merchant sold |
| `read_payment` | The gateway/settlement leg — captures, fees, payouts, balances |
| `read_store_information` | Store currency + timezone, to reconcile in the right terms |
| `read_returns` | Refund leg — matching refunds to settlements |
| `read_gift_card` | Gift-card split-tender orders reconcile correctly |

No write scopes are requested.

## 8. Pre-submission verification

- [ ] Full OAuth install → callback → onboarding works on a developer store
- [ ] Webhook receiver acks < 5s (queue-first) and dedupes on `X-Shopline-Webhook-Id`
- [ ] Both GDPR endpoints return 200 on a signed request, 401 unsigned
- [ ] Privacy / Terms / Support pages load publicly
- [ ] Billing webhooks (`appsubscription/create|paid|expiration`) update subscription state
- [ ] Logo + screenshots uploaded, EN set as default language
- [ ] App contact name + email filled in App settings

See `REVIEWER_TEST_GUIDE.md` for the reviewer-safe walkthrough and expected
outcomes. Do not submit the listing until every relevant external item above has
evidence attached to the release record.

See `CLAUDE.md` §2B.12 for the remaining go-live sequence.
