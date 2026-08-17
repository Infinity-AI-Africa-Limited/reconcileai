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
| Listing and reviewer package | Draft prepared | LISTING.md and REVIEWER_TEST_GUIDE.md. | Upload accurate assets and validate reviewer account. |
| Monitoring, incident, rollback, change control | Runbooks prepared | OPERATIONS_RUNBOOK.md. | P2 live drill after reviewed release deploys. |
