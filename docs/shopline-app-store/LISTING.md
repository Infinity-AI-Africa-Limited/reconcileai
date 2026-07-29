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

> Automatically match every SHOPLINE order against gateway payments and payouts.
> Catch chargebacks, fee variances, and settlement shortfalls before they cost you.

## 3. Long description

ReconcileAI is an AI-powered financial reconciliation layer for SHOPLINE
merchants. It connects in one click and automatically matches your orders
against what your payment gateway actually captured and what was actually paid
out — across every currency and every store you sell through.

Most reconciliation tools stop at flagging a mismatch. ReconcileAI diagnoses
it: each exception gets a category, a plain-English explanation, and a
recommended resolution drawn from your own resolution history and — where you
opt in — anonymised patterns from the wider merchant network. The longer you
use it, the more accurate its recommendations become for your specific payment
mix.

**What it catches:** chargebacks not posted, duplicate authorisations, gateway
fee variances, FX rate mismatches, settlement shortfalls and delays, refunds
not settled, reserve holds, payout discrepancies, and 17 more retail-specific
exception types.

**How it works:** install from the App Store, approve read-only access, and
ReconcileAI pulls 90 days of history immediately. Reconciliation runs
automatically from that point on — no file exports, no spreadsheets, no IT
project.

**Your data:** read-only access. ReconcileAI never writes to your store, never
initiates payments, and never sees your bank credentials.

## 4. Three feature bullets (required)

1. **Automatic three-way matching** — orders ↔ gateway transactions ↔ payouts,
   reconciled continuously with no manual uploads.
2. **AI exception diagnosis** — every mismatch categorised, explained, and paired
   with a recommended fix that improves as you resolve more cases.
3. **Settlement monitoring** — see what settled, what's pending, and what's short,
   with chargeback and fee variances surfaced before they become write-offs.

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
| App logo | 120×120 px, jpg/jpeg/png, ≤2 MB | ⬜ to produce |
| Screenshot — Settlement Monitor | Dashboard with KPI cards + plan banner | ⬜ capture from live app |
| Screenshot — Exceptions | Exception list with severities/categories | ⬜ capture |
| Screenshot — Resolution Intelligence | Both intelligence layers side by side | ⬜ capture |
| Screenshot — Sync status | Connected store + recent webhook events | ⬜ capture |

Capture at desktop width (1280×800) on a developer store with seeded data;
avoid real merchant names in any screenshot.

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

See `CLAUDE.md` §2B.12 for the remaining go-live sequence.
