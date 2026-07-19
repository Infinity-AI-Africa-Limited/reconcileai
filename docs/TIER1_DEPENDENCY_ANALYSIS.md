# SHOPLINE Tier 1 — Dependency Analysis & Blocker Report

## What's Already Built (Phase 1 Connector — PR #8)

| Module | Status | Notes |
|---|---|---|
| `signature.ts` | ✅ Complete | 3 HMAC modes per spec §A3 |
| `auth.ts` | ✅ Complete | OAuth flow, token create/refresh |
| `apiClient.ts` | ✅ Complete | All payment endpoints, pagination |
| `webhookHandler.ts` | ✅ Complete | 9 verified topics + 2 GDPR |
| `settlementSync.ts` | ✅ Complete | Three-leg join normalisation |
| `tokenStore.ts` | ✅ Complete | AES-256-GCM encrypted storage |
| `shoplineConnector.ts` router | ✅ Complete | Basic tRPC operations |
| DB schema (3 tables) | ✅ Complete | sl_connector_stores, tokens, webhook_events |
| Tests (705 passing) | ✅ Complete | All signature modes, topics, GDPR |

## What Still Needs Building

### 1. Merchant Self-Serve Onboarding
- `onboarding.ts` — auto-provision org + admin + channels on install
- Express routes: `/api/shopline/install`, `/api/shopline/callback`, `/api/webhooks/shopline`
- ShoplineConnect.tsx — install landing page
- First-run UX ("connected — first sync running")
- SHOPLINE-derived identity (no separate password)

### 2. Subscription & Billing (Stripe)
- Stripe integration (webdev_add_feature stripe)
- 5 pricing bands: Starter $49, Growth $99, Professional $199, Scale $349, Enterprise custom
- Annual billing default (2 months free = ~17% discount)
- 14-day free trial, no CC required
- Auto-tier assignment based on 30-day volume
- Revenue share tracking (15% to SHOPLINE)
- `subscriptions` table in schema

### 3. Retail Merchant Dashboard
- Retail-commerce navigation set in DashboardLayout
- Dashboard, Reconciliation, Exceptions, Settlement Monitor, Reports, Settings pages
- Segment-based routing (retail_commerce orgs see retail nav)

### 4. Scheduled Sync Jobs
- `subscriptions.ts` — desired-state webhook subscriber
- 15-minute polling fallback with watermark
- Daily 02:00 UTC batch sync
- 90-day historical pull on first install
- Heartbeat SDK integration

### 5. GDPR & Compliance
- Express GDPR routes (customers/redact, merchants/redact)
- Data retention policy (archive on uninstall, purge after 30 days)
- Privacy policy page (/privacy)
- Terms of service page (/terms)
- App Store listing assets

### 6. Integration Wiring
- `ingest.ts` — normalise to canonical transaction rows
- Wire into retailReconciliationEngine
- Three-leg join matching keys
- Dispute lifecycle → 25 retail exception categories
- Super Agent prompt injection for retail segment
- Settlement batch overdue watchdog

## External Dependencies (Blocked on Richard)

| Dependency | Action Required | Blocker Level |
|---|---|---|
| SHOPLINE Partner Portal account | Register at https://developer.myshopline.com, create Public App | **HARD BLOCKER** for live testing |
| App key + App secret | Issued by Partner Portal on app creation | **HARD BLOCKER** for live OAuth |
| Developer store | Created in Partner Portal for E2E testing | **HARD BLOCKER** for integration testing |
| GDPR webhook URLs | Configured in Developer Center (not via API) | Required before App Store review |
| App Store billing model | Confirm if platform-managed or ReconcileAI-side | Determines Stripe vs SHOPLINE billing |
| DPA with SHOPLINE | Legal agreement for data processing | Required before App Store review |
| Revenue share agreement | 15% target, negotiate with SHOPLINE | Required before go-live |
| App Store slot application | Submit when code is complete | Final step |

## Technical Dependencies (Can Build Now)

| Dependency | Status | Notes |
|---|---|---|
| Stripe SDK | Not yet added | Use `webdev_add_feature stripe` |
| Heartbeat SDK | Available | For scheduled sync jobs |
| BullMQ / Redis | Not yet wired | For async webhook processing (Phase 2) |
| Privacy/Terms pages | Not built | Static content, can build now |
| Retail dashboard UI | Not built | Can build with mock data |

## Pricing Model (from Tier1PricingModel.docx)

| Band | Monthly Volume | Monthly Price | Annual Price | Gross Margin |
|---|---|---|---|---|
| Starter | ≤ 500 txns | $49/mo | $490/yr | ~63% |
| Growth | 501–2,000 txns | $99/mo | $990/yr | ~72% |
| Professional | 2,001–10,000 txns | $199/mo | $1,990/yr | ~79% |
| Scale | 10,001–50,000 txns | $349/mo | $3,490/yr | ~81% |
| Enterprise | 50,000+ txns | Custom | Custom | 85%+ |

- Annual billing = default (2 months free)
- SHOPLINE revenue share = 15% (negotiate 15-20%)
- 14-day free trial, no CC required
- Auto-tier based on 30-day rolling volume

## Revenue Projections

| Year | Active Merchants | Gross Revenue | SHOPLINE Share (15%) | Net Revenue |
|---|---|---|---|---|
| Year 1 | 100 | $101K | $15K | $86K |
| Year 2 | 1,000 | $1.01M | $151K | $859K |
| Year 3 | 5,000 | $5.04M | $756K | $4.28M |

## Build Order (Recommended)

1. **Onboarding + Express routes** (T1-A) — can test with mocked SHOPLINE requests
2. **Ingest + Engine wiring** (T1-F) — connects to existing reconciliation engine
3. **Retail Dashboard** (T1-C) — UI for merchants to see results
4. **Scheduled Sync** (T1-D) — polling fallback + webhook reconciler
5. **Billing/Stripe** (T1-B) — monetisation layer
6. **GDPR + Compliance** (T1-E) — App Store review requirements
7. **App Store listing** (T1-G) — final step, needs Partner Portal access

## SHOPLINE Partner Portal (https://developer.myshopline.com)

The Partner Portal is login-gated. Richard needs to:
1. Register as a SHOPLINE developer partner
2. Create a Public App (gets app key + secret)
3. Configure callback URLs
4. Create a developer store
5. Submit for App Store review (when ready)

The portal URL is: https://developer.myshopline.com/home/index
