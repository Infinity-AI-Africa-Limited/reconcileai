# Corporate B2B Controlled-Pilot Controls — B0–B8 Implementation Status

**Date:** 22 August 2026  
**Scope:** First read-only FMCG/distributor reconciliation pilot in Uganda or Nigeria  
**Status:** Platform-controlled controls implemented on `manus/corporate-b2b-pilot-foundation`; the P1–P7 foundation release is merged and proven, while customer evidence remains the release gate.

> This is a **reconciliation-control pilot**, not a payment product. ReconcileAI may ingest customer-authorised evidence, match records, route exceptions and produce proposals or exports. It must not initiate or approve payments, access bank accounts, post to an ERP, create a credit note, or send a customer-facing action.

## 1. What the platform now enforces

| Gate | Platform control delivered | What is still customer / deployment evidence | Pilot status |
|---|---|---|---|
| **B0** | A dedicated Pilot Controls workspace requires a recorded no-write acknowledgement and bounded scope; the product’s existing ERP path remains export-only. | Customer selects one bounded receivable/reconciliation flow and confirms it remains no-write. | **Platform control ready; customer attestation required** |
| **B1** | Tenant-scoped source-contract metadata records the canonical invoice/AR and receipt-evidence sources. Readiness requires approved invoice/AR plus bank, mobile-money or PSP receipt evidence. | Customer supplies field mapping, source hierarchy, cut-off rules, reversals, deductions and approved sample extracts. | **Customer evidence required** |
| **B2** | Source contracts require customer-owned credentials and a control total; readiness needs two tested sources. The actual ingestion services remain tenant-scoped, idempotent and unmatched-on-arrival. | Customer approves SFTP, bucket, API or export route and proves source access / test delivery. | **Platform control ready; customer integration evidence required** |
| **B3** | The existing Distributor Registry is included in the hard gate: readiness refuses a roster with no identities, pending confirmations or flagged records. | Customer imports and signs off the active distributor roster and aliases. | **Customer evidence required** |
| **B4** | Readiness requires an approved allocation policy and daily close owner. Existing action drafts remain proposals and approval records, not payment execution. | Customer provides allocation / write-off rules, limits, escalation contacts and daily sign-off owner. | **Customer operating evidence required** |
| **B5** | Corporate B2B AI-assisted diagnosis now fails closed unless a tenant records a `private_approved` AI route and approval reference. The default is disabled. | Customer decides whether AI remains off or validates a private approved deployment and data boundary. | **Platform control ready; customer decision required** |
| **B6** | The pilot page records the merged and proven Financial Services foundation release without implying that it substitutes for tenant-level evidence. | P1–P7 foundation release confirmed merged and proven; durable queue / deployment profile evidence remains required where enabled. | **Foundation release closed** |
| **B7** | Readiness requires a passed recovery/replay status and a positive retention period. New pilot records are RLS-audited as `tenant_required`. | Execute and retain restore, replay, duplicate-file and support-escalation drill evidence with the customer. | **Customer + operations evidence required** |
| **B8** | Readiness requires recorded commercial and data-processing references; each configuration and source change is audit logged. | Legal teams execute / approve the applicable SOW, DPA or privacy annex and confirm country-specific requirements. | **Customer legal evidence required** |

## 2. Security and tenancy posture

Two new tables were added and applied to the development schema:

| Table | Purpose | Safety posture |
|---|---|---|
| `corporate_b2b_pilot_configs` | One auditable policy/evidence register per Corporate B2B tenant. | `organizationId` is `NOT NULL`, unique and classified as `tenant_required`. Defaults are preparation state, AI disabled, no-write unacknowledged, draft data/contract states and untested recovery. |
| `corporate_b2b_pilot_sources` | Metadata-only registry of customer-authorised evidence sources. | `organizationId` is `NOT NULL`, indexed and classified as `tenant_required`. It does not store provider credentials, account numbers, source-file contents or payment authority. |

The Corporate B2B Super Agent diagnosis path rejects direct calls unless the tenant has a private AI boundary approval. This is server-side policy, not a UI-only indicator.

## 3. Validation evidence

| Check | Result |
|---|---|
| Focused readiness-gate regression tests | 4/4 passed |
| Full regression suite | 114 files, 1,842 tests passed |
| TypeScript compilation | Passed |
| Development schema application | Applied successfully; both new tables initially contain zero rows |
| RLS audit ratchet | Updated and passing; both new tables classified as `tenant_required` |

## 4. What must not be represented as complete

1. No customer has yet supplied a signed data contract, source evidence, roster sign-off, allocation policy, recovery drill record, SOW or DPA. The controls correctly show these as open.
2. The new workspace does not create a payment connection or a financial action; it records the prerequisites for a safe pilot.
3. B6 is closed because the Financial Services P1–P7 foundation release is merged and proven. This does not close B0–B5 or B7–B8, and it does not waive deployment-specific durable-queue evidence where queued processing is enabled.
4. Nigeria-specific customer legal and privacy acceptance remains necessary before approved Nigerian operational data is ingested.

## 5. First controlled-pilot activation sequence

1. **Deploy only after review.** Obtain Claude Code approval on the Corporate B2B pilot-control PR, merge both repositories and verify the production migration.
2. **Create the anchor tenant.** Use the customer’s verified organisation, country and finance-owner role; do not use a demo tenant for evidence.
3. **Set Pilot Controls.** Record the bounded scope, no-write acknowledgement, AI-off default, retention policy and legal-reference placeholders.
4. **Register two source contracts.** Invoice/AR plus one authorised receipt source; validate the route with masked or approved extracts and control totals.
5. **Confirm roster and policy.** Resolve pending/flagged distributor identities; attach the customer’s allocation and daily-close procedure.
6. **Run recovery and duplicate drills.** Record results, do not merely toggle them to passed.
7. **Start parallel reconciliation only.** Reconcile against the customer’s existing close; investigate variance; export proposals for human action outside ReconcileAI.
8. **Assess limited control only after acceptance.** The customer must formally accept results, support process and rollback evidence before any broader operational scope.
