# ReconcileAI — Context Handoff Document

**For:** Rocket.new Production Engineering Team  
**From:** Richard Anwanakak, Founder & CPO — Infinity AI Africa Limited  
**Date:** May 2026  
**Purpose:** Complete context transfer from Manus prototype to production build  
**Pilot Target:** Lapo Microfinance Bank (MFB), Nigeria  

> This document is the single most important reference for the Rocket.new team. It captures what was built, what was deliberately left out, known limitations, key decisions and their rationale, and the open questions that the production team must resolve before go-live.

---

## 1. What Was Built

### 1.1 Executive Summary

ReconcileAI is a multi-tenant, AI-powered financial reconciliation platform built for African financial institutions. The prototype was built on Manus (React 19 + Express 4 + tRPC 11 + TiDB + Manus Forge LLM gateway) and is live at `https://reconcileai.vip/`. It implements the full product vision across two reconciliation modules, a super admin control plane, and an AI-powered exception management layer.

### 1.2 What Is Fully Implemented

The following features are built, tested in the browser, and ready for production hardening:

**Core Reconciliation Engine**

The reconciliation engine runs a 5-pass matching algorithm: exact match (reference + amount + date), fuzzy reference match (normalised string similarity), amount tolerance match, date window match, and AI-suggested match for residual unmatched pairs. Both reconciliation modules are implemented:

- **Settlement Reconciliation** — validates bulk settlement amounts against detailed transaction reports. Supports multi-processor reconciliation (Interswitch, UPSL, eTranzact), settlement window scheduling (3–4x per day), lump sum vs. detailed report validation, merchant-level grouping, pre-settlement reconciliation, multi-source transaction ingestion, duplicate detection (unidirectional and bidirectional), amount denomination correction, timestamp normalisation, and false positive classification.
- **Account-Level Reconciliation** — reconciles GL balances against CBS transaction records. Supports multi-account batch processing, balance variance detection, and period-close reconciliation.

**Exception Management**

Exceptions are classified into 8 categories (amount mismatch, missing transaction, duplicate, timing difference, status mismatch, reference mismatch, reversal pending, system error) and 4 severity levels (low, medium, high, critical). Each exception receives an AI-generated analysis and suggested resolution. The exception workflow supports assignment to users, escalation, resolution with notes, bulk status updates, and export to Excel.

**Data Ingestion**

Three ingestion methods are implemented: CSV upload (client-side parsing with Papa Parse), SFTP pull (configurable credentials, scheduled or on-demand), and API ingestion (configurable endpoint, authentication, field mapping). A channel management system allows each organisation to configure multiple data sources with custom field mappings.

**Reporting**

Reports can be generated from any reconciliation job. Each report includes match rate, exception breakdown, channel performance, and trend charts. Reports can be exported to PDF (browser print API) and Excel (ExcelJS with frozen headers and auto-filter). Reports can be shared via a signed token (time-limited, read-only, no login required). A CFO report scheduler sends automated email reports on a configurable schedule with Excel attachment.

**User Management**

Five user roles are implemented: Super Admin, Admin, Operations, CFO, and Compliance/Audit. Role-based access control gates both backend procedures and frontend navigation. Audit/Compliance and CFO roles cannot perform reconciliation operations. User invitation by email is implemented.

**Audit Trail**

An immutable audit log records all user actions with entity type, entity ID, action, user, IP address, and timestamp. The audit trail is exportable to Excel. A platform-level audit log tracks cross-tenant super admin actions separately.

**Super Admin Control Plane**

The super admin portal (accessible only to Infinity AI staff) provides cross-tenant statistics, organisation management (create, view, manage), user management across all tenants, platform-level audit log, and per-institution module override controls. A portal context switcher allows the super admin to "enter" any tenant's portal and see the application exactly as that tenant's admin would see it.

**Module Configuration**

Two modules (Settlement Reconciliation and Account-Level Reconciliation) can be enabled or disabled per organisation. The super admin can override the module state for any institution with a reason, independent of the organisation's own admin toggle.

**Advanced Tools**

Sample data generation (for demos and testing), integration management (webhook configurations, outbound event triggers), API ingestion configuration, SFTP configuration, and anomaly detection (configurable rules, scored anomalies with AI narrative).

**Compliance**

NDPA/NDPR compliance settings, data deletion request management (Article 7), security incident log, and a public self-assessment tool. A CBN compliance module tracks report frameworks, submissions, findings, and action plans.

**AI Super Agent**

A natural language interface that allows users to query reconciliation data in plain English. The agent can propose actions (e.g., "resolve all low-severity exceptions from yesterday") which are held in a draft queue for human approval before execution. The agent has per-organisation semantic memory that learns from past interactions.

**Financial Services Portal**

A dedicated portal view for financial services tenants (banks, MFBs, fintechs) with a segment-specific sidebar that includes all core features plus Email Settings, Module Configuration, and the full Advanced Tools dropdown with a visual alert badge that highlights active anomalies or integration errors.

**Corporate B2B Portal**

A dedicated portal view for corporate B2B tenants (FMCG distributors, manufacturers) with a segment-specific sidebar that includes Distributor Registry, reconciliation, and B2B-specific reporting.

**Guest Demo Mode**

A guest access system allows prospective clients to explore the platform without creating an account. Guest sessions are time-limited and scoped to demo data.

**Woodcore Integration (Partial)**

The Woodcore core banking integration is implemented in the backend (`woodcore` router) and has a live POC page (`/woodcore-poc`). It is blocked by IP whitelisting on Woodcore's side. The integration fetches accounts and transactions from Woodcore's test tenant and displays them in real time.

### 1.3 Pages Implemented (50+)

| Page | Route | Status |
|---|---|---|
| Landing / Home | `/` | Complete |
| Login | `/login` | Complete |
| Dashboard | `/dashboard` | Complete |
| Reconciliation Jobs | `/reconciliation` | Complete |
| New Reconciliation Job | `/reconciliation/new` | Complete |
| Exceptions | `/exceptions` | Complete |
| Transactions | `/transactions` | Complete |
| Multi-Channel | `/multi-channel` | Complete |
| Review Queue | `/review` | Complete |
| Reports | `/reports` | Complete |
| Report Detail | `/reports/:id` | Complete |
| Shared Report | `/shared-report/:token` | Complete |
| CBN Reports | `/cbn-reports` | Complete |
| Audit Trail | `/audit` | Complete |
| Data Protection | `/data-protection` | Complete |
| Monitoring | `/monitoring` | Complete |
| User Management | `/users` | Complete |
| Schedules | `/schedules` | Complete |
| Upload Data | `/upload` | Complete |
| Module Configuration | `/modules` | Complete |
| Email Settings | `/email-settings` | Complete |
| Sample Data | `/sample-data` | Complete |
| Integrations | `/integrations` | Complete |
| API Ingestion | `/api-ingestion` | Complete |
| SFTP Config | `/sftp-config` | Complete |
| Anomaly Detection | `/anomalies` | Complete |
| Super Admin Dashboard | `/admin/super-admin` | Complete |
| Super Agent | `/super-agent` | Complete |
| Woodcore POC | `/woodcore-poc` | Partial (blocked by IP whitelist) |
| Guest Demo | `/demo` | Complete |
| Compliance Assessment | `/assessment` | Complete |
| Documentation | `/docs` | Complete |
| Profile | `/profile` | Complete |
| Distributor Registry | `/distributors` | Complete (B2B portal) |
| CFO Reports | `/cfo-reports` | Complete |

---

## 2. What Was Deliberately Left Out

The following features were scoped out of the prototype to maintain focus and velocity. They are required for the production build:

### 2.1 Authentication

**What was left out:** Production-grade authentication. The prototype uses Manus OAuth, which is a platform-specific SSO mechanism tied to the Manus environment. It cannot be used in production.

**What is needed:** Email/password authentication with magic link, MFA (TOTP), and session management with refresh token rotation. See `ARCHITECTURE.md` Section 6.2 for implementation options.

**Priority:** Critical — must be the first thing built in Rocket.new.

### 2.2 Real Email Delivery

**What was left out:** Actual email sending. The email preferences UI, CFO report scheduler, and user invitation flows are fully implemented in the frontend and backend, but the email delivery is mocked (logged to console, not sent).

**What is needed:** Integrate a transactional email provider. Recommended: Resend (developer-friendly, Nigerian IP-friendly) or SendGrid. Add `RESEND_API_KEY` (or `SENDGRID_API_KEY`) to environment variables and replace the mock `sendEmail()` helper in `server/routers.ts` with real API calls.

**Priority:** High — required for CFO report delivery and user invitations.

### 2.3 Real-Time Updates (WebSockets)

**What was left out:** True real-time job progress. The monitoring page polls the `job_progress_events` table every 3 seconds. This works for the prototype but is inefficient at scale.

**What is needed:** Replace polling with WebSockets (Socket.io or native WebSocket) or Server-Sent Events (SSE). The `job_progress_events` table already has the right structure; the change is in the transport layer only.

**Priority:** Medium — polling works for the pilot; upgrade before general availability.

### 2.4 Payment Processing

**What was left out:** Subscription billing. The platform has no payment integration. All tenants are currently on a "free" tier.

**What is needed:** Stripe integration for subscription management. Define pricing tiers (Starter, Professional, Enterprise) and gate features by tier. The Manus WebDev platform has a Stripe feature that can be enabled.

**Priority:** Medium — not required for the Lapo pilot (pilot is a commercial agreement, not self-serve).

### 2.5 Production-Grade Background Jobs

**What was left out:** A proper job queue. The reconciliation runner and schedule poller run in the same Node.js process as the web server. This is acceptable for the pilot but will cause issues at scale.

**What is needed:** Extract the reconciliation runner to a BullMQ worker with Redis as the queue backend. This enables horizontal scaling, job retries, dead letter queues, and job prioritisation.

**Priority:** Medium — acceptable for pilot; required before onboarding more than 3 concurrent tenants.

### 2.6 Lapo MFB Core Banking Connector

**What was left out:** A direct integration with Lapo's core banking system. The Woodcore connector is implemented but Lapo does not use Woodcore.

**What is needed:** Determine Lapo's core banking vendor and build a dedicated connector. Options: SFTP file export (lowest effort — use the existing SFTP ingestion module), REST API integration (if Lapo's CBS has an API), or a custom file format parser. The existing channel management and field mapping system is designed to accommodate new connectors without core changes.

**Priority:** Critical for the Lapo pilot.

### 2.7 Card Transaction Support

**What was left out:** Card-specific reconciliation logic. The system handles generic transactions but does not have specific logic for Mastercard, Visa, and Verve card transaction formats from Interswitch.

**What is needed:** Add a `card_transactions` channel type with Interswitch-specific field mappings (PAN, card scheme, authorisation code, terminal ID, merchant category code). The matching algorithm needs a card-specific pass that matches on authorisation code + amount + date.

**Priority:** High for Lapo pilot (card transactions are a primary channel).

### 2.8 Multi-Currency Support

**What was left out:** Currency handling. All amounts are treated as NGN. There is no currency field on the `transactions` table.

**What is needed:** Add `currency` (ISO 4217) and `exchangeRate` columns to `transactions`. Update the matching algorithm to normalise amounts to a base currency before comparison. Update all reporting to show currency breakdowns.

**Priority:** Low for Lapo pilot (NGN only); required for expansion to other markets.

---

## 3. Known Limitations of the Prototype

### 3.1 Performance

The reconciliation engine has been tested with up to 10,000 transactions per job in the prototype environment. Performance beyond this threshold has not been validated. The single-process architecture means that a large reconciliation job will block the event loop and slow down API responses for other users during processing.

### 3.2 Database

TiDB Cloud (the prototype database) is a distributed MySQL-compatible database. It is production-ready but the current Drizzle configuration does not set connection pool limits. Under concurrent load, this could exhaust the connection pool. Set `max: 10` in the Drizzle MySQL2 config before production.

### 3.3 File Upload Size

The current file upload implementation uses a base64 encoding approach in the tRPC mutation. This is inefficient for large files (>10MB). For production, implement a direct-to-S3 presigned URL upload flow to bypass the server for large files.

### 3.4 SFTP Credential Encryption

SFTP credentials are stored in the database but the encryption key is currently managed by the Manus platform. In production, set `SFTP_ENCRYPTION_KEY` as a dedicated environment variable and re-encrypt existing credentials.

### 3.5 AI Analysis Latency

The AI exception analysis (LLM call per exception) runs synchronously during the reconciliation job. For jobs with thousands of exceptions, this adds significant latency. In production, run AI analysis as a separate background pass after the matching phase completes.

### 3.6 Manus-Specific Dependencies

The following must be replaced or removed when moving to Rocket.new:

| Dependency | Location | Replacement |
|---|---|---|
| Manus OAuth | `server/_core/oauth.ts`, `client/src/const.ts` | Email/password auth or Clerk/Auth0 |
| Manus Forge LLM | `server/_core/llm.ts` (Mode 1) | Set `DIRECT_LLM_API_KEY` env var (no code change needed) |
| Manus notification API | `server/_core/notification.ts` | Replace with email/Slack webhook |
| Manus analytics | `client/src/main.tsx` (VITE_ANALYTICS_*) | Replace with PostHog or Plausible |
| Manus image generation | `server/_core/imageGeneration.ts` | Replace with OpenAI DALL-E or Stability AI |
| Manus voice transcription | `server/_core/voiceTranscription.ts` | Replace with OpenAI Whisper API directly |

---

## 4. Key Technical Decisions and Rationale

### 4.1 tRPC over REST

**Decision:** All client-server communication uses tRPC, not REST.

**Rationale:** End-to-end type safety eliminates an entire class of bugs (mismatched request/response types). The Zod validation on inputs means all data is validated before it reaches business logic. The developer experience is significantly better — no need to maintain separate API contracts, Swagger docs, or Axios client wrappers.

**Implication for Rocket.new:** Keep tRPC. Do not convert to REST. The router structure in `server/routers.ts` is the API contract.

### 4.2 Drizzle ORM over Prisma

**Decision:** Drizzle ORM was used instead of Prisma.

**Rationale:** Drizzle is lighter, has better TypeScript inference, and generates cleaner SQL. It is schema-first (define tables in TypeScript, generate migrations) which aligns with the project's type-safety philosophy.

**Implication for Rocket.new:** Keep Drizzle. The schema in `drizzle/schema.ts` is the single source of truth for the database structure.

### 4.3 Monorepo (Single Node.js Process)

**Decision:** Frontend (Vite) and backend (Express) run as a single Node.js process in development and production.

**Rationale:** Simplifies deployment (one process, one port), eliminates CORS configuration, and makes the development loop faster. The Vite dev server proxies API requests to Express in development.

**Implication for Rocket.new:** This is a standard pattern that Rocket.new should support natively. The entry point is `server/index.ts` (or equivalent). Do not split into separate frontend and backend deployments unless there is a specific scaling reason.

### 4.4 Three-Segment Multi-Tenancy

**Decision:** Organisations are segmented into `financial_services`, `corporate_b2b`, and `super_admin`. Each segment gets a different portal experience (different sidebar navigation, different feature set).

**Rationale:** Financial services clients (banks, MFBs) have fundamentally different workflows from corporate B2B clients (FMCG distributors). A single undifferentiated portal would create a confusing UX. The segment-aware portal architecture allows the same codebase to serve both markets with appropriate customisation.

**Implication for Rocket.new:** The `PortalContext` in `client/src/contexts/PortalContext.tsx` and the segment-aware nav in `client/src/components/DashboardLayout.tsx` are the key files. Preserve this architecture.

### 4.5 Module Override Architecture

**Decision:** Module enable/disable state is split into two tables: `module_configurations` (org-controlled) and `module_overrides` (Infinity AI super admin-controlled). The effective state is the override if present, otherwise the org's own config.

**Rationale:** This allows Infinity AI to turn off a module for a specific institution (e.g., for compliance reasons, pricing tier, or a pilot restriction) without overwriting the institution's own preference. When the override is cleared, the institution's own setting is restored automatically.

**Implication for Rocket.new:** This is a deliberate design. Do not merge the two tables.

### 4.6 AI Exception Analysis (Synchronous vs. Asynchronous)

**Decision:** In the prototype, AI analysis runs synchronously during the reconciliation job.

**Rationale:** Simplicity. The prototype environment has low concurrency and small data volumes. Synchronous execution is easier to reason about and debug.

**Implication for Rocket.new:** This must be made asynchronous for production. Run AI analysis as a separate background pass after matching completes. Store `aiAnalysis` as nullable and show a "Analysing..." state in the UI until it is populated.

---

## 5. Open Questions for the Production Team

The following questions must be resolved before the Lapo MFB pilot goes live. They are listed in priority order.

### 5.1 Authentication Provider (Critical)

Which authentication system will be used in production? Options:
- **Email/password + magic link** (recommended for MFB context — no dependency on third-party SSO)
- **Clerk** (fastest to implement, good DX, paid)
- **Auth0** (enterprise-grade, more complex)
- **Custom JWT** (full control, most work)

The choice affects the `users` table schema (may need `password_hash`, `mfa_secret` columns), the login flow, and the session management strategy.

### 5.2 Lapo Core Banking Connector (Critical)

What is Lapo MFB's core banking system? What data export options are available?
- Does Lapo's CBS support SFTP file export? If yes, what file format (CSV, fixed-width, XML)?
- Does Lapo's CBS have a REST API? If yes, what authentication method?
- What transaction fields are available in the export (reference, amount, date, channel, status)?
- What is the expected volume of transactions per day?

### 5.3 Card Transaction Format (High)

What is the format of Interswitch's settlement file for Lapo's card transactions?
- Is it the standard Interswitch settlement report format?
- Does it include authorisation codes, terminal IDs, and merchant category codes?
- What is the settlement window schedule (how many times per day)?

### 5.4 Hosting and Infrastructure (High)

What is the target infrastructure on Rocket.new?
- What database service will be used? (TiDB Cloud, PlanetScale, Supabase, AWS RDS)
- What S3-compatible storage will be used? (AWS S3, Cloudflare R2, Backblaze B2)
- What region? (Recommended: af-south-1 Cape Town for lowest latency from Nigeria)
- Will the background job runner be extracted to a separate worker process from day one, or will the single-process approach be retained for the pilot?

### 5.5 LLM Provider (High)

Which LLM provider will be used in production?
- **OpenAI GPT-4o** (best quality, higher cost, US-based)
- **OpenAI GPT-4o-mini** (good quality, lower cost — recommended for pilot)
- **Anthropic Claude 3.5 Sonnet** (strong reasoning, slightly different API format)
- **Google Gemini 2.5 Flash** (fast, cost-effective, same model as prototype)

The choice affects cost, latency, and the `DIRECT_LLM_API_URL` configuration. See `ARCHITECTURE.md` Section 7 for detailed guidance.

### 5.6 Email Provider (Medium)

Which transactional email provider will be used?
- **Resend** (recommended — developer-friendly, good deliverability to Nigerian addresses)
- **SendGrid** (enterprise-grade, more complex setup)
- **Postmark** (excellent deliverability, higher cost)

The `FROM` email address must be a verified domain (e.g., `noreply@reconcileai.vip`). SPF, DKIM, and DMARC records must be configured on the `reconcileai.vip` domain.

### 5.7 Pilot Commercial Terms (Medium)

What are the agreed commercial terms with Lapo MFB for the pilot?
- Is the pilot free or paid?
- What is the duration?
- What are the success criteria that trigger conversion to a paid contract?
- What SLA commitments are being made (uptime, support response time)?

This affects whether payment processing needs to be implemented before the pilot starts.

### 5.8 Data Residency (Medium)

Does Lapo MFB have data residency requirements? Nigerian financial institutions are subject to CBN guidelines on data localisation.
- Must transaction data be stored on Nigerian soil?
- If yes, AWS af-south-1 (Cape Town) may not be sufficient — consider AWS me-south-1 (Bahrain) or a Nigerian data centre provider.
- The current TiDB Cloud instance is in an unspecified region. This must be clarified before production.

---

## 6. Recommended First Sprint for Rocket.new

Based on the above, the recommended sequence for the first production sprint is:

1. **Set up the Rocket.new project** — import from GitHub (`Infinity-AI-Africa-Limited/reconcileai`), configure environment variables (see `.env.example`), verify the app boots and the database connects.

2. **Replace Manus OAuth** — implement email/password authentication with magic link. This is the blocker for everything else.

3. **Configure LLM** — set `DIRECT_LLM_API_KEY` and `DIRECT_LLM_MODEL`. Verify AI exception analysis works end-to-end.

4. **Configure email delivery** — integrate Resend or SendGrid. Verify user invitation emails are delivered.

5. **Configure S3** — set AWS credentials and bucket. Verify file uploads work end-to-end.

6. **Deploy to `reconcileai.vip`** — configure custom domain in Rocket.new, update DNS CNAME record.

7. **Build Lapo connector** — once Lapo's CBS export format is confirmed, build the connector (likely SFTP + CSV parser).

8. **Card transaction support** — add Interswitch card settlement file parser and card-specific matching logic.

9. **End-to-end pilot test** — run a full reconciliation cycle with Lapo's actual data before go-live.

---

## 7. Contacts and Resources

| Resource | Details |
|---|---|
| GitHub (primary) | `github.com/Infinity-AI-Africa-Limited/reconcileai` |
| GitHub (secondary) | `github.com/MistaRichMan/reconcileai` |
| Live prototype | `https://reconcileai.vip/` |
| Founder | Richard Anwanakak — Founder, CEO & CPO, Infinity AI Africa Limited |
| Company | Infinity AI Africa Limited |
| PRD | `docs/PRD.md` in this repository |
| Architecture | `docs/ARCHITECTURE.md` in this repository |
| Conversation Summary | `docs/CONVERSATION_SUMMARY.md` in this repository |
| Environment template | `.env.example` in repository root |
