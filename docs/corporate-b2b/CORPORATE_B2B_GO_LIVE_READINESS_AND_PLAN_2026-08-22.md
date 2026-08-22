# ReconcileAI Corporate B2B Payments — Go-Live Readiness & Deployment Plan

**Prepared:** 22 August 2026  
**Scope:** Uganda and Nigeria FMCG/distributor beachheads, then repeatable Corporate B2B deployments  
**Decision standard:** Operationally safe reconciliation control; **not** a payment-initiation launch  
**Assessment type:** Technical and operational guidance, not formal legal advice. The anchor customer’s legal, tax, information-security and finance-control owners must confirm institution-specific obligations.

## Executive decision

ReconcileAI has a credible **controlled-pilot product foundation** for Corporate B2B reconciliation. It already provides a distributor registry, source-file/API ingestion, deterministic reconciliation, many-to-one and one-to-many matching, exception classification, human-reviewed action drafts, ageing, and audit surfaces. The latest local validation passed **116 test files and 1,852 tests**, followed by TypeScript compilation.

It is **not ready to control or initiate live customer payments today**. The recommended first production step is a **read-only parallel reconciliation pilot** for one FMCG manufacturer or national distributor, limited to a small distributor cohort and two authorised payment rails. ReconcileAI must ingest copies of invoice, bank-transfer and mobile-money evidence; it must not release funds, amend receivables, send customer communications, or post to an ERP without a separately approved, customer-controlled workflow.

> **The launch promise is not “we move money.” It is “we give finance an evidence-backed answer to what was received, how it should be allocated, what remains unresolved, and who must act next.”**

| Readiness conclusion | Status | What it means |
|---|---:|---|
| Controlled demonstration and customer discovery | **Ready** | Use synthetic, masked or customer-approved sample data only. |
| Read-only file-led pilot | **Conditionally ready** | Proceed after data mapping, security approval, source-file test, and the foundation hardening PRs are reviewed and deployed. |
| Parallel pilot with real, masked or approved operational data | **Not yet approved** | Requires signed data-processing terms, customer security approval, named owners, and successful dry runs. |
| Production reconciliation control | **Not yet ready** | Requires the release gates in this document and a successful parallel run. |
| Payment initiation, refund, credit-note posting, ERP posting or distributor messaging | **Out of scope** | Do not enable in the first go-live. Future integrations need distinct authority, idempotency, segregation-of-duties and customer approval controls. |

## 1. Market and operating context

The Uganda beachhead should be **FMCG distribution**, where a manufacturer or national distributor must reconcile a high-volume mix of invoices, partial remittances, trade deductions, bank transfers and mobile-money collections. Bank of Uganda identifies payment systems as critical infrastructure for secure and efficient transfers, regulates national payment systems and digital financial services, and lists MTN Mobile Money Uganda and Airtel Mobile Commerce Uganda among supervised providers.[1] GSMA reports that mobile-money merchant payments reached **US$155 billion globally in 2025**, growing by almost half; this supports treating mobile-money reconciliation as a material finance-control problem rather than an informal back-office activity.[2]

Those facts do not prove a particular distributor’s payment mix, ERP, mobile-money contract, bank interface, tax treatment, or data-retention obligations. The anchor customer must provide those facts before solution design. ReconcileAI should remain a reconciliation-control software provider, not represent itself as a payment service provider or system operator. If the intended workflow changes that boundary, Uganda legal counsel must assess the National Payment Systems framework before launch.[1]

Nigeria is the second launch geography, with the same FMCG/distributor wedge but a different evidence model. CBN identifies NIBSS, banks, payment service providers and switching companies as key payment-system participants, while NIBSS describes NIP as an account-based, real-time EFT service serving business-to-business transfers.[3] [4] A Nigerian customer pilot must therefore use **customer-authorised copies** of its bank, PSP, NIP-related or mobile-money evidence; ReconcileAI must not imply that it can initiate NIP transfers, perform name enquiry, query transaction status or access account balances unless the customer or an authorised provider has formally enabled that capability.[4]

The Nigerian rollout also requires a specific privacy workstream. The NDPC hosts the Nigeria Data Protection Act and the associated controller/processor, breach-reporting and audit services.[5] The customer and ReconcileAI must document their data-protection roles, the lawful basis for operational records, approved recipients, retention, security safeguards, incident procedure and any external-processing route before approved live data is received.

### 1.1 Two-market launch posture

| Dimension | Uganda | Nigeria |
|---|---|---|
| Initial customer profile | FMCG manufacturer, national distributor or regional sub-distributor using bank transfers and MTN MoMo/Airtel Money | FMCG manufacturer or national distributor using bank transfers, NIP-originated receipts, PSP/collection reports and any approved mobile-money evidence |
| Control focus | Distributor receipts, invoice allocations, mobile-money/bank settlement timing and trade deductions | Distributor receipts, bank/NIP evidence, payment-reference quality, bank charges, returns and trade deductions |
| Regulated-party boundary | Do not operate a payment service or system without separate analysis under the NPS framework | Do not operate or present as a payment service, switch or NIP participant; use customer-authorised evidence only |
| Privacy baseline | Customer contract, local counsel review and approved data route | NDPA roles, data-processing terms, lawful basis, retention, incident handling and external-data-route approval |
| First pilot | Read-only; 10–30 distributors; two authorised rails | Read-only; 10–30 distributors; bank evidence plus one additional authorised collection/payment evidence source |

## 2. What is currently evidenced in the product

### 2.1 Controls that can support a controlled pilot

| Product capability | Current evidence | Safe pilot use |
|---|---|---|
| Distributor identity register | The platform has a Distributor Registry and organisation-scoped distributor records. | Load only the pilot distributor roster and documented aliases; nominate a customer data steward for each change. |
| Deterministic reconciliation | The existing engine runs exact, tolerance and fuzzy passes before the Super Agent processes remaining unmatched records. | Match authorised invoice/receivable exports against bank and mobile-money receipts; retain source references. |
| Complex allocation reasoning | `runM2MMatching` supports one-to-many, many-to-one and many-to-many allocation suggestions, including invoice-reference grouping. | Treat results as **proposals** requiring finance review; do not write allocations back to the ERP in the first launch. |
| FMCG deduction interpretation | The Super Agent recognises partial payments, promotional deductions, damage deductions, bank-fee deductions, tax deductions, split payments and duplicate invoices. | Use a customer-approved deduction taxonomy and dispute/credit-note policy; retain documentary evidence. |
| Exception controls | The platform supports exception ownership, ageing, review queues, recommended actions and audit trails. | Use a named exception owner, SLA, escalation point and daily close process. |
| Ingestion protections | API ingestion validates API keys, organisation-scopes channels, hashes files for duplicate detection, stores an ingestion audit log and preserves raw source data. | Use customer-controlled API keys or SFTP/bucket drops only after source and key ownership are documented. |

### 2.2 Constraints that must shape the first live scope

The many-to-many engine is a useful pilot feature, but it is not an ERP allocation engine. Its subset-sum path is intentionally bounded to small combinations and returns a candidate match; it does not provide a universal optimiser, a receivables sub-ledger, approved trade-deduction limits, or a posting engine. Therefore, any proposed invoice allocation, bank-fee treatment, credit note or journal entry must remain **human-approved and customer-posted** during the pilot.

The public API ingestion service accepts data, validates and stores it, but deliberately does not claim automatic reconciliation from the upload endpoint. Its code explicitly removed unimplemented `autoReconcile` fields rather than silently accepting a request that would not run a reconciliation. This is the correct honesty boundary, but it means the first pilot needs a defined orchestration runbook: source arrival, validation, reconciliation launch, exception review, daily close and evidence export.

## 3. Critical pre-go-live gaps

| ID | Gap or dependency | Why it blocks a production B2B release | Required closure evidence | Owner |
|---|---|---|---|---|
| **B0** | Launch boundary not formally signed | A reconciliation platform must not accidentally become an unauthorised payment or ERP-posting workflow. | Signed scope: read-only ingestion and reconciliation; no payment initiation, account access, ERP posting, emails or credit notes. | Customer CFO / Legal / ReconcileAI |
| **B1** | No customer-approved canonical data contract | The platform currently maps generic transaction files, not a distributor’s authoritative AR, invoice, bank, NIP-related or mobile-money semantics. | Field-level mapping; sample files; source-of-truth hierarchy; refresh cadence; treatment of reversals, fees, taxes, deductions and credit notes. | Customer Finance + IT + ReconcileAI |
| **B2** | No verified production connector for the anchor distributor’s ERP, bank, PSP or mobile-money providers | Generic API, CSV, SFTP and bucket ingestion are foundations, not evidence of a working customer integration. | Signed interface approach, credentials held by customer, sandbox/file validation, error/retry runbook and source reconciliation. | Customer IT + provider + ReconcileAI |
| **B3** | Customer master-data governance unproven | Distributor aliases and invoice references can produce false match candidates when poorly governed. | Approved pilot roster, alias policy, maker/checker change process and duplicate-account rules. | Customer Finance / Sales Operations |
| **B4** | Allocation and deduction controls are proposals, not accounting authority | Automated allocation could misstate receivables, trade spend or revenue. | Approval matrix, approved deduction catalogue, variance thresholds and signed daily-close procedure. | Customer Financial Controller |
| **B5** | External-model/data boundary needs an approved setting | Customer operational records must not be sent to an external model without an approved data-processing route. | Disable AI assistance by tenant, or run it in the approved private path; retain model/data-flow sign-off. | Customer DPO / InfoSec + ReconcileAI |
| **B6** | Durable processing and tenant-hardening code remains under review | The P1–P7 foundation controls are in PR review and must be deployed before real customer data. | Merge, deploy and evidence Infinity AI PR #96 and mirror PR #26; configure Redis/BullMQ where queueing is enabled. | ReconcileAI |
| **B7** | Evidence-retention and recovery design untested with customer data | Finance must reproduce a daily conclusion after a source, worker or integration failure. | Backup/restore test, ingestion replay, duplicate-file test, time-bound retention policy and documented export process. | Customer IT + ReconcileAI |
| **B8** | Commercial and privacy contract not executed | The pilot needs clear allocation of data, confidentiality, support and liability responsibilities. | Mutual NDA where required, DPA/data-processing terms, pilot SOW, security annex and named support contacts. Nigerian customers additionally require NDPA role, lawful-basis, retention and incident-path approval. | Customer Legal / ReconcileAI |

## 4. Recommended first pilot design

The first customer should be an anchor FMCG manufacturer, national distributor or large regional distributor—such as the Movit Products route already being pursued—rather than a payment institution. The goal is a short, evidence-rich finance-control pilot, not a broad transformation project.

| Design dimension | Recommended first scope | Explicit exclusion |
|---|---|---|
| Legal entity | One distributor or manufacturer entity | Multi-country or group consolidation |
| Distributor set | 10–30 named distributors | Entire national network |
| Sources | AR/invoice export, one primary bank-account statement, MTN MoMo and/or Airtel Money statement where material | Direct payment initiation or live wallet commands |
| Historical window | 30–60 days for mapping and benchmark; 10 business days for dry run | Unbounded historical backfill |
| Operating cadence | Daily ingestion; daily finance review; weekly governance review | Intraday autonomous intervention |
| Core outcome | Receipt-to-invoice allocation, ageing, unresolved-value ledger, and evidence pack | Automated ERP posting, credit-note approval or collections messages |
| Data handling | Masked sample first; approved real data only after gates | Personal data, credentials or data outside the approved boundary |

## 5. Phased execution plan

### Phase 0 — Sponsor alignment and country selection (Week 0)

ReconcileAI and the prospect should convene a 90-minute workshop with the CFO or Financial Controller, Head of Sales Operations, IT/integration owner, data-protection or legal contact, and the daily reconciliation owner. The meeting must select one payable/receivable flow, name its source systems and approvers, agree the no-write boundary, document the success metric and identify the rollout geography. A vague “reconcile all distributor payments” mandate is not sufficient.

**Exit gate:** Signed one-page pilot charter, named owners, source list, no-write boundary, and commercial next step.

### Phase 1 — Country-specific data contract and safe sample validation (Weeks 1–2)

The customer supplies masked or approved extracts from invoice/AR, bank account, mobile-money and any settlement source. For Nigeria, the package should include customer-authorised bank/NIP-related receipt evidence and any PSP collection report used in the selected flow. ReconcileAI creates a field-level canonical mapping, validates transaction amount/date/reference semantics, identifies missing identifiers and prepares an exception taxonomy specific to the customer’s trade-deduction and returns process. The customer confirms the hierarchy of evidence: for example, which source is authoritative when a bank statement and distributor remittance advice conflict.

**Exit gate:** Customer-signed data dictionary; source quality report; approved roster and alias file; repeatable ingestion run with no unresolved structural parsing error.

### Phase 2 — Integration and dry-run control build (Weeks 3–4)

Implement the smallest approved ingestion route: signed SFTP/bucket drop, customer-held API key, or scheduled export. Configure channels, define idempotency keys and cut-off rules, and execute three non-destructive dry runs. Validate the handling of duplicate files, missing files, changed columns, duplicate payment references, partial payment, short payment, trade deduction, bank fee, reversal and delayed mobile-money settlement. For Nigeria, specifically test the customer’s NIP-related payment-reference and transaction-status evidence without connecting ReconcileAI directly to NIP.

**Exit gate:** Three consecutive successful dry runs; reconciliation runbook; source-file recovery evidence; customer and ReconcileAI support contacts; approved rollback to manual Excel reconciliation.

### Phase 3 — Read-only parallel pilot (Weeks 5–8)

Run daily in parallel with the customer’s existing process. ReconcileAI produces a daily reconciliation pack containing total imported value, matched value, open and ageing exceptions, proposed allocations, source completeness, exceptions by category and evidence links. The customer remains the only party that posts allocations, sends collections notices, raises credit notes or moves money.

**Exit gate:** The customer’s finance owner can reproduce the daily result from the source files; material exceptions have named owners; no unapproved external AI route is active; and the agreed success criteria are met for at least 20 business days.

### Phase 4 — Limited production control launch (Weeks 9–10)

Only after a formal pilot decision may the customer adopt ReconcileAI as the primary *reconciliation-control workspace* for the approved scope. Continue the no-write boundary. The first production month must include daily reconciliation sign-off, weekly issue review, and a 30-day hypercare plan. Any future ERP-posting or payment-action API requires a new risk assessment, granular approval design and separate UAT.

**Exit gate:** Customer CFO/Controller production sign-off; operating SOP; support and escalation agreement; recovery drill; retention evidence; and a post-launch review date.

## 6. Acceptance tests before pilot approval

| Test | Pass condition | Failure response |
|---|---|---|
| Source completeness | Each expected source arrives within the agreed cut-off and has a control total. | Mark the run incomplete; do not report a final match rate. |
| Data integrity | Imported row counts and control totals reconcile to customer exports. | Quarantine the batch and return a source-quality exception. |
| Duplicate protection | Re-sending an identical file does not create additional transaction rows or allocations. | Stop the run and investigate idempotency evidence. |
| Allocation control | Every non-exact or many-to-many candidate stays proposed until a named human approves it. | Disable the proposed allocation and keep the source items open. |
| Deduction control | Promotion, damage, return, tax and fee deductions are tied to an approved evidence type. | Raise an exception; no automated close or accounting post. |
| Exception SLA | Each material exception has an owner, severity, due date and escalation path. | Escalate to the Financial Controller at daily close. |
| Data boundary | No customer data is sent to an unapproved external model or service. | Disable AI assistance; use deterministic rules and human review. |
| Recovery | A failed import or reconciliation run is replayed from an immutable source copy without duplicate results. | Revert to the customer’s existing manual process and preserve incident evidence. |

## 7. Operating model and rollback

The customer must appoint a **Business Owner** (usually the Financial Controller), **Data Owner** (Finance Operations or AR), **Technical Owner** (IT), **Security/DPO approver**, and **Executive Sponsor**. ReconcileAI supplies the implementation lead, support owner and incident manager. The daily process should have an explicit cut-off: source files received, completeness checked, reconciliation run, exceptions triaged, human approvals recorded, daily evidence pack exported, and close signed.

Rollback must be practical rather than theoretical. ReconcileAI should be removed from the daily decision path if a source becomes unavailable, control totals do not reconcile, an unauthorised data route is detected, or the customer cannot reproduce the result. The customer continues with its existing spreadsheet/ERP reconciliation process while ReconcileAI preserves the affected source records, run identifier, error log and audit record for remediation.

## 8. Immediate next actions

1. **Run two parallel discovery tracks.** Prioritise the Uganda FMCG distributor/manufacturer path already opened through Movit Products, while opening a Nigeria FMCG manufacturer/distributor track. Select the first customer that provides a named finance sponsor, a bounded use case and safe sample files.
2. **Send the pilot charter, not a generic software proposal.** Ask for the 90-minute control-fit workshop and the five named customer roles.
3. **Request only masked sample files initially.** Invoice/AR export, one bank statement, mobile-money statement if used, distributor master and existing reconciliation workbook.
4. **Close the ReconcileAI foundation gate.** Wait for Claude Code review of Infinity AI PR #96 and mirror PR #26, merge only after the production-hardening decision, then deploy and verify the P1–P7 controls.
5. **Do not claim a payment-launch capability.** The commercial pilot should be priced and scoped as a reconciliation-control proof of value, with a clear later decision on production rollout.

## References

1. [Bank of Uganda, *Strengthening Uganda’s Financial Infrastructure*](https://bou.or.ug/financial_infrastructure_innovation)
2. [GSMA, *State of the Industry Report on Mobile Money 2026*](https://www.gsma.com/sotir/)
3. [Central Bank of Nigeria, *Payments System Supervision*](https://www.cbn.gov.ng/PaymentsSystem/)
4. [NIBSS, *NIBSS Instant Payment*](https://nibss-plc.com.ng/nibss-instant-payment/)
5. [Nigeria Data Protection Commission, *Nigeria Data Protection Act, 2023*](https://ndpc.gov.ng/download/nigeria-data-protection-act-2023)
