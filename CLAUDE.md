# ReconcileAI — Claude Code Persistent Context

> **This file is read automatically by Claude Code at the start of every session.**
> It contains the complete project context, architectural decisions, production build priorities,
> and engineering constraints for ReconcileAI. Read it fully before writing any code.

---

## 1. What This Project Is

**ReconcileAI** is an AI-powered financial reconciliation platform for African banks and microfinance banks (MFBs). It automates the matching of transactions across payment channels, classifies exceptions by severity, and resolves them using an AI Super Agent that learns from historical patterns.

**Owner:** Richard Anwanakak — Founder & CEO, Infinity AI Africa Limited; Divisional Head, Systegra Products (Mobile Financial Services), Interswitch.

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
Set these environment variables to switch to Anthropic Claude with **zero code changes**:

```bash
# Primary: Anthropic Claude API key
DIRECT_LLM_API_KEY=sk-ant-api03-...

# Anthropic OpenAI-compatible endpoint
DIRECT_LLM_API_URL=https://api.anthropic.com/v1

# Model selection — see below
DIRECT_LLM_MODEL=claude-sonnet-4-5
```

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
The `invokeLLM()` function in `server/_core/llm.ts` checks at runtime:
- If `DIRECT_LLM_API_KEY` is set and non-empty → uses direct provider (Anthropic/OpenAI-compatible)
- Otherwise → uses Manus Forge

No code changes are needed. All 20+ call sites use `invokeLLM()` identically.

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

### Current State (Prototype — DO NOT USE IN PRODUCTION)
The prototype uses **Manus OAuth** (`/api/oauth/callback`). This is a Manus-platform-specific OAuth2 flow that will not work outside Manus. It must be replaced before any external user can log in.

### Production Authentication Roadmap

| Phase | Method | Target Segment | Priority |
|---|---|---|---|
| **Phase 1 — Immediate** | Email / Magic Link | Lapo MFB pilot, all early users | Build first — unblocks all pilots |
| **Phase 2 — Q1** | Google OAuth2 | Fintechs, startups on Google Workspace | Broadens self-serve adoption |
| **Phase 3 — Q2** | Microsoft Entra ID (Azure AD) OAuth2 | Commercial banks, tier-2/tier-1 institutions | Required by enterprise IT security policy |

**Phase 1 implementation notes:**
- The `magicLinkTokens` table already exists in `drizzle/schema.ts` — the schema is ready
- Build: `/api/auth/request-magic-link` (POST email) → send email via Resend → `/api/auth/verify?token=xxx` → set JWT session cookie
- JWT secret is already configured via `JWT_SECRET` environment variable
- Session cookie logic lives in `server/_core/context.ts`

**Phase 2 & 3:** Standard OAuth2 PKCE flow. Use `passport.js` with `passport-google-oauth20` and `passport-azure-ad` respectively.

### What to Remove
- `server/_core/oauth.ts` — Manus OAuth callback handler (replace entirely)
- `client/src/const.ts` — `getLoginUrl()` function (replace with magic link request)
- `client/src/contexts/AuthContext.tsx` — update to use new auth endpoints

---

## 6. Three-Portal Architecture

ReconcileAI serves three distinct user segments from a single codebase, differentiated by the `organizations.segment` field:

| Segment | Value | Description |
|---|---|---|
| Financial Services | `financial_services` | Banks, MFBs, payment processors |
| Corporate B2B | `corporate_b2b` | FMCG distributors, supply chain finance |
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
- Both defined in `client/src/components/DashboardLayout.tsx`

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
DIRECT_LLM_API_URL=https://api.anthropic.com/v1
DIRECT_LLM_MODEL=claude-sonnet-4-5

# Auth (replace Manus OAuth)
JWT_SECRET=<generate 64-char random string>

# File Storage (Cloudflare R2 recommended)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=auto
AWS_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
AWS_BUCKET_NAME=reconcileai-storage

# Email (for magic link auth and notifications)
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@reconcileai.vip

# Manus-specific (DO NOT set in production — these are Manus-injected)
# BUILT_IN_FORGE_API_KEY  ← Manus only
# BUILT_IN_FORGE_API_URL  ← Manus only
# VITE_FRONTEND_FORGE_API_KEY  ← Manus only
# OAUTH_SERVER_URL  ← Manus only
# VITE_OAUTH_PORTAL_URL  ← Manus only
```

---

## 12. Deployment — reconcileai.vip

The production domain is `reconcileai.vip`. DNS is already configured with Cloudflare.

**To publish on Rocket.new or any Node.js host:**
1. Import the GitHub repository (`Infinity-AI-Africa-Limited/reconcileai`)
2. Set all environment variables from Section 11
3. Build command: `pnpm build`
4. Start command: `node dist/server/index.js` (or `pnpm start`)
5. Port: the server reads `PORT` from environment (defaults to 3000)
6. In your hosting provider's domain settings, add a custom domain: `reconcileai.vip`
7. In Cloudflare DNS, set a CNAME record: `reconcileai.vip → <your-hosting-provider-cname>`

**Do not hardcode the port number** — the server uses `process.env.PORT` for Cloud Run compatibility.

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

## 15. Coding Conventions

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
- The three-portal architecture (`organizations.segment` enum and portal context switcher)

---

*Last updated: June 2026 | Built in Manus | Transferring to Claude Code for production engineering*
*Owner: Richard Anwanakak, Infinity AI Africa Limited*
