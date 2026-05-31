# ReconcileAI — Product Requirements Document (PRD)

**Version:** 2.0 — Lapo MFB Pilot Edition  
**Date:** May 2026  
**Author:** Richard Anwanakak, Founder & CPO — Infinity AI Africa Limited  
**Status:** Active — Pilot Preparation  
**Target Platform:** Rocket.new (production build) → deployed at https://reconcileai.vip/

---

## 1. Executive Summary

ReconcileAI is an AI-powered financial reconciliation engine purpose-built for African banks, microfinance banks (MFBs), fintechs, and payment processors. It auto-matches transactions across multiple internal and external systems, classifies exceptions by severity and category, and reduces reconciliation cycle time from days to minutes.

The immediate commercial objective is a **production-grade pilot with Lapo Microfinance Bank (Lapo MFB)**, replacing the Woodcore POC that was pending IP whitelisting. The pilot is designed to compress the decision cycle — moving Lapo MFB from evaluation to signed contract without a separate POC phase.

The platform is built and operated by **Infinity AI Africa Limited**, with Interswitch's Systegra division as a strategic distribution and integration partner.

---

## 2. Problem Statement

Nigerian financial institutions — particularly MFBs and mid-tier banks — face a structural reconciliation crisis:

- Reconciliation officers spend 4–8 hours per day manually matching transactions across 5–6 disconnected systems (core banking, payment switches, mobile wallets, agent networks, settlement files)
- False positive exception rates of 35–65% consume analyst time on non-issues
- Settlement windows are missed because pre-settlement reconciliation is not automated
- CBN regulatory reporting (NDPR, NDPA, AML) requires audit-ready reconciliation trails that manual processes cannot reliably produce
- Existing tools (Excel, basic ERP modules) do not support multi-channel, multi-processor, or AI-assisted matching

**The Lapo MFB context specifically:** Lapo operates one of Nigeria's largest MFB networks with high transaction volumes across mobile money, agent banking, and core banking channels. Their reconciliation team is under-resourced relative to transaction volume, making them an ideal early adopter.

---

## 3. Product Vision

> ReconcileAI becomes the infrastructure layer for financial reconciliation across Africa — the same way Interswitch became the infrastructure layer for payment switching.

**FY1 focus:** Financial Services (banks, MFBs, fintechs, payment processors)  
**FY2 expansion:** Corporate B2B (FMCG distributors, manufacturer-to-retailer payment reconciliation)

---

## 4. Target Users

### 4.1 Primary Personas

| Persona | Role | Primary Need |
|---|---|---|
| **Reconciliation Officer** | Daily operator | Upload files, run jobs, resolve exceptions fast |
| **Operations Manager** | Team lead | Monitor match rates, assign exceptions, track SLAs |
| **CFO / Finance Director** | Executive | Weekly summary, regulatory readiness, audit trail |
| **Compliance Officer** | Risk & audit | CBN report generation, NDPA data protection, audit log |
| **IT / Integration Engineer** | Technical | API keys, SFTP config, webhook setup, channel management |

### 4.2 Platform Administrator Personas

| Persona | Role | Primary Need |
|---|---|---|
| **Org Admin** | Institution-level admin | User management, module config, email settings |
| **Infinity AI Super Admin** | Platform owner | Cross-tenant oversight, module overrides, audit, onboarding |

---

## 5. Modules

The platform is structured around two reconciliation modules, both configurable per institution by Infinity AI:

### 5.1 Settlement Reconciliation

**Purpose:** Validate that bulk settlement amounts from payment processors (Interswitch, UPSL, eTranzact, Nibss, etc.) match the institution's internal transaction records.

**Key capabilities (merged from Transaction Integrity):**
- Multi-source transaction ingestion (CSV, Excel, API, SFTP)
- Multi-processor reconciliation (Interswitch, UPSL, eTranzact, and others)
- Settlement window scheduling (3–4x per day)
- Pre-settlement reconciliation (catch mismatches before settlement hits)
- Lump sum vs. detailed report validation
- Merchant-level grouping
- Intelligent matching across 5–6 internal systems
- Duplicate detection (unidirectional and bidirectional)
- Timestamp normalisation across systems
- Amount denomination correction (kobo/naira, minor/major currency units)
- False positive classification via AI
- Unified portal orchestration

**Success metrics:**
- Reduce false positive rate from 35–65% to < 2%
- Reduce manual matching time by 60%
- Process 3–4 settlement windows per day automatically
- 99.9%+ transaction accounting accuracy

### 5.2 Account-Level Reconciliation

**Purpose:** Reconcile individual account balances and ledger entries against external statements and counterparty records.

**Key capabilities:**
- Account-to-account matching
- Ledger vs. statement reconciliation
- Balance verification across periods
- Nostro/vostro account reconciliation
- Inter-branch reconciliation
- Opening/closing balance validation

---

## 6. Feature Specifications

### 6.1 Data Ingestion

**File Upload (Manual)**
- Supported formats: CSV, XLSX, XLS
- File size limit: configurable per org (default 50 MB)
- Column mapping: user-configurable field mapping per channel
- Idempotency: SHA-256 file hash prevents duplicate uploads
- Validation: row-level validation with error reporting before processing

**API Ingestion**
- REST API endpoint per channel
- API key authentication (per-org, rotatable)
- Webhook support for push-based ingestion
- Ingestion log with status, row counts, error details

**SFTP Ingestion**
- Per-channel SFTP credentials (host, port, username, password/key, remote path)
- Scheduled pull (configurable frequency)
- Ingestion log with run history

### 6.2 Channel Management

A **channel** represents a single data source (e.g., "Interswitch Settlement File", "Core Banking Ledger", "Mobile Money Wallet"). Each channel has:
- Channel type: `bank_statement | payment_processor | internal_ledger | mobile_money | agent_network | pos_terminal | custom`
- Field mapping configuration (JSON)
- Alert thresholds (match rate floor, exception count ceiling)
- Active/inactive status

### 6.3 Reconciliation Engine

**Job configuration:**
- Source channel + target channel
- Date range
- Amount tolerance (default 0.5%)
- Date window (default ±3 days)
- Module type (settlement or account_level)

**Matching algorithm (5-pass):**
1. **Exact match** — transaction reference + amount + date (exact)
2. **Fuzzy reference match** — normalised reference string similarity
3. **Amount tolerance match** — within configured tolerance, same date window
4. **Date window match** — exact amount, date within window
5. **AI-suggested match** — LLM-assisted matching for ambiguous pairs (see Section 9)

**Match types stored:** `exact | fuzzy | amount_tolerance | date_window | ai_suggested | manual | reversal`

**Confidence scoring:** Each match carries a decimal confidence score (0.00–1.00). AI-suggested matches below 0.75 are flagged for human review.

**Reversal detection:** Transactions with `isReversal = true` are matched against their original transaction reference before entering the standard matching pipeline.

### 6.4 Exception Management

**Exception categories:**
- `missing_counterparty` — transaction exists on one side only
- `amount_mismatch` — matched by reference but amounts differ beyond tolerance
- `timing_difference` — matched by reference/amount but date outside window
- `duplicate_transaction` — same reference appears multiple times
- `unmatched` — no match found after all passes
- `reversal_unmatched` — reversal with no corresponding original
- `currency_mismatch` — currency codes differ
- `format_error` — data quality issue preventing matching

**Severity levels:** `low | medium | high | critical`

**Exception workflow:**
- Auto-assignment rules (by category, severity, or channel)
- Manual assignment to team members
- Resolution with notes and resolution template
- Escalation path
- Status: `open → in_review → resolved / dismissed / escalated`

**AI analysis:** Each exception receives an LLM-generated analysis and suggested resolution (see Section 9).

### 6.5 Review Queue

The review queue surfaces matches with `status = pending_review` — AI-suggested matches and manual matches awaiting confirmation. Reviewers can confirm or reject each match with a single action.

### 6.6 Reports

**Report types:** `daily | weekly | monthly | custom`  
**Formats:** PDF, Excel, CSV  
**Report content:** Match rate, exception summary by category/severity, unmatched transactions, processing time, operator activity  
**Shareable reports:** Time-limited public URL (token-based, expiry configurable)  
**CFO weekly digest:** Scheduled email with summary metrics and PDF attachment

### 6.7 CBN Compliance Reports

Dedicated module for generating CBN-mandated regulatory reports:
- Framework management (report templates per CBN directive)
- Submission tracking with deadlines
- Findings and action plan management
- Audit log of all submissions
- Deadline submission log

### 6.8 Anomaly Detection

**Detection methods:** `statistical | ml_model | rule_based | velocity | pattern`  
**Detection rules:** Configurable per org — velocity limits, amount thresholds, pattern rules, time-of-day rules  
**Review workflow:** `pending → false_positive / confirmed / escalated / resolved`  
**Integration:** Anomaly scores surface in the Advanced Tools sidebar section

### 6.9 Scheduled Tasks

- Frequency: `daily | weekly | biweekly | monthly`
- Configurable time-of-day and day-of-week
- Run history with status, duration, rows processed
- Email notification on completion/failure

### 6.10 Advanced Tools

| Tool | Purpose |
|---|---|
| **Sample Data Generator** | Generate realistic test transaction data for demos and onboarding |
| **Integrations** | Webhook management, API key management |
| **API Ingestion** | Configure and test API-based data sources |
| **SFTP Config** | Manage SFTP credentials and ingestion schedules |
| **Anomaly Detection** | Configure detection rules, review anomaly scores |

### 6.11 Admin Features

| Feature | Description |
|---|---|
| **User Management** | Invite users, assign roles, deactivate accounts |
| **Email Settings** | Configure outbound email (SMTP), notification templates |
| **Module Configuration** | Enable/disable Settlement and Account-Level modules |
| **Data Protection** | NDPA/NDPR compliance settings, data deletion requests, security incidents |
| **Audit Trail** | Full immutable log of all user and system actions |

### 6.12 Super Agent

An AI-powered assistant embedded in the platform that can:
- Answer questions about reconciliation data using natural language
- Draft exception resolution actions for human approval (action draft layer)
- Maintain semantic memory of org-specific patterns and preferences
- Execute approved actions (assign exceptions, update statuses, generate reports)

The Super Agent uses a two-layer safety model: **draft → human approval → execute**. No action is taken without explicit user confirmation.

### 6.13 Super Admin Portal (Infinity AI only)

Accessible only to users with `role = super_admin` and `organizationId` mapped to Infinity AI Africa Limited.

**Capabilities:**
- Cross-tenant dashboard (aggregate stats across all orgs)
- Organisation management (create, edit, segment assignment)
- User management across all orgs
- Module override: force ON/OFF per institution with reason and audit trail
- Platform audit log
- Portal context switcher: enter any org's portal to verify their experience

---

## 7. Multi-Tenant Architecture

The platform is **multi-tenant with hard data isolation**. Every database table that holds business data includes an `organizationId` foreign key. All queries are scoped to `ctx.user.organizationId` at the procedure level.

**Tenant segments:**
- `financial_services` — banks, MFBs, fintechs, payment processors
- `corporate_b2b` — FMCG distributors, manufacturer-to-retailer (FY2)
- `super_admin` — Infinity AI internal

Each segment receives a tailored sidebar navigation and feature set when accessed through the portal context switcher.

---

## 8. User Roles and Permissions

| Role | Scope | Key Permissions |
|---|---|---|
| `super_admin` | Platform-wide | All operations, cross-tenant access, module overrides |
| `admin` | Org-wide | User management, module config, all data operations |
| `user` (standard) | Org-wide | Upload, reconcile, resolve exceptions, view reports |
| `guest` | Session-scoped | Read-only demo access via guest token |

Role-based access is enforced at the tRPC procedure level via `protectedProcedure`, `adminProcedure`, and `superAdminProcedure` middleware.

---

## 9. AI / LLM Integration

### 9.1 Current Implementation (Manus Forge)

In the prototype, LLM calls are made via the Manus Forge API gateway (`BUILT_IN_FORGE_API_KEY`). The model in use is **Gemini 2.5 Flash**. The `invokeLLM()` helper in `server/_core/llm.ts` abstracts the provider.

### 9.2 LLM Use Cases in the Platform

| Feature | LLM Role |
|---|---|
| Exception AI Analysis | Generate human-readable analysis and suggested resolution for each exception |
| AI-Suggested Matching | Score ambiguous transaction pairs and recommend matches |
| Super Agent — Query | Natural language Q&A over reconciliation data |
| Super Agent — Action Drafts | Draft resolution actions for human approval |
| Super Agent — Memory | Summarise and store org-specific patterns |
| Anomaly Narrative | Generate plain-English explanation of detected anomalies |

### 9.3 Production LLM Replacement (Rocket.new)

When moving to Rocket.new, the Manus Forge gateway is **not available**. Replace it as follows:

**Step 1 — Set environment variables:**
```
DIRECT_LLM_API_KEY=<your OpenAI or Anthropic API key>
DIRECT_LLM_API_URL=https://api.openai.com/v1/chat/completions   # or Anthropic endpoint
DIRECT_LLM_MODEL=gpt-4o                                          # or claude-3-5-sonnet-20241022
```

**Step 2 — The `invokeLLM()` helper auto-switches.** The `resolveProvider()` function in `server/_core/llm.ts` checks for `DIRECT_LLM_API_KEY` first. If set and non-empty, it routes all LLM calls to the direct provider. No code changes are required.

**Step 3 — Recommended production model choices:**

| Use Case | Recommended Model | Rationale |
|---|---|---|
| Exception analysis, anomaly narrative | `gpt-4o-mini` or `claude-3-haiku` | Cost-efficient, fast, sufficient quality |
| AI-suggested matching | `gpt-4o` or `claude-3-5-sonnet` | Higher accuracy for financial data |
| Super Agent Q&A and action drafts | `gpt-4o` or `claude-3-5-sonnet` | Reasoning quality critical |

**Step 4 — Cost management:** Add per-org LLM usage tracking. Gate AI features behind the module configuration toggle so institutions can opt out of AI-powered features to control costs.

**Step 5 — Streaming (Super Agent):** The Super Agent uses `streamdown` for streaming responses. OpenAI and Anthropic both support SSE streaming. The `invokeLLM()` helper currently returns a complete response; for the Super Agent, extend it with a `stream: true` parameter that returns an `AsyncIterable<string>` and pipe it to the tRPC subscription or SSE endpoint.

---

## 10. Integrations

### 10.1 Current Integrations

| Integration | Type | Status |
|---|---|---|
| Woodcore Core Banking | REST API (POC) | Pending IP whitelist from Woodcore |
| Interswitch Settlement Files | CSV/SFTP | Prototype implemented |
| UPSL | CSV upload | Prototype implemented |
| eTranzact | CSV upload | Prototype implemented |

### 10.2 Planned Integrations (Pilot)

| Integration | Type | Priority |
|---|---|---|
| Lapo MFB Core Banking | REST API or SFTP | P0 — Pilot blocker |
| Lapo Mobile Money Platform | REST API | P1 |
| CBN RTGS / NIP | SFTP | P1 |
| Nibss | API/SFTP | P2 |

---

## 11. Non-Functional Requirements

### 11.1 Performance

- Reconciliation job for 100,000 transactions: complete within 5 minutes
- Dashboard load time: < 2 seconds (with cache)
- File upload processing: < 30 seconds for 50 MB file
- API response time (p95): < 500 ms

### 11.2 Security

- All data encrypted at rest (database) and in transit (TLS 1.2+)
- JWT session cookies (httpOnly, secure, sameSite=strict)
- API keys hashed before storage (SHA-256)
- SFTP credentials encrypted at rest
- Audit log is append-only and immutable
- NDPA/NDPR compliance controls built in (data deletion requests, breach notification, compliance settings)

### 11.3 Availability

- Target uptime: 99.5% (pilot), 99.9% (production)
- Zero-downtime deployments
- Database: TiDB (MySQL-compatible, distributed, HA)

### 11.4 Compliance

- CBN regulatory reporting (CBN Compliance Reports module)
- NDPA/NDPR data protection (Compliance module)
- Full audit trail for all user and system actions
- Role-based access control with principle of least privilege

---

## 12. Pilot Scope — Lapo MFB

The pilot is scoped to prove value on a single reconciliation workflow before expanding.

### 12.1 Pilot Phase 1 (Weeks 1–4)

- Onboard Lapo MFB as a `financial_services` tenant
- Configure 2–3 channels (core banking, mobile money, one payment processor)
- Run Settlement Reconciliation on historical data (30 days)
- Measure: match rate, exception reduction, time-to-reconcile

### 12.2 Pilot Phase 2 (Weeks 5–8)

- Enable live ingestion (API or SFTP)
- Run scheduled daily reconciliation
- Enable exception workflow (assign, resolve, escalate)
- Deliver first CBN compliance report

### 12.3 Pilot Success Criteria

| Metric | Target |
|---|---|
| Match rate | ≥ 95% auto-matched |
| False positive rate | < 5% |
| Time-to-reconcile | < 30 minutes per settlement window |
| Exceptions resolved without escalation | ≥ 80% |
| Reconciliation officer time saved | ≥ 50% |

### 12.4 Contract Trigger

A signed production contract is triggered when Lapo MFB confirms pilot success criteria are met and approves the production SLA.

---

## 13. Out of Scope (Prototype → Pilot)

The following items were **deliberately excluded** from the prototype and must be built for the pilot:

- Real-time streaming ingestion (Kafka/event bus)
- Native mobile application
- Direct core banking system integration via SDK (Temenos, Flexcube)
- Multi-currency settlement netting
- Automated CBN submission (API submission to CBN portal)
- White-labelling for reseller partners
- Corporate B2B segment features (FY2)

---

## 14. Roadmap Alignment

This PRD covers the **Q1 FY1** product and engineering deliverables from the GTM roadmap:

| GTM Item | PRD Coverage |
|---|---|
| Pilot with Lapo MFB | Section 12 |
| Settlement Reconciliation module | Section 5.1 |
| Account-Level Reconciliation module | Section 5.2 |
| AI exception analysis | Section 9.2 |
| CBN compliance reports | Section 6.7 |
| Super Agent (MVP) | Section 6.12 |
| Multi-tenant architecture | Section 7 |
| Super Admin portal | Section 6.13 |

---

## 15. Glossary

| Term | Definition |
|---|---|
| **Channel** | A single data source (e.g., Interswitch settlement file, core banking ledger) |
| **Job** | A single reconciliation run between a source and target channel |
| **Match** | A confirmed pairing between a source and target transaction |
| **Exception** | A transaction that could not be matched or has a data quality issue |
| **Settlement window** | A defined time period (e.g., 6am–12pm) within which processor settlements are batched |
| **MFB** | Microfinance Bank |
| **CBN** | Central Bank of Nigeria |
| **NDPA** | Nigeria Data Protection Act |
| **NDPR** | Nigeria Data Protection Regulation |
| **Forge** | Manus AI's internal LLM gateway (prototype only — replaced in production) |
| **Super Agent** | The AI assistant embedded in the platform |
| **Org** | An organisation (tenant) on the platform |
