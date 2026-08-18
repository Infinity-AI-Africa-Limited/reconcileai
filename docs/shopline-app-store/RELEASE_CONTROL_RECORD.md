# ReconcileAI × SHOPLINE Release Control Record

| Control | Current state | Evidence | Release gate |
|---|---|---|---|
| Infinity AI source baseline | Complete | Infinity-AI-Africa-Limited/reconcileai `main` used as authoritative source. | Passed. |
| Retail-only navigation | Pending merge | Review PR #87/21 and retail navigation regression suite. | Claude review and deployment required. |
| OAuth callback/reconnect | Complete for developer store | Controlled Test App reconnect evidence. | Passed for callback path. |
| Paid source order | Complete for developer store | Order `1003` manually marked paid in controlled test. | Passed for source-event creation. |
| Paid webhook → Settlement Monitor | Pending | Requires provisioned retail tenant session and delivery/sync evidence. | P0. |
| GDPR Portal settings | Complete | Contact and both GDPR callback URLs saved in Partner Portal. | Signed non-destructive test remains P0. |
| App subscription topics | Pending merge and live proof | Registration/recovery code in review branch. | P0 delivery evidence. |
| Per-store request pacing | Pending merge and Dev Store load test | Process-local 250 ms scheduler in review branch. | P1; distributed limit before multi-worker scale. |
| Listing and reviewer package | Partially complete | Accurate icon, three Product Features, accurate About, legal URLs, reviewer guide, and pricing verified. | Authentic screenshots and reviewer-account validation remain. |
| Monitoring, incident, rollback, change control | Runbooks prepared | OPERATIONS_RUNBOOK.md and SUPPORT_ESCALATION_RUNBOOK.md. | P2 live drill after reviewed release deploys. |
| Listing Product Features | Complete | Three Tier 1 Product Features approved by Richard and saved in App Details on 18 August 2026. | Passed. |
| Public contact email | Deferred by owner decision | Keep `richard@infinityaiafrica.ai` during preparation. Replace it with `support@reconcileaiafrica.com` and test the monitored inbox at final go-live. | P0 before Submit for Review. |
| SHOPLINE code-level regression | Complete for the current review candidate | 13 focused suites / 273 tests passed on 18 August 2026, covering API pacing, billing, onboarding, GDPR, webhook idempotency, payment legs, realtime and scheduled sync, secrets, settlement import, and the SHOPLINE connection experience. | Supports P1; does not replace live production evidence. |
