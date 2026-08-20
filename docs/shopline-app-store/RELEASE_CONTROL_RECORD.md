# ReconcileAI × SHOPLINE Release Control Record

| Control | Current state | Evidence | Release gate |
|---|---|---|---|
| Infinity AI source baseline | Complete | Infinity-AI-Africa-Limited/reconcileai `main` used as authoritative source. | Passed. |
| Retail-only navigation | Complete | Deployed OAuth hand-off and scoped portal views verified for `SL_RECONCILEAI_DEV`. | Passed. |
| OAuth callback/reconnect | Complete for developer store | Controlled Test App reconnect and persisted retail portal evidence. | Passed. |
| Paid source order | Complete for developer store | Controlled synthetic order #1004 marked paid through the Cash on Delivery test flow. | Passed. |
| Paid webhook → Settlement Monitor | Complete | Processed `orders/paid` delivery, tenant-scoped ingestion, synthetic settlement-file import, and reciprocal match pair verified. | Passed for Tier 1 settlement-file path. |
| GDPR Portal settings | Complete | Contact and both GDPR callback URLs saved; signed acknowledgement returned 200 and unsigned drill rejected with 401. | Passed. |
| App subscription topics | Caveat | Registration code is deployed, but the development-store package offers no no-charge lifecycle activation control. | SHOPLINE-supported billing-test route required before review submission. `P2_DRILL_EXECUTION_RECORD.md` classes the signed lifecycle delivery and resulting `sl_connector_subscriptions` row as **required P0 proof**, so owner acceptance does not discharge this gate. |
| Per-store request pacing | Code evidence complete | Pacing regression coverage and bounded manual recovery completed. | Distributed limiter remains post-launch scale work. |
| Listing and reviewer package | Complete | Accurate icon, three Product Features, About text, legal URLs, pricing, reviewer guide, and three 1920×1080 production previews saved. | Public contact switchover and version creation remain. |
| Monitoring, incident, rollback, change control | Controlled evidence complete | Bounded recovery, idempotency, and unsigned-request rejection drill completed; runbooks retained. | Do not manufacture a production rollback; follow procedure if a release regression occurs. |
| Listing Product Features | Complete | Three Tier 1 Product Features approved by Richard and saved in App Details on 18 August 2026. | Passed. |
| Public contact email | Deferred by owner decision | Keep `richard@infinityaiafrica.ai` during preparation. Replace it with `support@reconcileaiafrica.com` and test the monitored inbox at final go-live. | P0 before Submit for Review. |
| SHOPLINE code-level regression | Complete for the current review candidate | 13 focused suites / 273 tests passed on 18 August 2026, covering API pacing, billing, onboarding, GDPR, webhook idempotency, payment legs, realtime and scheduled sync, secrets, settlement import, and the SHOPLINE connection experience. | Supports P1; does not replace live production evidence. |
| App-subscription lifecycle delivery | Not observed in current development-store package | Test App supports OAuth/access verification only; no no-charge trial or plan-selection control is exposed, so no subscription row or signed lifecycle delivery has been generated. | P0 caveat pending a SHOPLINE-supported billing-test route; see `SHOPLINE_BILLING_TEST_SUPPORT_REQUEST.md`. |
