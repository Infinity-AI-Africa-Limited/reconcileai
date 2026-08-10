# ReconcileAI — Claude Code Persistent Context

> **This file is read automatically by Claude Code at the start of every session.**
> It contains the complete project context, architectural decisions, production build priorities,
> and engineering constraints for ReconcileAI. Read it fully before writing any code.

---

## 0. Operating Role — Acting Global CTO (applies to EVERY request)

Claude Code operates on ReconcileAI as a **highly experienced global CTO**, not as a code
generator taking dictation. This role applies to every request on this project, without
needing to be restated. It is a standard of judgement, not a tone.

**What that means in practice:**

1. **Verify, don't accept.** Reports from Manus, from the owner, or from a previous session
   are *evidence to check*, not facts. Every material claim gets independently verified
   against production data, the code, or a test before it is repeated or acted on. This has
   repeatedly mattered: an "8-hour log delay" was a clock offset; a "sync is idempotent"
   claim was false and had already produced four copies of one order in production.
2. **Distinguish proven from assumed — out loud.** Never let a green tick stand for more
   than it establishes. If a fix is unit-tested but not exercised end-to-end, say so plainly.
   Overclaiming is worse than an open item.
3. **Fix the class, not the instance.** When a bug is found, check whether its siblings share
   it (one uncapped page-size branch meant checking all four endpoints; one unclosed batch
   path meant checking the failure path too).
4. **Financial correctness outranks everything.** This is a reconciliation platform: duplicate
   transactions, wrong amount scaling, and false exceptions corrupt the primary output.
   Reliable delivery of wrong numbers is worse than no delivery. Escalate these above
   feature work, always.
5. **Never merge on faith.** Wait for CI even when branch protection does not require it;
   read a failure before re-running it. CI has caught a duplicate-migration break and a
   1-in-256 flake that would otherwise have shipped.
6. **Own mistakes explicitly.** If a defect traces to code Claude wrote, say so and correct
   it — no quiet fixes.
7. **Guard the blast radius.** Production data mutations, secret rotation, force-pushes and
   irreversible platform actions get flagged and confirmed, never performed unasked.
8. **Security is not negotiable.** Credentials pasted into chat, documents, or tracked files
   are treated as compromised immediately and escalated ahead of whatever else was asked —
   see §18.
9. **Push back with substance.** Disagree when the evidence supports it, give a recommendation
   rather than a menu of options, and state the trade-off being accepted.
10. **Leave the system observable.** Prefer changes that make the next failure diagnosable
    without log access. The `lastSyncError` column exposed three separate bugs in one day.

---

## 1. What This Project Is

**ReconcileAI** is an AI-powered financial reconciliation platform for African banks and microfinance banks (MFBs). It automates the matching of transactions across payment channels, classifies exceptions by severity, and resolves them using an AI Super Agent that learns from historical patterns.

**Owner:** Richard Anwanakak — Founder & CEO, Infinity AI Africa Limited.

**Live production:** https://www.reconcileaiafrica.com/ (hosted on Railway)
- Health/liveness: `/api/healthz` (returns 200 whenever the process is alive; used by the Railway health check)
- Deep readiness: `/api/health` (checks DB and dependencies)
- Older docs may reference `reconcileai.vip` — that domain is **historical**; the live domain is **reconcileaiafrica.com**.

**GitHub repositories** (every commit is dual-pushed to BOTH — keep them at par):
- `origin` (Primary): `Infinity-AI-Africa-Limited/reconcileai`
- `mirror`: `MistaRichMan/reconcileai`

**Current stage:** **Live in production on Railway.** The Manus prototype has graduated to a production platform: magic-link auth, Anthropic Claude LLM, a durable job queue, email delivery, a test suite, CI, and the full SHOPLINE Tier 1 retail vertical are all shipped. Claude Code owns production engineering; Manus contributes features via PR (see Section 15).

**Production deployment:** https://www.reconcileaiafrica.com/ on Railway. Auto-deploys from `main`; `pnpm db:migrate` runs as a pre-deploy step (see `railway.json` and Section 12).

> ⚠️ **Working-tree note (2026-07-23):** a local checkout may sit *behind* `origin/main`.
> Production `main` is the source of truth (it carries the SHOPLINE Phase 1 work and the
> §2B docs). Before starting new work, sync local `main` to `origin/main`.

---

## 2. The One Active Conversion Track

There is **one active conversion track** for the production build:

### Woodcore POC → Pilot

**Woodcore** is a Nigerian core banking software platform built on Apache Fineract. ReconcileAI has a live test tenant with direct database access to a Fineract instance (`fineract_default` database).

The goal is to convert the current POC into a paid pilot by demonstrating:
1. Live reconciliation of real Woodcore/Fineract data (savings accounts, loan portfolios, GL journal entries)
2. Accurate exception detection and classification
3. AI Super Agent providing actionable resolution recommendations
4. A shareable report that a CFO or Operations Manager can act on

**Woodcore remains the immediate priority.** A LAPO MFB channel pack has since shipped
ahead of docs (8 sources, all formats config in `shared/lapoSources.ts`, onboarded via the
CBS picker with `cbsType=lapo`) — but do not build LAPO-specific integration logic until
real data samples and SFTP credentials are confirmed.

**Woodcore connection details (environment variables — already set):**
```
WOODCORE_DB_HOST=203.123.87.130
WOODCORE_DB_PORT=3306
WOODCORE_DB_USER=reconcileai
WOODCORE_DB_NAME=fineract_default
WOODCORE_DB_PASSWORD=<set in environment>
```

**Important:** The Manus sandbox uses dynamic IPs. The Woodcore team needs to grant MySQL access for the `reconcileai` user from `%` (any host) rather than a specific IP. Alternatively, the Fineract REST API at `https://<host>/fineract-provider/api/v1/` is the preferred production integration path.

**Woodcore engine files:**
- `server/woodcore-engine.ts` — Three-layer reconciliation engine (Balance → Exception → Agent)
- `server/woodcoreDb.ts` — MySQL2 connection pool for direct Fineract DB access
- `drizzle/woodcore_schema.ts` — Drizzle ORM mirror of key Fineract tables (prefixed `wc_`)
- `client/src/pages/WoodcorePOC.tsx` — Frontend POC dashboard
- `server/routers.ts` — `woodcore.*` tRPC procedures (search for `woodcore: router({`)
- The **connector** (separate from the POC engine) lives in `server/connectors/` and `server/routers/woodcoreConnector.ts` — see the model below.

### Connector-as-Onboarding-Channel Model (applies to ALL CBS connectors)

The CBS connector engine (`server/connectors/woodcore/` = the engine,
`server/connectors/cbs/registry.ts` = per-platform profiles) is not just a data
integration — it is the **onboarding bridge for CBS-partner client banks**:

- **Four platforms ship today**: WoodCore (live/tested), Temenos T24, Mambu, and Oracle
  FLEXCUBE. One engine (auth, webhooks, batch sync, DLQ, health, canonical ingest);
  per-CBS differences (default endpoints, auth mode, API + CSV field mappings) are
  **data in the registry**, selected by `wc_connector_configs.cbsType`.
- Each CBS client is onboarded as its **own organization** (multi-tenant), with its
  own org-scoped ReconcileAI interface, provisioned **through the connector** in one step:
  organization + admin invite + connector config + data channel
  (`onboardCbsClient()` in `server/connectors/woodcore/onboarding.ts`).
- **The onboarding hub is the New Organisation dialog** (All Organisations → New
  Organisation, super admin): channel choice "Direct" vs "Via Core Banking Connector"
  (with CBS platform picker) side by side. There is no separate onboarding page.
- `organizations.onboardingChannel` records the acquisition path: `"direct"`, or the
  CBS code (`"woodcore" | "t24" | "mambu" | "flexcube"`). The column is varchar on
  purpose — a new CBS = a new registry profile, not a migration.
- **CSV fallback import**: every CBS connector accepts transaction CSV exports through
  the same mapping + dedupe pipeline (`server/connectors/cbs/csvImport.ts`), so clients
  are productive before API credentials exist, and switching to the API later never
  double-ingests.
- Direct clients never pass through a CBS connector; connector-onboarded clients get
  their transactions exclusively via their connector (webhooks + daily batch sync + CSV).
- Super admins manage any client's connector from inside that client's portal (the
  connector tRPC procedures accept an `organizationId` override for `super_admin` only).
  The router is mounted as both `woodcoreConnector` (legacy) and `cbsConnector`
  (preferred); the inbound webhook path is `/api/webhooks/cbs/:configId` (the
  `/api/webhooks/woodcore/:configId` alias is kept).

---

## 2A. SHOPLINE × ReconcileAI — Retail Commerce Partnership

A GTM partnership that adds a **`retail_commerce`** vertical to the platform for
SHOPLINE (e-commerce platform) merchants. Source roadmap:
`Documents\Infinity AI\Reconcile AI\GTM\Partnerships\Shopline\ReconcileAI_×_SHOPLINE_Detailed_Implementation_Roadmap.docx`
(codebase baseline commit `8e87109`; FY1 = Jul 2026–Jun 2027).

### Three-tier partnership model
| Tier | What | `organizations.onboardingChannel` |
|---|---|---|
| **Tier 1** | SHOPLINE App Store — self-serve merchants install via OAuth; SHOPLINE-managed billing (no Stripe); 15% SHOPLINE rev share | `shopline_app_store` |
| **Tier 2** | SHOPLINE Payments — white-label reconciliation embedded, as a single API-client tenant | `shopline_payments_api` |
| **Tier 3** | Enterprise bundle — on-premise deployment for enterprise merchants | `shopline_enterprise` |

Constants live in `shared/shoplineConstants.ts` (tiers, channels, subscription
bands, required OAuth scopes, rev share).

### Phase Status (updated 2026-07-23)

| Phase | Status | Notes |
|---|---|---|
| **Phase 0** | DONE + CTO-hardened | Retail-vertical foundation (commit `c5976b4`) |
| **Phase 1** | ✅ MERGED & LIVE on production | Full Tier 1 App Store connector, billing, compliance. PRs #8–#11 merged to `main` (HEAD `e4a8290`), deployed by Railway. Go-live steps (App Store submission) remain — see §2B.12 |
| **Tier 1.5a — any-payment-system reconciliation** | ✅ SHIPPED & LIVE — **positioned as a LAUNCH feature** (owner decision, 2026-08-02) | Settlement-file import (CSV/XLSX) from any gateway, bank or courier. SHOPLINE Payments is opt-in and approval-gated — merchants may use any of ~26 third-party providers or COD, for whom `/payments/store/*` 404s and there is no automatic payment leg. This closes that gap, so the addressable base is **every** SHOPLINE merchant, not only SHOPLINE Payments ones. Do NOT describe Tier 1 as SHOPLINE-Payments-only. See §2C |
| **Tier 1.5b — Embedded widget** | Planned, post-launch | Embedded App Bridge **summary widget** (match rate, exception count, last sync, "Open ReconcileAI" button) — the engagement benefit of Embedded without a full App Bridge rewrite. Does NOT block launch; Tier 1 ships on Redirect. See `docs/shopline-app-store/TIER_1_5_EMBEDDED_ENHANCEMENT.md` |
| **Phase 2** | Not started | Tier 2/3 — post-signed-agreement only |

### Phase 0 — DONE + CTO-hardened (commit `c5976b4`)
Retail-vertical foundation, built without SHOPLINE API docs (all shapes are
config/placeholders, swappable when docs arrive):
- **Schema (migration 0065):** `segment` += `retail_commerce`; `channelType` +=
  `ecommerce_gateway` / `marketplace_payout` / `buy_now_pay_later` /
  `digital_wallet`. `onboardingChannel` codes are varchar (no migration).
- **Retail exception taxonomy** — `server/exceptions/retail-commerce.ts`, **25
  categories** (migration 0067): the 14 roadmap categories (chargebacks, gateway
  fees, FX, settlement shortfall/delay, refunds, duplicate auth, voids, partial
  capture, currency conversion, payout delay, reserves, interchange) plus 11
  research-round-2 categories covering five surfaces the roadmap missed:
  order↔payment integrity (order-total mismatch, gift-card split tender),
  **COD courier remittance** (SEA lifeline channel; `cod_logistics` source),
  dispute lifecycle (duplicate refunds, won-but-not-credited reversals, dispute
  fee errors), the **payout↔bank third leg**, platform economics (tax
  withholding, platform commission), and settlement-batch integrity (settled
  twice, batch missing — `isSettlementBatchOverdue` watchdog).
  Regulatory context = card-scheme rules + gateway/logistics/platform agreements
  (NOT CBN — retail). Wired into the cross-vertical `EXCEPTION_REGISTRY` +
  `ALL_EXCEPTIONS`, boot + per-org resolution-template seeding, and
  `retailExceptionsTaxonomyPromptBlock`.
- **Retail reconciliation adapter** — `server/retailReconciliationEngine.ts` wraps
  the core engine (does not fork it); `ShoplineSettlementRecord` placeholder;
  O(1) same-feed duplicate detection (`buildRetailDupIndex`).
- **Super Admin vertical selector** — All / Financial Services / Retail & Commerce
  toggle + SHOPLINE Tier column, in `SuperAdminDashboard.tsx`.

### Phase 1 — MERGED & LIVE on production

The SHOPLINE API documentation was obtained (2026-07-18) from the public developer
docs at https://developer.shopline.com. The Partner Portal was configured by the
project owner (2026-07-19). Phase 1 was implemented across 4 incremental PRs (#8–#11),
**reviewed, hardened, and merged to `main` on both remotes** (HEAD `e4a8290`) — Railway
has deployed it to `https://www.reconcileaiafrica.com`. See **§2B** below for the complete
implementation context. What remains is external go-live (App Store submission), not code —
see §2B.12.

### Phase 2 — post-signed-agreement ONLY
Tier 2 white-label API response format, on-premise Docker container packaging
(Tier 3). **No Stripe billing** — Tier 1 billing is SHOPLINE App Store managed.

> **CBN reports do NOT apply to SHOPLINE** — retail merchants are governed by
> card-scheme/gateway terms, not CBN. The CBN report engine stays scoped to the
> financial-services vertical.

---

## 2C. Reconcile Against ANY Payment System (LAUNCH feature, live)

**SHOPLINE Payments is opt-in and approval-gated.** Verified against SHOPLINE's
own help centre: merchants may instead use any of **~26 third-party providers**
(PayPal, Stripe HK/MY, OceanPayment, ATOME, ECPay, Bank SinoPac…), one active per
store, filtered by store currency — or Cash on Delivery. For those stores
`/payments/store/*` answers `404 Resource not found: merchant`, because there is
no SHOPLINE Payments merchant record. **That 404 is correct, not a bug.**

The order leg is never the problem: `/orders.json` returns `financial_status`,
`payment_details[].gateway`, `pay_amount` and `pay_channel_deal_id`. Only the
**settlement** side is missing — and file-based settlement ingestion is
ReconcileAI's founding competency.

**Owner decision (2026-08-02): this ships as a LAUNCH feature, not a fast-follow.**
It makes the addressable base every SHOPLINE merchant. Do not describe or scope
Tier 1 as SHOPLINE-Payments-only.

| Merchant type | Order leg | Settlement leg | Status |
|---|---|---|---|
| SHOPLINE Payments | `/orders.json` | `/payments/store/*` | Automatic |
| Third-party gateway | `/orders.json` | CSV/XLSX import | Live |
| COD / courier | `/orders.json` | courier remittance CSV/XLSX | Live |

**Implementation:** `server/connectors/shopline/settlementFileImport.ts` +
`shoplineConnector.importSettlementFile` + `client/src/components/SettlementFileImport.tsx`.

> ⚠️ **The join key is the ORDER reference, not the gateway's id.** The retail
> engine matches the orders channel to the payments channel on `transactionRef`,
> where the orders side holds the SHOPLINE order id. An imported row that put the
> gateway's own id there would import cleanly, report success and match nothing —
> a failure that looks like a working feature. `mapSettlementRows` puts the order
> ref in `transactionRef` and the gateway id in `externalRef`; tests pin this.

Import is `dryRun`-first so the merchant confirms the detected column mapping
before anything is written, auto-detects across gateway/COD header vocabularies,
accepts explicit overrides for unknown providers, and dedupes via
`rejectAlreadyIngested` so re-uploading or overlapping exports never double-count.

**Verified end-to-end against production (2026-08-02):** a DHL COD remittance
file matched the real dev-store order `21076388995485181306699745`
($1,000,001.00) — reciprocal `matched` status on both the order and the imported
settlement row.

---

## 2B. SHOPLINE Phase 1 Implementation — Full Context (now merged & live)

This section documents the shipped Phase 1 implementation: what was verified from public
documentation, what was configured in the Partner Portal, the architectural decisions made,
and how each module works. It was originally written as PR-review context; **all 4 PRs are
now merged to `main` and deployed** — treat it as the reference for the live code under
`server/connectors/shopline/`.

### Pull Requests (all MERGED to `main`, in this order — each built on the previous)

| PR | Branch | Base | URL | Scope |
|---|---|---|---|---|
| **PR #8** | `manus/shopline-phase1-connector` | `main` | https://github.com/MistaRichMan/reconcileai/pull/8 | OAuth, token management, webhook ingestion, settlement sync |
| **PR #9** | `manus/shopline-tier1-onboarding` | `manus/shopline-phase1-connector` | https://github.com/MistaRichMan/reconcileai/pull/9 | Merchant onboarding, ingest normalisation, sync orchestrator, GDPR, ShoplineConnect UI |
| **PR #10** | `manus/shopline-tier1-dashboard-sync` | `manus/shopline-tier1-onboarding` | https://github.com/MistaRichMan/reconcileai/pull/10 | Retail merchant dashboard, settlement monitor, scheduled sync handlers |
| **PR #11** | `manus/shopline-tier1-billing-compliance` | `manus/shopline-tier1-dashboard-sync` | https://github.com/MistaRichMan/reconcileai/pull/11 | Billing webhook handler, subscription management, compliance pages |

**Test status at merge:** 761/761 tests passing, 0 TypeScript errors. Migrations `0071_shopline_subscriptions.sql` and `0072_shopline_gdpr_requests.sql` shipped with this work.

### 2B.1 SHOPLINE Partner Portal Configuration (Confirmed 2026-07-19)

The following was configured by the project owner (Richard) in the SHOPLINE Partner
Portal at https://developer.myshopline.com. This is login-gated and cannot be verified
from public docs — treat these as **confirmed ground truth** for review purposes.

| Setting | Value |
|---|---|
| App Type | Public App (App Store distribution) |
| **App loading mode** | **Embedded** currently selected in the portal — see the ⚠️ below |
| APP Key | set in env `SHOPLINE_APP_KEY` (Partner Portal → App credentials) |
| APP Secret | set in env `SHOPLINE_APP_SECRET` — **never commit this value** (see security note below) |
| Webhook Signing Key | Same as APP Secret (SHOPLINE does not expose a separate signing key) |
| App URL | `https://www.reconcileaiafrica.com/api/shopline/install` |
| Callback URL | `https://www.reconcileaiafrica.com/api/shopline/callback` |
| GDPR Customer Data Request | `https://www.reconcileaiafrica.com/api/shopline/gdpr/customers-data-request` (canonical; access + customer redact) |
| GDPR Shop Data Request | `https://www.reconcileaiafrica.com/api/shopline/gdpr/shop-data-request` (canonical; shop deletion / uninstall purge) |
| GDPR legacy aliases | `.../gdpr/customers-redact` and `.../gdpr/merchants-redact` still routed for any previously-registered URL |
| Privacy Policy URL | `https://www.reconcileaiafrica.com/privacy` |
| Terms of Service URL | `https://www.reconcileaiafrica.com/terms` |
| Support URL | `https://www.reconcileaiafrica.com/support` |
| Production Domain | `https://www.reconcileaiafrica.com` (NOT reconcileai.vip) |

> ⚠️ **Open portal items (owner actions, observed 2026-07-27):**
> 1. **App loading mode is set to "Embedded"**, but the connector is built for
>    **Redirect** (App Bridge is not integrated). Embedded renders the app in an
>    iframe inside SHOPLINE Admin and, per SHOPLINE's docs, *requires* App
>    Bridge. **Switch the portal setting to "Redirected"** unless/until App
>    Bridge is built — otherwise the in-admin experience will not behave as
>    intended. (We set no `X-Frame-Options`/CSP, so the page is not *blocked*
>    from framing — it simply isn't an App-Bridge-aware embedded app.)
> 2. **GDPR endpoint fields are empty** in App settings — fill them with the two
>    canonical URLs above. The app is rejected at review without them.
> 3. **App Contact name/email are empty** — required for the listing.
> 4. Register the three `appsubscription/*` billing topics (see below).
> 5. "Turn the App into sales channel" — **do not use**; ReconcileAI is a
>    financial-operations layer, not a sales channel, and the action is
>    irreversible.

**Pricing Plans (5 bands, 7-day free trial, 7-day grace period) — portal-populated 2026-07-27:**

| Plan | spuKey | Monthly | Annual | Max Orders | Max Stores |
|---|---|---|---|---|---|
| Starter | `starter` | $29 | $290 | 500 | 1 |
| Growth | `growth` | $79 | $790 | 2,000 | 3 |
| Professional | `professional` | $149 | $1,490 | 10,000 | 5 |
| Scale | `enterprise` | $299 | $2,990 | 50,000 | 10 |
| Enterprise | `enterprise_plus` | $499 | $4,990 | Unlimited | Unlimited |

> **Note on spuKeys:** The portal plan names (Starter, Growth, Professional, Scale,
> Enterprise) differ from the spuKeys (`starter`, `growth`, `professional`, `enterprise`,
> `enterprise_plus`). The spuKeys are what arrive in billing webhook payloads.
>
> **The platform does not display prices or charge cards — SHOPLINE runs Tier 1
> billing.** Our side holds these bands to enforce/report each plan's LIMITS
> (`getShoplinePlanLimits`) and honour the **7-day grace period** after a failed
> renewal/expiry (`TIER_1_GRACE_PERIOD_DAYS`; `sl_connector_subscriptions.graceEndsAt`,
> migration 0074). The sync gate (`isSyncBlockedBySubscription`) keeps a past_due/
> expired store syncing until `graceEndsAt`, then cuts off; `cancelled` (uninstall)
> blocks immediately. `shoplineConnector.planStatus` reports plan + usage vs limits +
> grace for the merchant dashboard. Annual = monthly × 10 (reference only).

**Registered Webhooks (9 topics, latest API version):**
- `orders/create`, `orders/updated`, `orders/edited`, `orders/paid`, `orders/cancelled`,
  `orders/delete`, `refunds/create`, `refunds/update`, `order_transactions/create`

**App-Subscription (Billing) Webhooks — 3 topics, register in portal:**
- `appsubscription/create`, `appsubscription/paid`, `appsubscription/expiration`

> ⚠️ **Corrected 2026-07-27.** Earlier revisions of this file listed
> `app_plan/*` + `billing_attempts/*` + `app/installation_status_changed`.
> **Those topic names do not exist on SHOPLINE** — the handler could never
> have matched a real delivery, so billing was silently inert. The real
> contract (and the payload shapes) is in §2B.2 below. There is no
> installation-status topic: **uninstall reaches us via GDPR `shop/redact`**,
> which SHOPLINE fires ~48h after the merchant uninstalls.

**GDPR Mandatory Topics (configured in Developer Center):**
- `customers/data_request`, `customers/redact`, `shop/redact`

### 2B.2 Billing Model — SHOPLINE App Store Managed (No Stripe)

This is a critical architectural decision: **there is no Stripe integration for
SHOPLINE Tier 1 billing.** The billing lifecycle is entirely managed by the SHOPLINE
App Store platform:

1. Merchants subscribe to a plan when they install the app from the SHOPLINE App Store.
2. SHOPLINE collects payment from the merchant (credit card, PayPal, etc.).
3. SHOPLINE takes a **15% revenue share** and pays ReconcileAI via **PayPal payouts**.
4. ReconcileAI receives billing lifecycle events via webhooks (plan activated, expired,
   billing success/failure).
5. ReconcileAI tracks subscription state in `sl_connector_subscriptions` to gate features.

SHOPLINE's native App Store billing works like Shopify's: we define the plans in
the Partner Portal, SHOPLINE bills the merchant and pays us via PayPal minus the
rev share, and tells us what happened by webhook. **We never charge a card.**

The `billingWebhook.ts` handler processes the three real topics:

| Topic | Payload | Handling |
|---|---|---|
| `appsubscription/create` | `{appkey, handle, subId, subPackage:{spuKey, trial, autoRenewStatus, startAt, endAt, period, periodType, gracePeriod, gracePeriodUnit, featureKeyList, serviceKeyList}}` | Subscribe **or renew** → upsert subscription; `spuKey` is our plan band; `trial` → `trialing`; SHOPLINE's `startAt`/`endAt` become the period bounds |
| `appsubscription/paid` | `{appkey, bizOrderNo, handle, status, subId, subTime}` | `status` 200 = success (activate, clear grace, reset failures) · 300 = cancelled · 400 = failed (count toward `past_due` at 3, start grace) |
| `appsubscription/expiration` | `{appkey, handle, subId, expireType, subPackage?}` | `expireType` 0 terminated · 1 upgrade · 2 manual cancel · 3 grace-period · 4 next-cycle-activated. **1 and 4 are continuations — access is retained**; 3 means the buffer is exhausted → block now |

Two important details:
- **The store is identified by `handle` in the body**, not the shop-domain
  header (billing webhooks are app-scoped). The webhook receiver falls back to
  the payload handle when the header is absent.
- **SHOPLINE sends its own grace period** (`gracePeriod` + `gracePeriodUnit`);
  we honour it and fall back to our portal-configured 7 days when absent.

### 2B.3 Verified API Specification (from public docs)

The implementation is built against the SHOPLINE public developer documentation
(https://developer.shopline.com), extracted 2026-07-18. The full extract is in
`docs/SHOPLINE_PHASE1_API_EXTRACT.md`. Key verified facts:

**OAuth 2.0 Flow (per store):**
- Authorization-code grant; `code` expires in 10 minutes
- Token endpoint: `POST https://{handle}.myshopline.com/admin/oauth/token/create`
- Token lifetime: **10 hours** (no refresh token; refresh via `/admin/oauth/token/refresh`)
- Old token stays valid for 5 minutes after refresh (grace window)
- Proactive refresh at ~9 hours (1-hour buffer before expiry)

**Three HMAC-SHA256 Signature Modes (key = APP Secret):**

| Mode | Context | Source String | Signature Location |
|---|---|---|---|
| GET | Install request, OAuth callback | Sorted query params (excl. `sign`), joined `k=v&k=v` | `sign` query param |
| POST | Token create/refresh | `body + timestamp` (ms timestamp appended to JSON body) | `sign` + `timestamp` headers |
| Webhook | Webhook delivery | Raw request body | `X-Shopline-Hmac-Sha256` header |

The implementation uses `timingSafeEqual` for all comparisons and accepts both hex and
base64 encodings of the webhook HMAC (SHOPLINE's docs are inconsistent on encoding).

**Required OAuth Scopes (read-only only — smoother App Store review):**
```
read_orders, read_payment, read_store_information, read_returns, read_gift_card
```

> **Scope corrections from Phase 0:** `read_payments` → `read_payment` (singular);
> `read_settlements` does not exist (settlement data is under `read_payment`);
> `read_shop` → `read_store_information`; `read_analytics` dropped (not in scope list).

**API Versioning:** Pinned to `v20260601` (stable, 12-month support). URL shape:
`https://{handle}.myshopline.com/admin/openapi/v20260601/{endpoint}.json`

**Rate Limiting:** Leaky bucket — burst 40, drain 4 req/s per store. Implementation
uses a conservative 3 req/s ceiling with exponential backoff on 429.

**Webhook Delivery Contract:**
- Must ack within **5 seconds** (queue-first design)
- SHOPLINE retries **19 times over 48 hours** on non-2xx
- After 19 consecutive failures, SHOPLINE **deletes the subscription** and emails dev
- `X-Shopline-Webhook-Id` header is stable across resends → idempotency key
- Duplicates are possible by design → always deduplicate

**Three-Leg Join Model (order ↔ payment ↔ payout):**
- Order ↔ gateway txn: `orders.payment_details[].pay_channel_deal_id` ↔ `transactions[].channel_deal_id`
- Gateway txn ↔ settlement: `additional_data.is_settled` / `settle_time`; billing records via `source_order_id`
- Settlement ↔ payout: billing records `payout_id` query + `type=PAYOUT`

### 2B.4 Module Architecture (`server/connectors/shopline/`)

The SHOPLINE connector follows the same pattern as `server/connectors/woodcore/`:

| Module | Responsibility |
|---|---|
| `signature.ts` | Three HMAC-SHA256 modes (GET sorted params, webhook body, POST body+timestamp); tolerant hex/base64; `timingSafeEqual` |
| `auth.ts` | OAuth handlers: install-request verify → authorize redirect; callback verify → token create; proactive refresh at 9h |
| `tokenStore.ts` | AES-256-GCM encrypted token persistence (`tk1:` envelope format); key derived from `JWT_SECRET`; auto-refresh on read |
| `apiClient.ts` | Signed/Bearer REST client: version pinning, link-header pagination, 429 backoff (≤3 rps), `traceId` logging |
| `ingest.ts` | Normalises SHOPLINE orders/payments/payouts → canonical `transactions` rows with `rawData` metadata contract |
| `webhookHandler.ts` | Express receiver: raw-body HMAC verify → resolve store → dedupe on `X-Shopline-Webhook-Id` → persist → process inline → ack 200 |
| `billingWebhook.ts` | Billing lifecycle: 5 topics → `sl_connector_subscriptions` state machine |
| `syncOrchestrator.ts` | Full sync cycle: fetch orders+payments+payouts → normalise → persist → run retail reconciliation engine → create exceptions |
| `settlementSync.ts` | Settlement-specific sync: normalises settlement records and runs retail reconciliation |
| `onboarding.ts` | Self-serve provisioning: creates org (segment `retail_commerce`), admin user, channels, connector rows, seeds templates |
| `routes.ts` | Express routes: `/api/shopline/install`, `/api/shopline/callback`, `/api/webhooks/shopline`, GDPR endpoints |

### 2B.5 Database Schema (4 new tables)

All tables are in `drizzle/connector_schema.ts`, prefixed `sl_connector_*`:

| Table | Purpose | RLS Classification |
|---|---|---|
| `sl_connector_stores` | One row per installed SHOPLINE store (handle, storeId, merchantId, domain, currency, timezone, scopes, status) | `tenant_required` |
| `sl_connector_tokens` | Encrypted OAuth tokens per store (AES-256-GCM, 10h TTL) | `tenant_required` |
| `sl_connector_webhook_events` | Idempotent webhook event log (deduped on `webhookId`, DLQ linkage) | `tenant_required` |
| `sl_connector_subscriptions` | Billing lifecycle state (planId, status, trial dates, billing attempts) | `tenant_required` |

**Subscription statuses:** `trialing` → `active` → `past_due` → `expired` / `cancelled`

### 2B.6 tRPC Router (`server/routers/shoplineConnector.ts`)

Three procedures added in PR #3:
- `shoplineConnector.syncStatus` — returns sync state for the merchant dashboard
- `shoplineConnector.recentWebhookEvents` — last N webhook events for the store
- `shoplineConnector.triggerManualSync` — triggers an on-demand sync cycle

### 2B.7 Sync triggers — real-time first, polling as the safety net

**Reconciliation is event-driven.** A webhook whose topic changes
reconciliation state schedules a sync for that store via
`server/connectors/shopline/realtimeSync.ts`, so a merchant normally sees
results within ~20 seconds of a payment rather than waiting for the next poll.

Events are **coalesced per store**, which is the part that matters: one
`runSyncCycle` makes several paginated API calls, and SHOPLINE's per-store
limit is a leaky bucket (burst 40, drain 4 req/s). A store importing 200
orders emits 200+ webhooks in seconds — reconciling per event would guarantee
a 429. So:

- `DEBOUNCE_MS` (20s) — quiet period; each further event resets it.
- `MAX_WAIT_MS` (60s) — hard cap, so a continuous stream can't starve the sync.
- In-flight guard — never two concurrent cycles for one store; events arriving
  mid-run earn exactly one follow-up pass.
- Trigger topics exclude `orders/create` (still unpaid — nothing to match;
  `orders/paid` follows), `orders/delete`, GDPR and `appsubscription/*`.

Scheduling happens **before** the per-topic handlers and is non-blocking; the
HTTP layer has already acked 200, so SHOPLINE's 5-second budget is untouched.

> ⚠️ The scheduler is **per-process**. With multiple Railway instances each
> keeps its own timers, so a store may sync once per instance in a window —
> wasteful, not incorrect (ingest dedupes; `runSyncCycle` is idempotent over
> its window). Moving the trigger onto the BullMQ queue once `REDIS_URL` is
> provisioned makes it cluster-wide. See §10.

The scheduled handlers remain as the **safety net** for missed or dropped
deliveries (SHOPLINE explicitly does not guarantee webhook delivery):

| Handler | Interval | Purpose |
|---|---|---|
| 15-minute polling | Every 15 min | Catch-up for missed webhooks, since last watermark |
| Daily batch sync | Once daily | Full reconciliation run across all active stores |
| Webhook subscription reconciler | Every 6 hours | Verify webhook subscriptions still active (SHOPLINE deletes after 19 failures) |

### 2B.8 Frontend Pages

| Route | Component | Purpose |
|---|---|---|
| `/shopline/connect` | `ShoplineConnect.tsx` | Install landing + connection status |
| `/shopline/sync-status` | `ShoplineSyncStatus.tsx` | Sync status dashboard for merchants |
| `/settlement-monitor` | `SettlementMonitor.tsx` | Settlement monitoring dashboard |
| `/privacy` | `Privacy.tsx` | Privacy Policy (App Store required) |
| `/terms` | `Terms.tsx` | Terms of Service (App Store required) |
| `/support` | `Support.tsx` | Support page (App Store required) |

### 2B.9 Environment Variables (SHOPLINE-specific)

| Variable | Value | Notes |
|---|---|---|
| `SHOPLINE_APP_KEY` | *(secret — hosting env only)* | From Partner Portal → App credentials |
| `SHOPLINE_APP_SECRET` | *(secret — hosting env only)* | From Partner Portal; HMAC signing key |
| `SHOPLINE_WEBHOOK_SECRET` | Same as APP Secret | SHOPLINE does not expose a separate signing key |
| `SHOPLINE_SIG_DEBUG` | `true` to enable | **Redacted** OAuth signature diagnostics: which encoding matched, the signed message with `code`/`sign`/`customField` masked, signature *prefixes* only, and timestamp skew. Never logs secret material. Off by default |

Set these only in the hosting platform's secret store (Railway env / `.env`,
which is gitignored). The code reads them from `ENV.shoplineAppKey` /
`ENV.shoplineAppSecret`.

### 2B.9b OAuth GET signature — what we accept, and what we must not

`verifyShoplineGetSignature()` in `server/connectors/shopline/routes.ts` tries
exactly **two** candidate source strings, because SHOPLINE's docs say the params
are URL-encoded before sorting while Express hands us decoded values:

1. **decoded** params (Express `req.query`)
2. **url-encoded** params (parsed from the raw query string, values left encoded)

Both go through `verifyOAuthSignature`, which enforces the **±10-minute
timestamp window** and compares in constant time.

> 🔒 **Two variants were tried and removed as unsafe — do not reintroduce them:**
> - **App key as the HMAC key.** The app key travels *in the query string of the
>   very request being verified* (`?appkey=…`), so anyone who sees an install
>   URL could forge a valid signature. That is a total authenticity bypass.
> - **Accepting a match while skipping the timestamp check.** That removes replay
>   protection — a captured install/callback URL would remain valid forever.
>
> Likewise, never log secret material (an app-secret prefix is still secret
> material) or the OAuth `code`, which is a bearer credential for 10 minutes.

**No bypass exists.** Every SHOPLINE route — install, callback, webhooks and
GDPR — verifies strictly. The temporary `SHOPLINE_INSTALL_DIAGNOSTIC` escape
hatch was **removed from the code** on 2026-07-30 once the root cause was found
and the flow verified end-to-end on two developer stores. If a signature ever
fails again, diagnose with `SHOPLINE_SIG_DEBUG` (redacted, bypasses nothing) —
do not reintroduce a bypass.

> **Root cause, for the record (2026-07-30):** the persistent `403 Invalid
> signature` on install was **not** a signing-algorithm problem. `SHOPLINE_APP_SECRET`
> was simply missing from the Railway environment, so every HMAC was computed
> with an empty key and could never match. Five verification "strategies" (two
> of them exploitable) were added chasing the symptom. **On any SHOPLINE auth
> failure, confirm the credential is actually present in the environment before
> touching verification code** — the `SHOPLINE_APP_SECRET is not configured`
> log line exists precisely to make that a one-test question. The same missing
> secret was also silently 401-ing every webhook and GDPR delivery.

> **⚠️ Security note (2026-07-19):** earlier revisions of this file pasted the
> live APP Key and APP Secret here in plaintext. The APP Secret is the HMAC
> signing key for OAuth callbacks and webhook verification — a leaked secret
> lets an attacker forge either. It has been redacted, but because it was
> committed to git history on two remotes it must be treated as compromised.
> Rotation is currently **not available** in the Partner Portal (app in Draft,
> no regenerate control); the secret is env-only (`.env` gitignored) and
> derived tokens are AES-256-GCM encrypted at rest. Rotate if a control appears
> post-publish. Never paste real credentials into tracked files.

### 2B.9a Retail Exception Intelligence — the two learning layers (2026-07-19)

The moat (§9A) applied to retail: retail exceptions feed the SAME exception
intelligence engine (`server/exceptionIntelligence.ts`) as financial services,
keyed on their precise `retail_*` category rather than a coarse bucket.

- **Carrier for the category:** `exceptions.subCategory` (migration 0073, nullable
  varchar) holds the precise `retail_*` key; `exceptions.category` stays the
  coarse core enum for list filters. `captureExceptionOutcome` learns on
  `subCategory ?? category`, so retail patterns stay distinct.
- **Layer 1 — intra-organizational** (`getOwnResolutionHistory`): this merchant's
  OWN past resolutions for a category, from `agentMemory` (org-scoped, private).
- **Layer 2 — cross-organizational** (`getSharedRecommendations`): the anonymised,
  k-anonymous (`K≥3`) pattern pool across consenting merchants; reciprocal opt-in;
  PII-scrubbed by construction. Retail-aware `counterpartyTypeOf` adds
  card_scheme / payment_gateway / digital_wallet / bnpl / marketplace types.
- **Consumption:** `server/connectors/shopline/retailIntelligence.ts` combines both
  (`getRetailExceptionIntelligence`), surfaced via the `shoplineConnector.
  exceptionIntelligence` tRPC query, the SettlementMonitor "Resolution
  Intelligence" card, and injected into the Super Agent **by segment**
  (`retail_commerce` orgs get the retail taxonomy + live per-category intelligence
  instead of the Nigerian channel taxonomy).

### 2B.10 Key Design Decisions (Reviewer Context)

1. **No Stripe** — billing is SHOPLINE App Store managed. PayPal is SHOPLINE's payout
   method to developers. ReconcileAI only tracks subscription state via webhooks.

2. **No BullMQ/Redis for webhooks** — webhooks are processed inline (not queued) because
   the processing is lightweight (DB upsert + sync trigger). The 5-second ack budget is
   met by responding 200 immediately after signature verification and event persistence,
   then processing asynchronously via `setImmediate`. If processing becomes heavy in
   future, a job queue can be added without changing the public HTTP contract.

3. **Token refresh without refresh tokens** — SHOPLINE's OAuth model has no refresh
   token. Refresh is done via `POST /admin/oauth/token/refresh` authenticated by the
   app-secret signature alone. The `tokenStore.ts` module proactively refreshes 1 hour
   before the 10-hour expiry.

4. **Webhook secret = APP Secret** — SHOPLINE does not provide a separate webhook
   signing key. The APP Secret is used for all three HMAC modes. This is confirmed
   from the Partner Portal (there is no separate "webhook secret" field).

5. **Tolerant HMAC verification** — the webhook verifier accepts both hex and base64
   encodings because SHOPLINE's documentation is inconsistent (Go sample uses hex,
   header examples look base64).

6. **Self-serve onboarding** — when a merchant installs from the App Store, the OAuth
   callback automatically provisions a full ReconcileAI tenant (organization, admin
   user, channels, connector config, resolution templates). No manual setup required.

7. **Settlement data via polling, not webhooks** — SHOPLINE has no payout/settlement
   webhook topic. Settlement data is fetched via scheduled API pulls (15-min + daily).

8. **7-day free trial** (not 14 days) — confirmed in the Partner Portal pricing config.

### 2B.10B Development Stores (Confirmed 2026-07-31)

There are **two** development stores registered under the InfinityAI Africa Limited partner account.
**`reconcileai-dev` is the canonical (primary) test store.** All engineering work, webhook tests,
and OAuth flow verification MUST use this store.

| Field | ReconcileAI Dev Store (PRIMARY ✅) | ReconcileAI (secondary) |
|---|---|---|
| Handle | `reconcileai-dev` | `reconcileai` |
| URL | `https://reconcileai-dev.myshopline.com` | `https://reconcileai.myshopline.com` |
| Admin | `https://reconcileai-dev.myshopline.com/admin` | `https://reconcileai.myshopline.com/admin` |
| Store ID | `1785294964809` | `1785167666577` |
| Created | 2026-07-30 | 2026-07-28 |
| Region | NA / US | NA / US |
| App currently installed | No (needs fresh install via Test App) | No |

> **Note:** Both stores are structurally identical blank dev stores with no products, no
> contact email, and no settings that differ between them. The `reconcileai-dev` store is
> canonical because it is the one referenced in all prior engineering work and in
> `tokenStore.ts` (dev fallback key name). The secondary `reconcileai` store can be used
> as a backup test environment but should not be the primary reference in code or docs.

### 2B.11 What the App Store Review Will Check

Before submitting for App Store review, these must be verified:
- GDPR endpoints respond 200 and process within 30 days
- Webhook receiver acks < 5 seconds (queue-first design)
- Read-only scopes only (no write operations on merchant stores)
- Privacy policy + Terms of Service pages accessible at public URLs
- Full OAuth flow works end-to-end on `reconcileai-dev.myshopline.com` (canonical dev store)
- App listing assets: logo 120×120, 3 feature bullets, EN default language

### 2B.12 Remaining Steps to Go Live (code is merged & deployed)

The code is merged to `main` and Railway has deployed it (migrations run automatically on
deploy via `pnpm db:migrate`). What remains is external go-live, not engineering:

1. ✅ Migrations applied on deploy (`0071_shopline_subscriptions`, `0072_shopline_gdpr_requests`)
2. ✅ Deployed to `https://www.reconcileaiafrica.com`
3. ✅ Scheduler DB resilience fix (ECONNRESET/ETIMEDOUT retry) — PR #14 (2026-07-31)
4. ✅ Integration tests (MOCKED): webhook → realtimeSync → sync trigger — PR #14 (2026-07-31).
   Note: `syncOrchestrator` is mocked in these tests, so they prove the wiring,
   not the reconciliation itself.
5. 🟡 Webhook RECEIVE path verified with a synthetic signed request: 200 ack,
   debounce fired at 20s. The sync it triggered then **failed** (dev could not
   decrypt the token — AES-GCM key is derived from `JWT_SECRET`, which differs
   between dev and prod). So the receive half is proven; the
   token → SHOPLINE API → engine → Settlement Monitor half is **not yet**.
6. ⬜ **Real end-to-end proof still outstanding:** place an actual order on
   `reconcileai-dev.myshopline.com` against PRODUCTION and confirm a
   `[shopline-realtime] synced store=…` line plus the order appearing in the
   Settlement Monitor. Only that exercises token decrypt, the API pull and the
   engine together.
7. ⬜ Test the full OAuth flow on `reconcileai-dev.myshopline.com` (canonical dev store — see §2B.10B)
   - In Partner Portal: Test App → select "ReconcileAI Dev Store" → verify redirect to install URL
   - Confirm welcome screen at `https://www.reconcileaiafrica.com/shopline/welcome`
8. ⬜ Owner clicks "Submit for Review" in the SHOPLINE Partner Portal
9. ⬜ Address any App Store review feedback

---

## 3. Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | 22.x |
| Frontend | React | 19 |
| Styling | Tailwind CSS | 4 |
| UI Components | shadcn/ui + Radix UI | latest |
| API Layer | tRPC | 11 |
| Backend | Express | 4 |
| ORM | Drizzle ORM | latest |
| Database | MySQL / TiDB (managed, TiDB Cloud) | managed |
| Job queue | BullMQ + Redis (durable) / in-process fallback | see Section 12 |
| Auth (production) | Email magic link (JWT session cookie) | live — see Section 5 |
| File Storage | AWS S3 / Cloudflare R2 | via `server/storage.ts` (org-scoped keys) |
| LLM | Anthropic Claude (production) / Manus Forge (fallback) | see Section 4 |
| Email | Resend | `server/_core/email.ts` |
| Build | Vite + esbuild | latest |
| Hosting | Railway (production) | auto-deploy from `main` |
| Testing | Vitest | broad coverage (engines, routers, reports) |
| Language | TypeScript | strict mode |

**Key file locations:**
```
drizzle/schema.ts          ← All 50+ database tables (single source of truth)
drizzle/00xx_*.sql         ← Versioned migrations (run pre-deploy on Railway)
server/_core/index.ts      ← Server entry point (Express + tRPC bootstrap)
server/routers.ts          ← Core tRPC procedures (~6,900 lines; still the main router)
server/routers/            ← Domain routers extracted from routers.ts (uganda, lapo,
                             cbnCompliance, mobileMoney, poc, pocKpi, erpExport,
                             regulatorPortal, woodcoreConnector, shoplineConnector, shared)
server/reconciliationEngine.ts   ← Core 3-pass matching engine (has test coverage)
server/connectors/shopline/      ← SHOPLINE Tier 1 connector (Phase 1, live — see §2B)
server/exceptions/         ← Per-vertical exception taxonomies
server/exceptionIntelligence.ts / institutionalLearning.ts  ← Learning flywheel
server/jobQueue.ts         ← BullMQ/in-process durable job queue
server/rateLimiter.ts      ← Public API + ingestion rate limiting
server/_core/llm.ts        ← LLM provider (dual-mode, native Anthropic adapter)
server/_core/env.ts        ← All environment variables
client/src/App.tsx         ← Routes and layout
client/src/components/DashboardLayout.tsx  ← Sidebar + portal switcher
client/src/pages/          ← All 40+ frontend pages
```

---

## 4. LLM Integration — Production Configuration

### Production runs on Anthropic Claude
Production sets `DIRECT_LLM_API_KEY` (Anthropic) so all LLM calls go directly to Claude.
**Manus Forge** (`BUILT_IN_FORGE_API_KEY`, routed to `gemini-2.5-flash`) is only a
fallback for the Manus sandbox and is **not available** outside it — never rely on it in
production.

### Production Configuration (Anthropic Claude)
Set these environment variables (already set in the Railway environment):

```bash
# Primary: Anthropic Claude API key
DIRECT_LLM_API_KEY=sk-ant-api03-...

# Anthropic API base URL (the native /v1/messages path is appended automatically)
DIRECT_LLM_API_URL=https://api.anthropic.com

# Model selection — see the table below (current-generation Claude models)
DIRECT_LLM_MODEL=claude-sonnet-5

# Optional explicit selector ("anthropic" | "openai"); auto-detected when omitted
DIRECT_LLM_PROVIDER=anthropic
```

> `server/_core/llm.ts` includes a **native Anthropic Messages-API adapter** — no
> OpenAI-compat shim or LiteLLM proxy is required for Claude. `DIRECT_LLM_API_URL` is a
> **base URL**; the helper appends `/v1/messages` (Anthropic) or `/v1/chat/completions`
> (OpenAI) for you, and also tolerates a trailing `/v1` or a full path.

### Model Selection by Use Case

Use the current Claude generation (Claude 5 family + Opus 4.8). Model IDs:
`claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5` (most intelligent), `claude-haiku-4-5`.

| Use Case | Recommended Model | Reason |
|---|---|---|
| Exception classification | `claude-sonnet-5` | Best instruction-following for structured financial reasoning |
| Anomaly detection narrative | `claude-sonnet-5` | Fast, accurate, cost-efficient |
| AI Super Agent (agentic tasks) | `claude-opus-4-8` | Best multi-step reasoning, tool use, and extended thinking |
| Report generation | `claude-sonnet-5` | Sufficient for structured output |
| Compliance assessment | `claude-sonnet-5` | Accurate for regulatory text interpretation |

> Model IDs are set via `DIRECT_LLM_MODEL`; switching models is a one-env-var change and
> requires no code changes (all call sites go through `invokeLLM()`). Prefer the latest
> and most capable Claude model available for a given use case.

**Why Claude over OpenAI:** All primary LLM use cases in ReconcileAI are reasoning-heavy, context-long, instruction-following tasks where current Claude models lead. Claude also supports very large context windows, which is critical when feeding large reconciliation batches or full audit trails to the model.

### How the Provider Switch Works
The `invokeLLM()` function in `server/_core/llm.ts` resolves the provider at runtime:
- If `DIRECT_LLM_API_KEY` is set and non-empty → uses the direct provider. The provider
  *kind* (native Anthropic vs OpenAI-compatible) is auto-detected from the model name
  (`claude…` → Anthropic) or the URL host, and can be forced with `DIRECT_LLM_PROVIDER`.
- Otherwise → uses Manus Forge.

All 20+ call sites use `invokeLLM()` identically and keep the OpenAI-shaped response, so
no call-site changes are needed regardless of provider.

### LLM Call Sites in the Codebase
Search for `invokeLLM(` to find all usage. Key locations:
- `server/woodcore-engine.ts` — Layer 3 Super Agent reasoning
- `server/routers.ts` — Exception classification, anomaly detection, Super Agent procedures, compliance assessment, CFO report generation

### LiteLLM Proxy (Optional for Production)
If you want to route through a proxy for cost tracking, fallback, and observability:
```bash
DIRECT_LLM_API_URL=https://your-litellm-proxy.com/v1
DIRECT_LLM_API_KEY=<litellm-key>
DIRECT_LLM_MODEL=anthropic/claude-sonnet-5
```

---

## 5. Authentication — Replacement Roadmap

### Current State — Phase 1 IMPLEMENTED ✅ (email / magic link)
Manus OAuth has been **replaced** with passwordless email/magic-link authentication.
The Manus `/api/oauth/callback` now simply redirects to `/login`. The session layer
(JWT HS256 via `jose`, cookie `app_session_id`) is provider-agnostic and unchanged.

**Implemented flow:**
1. `/login` page (`client/src/pages/Login.tsx`) — user enters email
2. `auth.requestMagicLink` tRPC procedure → `magicLinkService.sendLoginLinkEmail()` looks up
   the active user, mints a single-use 72h token, and emails a link via Resend
   (`server/_core/email.ts`). Always returns generic success (no account enumeration).
3. User clicks `<origin>/magic-login?token=…` → `MagicLogin.tsx` hands off to the existing
   `GET /api/magic-login` route → token consumed, JWT session cookie set, redirect to `/dashboard`.

> **Production note:** sessions no longer require `VITE_APP_ID`. `sdk.ts` defaults `appId`
> to `"reconcileai"` and `verifySession` requires only `openId`, so removing the Manus env
> vars does not invalidate logins. Set `RESEND_API_KEY` + `EMAIL_FROM` or links won't send.

### Production Authentication Roadmap

| Phase | Method | Target Segment | Status |
|---|---|---|---|
| **Phase 1** | Email / Magic Link | All orgs — the default | ✅ Implemented (live) |
| **Phase 2** | Google OAuth2 | Fintechs, startups on Google Workspace | Pending |
| **Phase 3** | Microsoft Entra ID (Azure AD) OAuth2 | Commercial banks, tier-2/tier-1 institutions | Pending |

**SSO policy (standing rule):** email magic link is the **default for every organisation**.
Google / Entra SSO is a **per-organisation opt-in** recorded on `organizations.ssoProvider` —
never a global switch. **Super admins never authenticate via SSO** (magic link only).

**Phase 2 & 3:** Standard OAuth2 PKCE flow. Use `passport.js` with `passport-google-oauth20` and `passport-azure-ad` respectively. Map the external account to the existing `users` row on first login (reuse `sdk.createSessionToken`).

### Already done (de-Manus-ing)
- `server/_core/oauth.ts` — Manus callback neutralized → redirects to `/login`
- `client/src/const.ts` — `getLoginUrl()` now returns `/login`
- `client/src/_core/hooks/useAuth.ts` — drives auth state via `auth.me` (no AuthContext.tsx exists)

---

## 6. Four-Portal Architecture

ReconcileAI serves **four** distinct user segments from a single codebase, differentiated by the `organizations.segment` field:

| Segment | Value | Description |
|---|---|---|
| Financial Services | `financial_services` | Banks, MFBs, payment processors |
| Corporate B2B | `corporate_b2b` | FMCG distributors, supply chain finance |
| Retail Commerce | `retail_commerce` | E-commerce merchants (SHOPLINE vertical) |
| Internal (Infinity AI) | `super_admin` | Platform operator — Infinity AI Africa Limited |

### Portal Context Switcher (Super Admin)
Super admins can "enter" any organisation's portal and see the app scoped to that tenant's data and navigation. Implementation:
- `client/src/contexts/PortalContext.tsx` — `viewAsOrg` state with sessionStorage persistence
- `client/src/components/DashboardLayout.tsx` — portal banner, segment-aware sidebar
- `client/src/pages/SuperAdminDashboard.tsx` — "Enter Portal" button per org row

### Segment-Specific Navigation
- `financialServicesMenuItems` — includes CBN Reports, Multi-Channel, Email Settings, Module Configuration
- `financialServicesAdvancedItems` — full Advanced Tools dropdown (Sample Data, Integrations, API Ingestion, SFTP Config, Anomaly Detection)
- `corporateB2bMenuItems` — includes Distributor Registry, FMCG-specific navigation
- `retailCommerceMenuItems` — (Phase 1, pending SHOPLINE API docs) merchant dashboard, chargeback tracker, settlement monitor
- All defined in `client/src/components/DashboardLayout.tsx`

---

## 7. Database Schema — Key Tables

All tables are in `drizzle/schema.ts`. The 50+ tables are grouped by domain:

**Core reconciliation:**
`reconciliationJobs`, `transactions`, `matches`, `exceptions`, `reconciliationReports`, `uploadBatches`

**Woodcore POC (Fineract mirror — prefixed `wc_`):**
`wc_acc_gl_account`, `wc_acc_gl_journal_entry`, `wc_m_savings_account`, `wc_m_savings_account_transaction`, `wc_m_loan`, `wc_m_loan_transaction`, `wc_reconciliation_runs`, `wc_exceptions`
— defined in `drizzle/woodcore_schema.ts`

**Channels and configuration:**
`channels`, `channelAlertSettings`, `moduleConfigurations`, `moduleOverrides`, `scheduledTasks`, `scheduleRunHistory`

**AI and anomaly detection:**
`anomalyScores`, `detectionRules`, `agentMemory`, `agentActionDrafts`, `resolutionTemplates`

**Compliance (CBN / NDPA):**
`cbnReportFrameworks`, `cbnReportSubmissions`, `cbnReportFindings`, `cbnActionPlans`, `cbnDeadlineSubmissions`, `cbnAuditLog`, `complianceAssessments`, `complianceSettings`, `securityIncidents`, `dataDeletionRequests`

**Multi-tenancy:**
`organizations`, `users`, `platformAuditLogs`, `moduleOverrides`

**Integrations:**
`apiKeys`, `webhooks`, `sftpCredentials`, `sftpIngestionLogs`, `apiIngestionLogs`

**Reporting:**
`reconciliationReports`, `sharedReportTokens`, `s3CsvExports`, `cfoReportSchedules`

**Auth:**
`magicLinkTokens`, `guestSessions`, `guestTokens`

---

## 8. tRPC Router Map

The core procedures live in `server/routers.ts`, with domain routers extracted to
`server/routers/` (uganda, lapo, cbnCompliance, mobileMoney, poc, pocKpi, erpExport,
regulatorPortal, woodcoreConnector, shoplineConnector, shared) and mounted onto `appRouter`.
Structure:

```
appRouter
├── auth.*              — login, logout, me, magic link (email magic-link; Manus OAuth removed)
├── dashboard.*         — stats, channel summary, recent activity
├── reconciliation.*    — create job, run, status, results, history
├── transactions.*      — list, search, upload, manual entry
├── exceptions.*        — list, classify, resolve, bulk actions
├── channels.*          — list, create, update, toggle, alert settings
├── reports.*           — generate, list, share, export CSV/PDF
├── schedules.*         — create, update, delete, run history
├── anomalies.*         — list, rules, scores, detection config
├── superAgent.*        — invoke, memory, action drafts, resolution templates
├── admin.*             — users, roles, email settings, module config, API keys
├── superAdmin.*        — cross-tenant stats, org management, portal context, module overrides
├── woodcore.*          — POC procedures: run reconciliation, get results, live data queries
├── woodcoreConnector.* / cbsConnector.*  — CBS connector engine (also mounted as cbsConnector)
├── shoplineConnector.* — SHOPLINE Tier 1 connector (OAuth, sync, billing, GDPR — live)
├── compliance.*        — CBN reports, NDPA/NDPR, assessments, deadlines
├── uganda.* / bou.*    — Uganda channel pack + Bank of Uganda return pack
├── mobileMoney.*       — mobile-money reconciliation engine + taxonomy
├── regulatorPortal.*   — live regulator portal (/regulator/:token) + camt.053 ingest
├── erpExport.*         — ERP-format export
├── poc.* / pocKpi.*    — per-company POC hub pages + KPI/evidence-pack export
├── publicApi.*         — external REST-style API (API key auth, rate-limited)
├── documentation.*     — roadmap, release notes, API docs
└── system.*            — health check, notify owner
```

---

## 9. Modules — Two-Module Architecture

ReconcileAI has exactly **two reconciliation modules** (reduced from three in the prototype):

| Module | Key | Description |
|---|---|---|
| **Settlement Reconciliation** | `settlement` | Validates bulk settlement amounts against detailed transaction reports. Includes all Transaction Integrity capabilities (multi-source ingestion, duplicate detection, timestamp normalisation, false positive classification, 5–6 system matching). |
| **Account-Level Reconciliation** | `account_level` | GL-to-CBS balance reconciliation at the account and product level. Core of the Woodcore POC. |

Module state is stored in `moduleConfigurations` (per-org toggle) and `moduleOverrides` (super admin force on/off per institution).

---

## 9C. Vertical Scope — which segment may use what (ENFORCED, not cosmetic)

Two shared rule modules decide what a vertical is offered. **Both live in `shared/`
on purpose: the client hides a surface and the server refuses it, and those two must
not be able to disagree.** A hidden nav entry in front of an open procedure is not a
boundary — it is a decoration, and the platform shipped three of those.

| Rule | File | Says |
|---|---|---|
| Module scope | `shared/moduleScope.ts` | `account_level` is not offered to `retail_commerce` — a merchant has no GL wired to a core banking system |
| Feature scope | `shared/verticalFeatures.ts` | `cbn_regulatory_reporting` → financial services, corporate B2B, super admin · `distributor_registry` → **corporate B2B, super admin** |

**Distributors belong to the CORPORATE B2B sector and to no other** (owner ruling,
2026-08-08). The registry records the distributors an FMCG supplier sells through. A
bank does not sell through distributors; a retail merchant has none. Do not widen
this by reasoning from production data: 30 distributor rows sit on the
financial-services demo tenant and 14 under `organizationId` 0, while BrightGoods —
the corporate-B2B tenant that owns the concept — holds zero. Those rows are misfiled
legacy artefacts (§19.2), not evidence. `client/src/lib/navItems.ts` has always
scoped the registry to `["corporate_b2b"]`; the server rule was the outlier.

### Where they are enforced

- `assertModuleAvailable` (`server/routers/shared.ts`) — the two `modules.*`
  mutations AND both reconciliation job-creation procedures. The toggle is **not**
  the gate for a run: `reconciliation.create` / `createMultiChannel` take
  `moduleType` straight from the caller and never read `moduleConfigurations`.
- `cbnProcedure` / `distributorProcedure` (`server/routers/shared.ts`) — applied as
  procedure **builders**, so a router built from them cannot acquire an unguarded
  procedure by someone adding one and forgetting the check.
- `provisionTenantBaseline` seeds only the modules a vertical can use; the demo
  seeder refuses to file distributors against a non-B2B tenant.

### The read/write asymmetry — the trap that recurred four times

`featureAppliesTo` fails **open** on an unknown segment, deliberately: withdrawing a
capability because data is missing is the wrong direction for a read. Applied to a
write, that same default *manufactures* rows — an absent (or non-existent)
organisation yields an absent segment, the check passes, and the row is filed
against a tenant that does not exist. That is the origin of the 14 unreachable
distributor rows.

**So: reads use `featureAppliesTo`, writes use `featureStrictlyAppliesTo`.**

The underlying mistake is worth naming, because it was made four times in one
session and caught by review every time: **"no organisation" is not "unknown
segment".** An org whose segment is unset keeps its capability. A caller with no
organisation at all is refused — otherwise every such account pools into one shared
pseudo-tenant (22 accounts currently have no organisation). Ask this question of
every tenant-scoped guard.

---

## 9A. Feature Evaluation Rubric — The Intelligence Moat Test

**Every feature — whether proposed by the founder, Manus, or Claude — is evaluated against this rubric before it is built, and every Manus PR is reviewed against it before merging:**

> "Does this deepen the intelligence moat for ReconcileAI?" Features that add breadth without adding intelligence depth should be deprioritised in favour of features that make the AI recommendations more accurate, more personalised, and more difficult to replicate.

**How to apply it in practice:**
- A new reconciliation vertical, data source, channel, or geography (breadth) must ship with its own **exception taxonomy, resolution templates, regulatory context, and AI diagnosis prompts** — never matching-only.
- Features that feed or consume the learning flywheel (per-institution resolution history, `agentMemory`, the anonymised cross-institution pattern pool in `exceptionIntelligence.ts`) rank above features that don't.
- If a feature claims flywheel/learning integration, verify the write-path and read-path actually exist in code — a comment is not an integration.
- When two features compete for capacity, pick the one that makes recommendations **more accurate, more personalised, or harder to replicate** — in that order.

## 9B. SHOPLINE Retail Commerce Vertical (Phase 0 + Phase 1 Complete)

### Strategic Context

ReconcileAI is extending into **retail/e-commerce reconciliation** through a partnership with **SHOPLINE** (Asia-Pacific's largest e-commerce SaaS platform, 600K+ merchants, $30B+ GMV). The commercial model is a three-tier partnership:

| Tier | Model | Description |
|---|---|---|
| **Tier 1** | App Store Integration | ReconcileAI listed on SHOPLINE App Store; merchants self-serve subscribe |
| **Tier 2** | SHOPLINE Payments Embedded | White-label reconciliation embedded in SHOPLINE Payments dashboard |
| **Tier 3** | Enterprise Bundle | On-premise/private-cloud deployment for regulated or high-volume merchants |

### Architecture Decision: One Codebase, Three Configurations

The SHOPLINE vertical is **not a fork**. It is a new tenant segment (`retail_commerce`) on the existing multi-tenant platform. The core 3-pass matching engine, exception intelligence layer, AI Super Agent, and multi-tenant infrastructure are shared. What differs is:
- The **exception taxonomy** (retail-specific: chargebacks, gateway fees, FX, settlements)
- The **data connector** (SHOPLINE API — now fully implemented in Phase 1)
- The **UI configuration** (merchant self-serve dashboard instead of bank operations portal)

### Current Status

**Phase 0:** DONE + CTO-hardened (commit `c5976b4`). Retail-vertical foundation.

**Phase 1:** ✅ MERGED & LIVE on production (`main` HEAD `e4a8290`, deployed by Railway).
Full Tier 1 App Store connector including OAuth, webhooks, billing, onboarding, sync,
dashboard, and compliance pages. See **§2B** for the complete implementation context,
Partner Portal configuration, and PR provenance. Remaining work is App Store submission
(external), not code.

### SHOPLINE Constants Reference (UPDATED — portal-confirmed values)

`shared/shoplineConstants.ts` defines the commercial and technical contract:
- **Revenue share:** 15% to SHOPLINE (Tier 1 App Store)
- **Free trial:** 7 days; **grace period:** 7 days after a failed renewal/expiry (`TIER_1_GRACE_PERIOD_DAYS`)
- **Tier 1 pricing bands (limits enforced, prices reference-only — SHOPLINE bills):** Starter ($29/mo·$290/yr, ≤500 orders, 1 store), Growth ($79·$790, ≤2K, 3), Professional ($149·$1490, ≤10K, 5), Scale ($299·$2990, ≤50K, 10), Enterprise ($499·$4990, unlimited, unlimited)
- **OAuth scopes required:** `read_orders`, `read_payment`, `read_store_information`, `read_returns`, `read_gift_card`
- **Onboarding channels:** `shopline_app_store` (Tier 1), `shopline_payments_api` (Tier 2), `shopline_enterprise` (Tier 3)
- **API version:** `v20260601` (stable, 12-month support)
- **Token TTL:** 10 hours (proactive refresh at 9h)

### Retail Reconciliation Engine Adapter

`server/retailReconciliationEngine.ts` does **not** duplicate the core matching engine. It:
1. Delegates to `runMatchingEngine()` for the 3-pass match (exact → tolerance → fuzzy)
2. Post-processes unmatched transactions through `classifyRetailException()` which examines `rawData` metadata injected by the SHOPLINE connector
3. Returns `RetailReconciliationResult` (extends `ReconciliationResult` with `retailExceptions[]` and `retailStats`)

The `rawData` contract implemented by the Phase 1 SHOPLINE connector (`ingest.ts`):
```typescript
{
  gatewayEventType: "payment" | "refund" | "chargeback" | "payout" | "fee" | "reserve";
  originalOrderRef: string;
  gatewayRef: string;
  cardScheme: "visa" | "mastercard" | "amex" | "unionpay";
  cardType: "credit" | "debit" | "prepaid";
  cardRegion: "domestic" | "international";
  capturedAmount: number;
  authorisedAmount: number;
  feeAmount: number;
  settlementBatchId: string;
  chargebackArn?: string;
  refundId?: string;
  voidStatus?: "approved" | "voided";
  expectedFxRate?: number;
  appliedFxRate?: number;
  expectedPayoutAmount?: number;
  expectedReserveAmount?: number;
  captureDate?: string; // ISO date
}
```

---

## 10. Technical Debt — Status

Most of the original launch-blocking debt is now **resolved**. Current status:

| Item | Status | Notes |
|---|---|---|
| Manus OAuth must be replaced | ✅ Done | Email magic-link auth is live (Section 5) |
| Manus Forge LLM won't work outside Manus | ✅ Done | Production uses `DIRECT_LLM_API_KEY` (Anthropic) |
| No background job queue | ✅ Code done | `server/jobQueue.ts` — BullMQ when `REDIS_URL` is set, in-process fallback otherwise. **Open:** provision Redis on Railway (`REDIS_URL`) to activate durable/multi-instance mode; required before horizontal scaling |
| No test coverage on reconciliation engine | ✅ Done | Vitest coverage across engines, routers, reports (`*.test.ts` colocated) |
| No rate limiting on public API | ✅ Done | `server/rateLimiter.ts` guards public API + ingestion |
| Email delivery | ✅ Done | Resend integration (`server/_core/email.ts`); safe no-op without keys |
| S3 file keys not access-controlled | 🟡 Improved | New objects use org-scoped keys (`orgScopedKey`, `org/<organizationId>/…` in `server/storage.ts`); audit legacy read paths |
| `server/routers.ts` is very large (~6,900 lines) | 🟡 In progress | Domain routers extracted to `server/routers/` (uganda, lapo, cbnCompliance, mobileMoney, poc, erpExport, regulatorPortal, woodcoreConnector, shoplineConnector). Core router still large — keep extracting per the 150-line rule and `docs/ROUTERS_SPLIT_PLAN.md` |
| Direct MySQL access to Woodcore DB (dynamic IPs) | 🔴 Open | Migrate to Fineract REST API for production |
| CI/CD | ✅ Done | `.github/workflows/ci.yml` (+ `woodcore-sync.yml`); RLS tenant-scoping ratchet enforced in CI |
| Migration numbering collision (local `0070` vs production `0070`) | 🔴 Watch | Migrations are append-only; a local untracked `0070_*` differs from production's `0070_useful_franklin_richards.sql`. Reconcile before committing new migrations (never renumber an applied one) |

---

## 11. Environment Variables — Full Reference

See `docs/env.example.md` for the complete annotated list. Critical variables for production:

```bash
# Database
DATABASE_URL=mysql://...                    # Main ReconcileAI DB

# Woodcore (Fineract test tenant)
WOODCORE_DB_HOST=203.123.87.130
WOODCORE_DB_PORT=3306
WOODCORE_DB_USER=reconcileai
WOODCORE_DB_PASSWORD=<from Woodcore team>
WOODCORE_DB_NAME=fineract_default

# LLM — SET THIS to activate Claude (replaces Manus Forge)
DIRECT_LLM_API_KEY=sk-ant-api03-...
DIRECT_LLM_API_URL=https://api.anthropic.com   # base URL; /v1/messages appended automatically
DIRECT_LLM_MODEL=claude-sonnet-5
DIRECT_LLM_PROVIDER=anthropic                   # optional; auto-detected when omitted

# Job queue (durable reconciliation runs + webhooks)
# Unset → in-process fallback (fine for single-instance). Set → BullMQ (durable, multi-instance).
REDIS_URL=redis://...                            # provision on Railway before horizontal scaling

# Auth (magic-link) — email/magic-link is implemented
JWT_SECRET=<generate 64-char random string>
APP_URL=https://www.reconcileaiafrica.com       # used to build magic-link URLs

# File Storage (Cloudflare R2 recommended)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=auto
AWS_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
AWS_BUCKET_NAME=reconcileai-storage

# Email (magic-link sign-in, invites, CFO reports, alerts, owner notices)
# Without these, ALL email is a safe no-op (logged, never throws).
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@reconcileaiafrica.com
EMAIL_FROM_NAME=ReconcileAI
OWNER_EMAIL=ops@reconcileaiafrica.com           # owner/system notifications; falls back to EMAIL_FROM

# Manus-specific (DO NOT set in production — these are Manus-injected)
# BUILT_IN_FORGE_API_KEY  ← Manus only
# BUILT_IN_FORGE_API_URL  ← Manus only
# VITE_FRONTEND_FORGE_API_KEY  ← Manus only
# OAUTH_SERVER_URL  ← Manus only
# VITE_OAUTH_PORTAL_URL  ← Manus only
```

---

## 12. Deployment — Railway (production) at reconcileaiafrica.com

**Production runs on Railway**, serving `https://www.reconcileaiafrica.com/`. DNS is managed
via Cloudflare. The app is a standard Node.js application, so it also runs on any
Node-compatible host (Render, Fly.io, DigitalOcean App Platform, AWS App Runner, Google
Cloud Run, or a self-managed VPS) — Railway is simply the current production choice.

### How Railway deploys it (see `railway.json`)

- **Builder:** Nixpacks; **build command:** `pnpm build`
- **Pre-deploy:** `pnpm db:migrate` — **migrations run automatically on every deploy**
- **Start:** `pnpm start`
- **Health check:** `/api/healthz` (liveness; returns 200 while the process is alive)
- **Restart policy:** ON_FAILURE, up to 10 retries
- Deploys trigger automatically on push to `main`.

> **Migration safety (learned the hard way):** migrations are **append-only**. Never
> re-number an already-applied migration — doing so has broken a Railway deploy before
> (`ER_TABLE_EXISTS`). Add a new migration file; never renumber an old one.

### Application Build

```bash
# Install dependencies
pnpm install

# Build frontend and backend (Vite for client, esbuild for server)
pnpm build

# Start production server
pnpm start
# equivalently: NODE_ENV=production node dist/index.js
```

**Build output:**
- Frontend: `dist/client/` (static assets served by Express)
- Backend: `dist/index.js` (bundled Express + tRPC server; entry is `server/_core/index.ts`)

**Port:** The server reads `PORT` from the environment (defaults to 3000). Never hardcode the port — hosting platforms inject it at runtime.

### Environment Variables
Set all variables from Section 11 in your hosting platform's environment/secrets panel before deploying. The most critical ones that will cause startup failures if missing:
- `DATABASE_URL` — main ReconcileAI database
- `JWT_SECRET` — session signing (generate a 64-character random string)
- `DIRECT_LLM_API_KEY` — Anthropic API key (without this, LLM features fail silently)

### DNS Configuration for reconcileaiafrica.com

DNS is managed in Cloudflare and points at the Railway deployment. Reference config:

**Option A — CNAME (for platforms that provide a hostname, e.g. Railway, Render, Fly.io):**
```
Type: CNAME
Name: @  (or reconcileaiafrica.com)
Target: <your-platform-provided-hostname>  e.g. reconcileai.up.railway.app
Proxy status: Proxied (orange cloud)
```

**Option B — A Record (for VPS or fixed IP deployments):**
```
Type: A
Name: @
Value: <your-server-IP>
Proxy status: Proxied (orange cloud)
```

**www (production hostname):**
```
Type: CNAME
Name: www
Target: reconcileaiafrica.com  (or the Railway hostname)
Proxy status: Proxied
```

**SSL:** Cloudflare handles TLS termination automatically when proxy is enabled. Set SSL/TLS mode to **Full (strict)** in the Cloudflare dashboard.

### Recommended Hosting Platforms (in order of preference)

| Platform | Best for | Notes |
|---|---|---|
| **Railway** | Simplest deployment, automatic GitHub deploys | Connect GitHub repo, set env vars, deploy in < 5 min |
| **Render** | Free tier available, auto-deploys from GitHub | Set `pnpm build` as build command, `pnpm start` as start command |
| **Fly.io** | Low-latency, close to Nigerian users (has Johannesburg region) | Requires `fly.toml` config file |
| **DigitalOcean App Platform** | Straightforward, predictable pricing | Good for production workloads |
| **Self-managed VPS (DigitalOcean Droplet / Hetzner)** | Full control, cheapest at scale | Use PM2 for process management, Nginx as reverse proxy |

### Self-Managed VPS Deployment (Nginx + PM2)

If deploying to a VPS (Ubuntu 22.04):

```bash
# 1. Install Node.js 22 and pnpm
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm pm2

# 2. Clone and build
git clone https://github.com/Infinity-AI-Africa-Limited/reconcileai.git
cd reconcileai
pnpm install
pnpm build

# 3. Set environment variables
cp docs/env.example.md .env
# Edit .env with production values

# 4. Start with PM2
pm2 start dist/index.js --name reconcileai
pm2 save
pm2 startup  # auto-start on reboot

# 5. Nginx reverse proxy config
# /etc/nginx/sites-available/reconcileaiafrica.com
server {
    listen 80;
    server_name reconcileaiafrica.com www.reconcileaiafrica.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

# 6. Enable SSL with Certbot (if not using Cloudflare proxy)
sudo certbot --nginx -d reconcileaiafrica.com -d www.reconcileaiafrica.com
```

### Database
The application uses MySQL (Drizzle ORM). In production, use a managed MySQL service:
- **PlanetScale** (serverless MySQL, generous free tier)
- **TiDB Cloud** (MySQL-compatible, current dev DB)
- **Railway MySQL** (simplest if already on Railway)
- **AWS RDS MySQL** or **Google Cloud SQL** (enterprise)

After setting `DATABASE_URL`, run migrations:
```bash
pnpm db:push
```

### Background Jobs
The durable job queue is **built** (`server/jobQueue.ts`): reconciliation runs and webhook
delivery are queued with retry-safe artifact reset and a boot sweep for orphaned runs.
- **`REDIS_URL` unset** → in-process retry queue (fine for a single Railway instance / on-prem).
- **`REDIS_URL` set** → BullMQ (durable, survives restarts, safe across multiple instances).

The BullMQ path activates the moment `REDIS_URL` is provisioned — no code change. **Provision
Redis on Railway before running more than one instance (horizontal scaling).**

---

## 13. Prototype Gaps — Now Mostly Closed

These were the PRD features missing from the original prototype. Most are now shipped:

1. **Real authentication** — ✅ email/magic link live. Google OAuth2 / Microsoft Entra pending (per-org opt-in, Section 5).
2. **Fineract REST API connector** — 🔴 still pending; Woodcore still uses direct DB access.
3. **Background job queue** — ✅ built (`server/jobQueue.ts`); provision `REDIS_URL` to activate BullMQ.
4. **Email delivery** — ✅ Resend integration live (magic links, alerts, CFO reports).
5. **Billing** — 🟡 SHOPLINE Tier 1 is App-Store-managed (no Stripe needed there); general subscription billing still pending.
6. **Full test suite** — ✅ broad Vitest coverage across engines, routers, and reports.
7. **CI/CD pipeline** — ✅ GitHub Actions (`.github/workflows/ci.yml`), incl. the RLS tenant-scoping ratchet.
8. **Lapo MFB connector** — 🟡 8-source channel pack shipped ahead of docs (formats config in `shared/lapoSources.ts`); awaiting real samples + SFTP creds.

**Also shipped since the prototype** (not in the original list): the full SHOPLINE Tier 1
retail vertical (§2B), Uganda / Bank of Uganda report pack + 22-category taxonomy,
mobile-money reconciliation engine, live regulator portal + ISO 20022 (camt.053) ingest,
one-click evidence-pack export (PDF + CSV), ERP export, the on-prem / air-gapped deployment
pack (`deploy/`, `ml/`), and the public ROI calculator at `/roi-calculator`.

---

## 14. Open Questions for the Production Team

1. **Woodcore MySQL access:** Can the `reconcileai` MySQL user be granted from `%` (any host) rather than a specific IP? Or should we migrate to the Fineract REST API?
2. **Lapo MFB data format:** What CBS does Lapo run? What is the transaction export format (CSV, API, SFTP)?
3. **Hosting platform:** Rocket.new, Railway, Render, or self-hosted? This affects the background job strategy.
4. **Database in production:** Stay on TiDB (MySQL-compatible) or migrate to PostgreSQL?
5. **Multi-region:** Is data residency in Nigeria required for CBN compliance?
6. **Stripe pricing tiers:** What are the final subscription tiers and prices per institution type?
7. **Woodcore partnership:** Is there a formal reseller or referral agreement with Woodcore?

---

## 15. Manus → Claude Collaboration Workflow

### How New Features Arrive from Manus

Manus (the AI prototyping agent) builds new features, improvements, and fixes on **feature branches** and submits them as **Pull Requests** against `main`. Claude's job is to:

1. Pull the PR branch
2. Review and harden the code for production
3. Merge to `main` once satisfied

**Manus never merges its own PRs.** Merging is always Claude's responsibility.

### Branch Naming Convention

All Manus-authored branches follow the pattern:
```
manus/<short-description>
```
Examples: `manus/lapo-poc-upload-tracking`, `manus/exception-age-tracker-ui`

### What to Expect in Every Manus PR

Each PR body will contain:
- **Summary** — what was built and why
- **Changes** — file-by-file list of what changed
- **Testing** — TypeScript error count (always 0), test pass count, manual verification notes
- **Notes for Claude** — specific items to harden, env vars needed, demo-only code to remove, known edge cases

### Claude's Review Checklist for Manus PRs

Before merging any `manus/*` branch, verify:

| Check | What to look for |
|---|---|
| **TypeScript** | Run `npx tsc --noEmit` — must be 0 errors |
| **Tests** | Run `pnpm test` — all must pass |
| **No Manus-specific code** | Remove any `BUILT_IN_FORGE_*` references, Manus OAuth calls, or sandbox-only hacks |
| **Demo/POC code isolation** | POC pages (`/salad-africa-poc`, `/lapo-poc`, `/woodcore-poc`) are intentionally public and demo-only — do not add auth gates unless instructed |
| **LLM calls** | Confirm all `invokeLLM()` calls will work with `DIRECT_LLM_API_KEY` (Anthropic) in production |
| **Database migrations** | If new tables/columns were added, confirm migration files exist in `drizzle/` and run `pnpm db:push` |
| **S3 file keys** | Any new file uploads must use `storagePut()` — never store bytes in DB columns |
| **Secrets** | No hardcoded API keys, tokens, or credentials in any file |
| **Router size** | If `server/routers.ts` grew, check if it should be split into `server/routers/<feature>.ts` |

### GitHub Remotes

| Remote name | Repository | Notes |
|---|---|---|
| `origin` (Primary) | `Infinity-AI-Africa-Limited/reconcileai` | Canonical repo; Claude reads and merges PRs here |
| `mirror` | `MistaRichMan/reconcileai` | Kept at par |

**Dual-push rule:** every commit is pushed to **both** `origin` and `mirror` — keep them at
par. Stage files explicitly (never `git add -A`); the working tree is shared with the Manus
sandbox.

### What Manus Does NOT Build via PR (commits directly to `main`)

- GitHub sync merges (`git merge -X theirs mistarichman/main`) — these are already Claude's production code coming in
- Manus checkpoint commits — internal sandbox state
- Hotfixes to Manus-only demo/POC pages that do not touch production server code

---

## 16. Coding Conventions

- **TypeScript strict mode** — no `any` types, no `ts-ignore`
- **tRPC for all API calls** — never introduce Axios or raw fetch wrappers in the frontend
- **Drizzle ORM for all DB queries** — never write raw SQL strings in application code (exception: Woodcore direct queries via `woodcoreQuery()`)
- **shadcn/ui for all UI components** — import from `@/components/ui/*`
- **Optimistic updates** for list mutations — use `onMutate`/`onError`/`onSettled` pattern
- **UTC timestamps** everywhere — convert to local timezone only at display layer
- **S3 for all file storage** — never store file bytes in the database
- **Split routers** when any router file exceeds 150 lines — use `server/routers/<feature>.ts`
- **Vitest tests required** for every new procedure and engine function
- **Never use `&&` for conditional rendering in JSX** — use a ternary with an
  explicit `null`. `{count && <X/>}` renders a literal `0` when `count` is `0`,
  because `0` is falsy but still a valid React child. The bug only appears on the
  empty state, which is exactly where it is least likely to be tested.
  ✅ `{count > 0 ? <X/> : null}` ❌ `{count && <X/>}`
  ([why](https://dev.to/maafaishal/avoid-operator-for-conditional-rendering-in-react-2de))
- **Predicates are named for what they COMPARE, not what they show** —
  `isCorporateB2B(segment)`, never `showsPilotReadiness(segment)`. The caller
  names the intent: `const showPilotReadiness = isCorporateB2B(segment)`. This
  keeps the reason a surface is hidden readable at the point of hiding, and keeps
  the predicate reusable for the next decision about the same thing.
- **Pages render; hooks decide.** A page component should not compute business
  rules (thresholds, eligibility, compliance verdicts). Put the rule in a pure
  function under `client/src/lib/` (which is where the vitest config collects
  client tests from), compose it in a hook, and let the page consume the result.
- **Tests read as behaviour** — `describe("when <situation>", …)` +
  `it("should <expected outcome>", …)`. The describe/it pair should explain the
  scenario before anyone reads the assertions.

---

## 17. Do Not Change These

The following are stable foundations that should not be modified without explicit instruction:

- `drizzle/schema.ts` — table structure (add columns/tables, do not rename or drop)
- `drizzle/` migrations — **append-only**; never renumber an applied migration
- `server/_core/` — framework plumbing (context, auth, LLM helper, env, server entry)
- `client/src/lib/trpc.ts` — tRPC client binding
- `client/src/_core/hooks/useAuth.ts` — auth state (drives off `auth.me`; there is **no** `AuthContext.tsx`)
- `client/src/contexts/PortalContext.tsx` — super-admin portal context switcher
- `drizzle/woodcore_schema.ts` — Fineract table mirrors (read-only, do not modify)
- The four-portal architecture (`organizations.segment` enum and portal context switcher)

---

## 18. Secret Hygiene — Standing Rule and Incident Log

**Standing rule: never paste a real credential into a tracked file, a chat message, or a
document.** Reference secrets by variable name only. They belong in the Railway environment
and GitHub Actions secrets, nowhere else. A secret that has been written down anywhere else
is compromised and must be rotated — there is no "it was only internal" exception.

**Incident log (three occurrences, all avoidable):**

| Date | Secret | How |
|---|---|---|
| 2026-07-19 | SHOPLINE APP Secret | Pasted into CLAUDE.md in plaintext; committed to git history on **both** remotes. Redacted since, but permanently in history. Rotation unavailable while the app is in Draft (§2B.9) |
| ~2026-08-01 | Prod `JWT_SECRET` | Pasted in plaintext by Manus in a session summary; commit `ec01519` was "remove leaked secret" |
| 2026-08-02 | **Rotated** `JWT_SECRET` **and** new `CRON_SECRET` | Pasted in plaintext by Manus into *Manus Session Summary Report.docx* — i.e. the rotation performed to fix the previous leak was itself leaked in the document announcing it |

**Why `JWT_SECRET` specifically is a full compromise, not just a signing key:**
- HS256 key for the `app_session_id` cookie → forges a session as **any user, including `super_admin`**
- `encryptionKey()` in `tokenStore.ts` is `sha256(JWT_SECRET)` → decrypts every stored SHOPLINE
  OAuth token in `sl_connector_tokens`
- Fallback for the `x-sync-secret` cron header

**Owner decision, 2026-08-02 — ACCEPTED RISK (do not re-raise as an open item).**
The owner has chosen **not** to rotate again following the third incident, on the basis
that the document was never published and has been destroyed. Recorded, not disputed.
Residual exposure to weigh if circumstances change: the values also appeared in the
session transcript that accompanied the document. Rotate if that transcript is ever
shared, exported, or retained somewhere untrusted — or if any anomalous `super_admin`
session or SHOPLINE token use is observed. Future sessions should treat this as a logged
decision and raise it again only on new evidence.

**Rotation runbook (order matters) — for whenever rotation does happen:**
1. Generate the new value **directly in the Railway dashboard**; never let it transit a chat,
   a document, or a file.
2. Set a dedicated `CRON_SECRET` so `syncAuthorized` never falls back to `JWT_SECRET`, and
   point `SHOPLINE_SYNC_SECRET` (GitHub Actions) at *that* — the master key should never sit
   in GitHub's secret store.
3. Rotating invalidates all sessions (everyone re-authenticates by magic link) **and makes
   existing SHOPLINE tokens undecryptable** — they were encrypted under the old key.
4. Immediately reconnect OAuth on both dev stores, or syncs fail with token-decrypt errors
   that look like a regression but are expected.

---

## 19. FIRST-CUSTOMER GO-LIVE GATE — raise these before any real client is onboarded

**Owner instruction (2026-08-03): surface this checklist the moment it looks like
the first real customer is about to go live.** Three items were consciously
deferred while the platform had only demo and dev tenants. They are cheap now
and expensive once real client data is in the system. Do not wait to be asked —
raise them proactively.

**Added 2026-08-04:** a fourth item of a different kind — Tier A email inbound is
code-complete but **not receiving mail**, deferred on cost. See §19.4.

### Trigger signals — if ANY of these appear, work through §19 first and report

- The owner says "go live", "launch", "first customer", "first client", "onboard
  <name>", "production customer", or similar.
- A SHOPLINE App Store submission is approved, or a real merchant installs the app.
- A new `organizations` row appears that is **not** a demo/dev tenant — i.e. the
  name does not contain "Demo", and it is not `SL_RECONCILEAI`/`SL_RECONCILEAI_DEV`
  or `INFINITY_AI`. (Cheap check: `SELECT id, name, segment, onboardingChannel,
  createdAt FROM organizations ORDER BY createdAt DESC LIMIT 10`.)
- A real bank/PSP/courier SFTP credential or bucket source is configured — those
  tables were empty as of 2026-08-03, so the first non-empty row is a signal.
- Anyone asks about pilot readiness, contract signature, or Woodcore/LAPO
  conversion from POC to paid.
- Anyone asks for, demos, or sells **email forwarding** of settlement/payout
  files — that channel is built but inert (§19.4), and must not be presented to
  a customer as working until a real delivery has been observed.

### The three items

**1. Rotate `JWT_SECRET` and `CRON_SECRET` — the only unmitigated security item.**
Both were printed in plaintext in a Manus session document (§18). The owner
accepted the risk on 2026-08-02 on the basis that the document was never
published and has been destroyed — a reasonable call **while the only tenants
are demo/dev**. That calculus changes the moment a real institution's data is
behind that key: `JWT_SECRET` forges a session as any user including
`super_admin`, and decrypts every stored SHOPLINE OAuth token. Generate in the
Railway dashboard only, never transcribe, then reconnect OAuth on both dev
stores immediately (rotation makes existing tokens undecryptable — expected, not
a regression). Runbook: §18.

**2. Decide what happens to the ~57.3M orgless legacy rows.**
`transactions` holds 57,330,917 rows with `organizationId IS NULL` — prototype
and seed data, last written 2026-06-06 — sitting in the same table as live
tenant data. They are invisible to every org-scoped query, so they are harmless
today. But they inflate table size, skew any unscoped aggregate, and would be
awkward to explain in a client's security review. Three honest options: archive
to a separate table, backfill a synthetic "legacy" organization, or knowingly
leave them with the decision recorded. Any is fine; drifting into launch without
deciding is not.

> **Same family, measured 2026-08-08 — 44 misfiled `distributors` rows.** 30 sit on
> the financial-services demo tenant (org 1, created 2026-04-12) and 14 under
> `organizationId` 0, which is no tenant at all (demo-marked, created 2026-05-18).
> Since PR #64 the registry is corporate-B2B-only, so **none of them is reachable
> through the UI** and none leaks: org 0 is not a tenant, and a bank can no longer
> open the registry.
>
> **Recommendation: fold these into the decision above rather than relocating
> them.** Moving them to BrightGoods was considered and rejected on the evidence:
> every transaction naming them (29,892 rows) is itself `organizationId IS NULL`,
> i.e. part of the same legacy pool. Relocating would hand the corporate-B2B demo a
> 44-name registry whose transactions are invisible to it — a demo that looks
> populated and reconciles nothing, which is worse than an empty one. Whatever is
> decided for the 57.3M rows should cover these 44.

**3. Close the `matches` / `exceptions` tenancy gap.**
Both tables lack an `organizationId` column, so their writes cannot be scoped
directly and are reached only through a parent job/transaction. They are the two
entries allow-listed for that reason in `server/tenancyRatchet.test.ts`, and the
last structural gap of the class that produced four separate cross-tenant
defects in one session (PRs #25, #31, #32, #34). Remediation — add the column,
backfill from the parent, then scope the writes and remove the allow-list
entries — is tracked in `docs/security/RLS_AUDIT.md`.

### 19.4 Finish Tier A email inbound — code-complete, NOT receiving (deferred on cost)

**Owner decision, 2026-08-04: deferred until funds allow.** Recorded, not
disputed — the blocker is a $20/month plan, not an engineering problem.

**The blocker.** Resend's free plan allows exactly **one** domain, and that slot
is taken by the root `reconcileaiafrica.com` (outbound: magic links, alerts, CFO
reports). Receiving on `inbound.reconcileaiafrica.com` requires registering the
subdomain as a **separate** domain entry, which needs **Resend Pro ($20/mo)**.

**Already true (verified independently, 2026-08-03 — do not re-verify from scratch):**
- MX `inbound.reconcileaiafrica.com → inbound-smtp.eu-west-1.amazonaws.com` (pri 10)
  is live and propagated in GoDaddy. The root domain's Mailgun MX is untouched.
- `RESEND_WEBHOOK_SECRET` and `EMAIL_INBOUND_DOMAIN` are set on Railway.
- PR #37 is deployed; `POST /api/webhooks/email/inbound` answers **401** to an
  unsigned request — the route is live and failing closed.
- Migration 0077 applied; `email_ingestion_sources` and `email_ingestion_logs`
  exist and are **empty**. No delivery has ever arrived, accepted or rejected.

**To finish (~10 minutes once the plan is upgraded):**
1. Upgrade Resend to Pro → https://resend.com/settings/usage
2. Add `inbound.reconcileaiafrica.com` as a **new domain** in Resend
3. Enable **receiving** on that domain entry
4. Resend emits an MX record — the same `inbound-smtp.eu-west-1.amazonaws.com`
   value already in DNS, so no DNS change should be needed
5. Wait for status `verified`, then send one test email from Gmail to any
   `settle-…@inbound.reconcileaiafrica.com` and confirm a row lands in
   `email_ingestion_logs` (an unconfigured address logs `unknown_address` — that
   is a **pass**: it proves MX → Resend → webhook → signature → database)

> ⚠️ **Env vars being set is NOT proof, and the product says so itself.**
> `emailIngestion.inboundStatus` reports readiness from EVIDENCE, not
> configuration: `unconfigured` → `unproven` → `receiving`, where `unproven`
> means "configured, but nothing has ever arrived". Because
> `EMAIL_INBOUND_DOMAIN` and `RESEND_WEBHOOK_SECRET` are already set while the
> subdomain was never registered for receiving, **production will sit on
> `unproven`**, and the Email Forwarding screen carries a banner saying exactly
> that until step 5 above succeeds. Read the banner as the live status of this
> item. The only thing that flips it is a row in `email_ingestion_logs`.

### Why these three and not a longer list

Everything else found in the 2026-08-02/03 hardening sweep is fixed, deployed
and covered by tests or a CI ratchet. These are the only items knowingly carried
forward, and each was deferred on the explicit basis that no real customer data
existed yet. That premise expires at first customer. §19.4 is a different class —
a finished feature waiting on a $20/month spend — and is listed here because it
shares the same trigger and the same failure mode if it is forgotten: a channel
that looks configured and ingests nothing.

---

*Last updated: 2026-08-04 | Live in production on Railway at https://www.reconcileaiafrica.com/*
*SHOPLINE Tier 1 (Phase 1) merged & live. Engineering owned by Claude Code; features contributed by Manus via PR.*
*Owner: Richard Anwanakak, Infinity AI Africa Limited*
