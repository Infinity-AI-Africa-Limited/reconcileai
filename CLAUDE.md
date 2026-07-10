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

## 2A. SHOPLINE × ReconcileAI — Retail Commerce Partnership (GTM Roadmap)

A GTM partnership that adds a **`retail_commerce`** vertical to the platform for
SHOPLINE (e-commerce platform) merchants. Source roadmap:
`Documents\Infinity AI\Reconcile AI\GTM\Partnerships\Shopline\ReconcileAI_×_SHOPLINE_Detailed_Implementation_Roadmap.docx`
(codebase baseline commit `8e87109`; FY1 = Jul 2026–Jun 2027).

### Three-tier partnership model
| Tier | What | `organizations.onboardingChannel` |
|---|---|---|
| **Tier 1** | SHOPLINE App Store — self-serve merchants install via OAuth; Stripe subscription billing; 15% SHOPLINE rev share | `shopline_app_store` |
| **Tier 2** | SHOPLINE Payments — white-label reconciliation embedded, as a single API-client tenant | `shopline_payments_api` |
| **Tier 3** | Enterprise bundle — on-premise deployment for enterprise merchants | `shopline_enterprise` |

Constants live in `shared/shoplineConstants.ts` (tiers, channels, subscription
bands, required OAuth scopes, rev share).

### THE SEQUENCING RULE (non-negotiable)
Three phases mirror the commercial dependency chain: **Phase 0** (pre-commercial,
no API docs needed) → **Phase 1** (post-API-docs, pre-pilot) → **Phase 2**
(post-signed-agreement, production build).
**Do NOT begin Phase 2 until a signed commercial agreement exists. Do NOT begin
Phase 1 until SHOPLINE delivers API documentation.** Phase 0 is the only
low-risk internal work that can proceed unconditionally.

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

### Phase 1 — needs SHOPLINE API docs (do NOT start until received)
SHOPLINE App Store OAuth connector (Tier 1), settlement batch ingestion endpoint
(Tier 2), merchant self-serve onboarding UI, simplified retail-facing dashboard,
App Store listing assets. Also: inject `retailExceptionsTaxonomyPromptBlock` into
the Super Agent by segment.

### Phase 2 — post-signed-agreement ONLY
Tier 2 white-label API response format, on-premise Docker container packaging
(Tier 3), Tier 1 Stripe subscription billing integration.

> **CBN reports do NOT apply to SHOPLINE** — retail merchants are governed by
> card-scheme/gateway terms, not CBN. The CBN report engine stays scoped to the
> financial-services vertical.

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

## 9B. SHOPLINE Retail Commerce Vertical (Phase 0 Complete)

### Strategic Context

ReconcileAI is extending into **retail/e-commerce reconciliation** through a partnership with **SHOPLINE** (Asia-Pacific’s largest e-commerce SaaS platform, 600K+ merchants, $30B+ GMV). The commercial model is a three-tier partnership:

| Tier | Model | Description |
|---|---|---|
| **Tier 1** | App Store Integration | ReconcileAI listed on SHOPLINE App Store; merchants self-serve subscribe |
| **Tier 2** | SHOPLINE Payments Embedded | White-label reconciliation embedded in SHOPLINE Payments dashboard |
| **Tier 3** | Enterprise Bundle | On-premise/private-cloud deployment for regulated or high-volume merchants |

### Architecture Decision: One Codebase, Three Configurations

The SHOPLINE vertical is **not a fork**. It is a new tenant segment (`retail_commerce`) on the existing multi-tenant platform. The core 3-pass matching engine, exception intelligence layer, AI Super Agent, and multi-tenant infrastructure are shared. What differs is:
- The **exception taxonomy** (retail-specific: chargebacks, gateway fees, FX, settlements)
- The **data connector** (SHOPLINE API instead of CBS API — Phase 1, pending API docs)
- The **UI configuration** (merchant self-serve dashboard instead of bank operations portal)

### What Was Built (Phase 0 — July 2026)

Phase 0 lays the foundation that all three tiers build upon. No external dependencies (SHOPLINE API docs not required).

**Schema changes:**
- `organizations.segment` enum: added `retail_commerce`
- `channels.channelType` enum: added `shopline_payments`, `shopline_orders`, `stripe_connect`, `adyen_platform`, `paypal_commerce`
- `RESOLUTION_TEMPLATE_CATEGORIES`: added 14 retail exception category keys

**New files:**

| File | Purpose |
|---|---|
| `shared/shoplineConstants.ts` | Onboarding channel codes (Tier 1/2/3), tier metadata, subscription pricing bands, OAuth scopes, revenue share percentage |
| `server/exceptions/retail-commerce.ts` | 14-category retail exception taxonomy with severity, SLA, regulatory context, resolution templates, and AI diagnosis hints |
| `server/retailReconciliationEngine.ts` | Retail reconciliation engine adapter — wraps core `runMatchingEngine` + retail-specific exception classifier |
| `server/retailReconciliationEngine.test.ts` | 14 unit tests covering all retail exception categories + integration test |

**Super Admin portal:**
- `PortalContext.tsx`: `OrgSegment` type includes `retail_commerce` with amber accent
- `SuperAdminDashboard.tsx`: Retail Commerce in segment filter, create-org dialog, stats cards, and segment update
- `server/routers.ts`: `z.enum` validators for `createOrganization` and `updateOrganizationSegment` include `retail_commerce`

### Retail Exception Taxonomy (14 Categories)

The taxonomy in `server/exceptions/retail-commerce.ts` covers:

| Category Key | Severity | SLA | Description |
|---|---|---|---|
| `retail_chargeback_not_posted` | critical | 24h | Chargeback not reflected in merchant ledger |
| `retail_chargeback_duplicate` | high | 48h | Same ARN charged twice |
| `retail_gateway_fee_variance` | high | 48h | Fee deviates from contracted rate schedule |
| `retail_fx_rate_mismatch` | high | 48h | Auth-to-settlement FX rate exceeds tolerance |
| `retail_settlement_shortfall` | critical | 24h | Payout amount less than expected |
| `retail_settlement_delay` | medium | 72h | Settlement beyond SLA (T+n) |
| `retail_refund_not_settled` | high | 48h | Refund issued but not deducted from settlement |
| `retail_void_not_reversed` | medium | 72h | Voided transaction still in settlement |
| `retail_duplicate_authorisation` | critical | 24h | Customer double-charged |
| `retail_partial_capture_mismatch` | medium | 72h | Captured ≠ settled amount |
| `retail_currency_conversion_error` | high | 48h | DCC/MCC conversion applied incorrectly |
| `retail_payout_discrepancy` | high | 48h | Marketplace payout does not match order sum |
| `retail_reserve_hold_unexplained` | medium | 72h | Reserve deduction not matching contract |
| `retail_interchange_overcharge` | medium | 72h | Interchange fee exceeds scheme cap |

Each category includes `regulatoryContext` (PCI DSS, card scheme rules, consumer protection law), `recommendedResolution` (step-by-step), and `aiDiagnosisHint` (prompt guidance for the AI Super Agent).

### Retail Reconciliation Engine Adapter

`server/retailReconciliationEngine.ts` does **not** duplicate the core matching engine. It:
1. Delegates to `runMatchingEngine()` for the 3-pass match (exact → tolerance → fuzzy)
2. Post-processes unmatched transactions through `classifyRetailException()` which examines `rawData` metadata injected by the SHOPLINE connector
3. Returns `RetailReconciliationResult` (extends `ReconciliationResult` with `retailExceptions[]` and `retailStats`)

The `rawData` contract expected from the Phase 1 SHOPLINE connector:
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

### Phase 1 Gate (Blocked on External Dependency)

Phase 1 requires the **SHOPLINE API documentation** to build:
- OAuth2 App Store connector (install flow, token lifecycle)
- Transaction/settlement webhook ingestion
- Merchant self-serve dashboard UI
- App Store billing integration (usage metering)

**Do not begin Phase 1 until the API documentation is received AND a signed Pilot agreement is in place.** The Pilot pricing is $3,500/month for 90 days, credited against the annual contract.

### SHOPLINE Constants Reference

`shared/shoplineConstants.ts` defines the commercial and technical contract:
- **Revenue share:** 15% to SHOPLINE (Tier 1 App Store)
- **Tier 1 pricing bands:** Starter ($49/mo, ≤500 txns), Growth ($99/mo), Professional ($199/mo), Scale ($349/mo), Enterprise (custom)
- **OAuth scopes required:** `read_orders`, `read_payments`, `read_settlements`, `read_shop`, `read_analytics`
- **Onboarding channels:** `shopline_appstore` (Tier 1), `shopline_payments_api` (Tier 2), `shopline_enterprise` (Tier 3)

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
