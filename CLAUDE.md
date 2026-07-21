# ReconcileAI — Claude Code Persistent Context

> **This file is read automatically by Claude Code at the start of every session.**
> It contains the complete project context, architectural decisions, production build priorities,
> and engineering constraints for ReconcileAI. Read it fully before writing any code.

---

## 1. What This Project Is

**ReconcileAI** is an AI-powered financial reconciliation platform for African banks and microfinance banks (MFBs). It automates the matching of transactions across payment channels, classifies exceptions by severity, and resolves them using an AI Super Agent that learns from historical patterns.

**Owner:** Richard Anwanakak — Founder & CEO, Infinity AI Africa Limited.

**Live prototype:** https://reconcileai.vip

**GitHub repositories:**
- Primary: `Infinity-AI-Africa-Limited/reconcileai`
- Mirror: `MistaRichMan/reconcileai`

**Current stage:** Working prototype built in Manus. Being transferred to Claude Code for production engineering.

**Target deployment:** https://reconcileai.vip (custom domain, already configured)

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

**Do not scope work for Lapo MFB** until the data format and integration requirements are confirmed. Lapo is a future track; Woodcore is the immediate priority.

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
- `server/routers.ts` — `woodcore.*` tRPC procedures (lines ~3926–4316)

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

### Phase Status (as of 2026-07-19)

| Phase | Status | Notes |
|---|---|---|
| **Phase 0** | DONE + CTO-hardened | Retail-vertical foundation (commit `c5976b4`) |
| **Phase 1** | BUILT — 4 PRs open for review | Full Tier 1 App Store connector, billing, compliance |
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

### Phase 1 — BUILT (4 PRs open for Claude Code review)

The SHOPLINE API documentation was obtained (2026-07-18) from the public developer
docs at https://developer.shopline.com. The Partner Portal was configured by the
project owner (2026-07-19). Phase 1 is now **fully implemented** across 4 incremental
PRs. See **§2B** below for the complete implementation context.

### Phase 2 — post-signed-agreement ONLY
Tier 2 white-label API response format, on-premise Docker container packaging
(Tier 3). **No Stripe billing** — Tier 1 billing is SHOPLINE App Store managed.

> **CBN reports do NOT apply to SHOPLINE** — retail merchants are governed by
> card-scheme/gateway terms, not CBN. The CBN report engine stays scoped to the
> financial-services vertical.

---

## 2B. SHOPLINE Phase 1 Implementation — Full Context for PR Review

This section provides the complete context Claude Code needs to review the 4 SHOPLINE
Tier 1 PRs. It covers: what was verified from public documentation, what was configured
in the Partner Portal, the architectural decisions made, and how each module works.

### Pull Requests (review in order — each builds on the previous)

| PR | Branch | Base | URL | Scope |
|---|---|---|---|---|
| **PR #8** | `manus/shopline-phase1-connector` | `main` | https://github.com/MistaRichMan/reconcileai/pull/8 | OAuth, token management, webhook ingestion, settlement sync |
| **PR #9** | `manus/shopline-tier1-onboarding` | `manus/shopline-phase1-connector` | https://github.com/MistaRichMan/reconcileai/pull/9 | Merchant onboarding, ingest normalisation, sync orchestrator, GDPR, ShoplineConnect UI |
| **PR #10** | `manus/shopline-tier1-dashboard-sync` | `manus/shopline-tier1-onboarding` | https://github.com/MistaRichMan/reconcileai/pull/10 | Retail merchant dashboard, settlement monitor, scheduled sync handlers |
| **PR #11** | `manus/shopline-tier1-billing-compliance` | `manus/shopline-tier1-dashboard-sync` | https://github.com/MistaRichMan/reconcileai/pull/11 | Billing webhook handler, subscription management, compliance pages |

**Test status (final branch):** 761/761 tests passing, 0 TypeScript errors.

### 2B.1 SHOPLINE Partner Portal Configuration (Confirmed 2026-07-19)

The following was configured by the project owner (Richard) in the SHOPLINE Partner
Portal at https://developer.myshopline.com. This is login-gated and cannot be verified
from public docs — treat these as **confirmed ground truth** for review purposes.

| Setting | Value |
|---|---|
| App Type | Public App (App Store distribution) |
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

**Pricing Plans (5 bands, 7-day free trial):**

| Plan | spuKey | Monthly Price (USD) | Max Orders | Max Stores |
|---|---|---|---|---|
| Starter | `starter` | $29 | 500 | 1 |
| Growth | `growth` | $79 | 2,000 | 3 |
| Professional | `professional` | $149 | 10,000 | 10 |
| Scale | `enterprise` | $299 | 50,000 | 50 |
| Enterprise | `enterprise_plus` | $499 | Unlimited | Unlimited |

> **Note on spuKeys:** The portal plan names (Starter, Growth, Professional, Scale,
> Enterprise) differ from the spuKeys (`starter`, `growth`, `professional`, `enterprise`,
> `enterprise_plus`). The spuKeys are what arrive in billing webhook payloads.

**Registered Webhooks (9 topics, latest API version):**
- `orders/create`, `orders/updated`, `orders/edited`, `orders/paid`, `orders/cancelled`,
  `orders/delete`, `refunds/create`, `refunds/update`, `order_transactions/create`

**Billing Webhooks (5 topics, registered in portal):**
- `app_plan/activated`, `app_plan/expired`, `billing_attempts/succeed`,
  `billing_attempts/fail`, `app/installation_status_changed`

**GDPR Mandatory Topics (configured in Developer Center):**
- `customers/redact`, `merchants/redact`

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

The `billingWebhook.ts` handler processes these 5 topics:
- `app_plan/activated` → creates/updates subscription record (trial or active)
- `app_plan/expired` → marks subscription as expired
- `billing_attempts/succeed` → confirms active status, resets failure counter
- `billing_attempts/fail` → increments failure counter, marks `past_due` after 3 failures
- `app/installation_status_changed` → handles uninstall (cancels subscription + marks store)

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

### 2B.7 Scheduled Sync Handlers (registered in `server/_core/index.ts`)

| Handler | Interval | Purpose |
|---|---|---|
| 15-minute polling | Every 15 min | Fetch new orders/payments since last watermark |
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

Set these only in the hosting platform's secret store (Railway env / `.env`,
which is gitignored). The code reads them from `ENV.shoplineAppKey` /
`ENV.shoplineAppSecret`.

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

### 2B.11 What the App Store Review Will Check

Before submitting for App Store review, these must be verified:
- GDPR endpoints respond 200 and process within 30 days
- Webhook receiver acks < 5 seconds (queue-first design)
- Read-only scopes only (no write operations on merchant stores)
- Privacy policy + Terms of Service pages accessible at public URLs
- Full OAuth flow works end-to-end on a SHOPLINE developer store
- App listing assets: logo 120×120, 3 feature bullets, EN default language

### 2B.12 Remaining Steps After PR Merge

1. Run `pnpm db:push` to apply the `sl_connector_subscriptions` table migration
2. Deploy to `https://www.reconcileaiafrica.com`
3. Test full OAuth flow on a SHOPLINE developer store
4. Owner clicks "Submit for Review" in the SHOPLINE Partner Portal
5. Address any App Store review feedback

---

## 3. Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | 22.13.0 |
| Frontend | React | 19 |
| Styling | Tailwind CSS | 4 |
| UI Components | shadcn/ui + Radix UI | latest |
| API Layer | tRPC | 11 |
| Backend | Express | 4 |
| ORM | Drizzle ORM | latest |
| Database | MySQL / TiDB | (managed) |
| Auth (prototype) | Manus OAuth | replace in production |
| File Storage | AWS S3 / Cloudflare R2 | via `server/storage.ts` |
| LLM | Manus Forge (dev) / Anthropic Claude (production) | see Section 4 |
| Build | Vite | latest |
| Testing | Vitest | latest |
| Language | TypeScript | strict mode |

**Key file locations:**
```
drizzle/schema.ts          ← All 50+ database tables
server/routers.ts          ← All tRPC procedures (~5,500 lines)
server/db.ts               ← Query helpers
server/_core/llm.ts        ← LLM provider (dual-mode)
server/_core/env.ts        ← All environment variables
client/src/App.tsx         ← Routes and layout
client/src/components/DashboardLayout.tsx  ← Sidebar + portal switcher
client/src/pages/          ← All 40+ frontend pages
```

---

## 4. LLM Integration — Production Configuration

### Current State (Prototype / Manus)
The prototype uses **Manus Forge** (`BUILT_IN_FORGE_API_KEY`), which routes to `gemini-2.5-flash`. This key is injected automatically by the Manus platform and will **not be available** outside Manus.

### Production Configuration (Claude Code / Rocket.new)
Set these environment variables to switch to Anthropic Claude:

```bash
# Primary: Anthropic Claude API key
DIRECT_LLM_API_KEY=sk-ant-api03-...

# Anthropic API base URL (the native /v1/messages path is appended automatically)
DIRECT_LLM_API_URL=https://api.anthropic.com

# Model selection — see below
DIRECT_LLM_MODEL=claude-sonnet-4-5

# Optional explicit selector ("anthropic" | "openai"); auto-detected when omitted
DIRECT_LLM_PROVIDER=anthropic
```

> `server/_core/llm.ts` includes a **native Anthropic Messages-API adapter** — no
> OpenAI-compat shim or LiteLLM proxy is required for Claude. `DIRECT_LLM_API_URL` is a
> **base URL**; the helper appends `/v1/messages` (Anthropic) or `/v1/chat/completions`
> (OpenAI) for you, and also tolerates a trailing `/v1` or a full path.

### Model Selection by Use Case

| Use Case | Recommended Model | Reason |
|---|---|---|
| Exception classification | `claude-sonnet-4-5` | Best instruction-following for structured financial reasoning |
| Anomaly detection narrative | `claude-sonnet-4-5` | Fast, accurate, cost-efficient |
| AI Super Agent (agentic tasks) | `claude-opus-4` | Best multi-step reasoning, tool use, and extended thinking |
| Report generation | `claude-sonnet-4-5` | Sufficient for structured output |
| Compliance assessment | `claude-sonnet-4-5` | Accurate for regulatory text interpretation |

**Why Claude over OpenAI:** All primary LLM use cases in ReconcileAI are reasoning-heavy, context-long, instruction-following tasks. Claude 3.5 Sonnet and Claude Opus 4 outperform GPT-4o on these benchmarks. Claude also supports 200K token context windows, which is critical when feeding large reconciliation batches or full audit trails to the model.

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
DIRECT_LLM_MODEL=anthropic/claude-sonnet-4-5
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
| **Phase 1** | Email / Magic Link | Lapo MFB pilot, all early users | ✅ Implemented |
| **Phase 2 — Q1** | Google OAuth2 | Fintechs, startups on Google Workspace | Pending |
| **Phase 3 — Q2** | Microsoft Entra ID (Azure AD) OAuth2 | Commercial banks, tier-2/tier-1 institutions | Pending |

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

All procedures are in `server/routers.ts`. The router is structured as:

```
appRouter
├── auth.*              — login, logout, me, magic link (prototype: Manus OAuth)
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
├── compliance.*        — CBN reports, NDPA/NDPR, assessments, deadlines
├── publicApi.*         — external REST-style API (API key auth)
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

**Phase 1:** BUILT — 4 PRs open for Claude Code review. Full Tier 1 App Store connector
including OAuth, webhooks, billing, onboarding, sync, dashboard, and compliance pages.
See **§2B** for the complete implementation context, Partner Portal configuration,
and PR URLs.

### SHOPLINE Constants Reference (UPDATED — portal-confirmed values)

`shared/shoplineConstants.ts` defines the commercial and technical contract:
- **Revenue share:** 15% to SHOPLINE (Tier 1 App Store)
- **Free trial:** 7 days (confirmed in Partner Portal)
- **Tier 1 pricing bands:** Starter ($29/mo, ≤500 orders), Growth ($79/mo, ≤2K), Professional ($149/mo, ≤10K), Scale ($299/mo, ≤50K), Enterprise ($499/mo, unlimited)
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

## 10. Known Technical Debt — Address in Production Build

These are the most critical items to resolve before the Woodcore pilot goes live:

| Item | Risk | Recommended Fix |
|---|---|---|
| Manus OAuth must be replaced | **Critical** — blocks all external users | Implement email/magic link (Phase 1) |
| `server/routers.ts` is ~5,500 lines | High — maintainability | Split into `server/routers/` directory by domain |
| No background job queue | Medium — reconciliation jobs run in-process | Add BullMQ + Redis for async job processing |
| No test coverage on reconciliation engine | High — correctness risk | Write Vitest unit tests for `woodcore-engine.ts` Layer 1 and Layer 2 |
| Manus Forge LLM key will not work outside Manus | **Critical** | Set `DIRECT_LLM_API_KEY` (Anthropic) before first external deployment |
| Direct MySQL access to Woodcore DB (dynamic IPs) | Medium | Migrate to Fineract REST API for production |
| No rate limiting on public API endpoints | Medium | Add express-rate-limit to `publicApi.*` procedures |
| S3 file keys are not access-controlled | Low | Add owner-based ACL check in `storageGet()` |

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
DIRECT_LLM_MODEL=claude-sonnet-4-5
DIRECT_LLM_PROVIDER=anthropic                   # optional; auto-detected when omitted

# Auth (replace Manus OAuth) — email/magic-link is implemented
JWT_SECRET=<generate 64-char random string>
APP_URL=https://reconcileai.vip                 # used to build magic-link URLs

# File Storage (Cloudflare R2 recommended)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=auto
AWS_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
AWS_BUCKET_NAME=reconcileai-storage

# Email (magic-link sign-in, invites, CFO reports, alerts, owner notices)
# Without these, ALL email is a safe no-op (logged, never throws).
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@reconcileai.vip
EMAIL_FROM_NAME=ReconcileAI
OWNER_EMAIL=ops@reconcileai.vip                 # owner/system notifications; falls back to EMAIL_FROM

# Manus-specific (DO NOT set in production — these are Manus-injected)
# BUILT_IN_FORGE_API_KEY  ← Manus only
# BUILT_IN_FORGE_API_URL  ← Manus only
# VITE_FRONTEND_FORGE_API_KEY  ← Manus only
# OAUTH_SERVER_URL  ← Manus only
# VITE_OAUTH_PORTAL_URL  ← Manus only
```

---

## 12. Deployment — reconcileai.vip

The production domain is `reconcileai.vip`. DNS is managed via Cloudflare. The platform is a standard Node.js application and can be deployed to any Node.js-compatible host (Railway, Render, Fly.io, DigitalOcean App Platform, AWS App Runner, Google Cloud Run, or a self-managed VPS).

### Application Build

```bash
# Install dependencies
pnpm install

# Build frontend and backend
pnpm build

# Start production server
pnpm start
# or: node dist/server/index.js
```

**Build output:**
- Frontend: `dist/client/` (static assets served by Express)
- Backend: `dist/server/` (compiled Express + tRPC server)

**Port:** The server reads `PORT` from the environment (defaults to 3000). Never hardcode the port — hosting platforms inject it at runtime.

### Environment Variables
Set all variables from Section 11 in your hosting platform's environment/secrets panel before deploying. The most critical ones that will cause startup failures if missing:
- `DATABASE_URL` — main ReconcileAI database
- `JWT_SECRET` — session signing (generate a 64-character random string)
- `DIRECT_LLM_API_KEY` — Anthropic API key (without this, LLM features fail silently)

### DNS Configuration for reconcileai.vip

DNS is managed in Cloudflare. Once your hosting provider gives you a deployment URL or IP:

**Option A — CNAME (for platforms that provide a hostname, e.g. Railway, Render, Fly.io):**
```
Type: CNAME
Name: @  (or reconcileai.vip)
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

**www redirect (already configured):**
```
Type: CNAME
Name: www
Target: reconcileai.vip
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
pm2 start dist/server/index.js --name reconcileai
pm2 save
pm2 startup  # auto-start on reboot

# 5. Nginx reverse proxy config
# /etc/nginx/sites-available/reconcileai.vip
server {
    listen 80;
    server_name reconcileai.vip www.reconcileai.vip;
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
sudo certbot --nginx -d reconcileai.vip -d www.reconcileai.vip
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
The current prototype runs reconciliation jobs in-process (synchronous). For production, add **BullMQ + Redis** before going live with high transaction volumes. This is listed as a known technical debt item.

---

## 13. What Was Deliberately Left Out of the Prototype

These features are in the PRD but were not built in the prototype. They are first-sprint priorities for the production build:

1. **Real authentication** — email/magic link, Google OAuth2, Microsoft Entra ID
2. **Fineract REST API connector** — replace direct DB access with the official API
3. **Background job queue** — BullMQ + Redis for async reconciliation processing
4. **Email delivery** — Resend integration for magic links, alerts, and CFO reports
5. **Stripe billing** — subscription management and usage-based billing
6. **Full test suite** — Vitest unit tests for the reconciliation engine and tRPC procedures
7. **CI/CD pipeline** — GitHub Actions for lint, test, build on every PR
8. **Lapo MFB connector** — data format and scope TBD pending Lapo engagement

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

| Remote | Repository | Notes |
|---|---|---|
| Primary | `MistaRichMan/reconcileai` | Claude reads and merges PRs here |
| Mirror | `Infinity-AI-Africa-Limited/reconcileai` | Manus also pushes branches here |

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

---

## 16. Do Not Change These

The following are stable foundations that should not be modified without explicit instruction:

- `drizzle/schema.ts` — table structure (add columns/tables, do not rename or drop)
- `server/_core/` — framework plumbing (context, auth, LLM helper, env)
- `client/src/lib/trpc.ts` — tRPC client binding
- `client/src/contexts/AuthContext.tsx` — auth state management (update, do not replace)
- `drizzle/woodcore_schema.ts` — Fineract table mirrors (read-only, do not modify)
- The four-portal architecture (`organizations.segment` enum and portal context switcher)

---

*Last updated: July 2026 | Built in Manus | Transferring to Claude Code for production engineering*
*Owner: Richard Anwanakak, Infinity AI Africa Limited*
