# ReconcileAI — Competitive Gap Closure Implementation Plan

> **Sources:** merges the *Credrails vs. ReconcileAI Competitive Intelligence Report* (July 2026) — specifically **Section 9: Recommendations for ReconcileAI** — with the *Product Feature Gap Roadmap* (July 2026). Where the two documents differ, this plan reconciles them and says so explicitly.
> **Status:** ACTIVE — this is the execution plan. Review quarterly (see §7).
> **Owner:** Richard Anwanakak (CEO). Engineering execution: Claude Code sessions in this repo.

---

## 1. How the Two Documents Were Merged

The Gap Roadmap covers 9 gaps. CI Report Section 9 makes 8 recommendations. They overlap almost 1:1, with **two Section 9 items that the Gap Roadmap does not carry as workstreams**:

| CI §9 Recommendation | Gap Roadmap Equivalent | Resolution in this plan |
|---|---|---|
| 1. Publish LAPO case study | Gap 7 (Reference Customers) | Workstream **WS-1** |
| 2. Begin PCI DSS assessment | Gap 5 | Workstream **WS-2** |
| 3. Mobile money reconciliation module | Gap 2 | Workstream **WS-3** |
| 4. Build a developer API | Gap 1 + Gap 9 (webhooks) | Workstream **WS-4** |
| 5. **Deepen the cross-institution intelligence network** | *— not in roadmap —* | **Added as WS-5** (H1→H2, continuous) |
| 6. Multi-currency capability | Gap 4 | Workstream **WS-6** |
| 7. Pan-African expansion thesis | Gap 6 | Workstream **WS-9** (H3) |
| 8. **Defend the AI intelligence moat aggressively** | Roadmap's "Non-Negotiable Constraint" | Elevated to the **Moat Gate** (§2) — a standing decision rule, not a workstream |
| — | Gap 8 (ERP integration) | Workstream **WS-7** |
| — | Gap 3 (Wallet / Insurance) | Workstream **WS-8** |

**Net result: 9 workstreams + 1 governing gate.**

---

## 2. Guiding Principles

1. **Sequencing rule** (Gap Roadmap): procurement blockers first → market expanders second → strategic positioning third. Market expanders are closed **in sequence, not in parallel**, to avoid spreading engineering capacity thin.
2. **The Moat Gate** (CI §9, Rec 8): every feature in this plan is evaluated against *"Does this make the AI smarter, or does it just make the platform wider?"* Breadth features must carry an intelligence-depth component (new exception taxonomies, new diagnosis prompts, new learning-flywheel inputs) or they get deprioritised. Concretely: **every new reconciliation vertical ships with its own exception taxonomy, resolution templates, and AI diagnosis prompts — never matching-only.**
3. **Proof before promise** (CI §9, Rec 1): the LAPO case study outranks every engineering item. No engineering work may block or delay POC-conversion support work.
4. **Engineering enablers ride along**: known tech debt that directly serves a workstream (rate limiting, router split, job queue) is scheduled inside that workstream, not as separate "cleanup."

---

## 3. Workstream Summary

| WS | Name | Type | Horizon | Priority | Effort | Owner |
|---|---|---|---|---|---|---|
| WS-1 | LAPO case study → Woodcore → Salad | Procurement blocker (commercial) | H1 | 10/10 | Low (eng: small support) | CEO |
| WS-2 | PCI DSS certification | Procurement blocker | H1 | 9/10 | Medium | CTO |
| WS-3 | Mobile money reconciliation | Market expander | H1 | 8/10 | Medium (6–10 wks) | Eng Lead |
| WS-4 | Developer API + webhooks + sandbox | Procurement blocker (at scale) | H2 | 9/10 | High (3–4 mo) | Eng Lead |
| WS-5 | Cross-institution intelligence network | Moat deepening (CI §9 Rec 5) | H1→H2 | 8/10 | Medium, continuous | Eng Lead |
| WS-6 | Multi-currency + FX exceptions | Market expander | H2 | 6/10 | Low–Med (3–4 wks) | Eng Lead |
| WS-7 | ERP integration (export → native) | Strategic positioning | H2 | 6/10 | Medium | Product Lead |
| WS-8 | Wallet recon (insurance deferred) | Market expander | H2→H3 | 5/10 | Medium | Product Lead |
| WS-9 | Pan-African expansion | Market expander | H3 | 4/10 now | High | CEO |

---

## 4. Horizon 1 (Months 0–6)

### WS-1 — Reference Customers at Scale (Gap 7 / CI Rec 1) — **THE top priority**

Commercial workstream; engineering plays a support role only.

**Commercial checklist (CEO):**
- [ ] Convert LAPO MFB POC → signed annual contract within 30 days of KPI achievement
- [ ] Case-study rights clause **in the contract at signing** (quantified outcomes + name + logo)
- [ ] Publish case study within 60 days of signing (Nomba format: problem → solution → quantified outcomes → CFO/Head-of-Ops quote); distribute via website, LinkedIn, direct outreach to the 15 most-similar Nigerian MFBs
- [ ] Repeat for Woodcore (CBS-vendor persona) and Salad Africa (FMCG persona)

**Engineering support (this repo):**
- [ ] **KPI evidence export**: one-click export of the POC KPI dashboard (false-positive rate, resolution time, chargeback detection rate, audit confidence vs. target/floor bands) as a shareable PDF/CSV pack — the quantified-outcomes engine for every case study. Builds on the existing KPI dashboard and `reconciliationReports` / `sharedReportTokens` infrastructure.
- [ ] Public case-study page template on the marketing site with live-KPI embed (reuses shared report tokens).

**Success criteria:** contract ≤30 days post-KPI; case study ≤60 days post-signing; ≥3 quantified metrics; ≥5 qualified inbound enquiries within 90 days.

### WS-2 — PCI DSS Certification (Gap 5 / CI Rec 2)

Process-led (QSA engagement), with a defined engineering remediation package.

**Process (CTO):** Month 1 QSA scoping workshop → Month 1–2 gap assessment → Month 2–4 remediation → Month 4–6 SAQ + AOC, publish AOC on website. Budget ₦2.3M–₦4.5M one-time, ₦1.5M–₦2.5M/yr maintenance.

**Engineering remediation package (schedule Month 2–4, informed by QSA findings — these are the *likely* items, already known tech debt):**
- [ ] Rate limiting on all public API endpoints (`server/publicApiRouter.ts` + REST layer when it lands) — express-rate-limit (tech debt item, now PCI-mandated)
- [ ] Owner-based ACL check in `storageGet()` (S3 key access control — tech debt item)
- [ ] Encryption-at-rest verification for DB + R2/S3; TLS-everywhere audit
- [ ] Access/audit logging completeness pass (`platformAuditLogs`, `cbnAuditLog`) — every data-touching procedure logs actor + action
- [ ] Vulnerability scanning + pen-test remediation cycle
- [ ] Confirm the on-prem deployment (`deploy/on-prem`) control set is documented — it already implements several controls by design and is a sales asset in the assessment

**Success criteria:** scoping done M1; gap report M2; critical controls M4; AOC published M6; zero PCI objections in subsequent sales processes.

### WS-3 — Mobile Money Reconciliation Module (Gap 2 / CI Rec 3)

10-week build. Structurally a sibling of the card-settlement capability we already have. **Moat Gate compliance:** ships with full taxonomy + templates + AI diagnosis, not matching-only.

| Week | Deliverable | Where in the codebase |
|---|---|---|
| 1–2 | Exception taxonomy: 8–12 categories (failed USSD debit-no-credit, reversed transfer not credited, NIP settlement shortfall, duplicate MoMo credit, expired USSD session debit, etc.) | Taxonomy doc in `docs/`; categories in `server/exceptionIntelligence.ts` |
| 2–4 | Settlement-file parsers: NIBSS NIP, OPay, Palmpay formats (CSV/Excel, operator-specific columns), auto-detected | Extend `server/poc-engine.ts` + `server/reconciliationEngine.ts` parser layer (operator names already exist as channel labels; real format parsing is new) |
| 4–6 | AI diagnosis: mobile-money prompts (CBN mobile-money guidelines context vs. card-scheme rules), resolution templates seeded per category | `server/exceptionIntelligence.ts`, `server/seedResolutionTemplates.ts` |
| 6–8 | UI: "Mobile Money" channel in exception dashboard — same pattern as card settlement view (exception list → AI diagnosis panel → resolution workflow → KPI) | `client/src/pages/` + `client/src/components/DashboardLayout.tsx` channel nav |
| 8–10 | Validate in LAPO production; capture outcomes for the case study (links WS-3 → WS-1) | — |

**Testing (per repo convention):** Vitest coverage for every parser and each new exception category classifier — same standard as `poc-engine.test.ts` / `exceptionIntelligence.test.ts`.

**Success criteria:** 3 operator formats parse without manual config; ≥8 exception categories; AI diagnosis ≥85% accuracy; validated at LAPO ≤10 weeks; included in LAPO case study.

### WS-5 (start) — Intelligence Network Foundation (CI Rec 5 — *added; not in the Gap Roadmap*)

The cross-institution network only becomes a moat with **5–7 contributing institutions**; recommendations beat single-institution data at ~3+. H1 goal: make the plumbing production-grade so every conversion immediately feeds it.

- [ ] Audit `agentMemory` / RAG ingestion: confirm every resolved exception (all channels, incl. new mobile-money) writes a learning record with institution-scoped + anonymised-shared tiers
- [ ] Anonymisation review: verify the privacy-preserving pattern-sharing layer strips institution-identifying fields (procurement + NDPA requirement)
- [ ] Network dashboard metric: "recommendations informed by cross-institution patterns — %" as an internal KPI, so we can *prove* flywheel compounding in sales conversations
- [ ] Commercial dependency: getting LAPO/Woodcore/Salad live on the **full platform** (not POC) is what feeds the network — tracked under WS-1

---

## 5. Horizon 2 (Months 6–18)

### WS-4 — Developer API, Sandbox & Webhooks (Gap 1 + Gap 9 / CI Rec 4)

Builds **on top of** what exists: `server/publicApiRouter.ts` (API-key validation), `apiKeys` + `webhooks` tables in `drizzle/schema.ts`. What's missing: a true REST surface, public docs, self-service sandbox, and outbound webhook **delivery**.

**Pre-work enablers (Month 6, before API code):**
- [ ] Split `server/routers.ts` (~5,500 lines) into `server/routers/<domain>.ts` — the API layer wraps these procedures; wrapping a monolith bakes the debt in (tech-debt item, now on the critical path)
- [ ] Stand up BullMQ + Redis job queue (deferred tech-debt item) — required for reliable webhook delivery with retries and for API-triggered async reconciliation runs

**Phases (per Gap Roadmap):**
1. **M6–7 — Design first**: OpenAPI 3.0 spec for 5 resource groups — `/reconciliation`, `/exceptions`, `/templates`, `/intelligence`, `/kpi`. Publish docs at `developers.<domain>` **before building** (sales asset). *Note: decide docs domain — production is `reconcileaiafrica.com`; the roadmap doc says `reconcileai.vip`.*
2. **M7–9 — REST gateway**: Express layer translating REST ↔ existing tRPC procedures; API-key auth, rate limiting (shared with WS-2 work), request/response logging (`apiIngestionLogs`)
3. **M9–10 — Sandbox**: self-service signup → API key → first call in ≤15 minutes, on synthetic data (reuse `sampleDataGenerator.ts`)
4. **M10–11 — Webhooks**: outbound events `exception.created`, `exception.resolved`, `reconciliation.completed`, `kpi.threshold.breached`; retry via BullMQ; delivery dashboard in admin UI
5. **M11–12 — DX**: JS/Python/cURL examples per endpoint, Swagger UI/Redoc explorer, "Getting Started in 5 Minutes" guide

**API also unlocks:** programmatic consumption of the on-prem deployment (bank internal systems trigger runs/pull exceptions without dashboard logins).

**Success criteria:** docs live M7; 5 resource groups M9; sandbox M10; webhook reliability ≥99.5% M11; first API-first customer M12; API cited as differentiator in ≥3 enterprise conversations by M12.

### WS-6 — Multi-Currency + FX Exception Category (Gap 4 / CI Rec 6)

- [ ] **M6 — Audit**: find every NGN assumption — Layer 1 balance checks (`server/reconciliationEngine.ts`, `server/woodcore-engine.ts`, `server/poc-engine.ts`), exception amount display, KPI amount buckets
- [ ] **M7–8 — Currency-aware engine**: `currency` field on reconciliation runs + exception records (additive schema change per repo rules); matcher compares within-currency only; UI shows currency codes
- [ ] **M8–9 — FX rate variance exception category** (Moat Gate: the intelligence component): settlement-vs-transaction-date rate variance, with AI diagnosis prompts

**Success criteria:** multi-currency documented on website M8; FX category in diagnosis engine M9; one Tier-1 bank POC using it by M12.

### WS-7 — ERP Integration (Gap 8)

Export-first, native-later — a data-transformation problem before an integration problem.

- [ ] **M6–7**: confirm target ERPs (working hypothesis: SAP Business One, Sage 300 for banks/MFBs; QuickBooks for SME fintechs/FMCG)
- [ ] **M7–10**: structured journal-entry export formats per ERP (natively importable files) — extends the existing report/CSV export layer (`s3CsvExports`)
- [ ] **M10–14**: native API push for SAP + Sage after export formats validate with ≥2 customers (requires SAP PartnerEdge / Sage Developer Programme — start certification paperwork early)

**Success criteria:** export formats live M10; 2 customers using them M12; native SAP integration M14.

### WS-8 — Wallet Reconciliation (Gap 3, wallet half)

**M9–12**, only after WS-3 ships (wallet extends the mobile-money module): wallet-specific exception categories (failed wallet credits, reversed wallet debits, settlement shortfalls) for OPay/Palmpay/Moniepoint wallets. **Insurance reconciliation is explicitly deferred** — scope only against a named customer opportunity, never speculatively.

**Success criteria:** wallet module M12; first fintech customer M14.

### WS-5 (continued) — Intelligence Network Scale-Up

Target ≥3 institutions live on the full platform contributing to the network by M12, tracking toward the 5–7 threshold. Quarterly measurement of recommendation-quality lift vs. single-institution baseline.

---

## 6. Horizon 3 (Months 18–36)

### WS-9 — Pan-African Expansion (Gap 6 / CI Rec 7)

Deliberately deferred — Nigeria-first is the bootstrapping strategy; breadth becomes a valuation driver at Series A.

- **M0–18 (prerequisite):** 5–7 published Nigerian case studies (WS-1 pipeline)
- **M18–24:** select first market — Ghana (Interswitch presence, English-speaking, CBN-adjacent) then Kenya (Credrails' home turf, strategically significant)
- **M24–30:** platform adaptation: local scheme settlement parsers (GhIPSS / Pesalink), local exception taxonomy, localised AI diagnosis prompts — core architecture unchanged; on-prem capability answers data-residency in every African market
- **M30–36:** first expansion-market reference customer, sold on the Nigerian case-study portfolio

### Insurance Reconciliation (Gap 3, second half)
Customer-driven only, M24+. Do not build speculatively.

---

## 7. Governance

**Ownership & cadence** (from Gap Roadmap, plus added WS-5):

| Workstream | Owner | Review |
|---|---|---|
| WS-1 Reference customers | CEO | Weekly |
| WS-2 PCI DSS | CTO | Monthly |
| WS-3 Mobile money | Eng Lead | Bi-weekly |
| WS-4 Developer API + webhooks | Eng Lead | Bi-weekly |
| WS-5 Intelligence network | Eng Lead | Monthly |
| WS-6 Multi-currency | Eng Lead | Monthly |
| WS-7 ERP | Product Lead | Monthly |
| WS-8 Wallet/Insurance | Product Lead | Quarterly |
| WS-9 Geographic | CEO | Quarterly |

**Quarterly review questions:** (1) Has Credrails shipped anything that changes the priority order — especially any move toward AI exception intelligence (the CI report's 18–24-month threat window)? (2) Has a customer conversation revealed a gap not on this plan? (3) Should a specific customer opportunity pull an H2 item forward?

**Standing threat triggers** (from CI §8 — escalate immediately, don't wait for the quarterly review):
- Credrails announces AI/LLM exception-diagnosis capability → accelerate WS-5
- Credrails signs a Tier-1 Nigerian bank → escalate Tier-1 pursuit (WS-6 multi-currency is the Tier-1 enabler)

**The Moat Gate applies to every item above** — see §2.

---

## 8. First 30 Days — Concrete Next Actions

| # | Action | Workstream | Type |
|---|---|---|---|
| 1 | Draft LAPO contract + case-study rights clause; define KPI-achievement trigger | WS-1 | Commercial |
| 2 | Shortlist + engage PCI DSS QSA for scoping workshop | WS-2 | Process |
| 3 | Build KPI evidence-export (PDF/CSV pack from POC KPI dashboard) | WS-1 | **Eng — this repo** |
| 4 | Write the mobile-money exception taxonomy (8–12 categories) + collect real NIBSS/OPay/Palmpay settlement-file samples from LAPO | WS-3 | Eng + Commercial |
| 5 | Begin mobile-money parser build once samples land | WS-3 | **Eng — this repo** |
| 6 | Audit `agentMemory`/RAG write-path + anonymisation layer | WS-5 | **Eng — this repo** |
| 7 | Rate limiting on `publicApiRouter.ts` (serves WS-2 *and* WS-4) | WS-2/4 | **Eng — this repo** |

Engineering items 3, 5, 6, 7 are the first Claude Code build tickets, in that order.

---

*Living document. Update alongside the quarterly roadmap review. Prepared July 2026 from the two source documents in `Documents/Infinity AI/Reconcile AI/Strategy and Product Development/`.*
