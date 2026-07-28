# SHOPLINE Phase 1 — Verified API Extract & Build Spec

> Extracted 2026-07-18 from the public SHOPLINE developer documentation
> (https://developer.shopline.com — the new unified docs; the legacy
> developer.myshopline.com/docsv2 system now redirects here). Every fact in
> Part A was read directly from SHOPLINE's own pages, most of them from the
> raw markdown the docs site serves at `<page-url>.md`. This closes the
> "Phase 1 needs SHOPLINE API docs" gate in CLAUDE.md §2A.
>
> The **Partner Portal** (https://developer.myshopline.com) — where the app is
> created, credentials issued, App Store listing configured, and pricing set —
> is behind SHOPLINE partner login and could not be inspected. See §B8.

---

## Part A — Verified platform facts

### A1. App model (Tier 1 = Public App)

| Fact | Value |
|---|---|
| Distribution type for App Store | **Public app** — installable by all stores from the App marketplace |
| Authorization | OAuth 2.0 authorization-code grant |
| Review | Mandatory App Store review; app must pass before activation |
| GDPR webhooks | **Mandatory** for public apps (`customers/redact`, `merchants/redact`); app is rejected without a valid endpoint |
| Display mode | Embedded (iframe in SHOPLINE Admin, requires App Bridge) or Redirect (new tab). Redirect is acceptable and simpler for Phase 1 |
| Credentials | App key + app secret from Developer Center → Apps → App credentials |
| Callback URLs | Multiple callback URLs configurable (per environment); the `redirectUri` must exactly match one of them |
| Testing | Free "developer store" provided by the platform |
| App Store slot | Separate "App Store slot application process" exists (Partner Portal work order) |

Custom apps (whitelisted stores, no review, no App Bridge) use the same OAuth
flow — useful for piloting with a named merchant **before** App Store review.

### A2. OAuth 2.0 flow (per store, `handle` = store subdomain)

1. **Install request** (SHOPLINE → our App URL):
   `GET {appUrl}?appkey&handle&timestamp&sign` (+`lang` if embedded).
   Verify `sign`, then redirect the merchant to the authorize URL.
2. **Authorize URL** (merchant's browser):
   `https://{handle}.myshopline.com/admin/oauth-web/#/oauth/authorize?appKey={appKey}&responseType=code&scope={comma-separated}&redirectUri={urlencoded}&customField={optional}`
3. **Callback** (SHOPLINE → redirectUri):
   `GET {redirectUri}?appkey&code&handle&timestamp&sign` (+`customField`).
   Verify `sign`. **`code` expires in 10 minutes.**
4. **Create token**: `POST https://{handle}.myshopline.com/admin/oauth/token/create`
   Headers `appkey`, `timestamp`, `sign` (POST signature), body `{"code": "..."}`.
   Response `data`: `accessToken`, `expireTime` (UTC ISO), `scope`.
5. **Token lifetime: 10 hours.** No refresh token; refresh is
   `POST /admin/oauth/token/refresh` authenticated by app signature alone.
   After refresh the **old token stays valid for 5 minutes** (grace window).
   Do not refresh immediately after minting (rate-limited: `REQUEST_FREQUENTLY`).
6. **Revoke**: a "Cancel Authorization" endpoint exists (call on tenant offboard).
7. **Scope upgrade**: adding scopes later requires re-sending the merchant
   through the authorize URL (Step 2) for incremental consent.
8. Optional **IP whitelist** per app in Developer Center
   (`REQUEST_NOT_IN_APP_IP_WHITELIST` error) — leave empty for Railway (dynamic
   egress IPs) or maintain it carefully.

Token-refresh error codes worth handling: `STORE_NOT_INSTALL_APP` (merchant
uninstalled — deactivate tenant sync), `APP_AUDIT_NOT_PASS`,
`REQUEST_FREQUENTLY`, `OAUTH_CODE_INVALID`.

### A3. Signatures (HMAC-SHA256, hex, key = app secret)

| Context | Source string | Where the sign travels |
|---|---|---|
| GET (install request, OAuth callback) | URL-encoded query params, `sign` removed, remaining params sorted alphabetically, joined `k=v&k=v` | `sign` query param |
| POST (token create/refresh) | `body + timestamp` (millisecond timestamp appended to raw JSON body) | `sign` + `timestamp` headers |
| Webhook delivery | raw request body | `X-Shopline-Hmac-Sha256` header |

- Compare with a constant-time compare. SHOPLINE's Go sample compares **hex**
  digests, but their header example looks base64 — implement a
  tolerant verifier that accepts either encoding of the same digest.
- Enforce a ±10-minute timestamp window (SHOPLINE's own stated limit) for replay protection.

### A4. Verified access scopes (Phase 0 constants were wrong)

| We guessed (Phase 0) | Actual SHOPLINE scope | Covers |
|---|---|---|
| `read_orders` | ✅ `read_orders` | Orders, transactions, fulfillments, abandoned checkouts, order payment, store settlement currency |
| `read_payments` | ❌ → **`read_payment`** (singular) | SHOPLINE Payments: payouts, balance, transactions, billing records |
| `read_settlements` | ❌ **does not exist** | Settlement data is under `read_payment` |
| `read_shop` | ❌ → **`read_store_information`** | Store info + store payment channels |
| `read_analytics` | ❌ not in the published scope list | Dropped |
| — | ➕ `read_returns` | Returns / return orders (refund-leg recon) |
| — | ➕ `read_gift_card` | Gift card ops (our `retail_giftcard_split_tender` category) |

Phase 1 scope request: `read_orders,read_payment,read_store_information,read_returns,read_gift_card`.
Request **read-only scopes only** — smoother App Store review, and ReconcileAI never writes to merchant stores.

### A5. API versioning & conventions

- URL shape: `https://{handle}.myshopline.com/admin/openapi/{version}/{endpoint}.json`
- Auth header: `Authorization: Bearer {accessToken}`; `Content-Type: application/json; charset=utf-8`
- **Current stable: `v20260601`** (stable 2026-06-01 → deprecated 2027-06-01). Quarterly releases, 12-month support, 9-month migration overlap. Pin per-config, default `v20260601`.
- All times ISO-8601 with offset; convert using the store's `iana_timezone` from store info.
- Rate limit (REST): **leaky bucket, burst 40, drain 4 req/s per store** (429 on overflow). Unlimited for Enterprise-plan stores.
- Pagination: cursor-based via the `link` response header (`rel="next"/"previous"`, opaque `page_info`); `since_id` for the first page. When `page_info` is present all other filters except `limit`/`fields` are ignored — bind filters into the cursor on page 1.
- Failure shape: HTTP status + `{"errors": "..."}`; `traceId` response header on every call (log it for SHOPLINE support tickets).

### A6. Core REST endpoints for reconciliation (all GET)

| Endpoint | Scope | Key params | Key response fields |
|---|---|---|---|
| `/orders.json` | read_orders | `financial_status`, `status`, `created_at_min/max`, `updated_at_min/max`, `since_id`, `page_info`, `limit`, `fields`, `ids` | `orders[]`: `id`, `name`, `created_at`, `currency`, `presentment_currency`, `financial_status` (`unpaid/authorized/pending/partially_paid/paid/partially_refunded/refunded`), `current_total_price(_set)`, `total_outstanding`, `payment_details[]` (`gateway`, `pay_amount`, `pay_channel`, **`pay_channel_deal_id`**, `giftcard_presentment_money`, `create_time`), `payment_gateway_names`, `refunds[]`, `discount_applications`, `tax_lines`, `line_items` |
| `/orders/.../refunds` ("Get refunds associated with an order") | read_orders | order id | refund records incl. amounts, status |
| `/payments/store/transactions.json` | read_payment | `date_min/date_max` (pair required, ≤6 months apart, within last 12 months), `transaction_type` (`PAYMENT/REFUND/DISPUTE`), `status`, `trade_order_id`, `merchant_id`, `since_id`, `page_info`, `limit` ≤1000 (default 100) | `transactions[]`: `trade_order_id`, **`seller_order_id`** (→ order join), `channel_deal_id`, `amount`, `paid_amount`, `currency`, `fee` (negative = charged), `fee_type` (`domestic/international`), `exchange` {amount, currency, rate@10dp}, `additional_data` {**`is_settled`**, **`settle_time`**, `statement_time`, **`reserve_held`**, `reserve_release_time`, `arbitration_fee`, `prearbitration_fee`, `dispute_evidence_update_deadline`}, `dispute_type` (`CHARGEBACK/PRE_CHARGEBACK/RETRIEVAL/FRAUD_NOTIFICATION`), `stage` (`CHARGEBACK/PRE_ARBITRATION/ARBITRATION`), `stage_final_amount`, `reason` (incl. `duplicate`, `fraudulent`, `credit_not_processed`…), `status`/`sub_status` (full lifecycle incl. `WON/LOST/EXPIRED`), `credit_card` {brand, bin, last4, type, issuer_country, auth_code}, `payment_method`/`sub_payment_method`, `payment_msg` {code,msg}, `create_time`, `update_time` |
| `/payments/store/payouts.json` | read_payment | `start_time`/`end_time` (pair required, ≤3 months apart), `status` (`CREATED/PROCESSING/SUCCESS/FAILED`), `payout_transaction_no`, `merchant_id`, `since_id`, `page_info`, `limit` ≤100 (default 50) | `payouts[]`: `payout_transaction_no`, `amount`, `currency`, `status`, `time` |
| `/payments/store/payout.json` | read_payment | payout id | `payouts[]`: `id`, `amount`, `currency`, `date`, `status` |
| `/payments/store/balance_transactions.json` (billing records) | read_payment | `start_time`/`end_time` (≤3 months) **or `payout_id`**, `is_settlement_details` (true = itemized rows, false = SETTLEMENT rows), `page_info`, `limit` | `transactions[]`: `id`, `type` (~60 codes: `PAYMENT`, `SETTLEMENT`, `REFUND*`, `CHARGEBACK*`, `PRE_ARBITRATION*`, `ARBITRATION*`, `*_FROZEN/UNFROZEN`, `FIXED/ROLLING_RESERVE_*`, `PAYOUT`, `PAYOUT_FAILED`, `PAYOUT_RETURNED`), **`settlement_batch_id`**, **`source_order_id`**, `source_order_transaction_id`, `amount`, `net` (= amount + interchange_fee + scheme_fee + payment_method_fee + revolving_margin_account_balance), `interchange_fee`, `scheme_fee`, `payment_method_fee`, `other_fee`, `total_fee`, `transaction_amount/currency`, `account_currency`, `exchange_rate` (=transaction_amount/amount, 10dp), `account_type` (`PendingSettlementAccount/PayoutAccount/RevolvingMarginAccount/FixedMarginAccount`), `account_balance`, `posting_time` |
| `/payments/store/balance.json` (response wrapped in a `balance` object) | read_payment | — | `pending_settlement_balance`, `payout_account_available_balance`, `payout_account_frozen_balance`, `payout_account_balance`, `fixed_margin_account_balance`, `revolving_margin_account_balance`, `currency` |
| `/payments/store/merchants.json` | read_payment | — | `merchants[]`: `merchant_id`, `entity_name`, `entity_country` |
| `/merchants/shop.json` (store information; response wrapped in a `data` object) | read_store_information | — | `id`, `merchant_id`, `name`, `domain`, **`currency`**, **`iana_timezone`**, `language`, `biz_store_status`, `email` |
| `/webhooks.json` (+ list/get/update/delete) | — | body `{webhook: {api_version, topic, address}}` | manage subscriptions programmatically (v20240601+) |

**Three-leg join model** (maps 1:1 to our order↔payment↔payout taxonomy surfaces):
- Order ↔ gateway txn: `orders.payment_details[].pay_channel_deal_id` ↔ `transactions[].channel_deal_id`; `transactions[].seller_order_id` ↔ order id/name.
- Gateway txn ↔ settlement: `additional_data.is_settled` / `settle_time`; itemized in billing records via `source_order_id`/`source_order_transaction_id` + `settlement_batch_id`.
- Settlement ↔ payout: billing records `payout_id` query + `type=PAYOUT`; payout batch = `payout_transaction_no`. Bank leg = merchant's bank statement vs payout records.

### A7. Webhooks

**Delivery contract:** POST JSON; headers `X-Shopline-Topic`,
`X-Shopline-Hmac-Sha256` (HMAC of raw body), `X-Shopline-Shop-Domain`,
`X-Shopline-Shop-Id`, `X-Shopline-Merchant-Id`, `X-Shopline-API-Version`,
**`X-Shopline-Webhook-Id`** (stable across resends → idempotency key).
**Ack within 5 seconds** with HTTP 200 or SHOPLINE retries **19 times over
48 h** (0s, 5s, 10s, 30s, 45s, 1m, 2m, 5m, 12m, 38m, 1h, 2h, then 4h×7); after
19 consecutive failures with no successes of that type, **SHOPLINE deletes the
subscription** and emails the developer. Duplicates are possible by design.
SHOPLINE's own caution: webhooks are not guaranteed — always run query-API
backfill alongside (our daily batch sync).

**Verified topics** (subscribe per store via `POST /webhooks.json`, one call per topic, pinned `api_version`):

| Event | Topic | Group |
|---|---|---|
| Order created | `orders/create` | orders |
| Order updated | `orders/updated` | orders |
| Order edited | `orders/edited` | orders |
| Order paid | `orders/paid` | orders |
| Order cancelled | `orders/cancelled` | orders |
| Order deleted | `orders/delete` | orders |
| Refund created | `refunds/create` | refunds |
| Refund updated | `refunds/update` | refunds |
| Order payment created | `order_transactions/create` | order_transactions — payload: `pay_seq`, `pay_status` (`unpaid/pending/risking/paid/paid_overtime/paid_failed`), `pay_channel_deal_id`, `pay_amount`, `create_time`, `status_code`, `status_msg` |
| GDPR customer erasure | `customers/redact` | mandatory, configured in Developer Center |
| GDPR store erasure | `merchants/redact` | mandatory; fires **48 h after uninstall** → our uninstall/offboarding signal |

(Additional groups exist — products, transactions/cart, fulfillments,
subscription contracts — not needed for Phase 1.)

No payout/settlement webhook topic was found in the public catalogue →
settlement data arrives via **scheduled pulls** of the three payments
endpoints, not push.

### A8. What could NOT be verified publicly

- **Partner Portal contents** (app creation UI, credential issuance, App Store
  listing config, pricing/billing setup, review submission) — login-gated.
- **App Store billing/subscription API** — no public REST resource found for
  charging merchants. Monetization appears to be configured via the Partner
  Portal listing (SHOPLINE 15% rev share per our commercial model). Until the
  portal confirms a billing API, Tier 1 subscription enforcement stays
  ReconcileAI-side (subscription band on the org + usage metering), and Stripe
  billing remains the Phase 2 item it already is.
- Embedded-mode App Bridge specifics (only needed if we choose embedded display).

---

## Part B — Phase 1 build spec (maps the extract onto our architecture)

Phase 1 scope per CLAUDE.md §2A: **App Store OAuth connector (Tier 1),
settlement batch ingestion (Tier 2 groundwork), merchant self-serve
onboarding, simplified retail dashboard, Super Agent prompt wiring.**
Pattern: mirror `server/connectors/woodcore/` (engine) — SHOPLINE becomes
`server/connectors/shopline/` with the same auth/webhook/sync/DLQ/health
skeleton, but OAuth-per-store instead of per-org API creds.

### B1. New module `server/connectors/shopline/`

| File | Responsibility |
|---|---|
| `types.ts` | Canonical SHOPLINE record types from A6 (order payment detail, payments transaction, payout, billing record), config shape, API version constant |
| `signature.ts` | The three HMAC modes from A3 + tolerant hex/base64 compare + timestamp window. Pure functions, fully unit-tested |
| `auth.ts` | OAuth handlers: install-request verify → authorize redirect; callback verify → token create; **token cache with proactive refresh** (refresh at ~8 h, well before the 10 h expiry, inside the 5-min grace design); per-store token rows |
| `client.ts` | Signed/Bearer REST client: per-store base URL, version pinning, `link`-header pagination iterator, 429 leaky-bucket backoff (token bucket ≤3 rps to stay under 4), `traceId` logging |
| `ingest.ts` | Map orders / payments transactions / payouts / billing records → canonical `transactions` rows with namespaced dedupe keys (`shopline:{storeId}:{entity}:{externalId}`), injecting the `rawData` gateway-metadata contract that `classifyRetailException()` already consumes (gatewayEventType, chargebackArn→`trade_order_id`, feeAmount, expected/applied FX from `exchange`, settlementBatchId, reserve fields…) |
| `webhooks.ts` | Express receiver `POST /api/webhooks/shopline/:storeKey`: raw-body HMAC verify → **enqueue + ack 200 immediately** (5 s budget) → BullMQ worker processes; idempotency on `X-Shopline-Webhook-Id` + topic; DLQ reuse |
| `sync.ts` | Scheduled backfill: orders by `updated_at` watermark; payments transactions by `date_min/max` windows (≤6 months); payouts by `start/end` (≤3 months); billing records per payout id. Windowed watermarking honouring the documented range caps |
| `subscriptions.ts` | Reconcile-desired-state webhook subscriber: on install (and daily), list `/webhooks.json` and create missing topics from A7; alert if SHOPLINE deleted one (the 19-failure rule) |
| `gdpr.ts` | `customers/redact` + `merchants/redact` handlers → existing `dataDeletionRequests` flow; `merchants/redact` also triggers connector deactivation (uninstall) |
| `onboarding.ts` | `onboardShoplineMerchant()` mirroring `onboardCbsClient()`: org (segment `retail_commerce`, onboardingChannel `shopline_app_store`) + admin invite + connector config + channels (`shopline_payments`, `shopline_orders`) + retail resolution-template seed — invoked from the OAuth callback for stores we don't know yet (self-serve instal = tenant provisioning) |

### B2. Schema additions (add-only, per CLAUDE.md rules)

- `shopline_stores` (or generalized `connector_oauth_stores`): org id, store
  handle, store id, merchant id, domain, currency, iana_timezone, granted
  scopes, api version, install status, installed_at/uninstalled_at.
- `shopline_tokens`: store id → encrypted access token (reuse tenant envelope
  encryption `tk1:` format per the tenant-hardening baseline), expire_time,
  refreshed_at. 10 h TTL demands a refresh job — piggyback on the BullMQ
  repeatable jobs (`REDIS_URL` prerequisite already tracked).
- `shopline_webhook_events`: webhook id + topic unique key, payload ref,
  processed status → idempotent replay, DLQ linkage.
- RLS ratchet: classify all three tables (tenant-scoped) or CI fails.

### B3. tRPC router `server/routers/shoplineConnector.ts`

`shoplineConnector.*`: `getConfig`, `getInstallUrl` (authorize URL builder),
`listStores`, `syncNow`, `health` (token freshness, webhook delivery lag,
last sync watermarks, subscription completeness), `listWebhookEvents`,
`replayDlq` — same shape as `woodcoreConnector`, `organizationId` override for
super_admin only. Public Express routes (not tRPC): app URL entry (install
request), OAuth callback, webhook receiver, GDPR endpoints.

### B4. Reconciliation wiring

- Channels: `shopline_orders` (order leg) + `shopline_payments` (gateway leg)
  feed the existing settlement module via `retailReconciliationEngine.ts` —
  no engine changes; `ingest.ts` provides the `rawData` contract it expects.
- The A6 three-leg join gives the matching keys; `isSettlementBatchOverdue`
  watchdog gets real `settlement_batch_id`s from billing records.
- Exception taxonomy: dispute lifecycle statuses (`WON/LOST/EXPIRED`,
  pre-chargeback flows) and reserve/fee fields map onto the existing 25
  retail categories — classification rules become config in `ingest.ts`
  mapping, not new categories.

### B5. Merchant self-serve UI (retail portal)

- `retailCommerceMenuItems` in `DashboardLayout.tsx` (currently pending):
  Dashboard, Reconciliation, Exceptions (chargeback tracker view), Settlement
  monitor, Reports, Settings.
- `client/src/pages/ShoplineConnect.tsx`: install landing + connection status
  (mirrors `WoodcoreConnector.tsx` but merchant-simple).
- Post-install first-run: "connected — first sync running" state driven by
  `shoplineConnector.health`.

### B6. Super Agent wiring (Phase 1 item from CLAUDE.md)

Inject `retailExceptionsTaxonomyPromptBlock` into Super Agent prompts when
`organizations.segment === "retail_commerce"` (registry + prompt builder
already exist; segment switch is the missing piece).

### B7. Compliance/App review checklist (from A1/A7)

- GDPR endpoints live before review submission; respond 200 + complete within 30 days.
- Webhook receiver acks < 5 s (queue-first design) — also an App review reliability signal.
- Read-only scopes only; privacy policy + app listing assets (logo 120×120, 3 feature bullets, EN default language).
- Test full flow on a SHOPLINE developer store before submitting for review.

### B8. Blocked on the Partner Portal account (owner actions)

1. Create the app (Public) in the Partner Portal → obtain **app key + app secret** → set env `SHOPLINE_APP_KEY` / `SHOPLINE_APP_SECRET` (+ `SHOPLINE_API_VERSION=v20260601`).
2. Configure App URL + callback URLs (`https://www.reconcileaiafrica.com/api/shopline/install`, `/api/shopline/callback` — final paths per B1) and the two GDPR webhook URLs.
3. Create a developer store for end-to-end testing.
4. Confirm in the portal whether App Store billing is platform-managed (pricing bands on the listing) or requires an API — decides Tier 1 monetization wiring.
5. App Store slot application + listing assets when we're ready to submit.

### Suggested build order

1. `signature.ts` + `auth.ts` + schema (testable without a SHOPLINE account: signatures and flows are fully specified above)
2. `client.ts` + `ingest.ts` + `sync.ts` with fixture-based tests (response shapes from A6)
3. `webhooks.ts` + `subscriptions.ts` + `gdpr.ts` + DLQ
4. `onboarding.ts` + router + UI
5. Developer-store end-to-end test (needs B8 items 1–3) → App review submission

*Raw endpoint markdown (full field-by-field schemas incl. the 638 KB orders
spec) can be re-fetched anytime by appending `.md` to any docs URL, e.g.
`https://developer.shopline.com/docs/admin-rest-api/shopline-payments/query-store-transaction-records.md`.*
