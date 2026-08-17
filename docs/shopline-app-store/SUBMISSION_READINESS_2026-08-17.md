# SHOPLINE App Store Submission Readiness Assessment

**Assessment date:** 17 August 2026  
**Authoritative code baseline:** `Infinity-AI-Africa-Limited/reconcileai` `main` at `42bccf8`  
**Primary test store:** `reconcileai-dev.myshopline.com` — **ReconcileAI Dev Store**

## Executive conclusion

The Tier 1 SHOPLINE connector is materially implemented: it has OAuth onboarding,
read-only API scopes, signed webhooks, subscription handling, scheduled sync,
settlement-file support for non-SHOPLINE-Payments merchants, GDPR routes, public
legal/support pages, and a dedicated merchant Settlement Monitor. The immediate
code remediation is to narrow the retail tenant surface to its actual merchant
workflow and remove bank/operator tooling from retail navigation and direct routes.

The application **must not be submitted yet**. Submission should follow only after
the production deployment of that retail-surface correction and completion of the
external P0 verification and Partner Portal configuration gates listed below. The
highest-risk review failures are empty mandatory GDPR/contact settings, missing live
OAuth-to-order evidence on the primary developer store, unverified subscription
lifecycle delivery, and missing real listing assets. The verified **Redirected**
loading mode is correct for the current application. SHOPLINE can reject apps that fail installation, lack mandatory GDPR
webhooks or a privacy policy, have incomplete FAQ/support material, or ship
misleading/incomplete listing assets. [1]

## Approved retail product boundary

The SHOPLINE merchant experience must answer a narrow operational question:

> **Which orders were paid, which payments settled, and what needs attention?**

| Keep in the merchant experience | Why it belongs |
|---|---|
| **Settlement Monitor** | Merchant home: expected-versus-actual payouts, sync health, plan/grace state, and settlement-file import. |
| **SHOPLINE Sync Status** | Connection state, last sync, webhook events, and controlled manual sync. |
| **SHOPLINE Connection** | Reconnect/help surface after OAuth installation. |
| **Orders & Payments** | Merchant view of the order and payment records being reconciled. |
| **Payment Exceptions** | Retail-relevant fee variance, refund, chargeback, capture, and settlement shortfall work. |
| **Team Access** | Merchant administrator’s minimal tenant-user control. |

| Remove from the merchant experience | Why it does not belong |
|---|---|
| Generic Dashboard and role switcher | These are financial-services operator views; Settlement Monitor is the retail dashboard. |
| Super Agent, Exception Intelligence, Review Queue, Audit Trail, Age Tracker | These are platform/bank operating or regulatory workflow surfaces, not the Tier 1 merchant product. |
| Upload Data, generic Reconciliation, generic Reports, Schedules, Monitor, Documentation | SHOPLINE OAuth, webhooks, scheduled sync, and merchant support replace generic reconciliation-job administration. |
| Multi-Channel, core-bank/FMCG connectors, SFTP, bucket drops, email forwarding, anomaly tooling, modules | These are financial-services or enterprise deployment controls. They create scope confusion during App Store review. |

The retail navigation and route gate are therefore required to allow only the
merchant surfaces above. A merchant must not be able to re-open a removed
financial-services page by entering its URL directly.

## Evidence reviewed

| Area | Evidence from Infinity AI main | Assessment |
|---|---|---|
| Retail data model and engine | `retail_commerce` segment, retail taxonomy, reconciliation adapter, payment/order/payout matching. | Present. |
| OAuth and tenant onboarding | Signed install/callback, token encryption, automatic tenant/channel/template provisioning. | Present; needs live canonical-store proof. |
| Read-only permission model | Listing scope set: `read_orders`, `read_payment`, `read_store_information`, `read_returns`, `read_gift_card`. | Appropriate; retain minimum scope justification. |
| Webhooks and sync | Signed order/refund/transaction events, 15-minute fallback, daily batch, 90-day first-install backfill in 30-day slices. | Present; needs live end-to-end proof. |
| Billing | SHOPLINE-managed subscription lifecycle; five plans and grace handling; no Stripe. | Present; confirm three subscription topics in portal. |
| GDPR | Canonical customer/store endpoints exist. Live unsigned probes correctly returned **401** on 17 August 2026. | Fail-closed check passed; signed 200 test remains. |
| Public pages | `/privacy`, `/terms`, and `/support` each returned **200** on 17 August 2026. | Present; confirm final contact language matches portal. |
| Listing assets | Listing copy, scope rationale, URLs, and plan framing exist in `LISTING.md`. | Logo and four real screenshots remain outstanding. |

## Submission gates

The following gates are sequenced to prevent avoidable review failure. “P0” means
do not click **Submit for Review** until it is complete.

| Priority | Gate | Owner | Evidence required |
|---|---|---|---|
| **P0** | Deploy and visually verify the narrow merchant surface from this review branch. | ReconcileAI / Claude Code | Retail tenant sees only the approved six-surface workflow; direct financial-services routes redirect away. |
| **P0** | Preserve the already-correct Partner Portal **Redirected** loading mode. | Richard | Screenshot/configuration record immediately before submission. App Bridge is a post-launch Tier 1.5 enhancement, not a launch dependency. |
| **P0** | Enter canonical GDPR URLs for customer data and store data requests. | Richard | Portal fields populated with the URLs in `LISTING.md`; signed request test returns 200. |
| **P0** | Enter app contact name and monitored support email. | Richard | Portal record plus test email receipt. |
| **P0** | Verify `appsubscription/create`, `appsubscription/paid`, and `appsubscription/expiration` were registered by the connector and receive a signed lifecycle delivery. | Richard + ReconcileAI | API/Portal webhook list and signed delivery/subscription-state evidence. |
| **P0** | Perform install → OAuth → onboarding on **ReconcileAI Dev Store**. | Richard + ReconcileAI | Install succeeds, welcome page appears, store/tenant config is created, and callback is signed. |
| **P0** | Place an actual developer-store order against production. | Richard + ReconcileAI | `[shopline-realtime] synced store=…` log and matching order in Settlement Monitor. This proves token decrypt, API pull, engine, and UI together. |
| **P0** | Produce/upload approved listing assets. | Richard + ReconcileAI | 120×120 logo and real 1920×1080 screenshots with no customer data, watermarks, or irrelevant screens. [1] |
| **P1** | Review listing copy against implemented behavior and final support contact details. | ReconcileAI | No unsupported claims, no other marketplace trademarks, clear FAQ and privacy explanations. [1] |
| **P1** | Provide reviewer test instructions and a usable developer-store test path. | Richard | Short reviewer guide: install steps, expected first sync, test order, where results appear, and support contact. |
| **P2** | Consider the App Bridge summary widget after activation. | ReconcileAI | Separate Tier 1.5 design and review; do not change launch mode back to Embedded before that work exists. |

## Partner Portal evidence observed on 17 August 2026

The authorised InfinityAI Africa Limited Partner Portal was reviewed without editing
or submitting any settings. The app is a **Public app** in **Draft** status and has
two installations. The configured App URL and callback URL exactly match the
production routes in this document, and **Redirected** is selected as the loading
mode. This is the correct launch configuration; the sales-channel setting is not
enabled and should remain that way.

The Portal also exposes the expected fields for app logo, contact name/email,
customer-data deletion endpoint, and store-data deletion endpoint. Their values
must be inspected and any blanks completed before submission; no values were changed
during this audit. The related listing asset and signed-GDPR tests remain P0 gates.

On the subsequent read-only settings review, an internal Infinity AI app logo was
present. The contact fields displayed no configured values, and both mandatory GDPR
endpoint fields displayed only the `https://` placeholder rather than the required
ReconcileAI URLs. These are confirmed **P0 Portal configuration blockers**. The
internal logo does not replace the public App Details logo and screenshots required
for the listing.

## Portal settings to enter exactly

| Partner Portal field | Required value |
|---|---|
| App loading mode | **Redirected** |
| App URL | `https://www.reconcileaiafrica.com/api/shopline/install` |
| Callback URL | `https://www.reconcileaiafrica.com/api/shopline/callback` |
| GDPR customer data | `https://www.reconcileaiafrica.com/api/shopline/gdpr/customers-data-request` |
| GDPR store data | `https://www.reconcileaiafrica.com/api/shopline/gdpr/shop-data-request` |
| Privacy policy | `https://www.reconcileaiafrica.com/privacy` |
| Terms | `https://www.reconcileaiafrica.com/terms` |
| Support | `https://www.reconcileaiafrica.com/support` |
| Sales channel | **Do not enable.** ReconcileAI is an operational reconciliation app, not a sales channel. |

## Submission package

The review submission should contain only current, demonstrable features. The
recommended opening language is: **“ReconcileAI automatically reconciles SHOPLINE
orders against payment and payout records, highlights settlement exceptions, and
provides merchant-facing resolution guidance using read-only access.”** Do not
describe it as a banking-compliance platform, a generic AI agent, or a
SHOPLINE-Payments-only product. Third-party gateway and COD merchants are supported
through settlement-file import; the listing’s 90-day history claim is implemented
by the first-install backfill, which runs in three 30-day slices.

The screenshot set should show the Settlement Monitor, a realistic retail exception,
sync health, and settlement-file import/connected-store context. It must be captured
from ReconcileAI Dev Store with synthetic or developer-store data only. SHOPLINE
requires images to be clear, accurately representative, free of irrelevant branding,
and within the stated image limits. [1]

## Review hand-off to Claude Code

Claude Code should assess the retail-surface PR against the following production
questions before merge:

1. Does every merchant-visible route and sidebar item remain within the approved
   retail boundary, including direct URL access and super-admin portal context?
2. Does the post-install CTA route only to a Shopline-specific status surface?
3. Does the `null`/unclassified segment fallback fail safely without sending a
   tenant into a banking workspace or creating a redirect loop?
4. Do retail navigation tests pin the exact approved route set and reject future
   unscoped financial-services additions?
5. Are the live OAuth, webhook, signed GDPR, subscription-webhook, and real-order
   tests recorded as external release gates rather than fabricated test evidence?

## Developer-documentation integration matrix

The following requirements are taken from the current official SHOPLINE developer
documentation and are the baseline for the remaining code-to-documentation audit.

| Documentation requirement | ReconcileAI design evidence | Verification still required |
|---|---|---|
| Public apps need a configured App URL and callback URL; a redirect-mode app opens in a new browser tab. [5] | Partner Portal URL/callback match the production `/api/shopline/install` and `/api/shopline/callback` routes; **Redirected** is selected. | Live install/callback proof on ReconcileAI Dev Store. |
| OAuth installation and callback signatures must be verified before using the authorisation code; the code expires after ten minutes. The access token expires after ten hours and must be refreshed before expiry. [6] | The connector has signed install/callback verification, encrypted token storage, and proactive refresh design. | Fresh production install and a post-refresh API-pull observation. |
| Merchants should grant only scopes required for actual functionality. `read_orders`, `read_payment`, and `read_store_information` correspond to the core reconciliation data legs. [7] | Tier 1 requests read-only scopes only; no write scope is documented. | Reconfirm each requested scope against every current endpoint before submit. |
| Webhook delivery requires HTTP 200 acknowledgement, can retry after five seconds, can be retried 19 times over 48 hours, may be duplicated, and requires API polling as a recovery path. [8] | The connector verifies signatures, persists/deduplicates deliveries, acknowledges promptly, and has scheduled polling. | Confirm portal event-version subscriptions and simulate/observe a real duplicate delivery. |
| REST Admin APIs use a leaky-bucket constraint, with a standard limit of four requests per second per store. [9] | Sync code has per-store rate handling and historical windowing. | Inspect every API call path for a shared 4 rps budget, 429 handling, and bounded retries. |
| `appsubscription/paid` reports successful, cancelled, and failed subscription-payment outcomes and requires an HTTP 200 response. [10] | Subscription lifecycle handling exists in the connector. | Register and verify `appsubscription/create`, `appsubscription/paid`, and `appsubscription/expiration` in the Portal. |

| Documentation requirement | ReconcileAI code status | Remaining action before approval |
|---|---|---|
| Every API request must remain within the standard four-requests-per-second per-store budget, with 429 recovery. [9] | **Improved; deployment caveat remains.** `apiClient.ts` applies a deterministic process-local 250 ms per-store scheduler before every API request, plus bounded 429 retry and sync windowing. | Load-test on ReconcileAI Dev Store. Before horizontally scaling application workers for one merchant, replace the process-local scheduler with a shared distributed limiter; do not represent passive 429 retry alone as a complete control. |
| App subscription lifecycle uses `appsubscription/create`, `appsubscription/paid`, and `appsubscription/expiration`. [10] | **Implemented in code.** The install registration loop and daily webhook reconciler now include all three documented topics, and the handler verifies HMAC, deduplicates, records state, and returns 200. | Observe each topic from ReconcileAI Dev Store or the official test route and retain the store subscription list as review evidence. |
| Mandatory customer data and shop data requests require signed acknowledgement and completion within the platform window. [1][8] | **Implemented in code; Portal configuration incomplete.** Dedicated signed routes reject unsigned requests, audit requests, scrub stored customer webhook PII, and offboard a redacted shop. | Populate both blank Partner Portal GDPR endpoint fields, then execute signed developer-store tests and retain response/audit evidence. |
| App installation must verify callback integrity, provision the merchant tenant, and avoid storing access tokens in plaintext. [6] | **Implemented in code.** Install and callback signatures are verified before code exchange; tokens are encrypted at rest; tenant and reconciliation channels are provisioned after OAuth. | Perform production install/reinstall and token-refresh evidence test using ReconcileAI Dev Store. |
| Settlement reconciliation must support the merchant’s actual payment availability. | **Implemented with an explicit limitation.** SHOPLINE Payments transaction/payout/balance legs are fetched where available; merchants without SHOPLINE Payments use settlement-file import rather than a fabricated payout feed. | Ensure the listing and reviewer guide explain this distinction without claiming universal native payout coverage. |
| Webhook subscriptions require an HTTPS callback, 200 acknowledgement, signature verification, deduplication, and polling recovery. [8] | **Implemented in code.** The callback is production HTTPS, validates HMAC, tracks webhook IDs, responds quickly, retries 429 API calls, has polling/daily batch recovery, and now reconciles operational plus subscription topics. | Exercise duplicate-delivery and missed-webhook recovery on the developer store; capture logs without merchant data. |
| App review requires a complete listing, clear accurate screenshots, public support/privacy information, and reviewer test instructions. [1] | **Partial.** Public legal/support routes return 200 and copy exists; internal settings logo exists. Contact values, public listing logo/screenshots, and reviewer guide still need completion. | Fill Portal contact fields, publish real developer-store screenshots, confirm App Details branding, and prepare the reviewer test guide. |

The matrix does not claim production proof where a live developer-store action has
not occurred. External release gates remain P0 until the Portal configuration,
OAuth flow, signed webhooks, and real-order evidence are captured.

## References

[1]: https://developer.shopline.com/docs/apps/application-management/shopline-app-review-standards "SHOPLINE App Review Standards"

[2]: https://www.reconcileaiafrica.com/privacy "ReconcileAI Privacy Policy"

[3]: https://www.reconcileaiafrica.com/terms "ReconcileAI Terms of Service"

[4]: https://www.reconcileaiafrica.com/support "ReconcileAI Support"

[5]: https://developer.shopline.com/docs/apps/application-management/configuring-public-applications/ "Configuring Public Apps"

[6]: https://developer.shopline.com/docs/apps/api-instructions-for-use/app-authorization "SHOPLINE App Authorization"

[7]: https://developer.shopline.com/docs/apps/api-instructions-for-use/access-scope "SHOPLINE AccessScope"

[8]: https://developer.shopline.com/docs/apps/api-instructions-for-use/webhooks/overview "SHOPLINE Webhooks Overview"

[9]: https://developer.shopline.com/docs/apps/api-instructions-for-use/shopline-api-rate-limit "SHOPLINE API Rate Limit"

[10]: https://developer.shopline.com/docs/webhook/v20260301/application/app-plan-subscription-payment-finalized "SHOPLINE App Plan Subscription Payment Finalized"
