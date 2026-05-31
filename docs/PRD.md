# Product Requirements Document (PRD)
## ReconcileAI — AI-Powered Financial Reconciliation Engine

---

| Field | Value |
|---|---|
| **Product Name** | ReconcileAI |
| **Company** | Infinity AI Africa Limited |
| **Author** | Richard Anwanakak — Founder, CEO & Chief Product Officer |
| **Document Version** | 2.0 |
| **Status** | Approved — Lapo MFB Pilot Ready |
| **Last Updated** | May 2026 |
| **Prototype URL** | https://reconcileai.vip |
| **Production Target** | Rocket.new → https://reconcileai.vip |
| **Classification** | Confidential — Internal Use Only |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Product Vision and Strategic Positioning](#3-product-vision-and-strategic-positioning)
4. [Target Users and Personas](#4-target-users-and-personas)
5. [Market Segmentation](#5-market-segmentation)
6. [Platform Architecture Overview](#6-platform-architecture-overview)
7. [Module Definitions](#7-module-definitions)
8. [Feature Specifications](#8-feature-specifications)
9. [AI and LLM Integration](#9-ai-and-llm-integration)
10. [Multi-Tenancy and Access Control](#10-multi-tenancy-and-access-control)
11. [Non-Functional Requirements](#11-non-functional-requirements)
12. [Integrations](#12-integrations)
13. [Pilot Scope — Lapo MFB](#13-pilot-scope--lapo-mfb)
14. [Roadmap Alignment](#14-roadmap-alignment)
15. [Out of Scope](#15-out-of-scope)
16. [Risks and Mitigations](#16-risks-and-mitigations)
17. [Glossary](#17-glossary)

---

## 1. Executive Summary

ReconcileAI is an AI-powered financial reconciliation engine purpose-built for African banks, microfinance banks (MFBs), fintechs, payment processors, and — in a future phase — corporate B2B payment operators. The platform automates the matching of transactions across multiple payment channels and internal systems, classifies exceptions by severity and category using a structured taxonomy, and provides AI-assisted resolution workflows that compress the daily reconciliation cycle from 24–72 hours to under two hours.

The platform is built on a three-layer intelligence architecture. The **Balance Engine** performs deterministic multi-source transaction matching using seven distinct matching methods. The **Exception Classifier** categorises every unmatched transaction into one of eight exception types and assigns a severity level. The **Context-Aware Super Agent** learns from historical resolution patterns to suggest and draft resolutions autonomously, operating under a human-in-the-loop safety model.

The platform is live at [https://reconcileai.vip](https://reconcileai.vip) as a functional prototype, built on a React 19 + TypeScript + tRPC + MySQL stack and deployed on Manus infrastructure. The immediate commercial objective is a **paid pilot with Lapo Microfinance Bank**, replacing the Woodcore POC that was blocked by an IP whitelisting dependency. The pilot is designed to compress the decision cycle — moving Lapo MFB from evaluation to a signed production contract without a separate POC phase.

The production build will be executed on **Rocket.new**, deployed at [https://reconcileai.vip](https://reconcileai.vip), and will implement the Product and Engineering section of the Q1 FY1 GTM roadmap.

---

## 2. Problem Statement

Financial reconciliation in African financial institutions is characterised by four compounding structural failures.

**Failure 1 — Volume and velocity mismatch.** A mid-tier Nigerian bank processes between 500,000 and 2 million transactions per day across 8–14 payment channels: NIP, POS, ATM, mobile banking, USSD, agent banking, card payments, RTGS, SWIFT, and others. Each channel produces its own transaction log in a different format, at a different cadence, and with different reference number conventions. Reconciling these streams manually requires an operations team of 15–40 staff working in shifts, and the process still takes 24–72 hours to complete.

**Failure 2 — False positive epidemic.** Industry data indicates that 35–65% of flagged exceptions are false positives — items that appear unmatched due to timing differences, reference format variations, or amount denomination discrepancies rather than genuine discrepancies. Operations staff spend the majority of their time investigating and dismissing these false positives rather than resolving genuine exceptions. This is the single largest driver of reconciliation cost.

**Failure 3 — Regulatory exposure.** The Central Bank of Nigeria (CBN) requires financial institutions to submit reconciliation reports within defined windows. Delays in reconciliation directly create delays in regulatory reporting, which carry financial penalties and reputational risk. The CBN's increasing scrutiny of operational risk management means that institutions with manual reconciliation processes face growing regulatory pressure, particularly under the NDPA 2023 and NDPR 2019 frameworks.

**Failure 4 — Talent dependency and knowledge loss.** Reconciliation knowledge — which reference formats map to which channels, which exception categories are common for which processors, how to resolve specific exception types — is largely undocumented and held by individual staff members. When experienced reconciliation officers leave, the institution loses institutional knowledge that takes months to rebuild.

**The Lapo MFB context specifically.** Lapo operates one of Nigeria's largest MFB networks, with high transaction volumes across mobile money, agent banking, and core banking channels. Their reconciliation team is under-resourced relative to transaction volume, making them an ideal early adopter and a commercially compelling reference customer for the broader MFB market.

---

## 3. Product Vision and Strategic Positioning

> ReconcileAI becomes the infrastructure layer for financial reconciliation across Africa — the same way Interswitch became the infrastructure layer for payment switching.

**FY1 focus (July 2026 – June 2027):** Financial Services — banks, MFBs, fintechs, payment processors. Target: 3 signed pilot agreements, 2 converted to production contracts, ₦15M MRR by Q4 FY1.

**FY2 expansion (July 2027 – June 2028):** Corporate B2B — FMCG distributors, manufacturer-to-retailer payment reconciliation, corporate treasuries. The three-layer architecture requires only a new data connector layer and new exception categories to serve this segment.

**Strategic partnership:** Interswitch's Systegra division is a strategic distribution and integration partner. Systegra's existing relationships with Nigerian banks and payment processors provide a distribution channel that significantly reduces the cost of customer acquisition in the financial services segment.

**Competitive differentiation** rests on three pillars. First, African-native data understanding: the system is designed around African payment channel formats, reference number conventions, and exception patterns rather than adapted from Western reconciliation tools. Second, the three-layer architecture that separates deterministic matching (high confidence, no AI required) from probabilistic matching (AI-assisted) from exception resolution (AI-drafted, human-approved), which allows the system to be both highly accurate and highly explainable. Third, the Super Agent's semantic memory layer, which learns from every resolved exception and improves match suggestions over time without requiring model retraining.

---

## 4. Target Users and Personas

ReconcileAI serves five primary user personas within a financial institution, each with distinct workflows, information needs, and success criteria.

### 4.1 Reconciliation Officer (Primary Operator)

The Reconciliation Officer is the day-to-day user of the platform. They are responsible for running reconciliation jobs, reviewing exceptions, and resolving discrepancies. They typically have a background in banking operations and are proficient with Excel but have limited programming knowledge. Their primary pain point is the volume of false positives they must investigate daily. They measure their own performance by the number of exceptions resolved per shift and the time taken to close the daily reconciliation cycle.

**Primary workflows:** Upload transaction files, trigger reconciliation jobs, work through the exception queue, apply resolution templates, escalate critical exceptions.

### 4.2 Operations Manager (Team Lead)

The Operations Manager oversees a team of reconciliation officers. They need visibility into team performance, exception queue depth, SLA compliance, and channel health. They are responsible for escalating unresolved exceptions to the CFO or compliance team and for configuring alert thresholds.

**Primary workflows:** Monitor the operations dashboard, assign exceptions to team members, review match rate trends, configure channel alerts.

### 4.3 CFO / Finance Director (Executive Sponsor)

The CFO is the economic buyer and the primary recipient of reconciliation reports. They do not use the platform daily but require accurate, timely reports on match rates, outstanding exceptions, and channel health. They are concerned with regulatory compliance, financial accuracy, and the cost of the reconciliation function.

**Primary workflows:** Review the CFO dashboard, receive scheduled email reports, share reports with the board via signed links.

### 4.4 Compliance Officer / Internal Auditor

The Compliance Officer requires a complete, tamper-evident record of all reconciliation activity, exception resolutions, and user actions. They access the platform periodically to conduct reconciliation audits and prepare for CBN examinations.

**Primary workflows:** Review the audit trail, manage CBN compliance reports, track data protection settings, respond to data deletion requests.

### 4.5 IT / Integration Administrator

The IT Administrator is responsible for configuring data ingestion pipelines, managing API keys, setting up SFTP connections, and integrating ReconcileAI with the institution's core banking system.

**Primary workflows:** Configure SFTP credentials, manage API keys and webhooks, set up channel field mappings, manage integrations.

### 4.6 Infinity AI Super Admin (Platform Owner)

The Super Admin is an Infinity AI Africa Limited employee with cross-tenant access. They are responsible for onboarding new institutions, managing module access, monitoring platform health, and verifying that each institution's portal is correctly configured.

**Primary workflows:** Platform control centre, portal context switcher, module overrides, cross-tenant audit log, organisation management.

---

## 5. Market Segmentation

The platform supports two primary market segments, each with a distinct portal experience, feature set, and commercial model.

### 5.1 Financial Services Segment

The financial services segment is the primary segment for FY1. It encompasses commercial banks, microfinance banks, fintechs, and payment processors operating in Africa.

| Institution Type | Primary Reconciliation Challenge | Key Channels |
|---|---|---|
| Commercial Banks | Multi-processor settlement, CBN reporting, nostro reconciliation | NIP, POS, ATM, RTGS, SWIFT, mobile banking |
| Microfinance Banks | Agent banking, mobile money, USSD, core banking | Agent banking, mobile money, USSD, NIP |
| Fintechs | API-driven multi-processor, high velocity | Fintech API, card payments, NIP, mobile money |
| Payment Processors | Lump sum vs. detailed settlement, merchant-level grouping | Card payments, POS, NIP, QR payment |

**Portal features:** Full feature set including CBN Compliance Reports, Multi-Channel management, Advanced Tools, Email Settings, Anomaly Detection, CFO Dashboard, Auditor Dashboard, Operations Dashboard, and SFTP/API ingestion.

### 5.2 Corporate B2B Segment

The corporate B2B segment is the secondary segment, commencing in FY2. It encompasses FMCG manufacturers, distributors, and corporate treasuries that manage high-volume payment flows.

| Entity Type | Primary Reconciliation Challenge | Key Channels |
|---|---|---|
| FMCG Manufacturers | Distributor payment matching, invoice reconciliation | Bank transfer, NIP |
| Distributors | Invoice-to-payment reconciliation, deduction management | Bank transfer, NIP, USSD |
| Corporate Treasuries | Multi-bank, multi-currency settlement | RTGS, SWIFT, bank transfer |

**Portal features:** Distributor Registry, Settlement Reconciliation, Exceptions, Transactions, Reports, Review Queue, Audit Trail, Monitor, User Management, Upload Data, Schedules.

---

## 6. Platform Architecture Overview

ReconcileAI is a multi-tenant SaaS platform built on a single-process Node.js server with a React frontend. The architecture is designed for simplicity and correctness in the prototype phase, with a clear upgrade path to a distributed, event-driven architecture for production scale.

### 6.1 Three-Layer Intelligence Architecture

```
Layer 1: Balance Engine (Deterministic)
  ├── Multi-source transaction ingestion (CSV, SFTP, API)
  ├── Data normalisation (timestamp, amount denomination, reference format)
  ├── 7-method matching pipeline (exact → fuzzy → tolerance → AI)
  └── Confidence scoring per match

Layer 2: Exception Classifier (AI-Assisted)
  ├── 8-category exception taxonomy
  ├── 4-level severity scoring
  ├── AI-generated analysis and resolution suggestion per exception
  └── SLA tracking and breach alerts

Layer 3: Context-Aware Super Agent (Conversational AI)
  ├── Natural language Q&A over reconciliation data
  ├── Semantic memory (learns from resolved exceptions)
  ├── Action draft layer (human-in-the-loop)
  └── Anomaly narrative generation
```

### 6.2 Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend | React | 19 |
| Language | TypeScript | 5.x |
| Styling | Tailwind CSS | 4.x |
| Component Library | shadcn/ui | Latest |
| API Layer | tRPC | 11 |
| Backend Runtime | Node.js / Express | 22 / 4 |
| Database | MySQL (TiDB-compatible) | 8.x |
| ORM | Drizzle ORM | Latest |
| File Storage | S3-compatible (AWS S3 / Cloudflare R2) | — |
| Authentication | Manus OAuth (prototype) → Email/Magic Link (production) | — |
| LLM Gateway | Manus Forge (prototype) → OpenAI / Anthropic (production) | — |
| Serialisation | SuperJSON | — |

### 6.3 Data Flow

```
External Data Sources
  (CBS, Payment Processors, SFTP, API)
         │
         ▼
  Ingestion Layer
  (File Upload / SFTP Pull / API Push)
         │
         ▼
  Normalisation Layer
  (Column mapping, timestamp normalisation,
   amount denomination correction)
         │
         ▼
  Transaction Store (MySQL)
         │
         ▼
  Matching Engine
  (7-pass matching pipeline)
         │
    ┌────┴────┐
    ▼         ▼
 Matches   Exceptions
    │         │
    ▼         ▼
Review     Exception
Queue      Classifier
           (AI analysis,
            severity,
            resolution suggestion)
                │
                ▼
          Exception Queue
          (Operations Officer)
                │
                ▼
          Resolution
          (Template / Manual / Super Agent)
                │
                ▼
          Reports & CBN Compliance
```

---

## 7. Module Definitions

The platform is structured around two reconciliation modules. Each module can be independently enabled or disabled per organisation by the organisation's admin. Infinity AI (super admin) can override the module state for any organisation, independently of the organisation's own setting, with a mandatory reason and a full audit trail.

### 7.1 Settlement Reconciliation Module

**Purpose:** Validate that transaction records across all payment channels are internally consistent and that bulk settlement amounts from payment processors match the institution's internal transaction records.

This module incorporates all capabilities previously described separately as "Transaction Integrity Reconciliation" and "Settlement Reconciliation". The merger was deliberate: in practice, transaction integrity checks (duplicate detection, timestamp normalisation, false positive classification) are prerequisites for settlement reconciliation and cannot be meaningfully separated in an operational workflow.

**Key capabilities:**

| Capability | Description |
|---|---|
| Multi-source transaction ingestion | Accept data from CSV, Excel, SFTP, and REST API simultaneously |
| Multi-processor reconciliation | Support Interswitch, UPSL, eTranzact, NIBSS, and others |
| Settlement window scheduling | Run 3–4 reconciliation cycles per day automatically |
| Pre-settlement reconciliation | Catch mismatches before settlement funds are released |
| Lump sum vs. detailed report validation | Match processor lump sum settlements against itemised transaction logs |
| Merchant-level grouping | Reconcile at the merchant level within a settlement file |
| Intelligent matching across 5–6 internal systems | Match transactions across CBS, payment switch, mobile wallet, agent network, and settlement files |
| Duplicate detection | Identify duplicate transactions both within a single source and across sources |
| Timestamp normalisation | Reconcile transactions with different time zones or clock drift |
| Amount denomination correction | Handle kobo/naira and minor/major currency unit mismatches |
| False positive classification | AI-powered identification of apparent mismatches that are actually valid |
| Unified portal orchestration | Single interface for all channels and processors |

**Success metrics:**
- Reduce false positive rate from 35–65% to < 2%
- Reduce manual matching time by 60%
- Process 3–4 settlement windows per day automatically
- 99.9%+ transaction accounting accuracy

### 7.2 Account-Level Reconciliation Module

**Purpose:** Reconcile individual account balances and ledger entries against external statements and counterparty records.

This module operates at a higher level of abstraction than the Settlement module — matching account balances rather than individual transactions — and is designed for use by the finance team rather than the operations team.

**Key capabilities:**

| Capability | Description |
|---|---|
| Account-to-account matching | Match balances between internal accounts and external statements |
| Ledger vs. statement reconciliation | Reconcile general ledger entries against bank statements |
| Balance verification across periods | Verify opening and closing balances match across settlement periods |
| Nostro/vostro account reconciliation | Reconcile correspondent banking accounts |
| Inter-branch reconciliation | Reconcile transactions between branches of the same institution |
| Opening/closing balance validation | Validate that period-end balances are consistent across systems |

**Success metrics:**
- Reduce balance discrepancy resolution time by 70%
- Eliminate manual spreadsheet-based account reconciliation
- Provide audit-ready balance reconciliation trail for CBN examinations

---

## 8. Feature Specifications

### 8.1 Data Ingestion

**8.1.1 File Upload (Manual)**

The system accepts CSV, XLSX, and XLS files. Each channel has a configurable column mapping that allows institutions to map their existing export formats without reformatting data. Files are validated against the channel's format specification before processing, and validation errors are reported at the row level with clear descriptions. A SHA-256 hash of each file is stored to prevent duplicate uploads. The default file size limit is 50 MB, configurable per organisation.

**8.1.2 SFTP Ingestion**

Each channel can be configured with an independent SFTP connection (host, port, username, password or SSH key, remote path, file pattern). The system polls the SFTP server at a configurable interval (minimum 15 minutes). SFTP credentials are encrypted at rest using AES-256 before storage. Every pull attempt is logged with the file name, record count, success/failure status, and timestamp. Failed pulls trigger an email notification to the configured alert recipients.

**8.1.3 REST API Ingestion**

The system provides a REST API endpoint for push-based ingestion. Each organisation has its own API keys with configurable permission scopes. The endpoint validates the API key, rate-limits requests per key, and logs every ingestion event with the source IP, key prefix, record count, and status. Ingestion logs are accessible from the API Ingestion page in the Advanced Tools section.

**8.1.4 Woodcore Core Banking Connector**

A dedicated connector for the Woodcore core banking system has been implemented. It supports direct queries against the Woodcore test tenant for transaction history, account balances, and customer data. This connector is currently blocked by an IP whitelisting requirement from Woodcore. Once the whitelist is resolved, the connector will be activated for institutions running on Woodcore CBS.

### 8.2 Channel Management

A channel represents a single data source (e.g., "Interswitch Settlement File", "Core Banking Ledger", "Mobile Money Wallet"). The platform supports 14 channel types:

| Channel Type | Description |
|---|---|
| `bank_core` | Core banking system transaction log |
| `nibss` | NIBSS NIP transaction file |
| `pos` | Point-of-sale terminal settlement |
| `atm` | ATM transaction log |
| `mobile_money` | Mobile money wallet transaction log |
| `bank_transfer` | Bank-to-bank transfer log |
| `agent_banking` | Agent banking network transaction log |
| `fintech_api` | Fintech API transaction feed |
| `card_payments` | Card scheme settlement file (Mastercard, Visa, Verve) |
| `rtgs` | Real-Time Gross Settlement |
| `swift` | SWIFT international transfer log |
| `mobile_banking` | Mobile banking application transaction log |
| `ussd` | USSD session transaction log |
| `qr_payment` | QR code payment transaction log |

Each channel has independently configurable matching rules (amount tolerance, date window, reference format normalisation), file format specifications (column mapping for CSV/Excel uploads), and alert thresholds (exception count ceiling, match rate floor).

### 8.3 Reconciliation Engine

**Job configuration parameters:**
- Source channel and target channel
- Settlement date range
- Amount tolerance (default 0.5%, configurable per channel)
- Date window (default ±3 days, configurable per channel)
- Module type (`settlement` or `account_level`)
- Notification recipients (email addresses for completion/failure alerts)

**Matching pipeline — seven methods applied in priority order:**

| Priority | Method | Description | Confidence Range |
|---|---|---|---|
| 1 | `exact` | Reference number, amount, and date match exactly | 1.00 |
| 2 | `amount_tolerance` | Reference and date match; amount within configured tolerance | 0.90–0.99 |
| 3 | `date_window` | Reference and amount match; date within configured window | 0.85–0.95 |
| 4 | `fuzzy` | Reference matches after normalisation (prefix/suffix stripping, format standardisation) | 0.75–0.90 |
| 5 | `ai_suggested` | LLM identifies probable match based on amount, date, and partial reference similarity | 0.60–0.90 |
| 6 | `reversal` | Transaction identified as reversal of a previously matched transaction | 0.95–1.00 |
| 7 | `manual` | Operations officer manually links two transactions | 1.00 (human-confirmed) |

Every match records the method used, the confidence score, and the user who approved it (for manual and AI-suggested matches). AI-suggested matches with confidence below 0.75 are automatically placed in the review queue for human confirmation before being marked as final.

### 8.4 Exception Management

Every unmatched transaction is classified into one of eight exception categories:

| Category | Description | Typical Cause |
|---|---|---|
| `missing_counterparty` | Transaction exists in one system only | Processor not yet settled; CBS not yet posted |
| `amount_mismatch` | Counterparty found but amounts differ beyond tolerance | Fees deducted at source; denomination error |
| `timing_difference` | Counterparty found but dates differ beyond window | Clock drift; different settlement windows |
| `duplicate_transaction` | Reference appears more than once in the same channel | Retry without idempotency key; double posting |
| `unmatched` | No counterparty found after all matching methods | Genuine missing transaction; data not yet available |
| `reversal_unmatched` | Reversal exists but original transaction not found | Original in a different settlement window |
| `currency_mismatch` | Counterparty found but currencies differ | Multi-currency account; denomination error |
| `format_error` | Transaction record is malformed | Export format change; encoding issue |

Each exception is assigned a severity level based on the exception category, the transaction amount, and configurable severity rules:

| Severity | Typical Criteria | Response SLA |
|---|---|---|
| `critical` | Amount > ₦10M; `missing_counterparty` on settlement day | Immediate escalation |
| `high` | Amount > ₦1M; `amount_mismatch` on settlement day | Resolve within 2 hours |
| `medium` | Amount > ₦100K; `timing_difference` | Resolve within 24 hours |
| `low` | Amount < ₦100K; `format_error` | Resolve within 72 hours |

Every exception receives an AI-generated analysis and resolution suggestion at the time of classification. The AI analysis draws on the Super Agent's semantic memory of previously resolved exceptions in the same category and amount range.

**Exception workflow states:** `open → in_review → resolved / dismissed / escalated`

All state changes are recorded in the audit log with the user ID, timestamp, and previous and new state values.

### 8.5 Review Queue

The review queue presents all matches with `status = pending_review` — AI-suggested matches and manual matches awaiting confirmation. Reviewers can confirm or reject each match with a single action. Rejected matches are returned to the exception queue for re-classification.

The review queue also surfaces exceptions that have been escalated and are awaiting senior review. Escalated exceptions display the escalation reason and the name of the officer who escalated them.

### 8.6 Reporting

**Report types:** `daily | weekly | monthly | custom date range`

**Report content:** Total transactions processed, matched count and match rate, exception count by category and severity, channel-level breakdown, top exception categories, operator activity summary, comparison to previous period.

**Export formats:** PDF (compliance and archiving), Excel (operations teams who need to further analyse the data). Both formats are required and must be available before the Lapo pilot goes live.

**Shared reports:** Reports can be shared via a signed token that provides time-limited, read-only access without requiring the recipient to log in. Tokens have a configurable expiry (default 7 days) and are revocable by the report owner.

**CFO weekly digest:** A scheduled email with summary metrics and a PDF attachment, delivered at a configurable time on a configurable day of the week.

### 8.7 CBN Compliance Reports

The CBN Compliance module supports the complete lifecycle of CBN regulatory reporting:

- **Framework management:** Report name, frequency, submission deadline, responsible officer
- **Submission tracking:** Draft → Submitted → Acknowledged → Queried → Closed
- **Findings management:** Finding description, severity, remediation deadline, responsible officer
- **Action plan tracking:** Action description, due date, completion status
- **Automated reminders:** Email reminders to responsible officers when submission deadlines are approaching (configurable lead time, default 7 days)
- **CBN audit log:** All CBN module activity is recorded in a dedicated, immutable audit log

### 8.8 Anomaly Detection

The anomaly detection module runs independently of the reconciliation engine and monitors transaction patterns for unusual activity.

**Detection methods:** `statistical | ml_model | rule_based | velocity | pattern`

**Configurable detection rules per organisation:**
- Velocity limits (maximum transactions per hour per channel)
- Amount thresholds (flag transactions above a configurable amount)
- Pattern rules (flag transactions matching a specific reference pattern)
- Time-of-day rules (flag transactions outside business hours)

**Review workflow:** `pending → false_positive / confirmed / escalated / resolved`

Confirmed anomalies trigger a notification to the configured alert recipients and are recorded in the audit log.

### 8.9 Scheduled Tasks

The system supports automated reconciliation scheduling with the following configuration options:

- **Frequency:** `daily | weekly | biweekly | monthly` or custom cron expression
- **Time of day and day of week:** Configurable per task
- **Channel selection:** One or more channels per job
- **Notification recipients:** Email addresses to notify on completion or failure
- **Retry policy:** Number of retries on failure, retry interval

The system maintains a run history for every scheduled task, recording the start time, end time, status, record count, match rate, and exception count for each execution.

### 8.10 Advanced Tools

The Advanced Tools section is accessible to financial services portal users and contains five tools:

| Tool | Purpose |
|---|---|
| **Sample Data Generator** | Generate realistic test transaction data for demos, onboarding, and QA |
| **Integrations** | Manage webhooks (HMAC-signed, configurable events) and API keys (scoped permissions) |
| **API Ingestion** | Configure and test API-based data sources; view ingestion logs |
| **SFTP Config** | Manage SFTP credentials and ingestion schedules; view pull history |
| **Anomaly Detection** | Configure detection rules; review and action anomaly scores |

A visual alert badge on the Advanced Tools dropdown indicates when new anomalies or integration errors are detected, drawing the operations team's attention without requiring them to navigate to the section.

### 8.11 Admin Features

| Feature | Description |
|---|---|
| **User Management** | Invite users via magic link, assign roles (`admin / user / auditor`), deactivate accounts |
| **Email Settings** | Configure outbound email (SMTP), notification templates, delivery preferences |
| **Module Configuration** | Enable/disable Settlement Reconciliation and Account-Level Reconciliation modules |
| **Data Protection** | NDPA/NDPR compliance settings, data deletion requests, security incident tracking |
| **Audit Trail** | Full, append-only log of all user and system actions with timestamp, user, and action detail |

### 8.12 Super Agent

The Super Agent is a conversational AI interface embedded in the platform. It assists operations staff in resolving exceptions and answering questions about reconciliation data.

**Capabilities:**
- Natural language Q&A over the organisation's reconciliation data
- Context-aware resolution suggestions based on exception category and historical patterns
- Draft resolution actions (status changes, resolution notes, escalations) for human approval
- Plain-language explanation of AI reasoning and historical precedent
- Anomaly narrative generation

**Safety model:** The Super Agent operates under a strict human-in-the-loop constraint. It may draft actions but must not execute them without explicit human approval. All drafted actions are displayed to the user for review before execution. This constraint is enforced at the procedure level and cannot be bypassed.

**Semantic memory:** The Super Agent maintains a semantic memory layer that records the exception category, amount range, resolution outcome, and resolution notes for every resolved exception. This memory is used to improve the quality of resolution suggestions over time. Memory entries are scoped to the organisation — one institution's resolution history does not influence another institution's suggestions.

### 8.13 Super Admin Portal (Infinity AI Only)

The Super Admin portal is accessible only to users with `role = super_admin` and `organizationId` mapped to Infinity AI Africa Limited. It provides cross-tenant visibility and control.

**Capabilities:**
- **Platform control centre:** Aggregate statistics across all organisations (total transactions, match rates, exception counts, active users)
- **Organisation management:** Create, edit, and segment-assign organisations; view organisation-level health metrics
- **User management:** View and manage users across all organisations
- **Module overrides:** Force-enable or force-disable any module for any organisation, with a mandatory reason field and full audit trail
- **Portal context switcher:** Enter any organisation's portal and see the application exactly as that organisation's admin would see it, with a persistent banner showing the active context and a one-click exit
- **Cross-tenant audit log:** View all platform-level events across all organisations

**Portal context switcher detail:** When a super admin enters a portal context, the sidebar navigation switches to the segment-specific navigation for that organisation (Financial Services or Corporate B2B), the sidebar header displays the organisation name and segment, and all data queries are scoped to the viewed organisation. The context is preserved across page refreshes (sessionStorage) and clears automatically when the tab is closed.

---

## 9. AI and LLM Integration

### 9.1 LLM Use Cases

| Feature | LLM Role | Frequency |
|---|---|---|
| Exception AI analysis | Generate human-readable analysis and suggested resolution | Per exception created |
| AI-suggested matching | Score ambiguous transaction pairs and recommend matches | Per matching pass |
| Super Agent — Q&A | Natural language queries over reconciliation data | Per user query |
| Super Agent — Action drafts | Draft resolution actions for human approval | Per user request |
| Super Agent — Memory | Summarise and store organisation-specific resolution patterns | Per resolved exception |
| Anomaly narrative | Generate plain-English explanation of detected anomalies | Per confirmed anomaly |

### 9.2 Current Implementation (Manus Forge — Prototype Only)

In the prototype, all LLM calls are made via the Manus Forge API gateway, using the `BUILT_IN_FORGE_API_KEY` environment variable injected automatically by the Manus platform. The model in use is **Gemini 2.5 Flash**. The `invokeLLM()` helper in `server/_core/llm.ts` abstracts the provider entirely — all callers use the same interface regardless of which provider is active.

### 9.3 Production LLM Replacement (Rocket.new)

The Manus Forge gateway is **not available outside the Manus platform**. When moving to Rocket.new, the LLM integration must be replaced. The `invokeLLM()` helper is already designed for this transition and requires **zero code changes** — only environment variable changes.

**Step 1 — Set the following environment variables in Rocket.new:**

```
DIRECT_LLM_API_KEY=<your OpenAI or Anthropic API key>
DIRECT_LLM_API_URL=https://api.openai.com/v1/chat/completions
DIRECT_LLM_MODEL=gpt-4o
```

For Anthropic, use:
```
DIRECT_LLM_API_URL=https://api.anthropic.com/v1/messages
DIRECT_LLM_MODEL=claude-3-5-sonnet-20241022
```

**Step 2 — Provider auto-selection.** The `resolveProvider()` function in `server/_core/llm.ts` checks for `DIRECT_LLM_API_KEY` first. If set and non-empty, it routes all LLM calls to the direct provider. If not set, it falls back to Manus Forge. No code changes are required.

**Step 3 — Recommended model choices for production:**

| Use Case | Recommended Model | Rationale |
|---|---|---|
| Exception analysis, anomaly narrative | `gpt-4o-mini` or `claude-3-haiku-20240307` | Cost-efficient, fast, sufficient quality |
| AI-suggested matching | `gpt-4o` or `claude-3-5-sonnet-20241022` | Higher accuracy required for financial data |
| Super Agent Q&A and action drafts | `gpt-4o` or `claude-3-5-sonnet-20241022` | Reasoning quality is critical |

**Step 4 — Cost management.** Implement per-organisation monthly token budget tracking. Gate AI features behind the module configuration toggle so institutions can opt out of AI-powered features to control costs. Monitor token usage per use case and switch to cheaper models for high-frequency, lower-stakes operations (exception analysis) while retaining premium models for low-frequency, high-stakes operations (Super Agent action drafts).

**Step 5 — Streaming for the Super Agent.** The Super Agent currently uses `streamdown` for streaming responses. The `invokeLLM()` helper returns a complete response. For production, extend the helper with a `stream: true` parameter that returns an `AsyncIterable<string>` and pipe it to a tRPC subscription or Server-Sent Events (SSE) endpoint. Both OpenAI and Anthropic support SSE streaming natively.

**Step 6 — Structured outputs.** Several use cases (AI-suggested matching, action drafts) use `response_format: { type: "json_schema" }` to ensure the LLM returns structured JSON. This is supported by OpenAI's `gpt-4o` and `gpt-4o-mini` models. For Anthropic, use the `tool_use` pattern to achieve equivalent structured output.

---

## 10. Multi-Tenancy and Access Control

### 10.1 Tenant Architecture

The platform is multi-tenant with hard data isolation. Every database table that holds business data includes an `organizationId` foreign key. All tRPC procedures scope queries to `ctx.user.organizationId` at the procedure level. There is no mechanism for one organisation to access another organisation's data except through the Super Admin portal, which requires `role = super_admin`.

**Tenant segments:**

| Segment | Description | Portal Features |
|---|---|---|
| `financial_services` | Banks, MFBs, fintechs, payment processors | Full feature set |
| `corporate_b2b` | FMCG distributors, corporate treasuries | Distributor Registry, core reconciliation |
| `super_admin` | Infinity AI Africa Limited | Platform control centre, cross-tenant access |

### 10.2 User Roles

| Role | Scope | Key Permissions |
|---|---|---|
| `super_admin` | Platform-wide | All operations, cross-tenant access, module overrides, portal context switching |
| `admin` | Organisation-wide | User management, module configuration, all data operations, email settings |
| `user` (standard) | Organisation-wide | Upload data, run reconciliation, resolve exceptions, view reports |
| `guest` | Session-scoped | Read-only demo access via guest token (no account required) |

Role-based access is enforced at the tRPC procedure level via three middleware guards:
- `publicProcedure` — no authentication required
- `protectedProcedure` — any authenticated user
- `adminProcedure` — `role = admin` within the organisation
- `superAdminProcedure` — `role = super_admin` (Infinity AI only)

### 10.3 Authentication

**Prototype (current):** Manus OAuth — a managed OAuth 2.0 flow provided by the Manus platform. This is not available outside the Manus environment and must be replaced for production.

**Production (required before Lapo pilot):** Email/password authentication with magic link support. The `magic_link_tokens` table is already present in the schema. The authentication flow must be implemented as follows:
1. User enters email address
2. System generates a time-limited (15-minute) magic link token, stores it in `magic_link_tokens`, and sends an email with the link
3. User clicks the link; system validates the token, creates a session, and redirects to the dashboard
4. For returning users, offer email/password as an alternative to magic link

The `magicLinkTokens` table and the `MagicLogin` page are already implemented in the prototype. The remaining work is the email sending integration (Resend or SendGrid) and the session creation logic.

---

## 11. Non-Functional Requirements

### 11.1 Performance

| Metric | Target |
|---|---|
| Reconciliation job (100,000 transactions) | Complete within 5 minutes |
| Dashboard load time (with cache) | < 2 seconds |
| File upload processing (50 MB) | < 30 seconds |
| API response time (p95) | < 500 ms |
| Concurrent organisations | ≥ 50 without performance degradation |

### 11.2 Security

All data in transit must be encrypted using TLS 1.2 or higher. All data at rest must be encrypted at the database level. SFTP credentials must be encrypted at the field level before storage. API keys must be stored as SHA-256 hashes; the plaintext key must only be displayed once at creation time. Session tokens must be signed using HMAC-SHA256 and must expire after 24 hours of inactivity. All user actions must be recorded in the audit log with sufficient detail to reconstruct the sequence of events.

Webhook payloads must be signed using HMAC-SHA256 with a per-webhook secret, allowing receiving systems to verify the authenticity of webhook deliveries.

### 11.3 Availability

| Environment | Target Uptime | Maintenance Window |
|---|---|---|
| Pilot | 99.5% | Weekends, 00:00–06:00 WAT |
| Production | 99.9% | Sundays, 00:00–04:00 WAT |

The background reconciliation runner must recover automatically from failures and resume from the last checkpoint. Scheduled tasks that fail must retry up to 3 times before sending a failure notification.

### 11.4 Data Residency

For Nigerian financial institutions, all transaction data must be stored in data centres located within Nigeria or, at minimum, within Africa. The production deployment must use AWS `af-south-1` (Cape Town) or an equivalent African region. This requirement must be confirmed with Lapo MFB's compliance team before the pilot goes live.

### 11.5 Compliance

The platform must comply with the Nigeria Data Protection Act (NDPA) 2023 and the Nigeria Data Protection Regulation (NDPR) 2019. Implemented compliance controls include:

- Configurable data retention policy (default 7 years for financial data)
- Data deletion request workflow with audit trail
- Security incident reporting mechanism with severity classification
- Compliance settings management (data processing basis, consent records)
- Compliance readiness self-assessment tool (public, no login required)

---

## 12. Integrations

### 12.1 Current Integrations (Prototype)

| Integration | Type | Status |
|---|---|---|
| Woodcore Core Banking | REST API | Implemented — blocked by IP whitelist |
| Interswitch Settlement Files | CSV / SFTP | Implemented |
| UPSL | CSV upload | Implemented |
| eTranzact | CSV upload | Implemented |
| Manus OAuth | OAuth 2.0 | Active (prototype only) |
| Manus Forge LLM | REST API | Active (prototype only) |
| Manus S3 Storage | S3-compatible | Active (prototype only) |

### 12.2 Required Integrations (Before Lapo Pilot)

| Integration | Type | Priority | Notes |
|---|---|---|---|
| Email (Resend or SendGrid) | SMTP / API | P0 | Required for magic link auth, notifications, scheduled reports |
| Lapo MFB Core Banking | REST API or SFTP | P0 | Format to be confirmed in pilot onboarding |
| OpenAI or Anthropic | REST API | P0 | Replace Manus Forge LLM gateway |
| AWS S3 or Cloudflare R2 | S3-compatible | P0 | Replace Manus S3 storage |

### 12.3 Planned Integrations (During Pilot)

| Integration | Type | Priority |
|---|---|---|
| Lapo Mobile Money Platform | REST API | P1 |
| CBN NIP / NIBSS | SFTP | P1 |
| Interswitch Nibss | API / SFTP | P2 |
| Mastercard / Visa / Verve settlement files | CSV / SFTP | P2 |

---

## 13. Pilot Scope — Lapo MFB

The Lapo MFB pilot is the first paid engagement and the primary validation event for the product. The pilot scope is deliberately narrow to maximise the probability of a successful outcome within the 90-day window.

### 13.1 Pilot Phase 1 — Onboarding and Historical Validation (Weeks 1–4)

- Onboard Lapo MFB as a `financial_services` tenant
- Conduct a data format discovery session to understand Lapo's CBS export format
- Configure 2–3 channels: core banking, mobile money, and one payment processor
- Run Settlement Reconciliation on 30 days of historical data
- Measure: match rate, exception reduction, time-to-reconcile
- Deliver a Phase 1 findings report to Lapo's operations director

### 13.2 Pilot Phase 2 — Live Operations (Weeks 5–8)

- Enable live ingestion (SFTP or API, depending on Lapo's infrastructure)
- Run scheduled daily reconciliation (3 settlement windows per day)
- Enable the full exception workflow (assign, resolve, escalate)
- Deliver the first CBN compliance report using the platform
- Conduct a 2-day operations team training session

### 13.3 Pilot Phase 3 — Validation and Contract (Weeks 9–12)

- Collect NPS scores from the operations team
- Prepare a pilot outcomes report against the success criteria
- Present the production SLA and commercial terms
- Target: signed production contract by end of Week 12

### 13.4 Pilot Success Criteria

| Metric | Target |
|---|---|
| Match rate (auto-matched) | ≥ 95% |
| False positive rate | < 5% |
| Time-to-reconcile per settlement window | < 30 minutes |
| Exceptions resolved without escalation | ≥ 80% |
| Reconciliation officer time saved | ≥ 50% |
| Operations team NPS | ≥ 7 / 10 |
| Production incidents (P0/P1) | 0 |

### 13.5 Lapo-Specific Technical Notes

Lapo MFB does not use Woodcore as its core banking system. A dedicated connector will be built for Lapo's CBS export format during the pilot onboarding phase. Card transactions (Mastercard, Visa, Verve) originating from Interswitch must be supported as a payment channel. The SFTP ingestion module is the primary data pathway; API ingestion is a secondary pathway for real-time transaction feeds.

---

## 14. Roadmap Alignment

This PRD covers the **Q1 FY1** product and engineering deliverables from the GTM roadmap.

| GTM Item | PRD Section |
|---|---|
| Pilot with Lapo MFB | Section 13 |
| Settlement Reconciliation module | Section 7.1 |
| Account-Level Reconciliation module | Section 7.2 |
| AI exception analysis and matching | Section 9 |
| CBN compliance reports | Section 8.7 |
| Super Agent (MVP) | Section 8.12 |
| Multi-tenant architecture | Section 10 |
| Super Admin portal | Section 8.13 |
| Financial Services portal (full feature set) | Section 5.1 |
| Corporate B2B portal (FY2) | Section 5.2 |

---

## 15. Out of Scope

The following capabilities are explicitly out of scope for the current version and the Lapo pilot.

**Mobile application.** ReconcileAI is a desktop-first product. No iOS or Android application will be built in FY1. The web application is responsive and accessible on mobile browsers for read-only use cases, but the primary operations workflow requires a desktop environment.

**Multi-currency settlement netting.** All amounts are treated as NGN in the current version. Multi-currency support is deferred to a future release.

**Open banking integration (NIBSS direct API).** Direct integration with the NIBSS open banking API requires a separate API access agreement and regulatory approval. The NIP channel is supported via file-based ingestion in the current version.

**Automated CBN submission.** The CBN compliance module supports report preparation and tracking but does not submit reports directly to the CBN portal. Automated submission requires a separate API agreement with the CBN and is deferred to a future release.

**Automated exception resolution.** The Super Agent drafts resolutions but does not execute them without human approval. Fully automated exception resolution is not supported in the current version.

**General ledger write-back.** The Account-Level Reconciliation module reconciles at the account balance level but does not write back to the institution's general ledger. GL write-back requires a separate ERP integration and is out of scope.

**White-labelling.** The platform is not white-labelled in the current version. All client-facing pages display ReconcileAI branding.

---

## 16. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Lapo CBS export format is non-standard | High | High | Conduct format discovery session in Week 1; build custom column mapping in the SFTP ingestion module |
| Match rate below 95% due to data quality | Medium | High | Run data quality assessment in Week 1; implement data cleansing rules for known format issues before going live |
| Manus OAuth dependency in production | High | High | Replace with email/password + magic link authentication before pilot go-live |
| LLM API cost overrun | Low | Medium | Use `gpt-4o-mini` for high-frequency operations; implement per-organisation monthly token budget |
| CBN data residency requirement | Medium | High | Deploy production on AWS `af-south-1`; confirm with Lapo compliance team |
| Operations staff resistance to adoption | Medium | Medium | 2-day onboarding workshop; dedicated customer success contact for pilot duration |
| Woodcore IP whitelist not resolved | High | Low | Lapo does not use Woodcore; this risk does not affect the Lapo pilot |
| Rocket.new build timeline overrun | Medium | High | Prioritise authentication and core reconciliation engine; defer Advanced Tools and CBN module to Sprint 2 |

---

## 17. Glossary

| Term | Definition |
|---|---|
| **CBS** | Core Banking System — the primary transaction processing system of a financial institution |
| **CBN** | Central Bank of Nigeria — the primary financial services regulator in Nigeria |
| **Channel** | A single data source (e.g., Interswitch settlement file, core banking ledger) |
| **Exception** | A transaction that cannot be automatically matched and requires human review |
| **Job** | A single reconciliation run between a source and target channel |
| **Match** | A confirmed pairing between a source and target transaction |
| **Match rate** | The percentage of transactions successfully matched by the engine |
| **MFB** | Microfinance Bank — a category of financial institution licensed by the CBN |
| **NIP** | NIBSS Instant Payment — the primary interbank instant payment scheme in Nigeria |
| **NIBSS** | Nigeria Inter-Bank Settlement System — the national payment infrastructure operator |
| **NDPA** | Nigeria Data Protection Act 2023 |
| **NDPR** | Nigeria Data Protection Regulation 2019 |
| **Settlement window** | A defined time period within which processor settlements are batched |
| **Super Agent** | ReconcileAI's AI-powered conversational assistant for exception resolution |
| **Tenant** | An organisation that uses the ReconcileAI platform |
| **tRPC** | TypeScript Remote Procedure Call — the API framework used by ReconcileAI |
| **WAT** | West Africa Time — UTC+1, the standard time zone for Nigeria |
