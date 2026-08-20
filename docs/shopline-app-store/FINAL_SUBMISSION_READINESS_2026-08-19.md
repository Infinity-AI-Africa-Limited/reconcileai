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

## Gates remaining before Submit for Review

This list is the complete set, and it is deliberately longer than the owner-facing
summary it replaced. An earlier revision named three gates — email switchover, app
version creation, and the lifecycle decision — as though they were the whole
remainder. Two further controls exist in this repository and neither was listed, so
a release owner following this page alone could have submitted while those controls
still said not to. A readiness page that understates the gate set is worse than no
readiness page, because it is the document someone acts on.

**Owner-controlled, in the Partner Portal**

| # | Gate | Tracked in |
| --- | --- | --- |
| 1 | Switch the public contact email from `richard@infinityaiafrica.ai` to the monitored `support@reconcileaiafrica.com`, and test the inbox | `RELEASE_CONTROL_RECORD.md` — marked **P0 before Submit for Review** |
| 2 | Create the app version | Partner Portal |
| 3 | Decide whether the subscription-lifecycle caveat is accepted as a known limitation, or must be closed first | This document, plus `SHOPLINE_BILLING_TEST_SUPPORT_REQUEST.md` |

**Repository controls that also gate submission**

| # | Control | Where it is stated |
| --- | --- | --- |
| 4 | *"No App Store review submission should be created before this record contains the completed live evidence."* The drill record is a **pre-execution control**, and sections of it remain open — the settlement figures shown in the tenant-scoped views are still designated product-preview data until tied to the controlled paid-order evidence | `P2_DRILL_EXECUTION_RECORD.md` |
| 5 | Three subscription-lifecycle tasks are still open, not merely caveated: activating a controlled no-charge subscription test and verifying a signed lifecycle delivery plus the resulting `sl_connector_subscriptions` state; activating and then cancelling the approved 7-day trial before renewal; and obtaining a SHOPLINE-supported billing-test route | `todo.md`, unchecked |

Gate 5 is worth separating from gate 3, because they are easy to conflate and the
difference decides whether submission is permitted. Gate 3 is a *decision* the owner
may take either way. Gate 5 is *work that has not been done*. Recording the lifecycle
gap as an accepted caveat does not complete those tasks; it only states that the
package ships without that evidence, which is a claim SHOPLINE's reviewer may test.

**Nothing here authorises submission on its own.** Gates 1–3 are the owner's to
close; gates 4–5 are closed by evidence, not by decision.

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
