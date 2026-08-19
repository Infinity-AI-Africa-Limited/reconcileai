# ReconcileAI Dev Store — Final SHOPLINE Submission Readiness

**Assessment date:** 19 August 2026  
**Primary app:** ReconcileAI Dev Store  
**Integration mode:** Redirected, Tier 1 read-only orders and payments reconciliation

## Decision summary

ReconcileAI has completed the material technical and listing evidence needed for a
credible Tier 1 App Store package. The release must **not** be represented as having
completed a paid or expiry subscription-lifecycle test: the current SHOPLINE
development-store package exposes OAuth/access testing but no no-charge plan or
trial activation route. A support request is prepared in
`SHOPLINE_BILLING_TEST_SUPPORT_REQUEST.md`.

The remaining owner-controlled gates before an App Store review submission are the
public support-email switchover, creation of the app version, and a decision on
whether the documented subscription-lifecycle caveat is acceptable or must be closed
through SHOPLINE’s supported billing-test route.

## Verified P0 evidence

| Gate | Status | Evidence |
| --- | --- | --- |
| Retail tenant isolation | Complete | OAuth hand-off, portal context, and server-side scope verified for `SL_RECONCILEAI_DEV`. |
| Connected developer store | Complete | `reconcileai-dev` appears active in the tenant-scoped Settlement Monitor and Sync Status views. |
| Controlled paid-order path | Complete | Synthetic cash-on-delivery order #1004 was marked paid; `orders/paid` and related delivery rows processed. |
| Tier 1 reconciliation fallback | Complete | Controlled synthetic remittance import created a reciprocal matched order/remittance pair for #1004. |
| Recovery and idempotency | Complete | Manual recovery processed one order and no native payments; the matched pair stayed at one source order and one remittance, with no linked exception. |
| GDPR signature handling | Complete | Signed non-destructive acknowledgement returned 200; unsigned synthetic request rejected with 401. |
| App-subscription lifecycle | Caveat | No test subscription row or lifecycle delivery can be created in the current development-store package. |

## Verified P1 and P2 evidence

| Area | Status | Evidence |
| --- | --- | --- |
| App Details | Complete | Approved standalone icon, accurate About text, three Product Features, Privacy/FAQ URLs, and current contact detail saved. |
| Billing catalogue | Complete | Seven-day trial and five published Tier 1 plans verified in Partner Portal. |
| Product preview | Complete | Three authentic production screenshots uploaded at exact 1920×1080. |
| Merchant support | Complete | Onboarding, operational, and support-escalation runbooks prepared. |
| Monitoring and incident response | Complete for controlled scope | Healthy delivery state, bounded recovery, and unsigned-request rejection drill documented. |
| Rollback | Procedure ready | Approved rollback procedure documented; no artificial production rollback was performed. |

## Marketing-safe statement

The live developer-store reconciliation view currently contains **four matched legs
out of six total legs (66.7%)**, because two historical order-only legs remain
without settlement evidence. Separately, the real matching engine passed a
transparent synthetic clean-data benchmark of **394 matched legs out of 400 total
(98.5%)**, including six intentional exception legs. Any external use of 98.5% must
state that it is a **controlled synthetic benchmark** and not a promised production
match rate.

## Remaining owner actions

1. Submit the prepared billing-test support request or formally accept the
   subscription-lifecycle caveat for the initial review package.
2. Change the App Details contact email to `support@reconcileaiafrica.com` and
   confirm that inbox is monitored before creating the app version.
3. Create the App Store version and review submission only after the preceding
   decision is documented.
