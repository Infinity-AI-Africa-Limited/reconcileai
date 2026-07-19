# PR #3 Implementation Notes

## Branch: manus/shopline-tier1-onboarding (continuing from PR #2)

## Heartbeat SDK Pattern (from SKILL.md)
- `server/_core/heartbeat.ts` EXISTS already
- `CRON_OPEN_ID_PREFIX` NOT in sdk.ts yet (legacy project patches needed for end-user crons)
- For project-level crons (no end-user): use `manus-heartbeat create` CLI
- Callback path MUST start with `/api/scheduled/`
- Cron is 6-field: `sec min hour dom mon dow`, UTC, min interval 60s
- Handlers must be idempotent, timeout 2min, retries on 5xx/429 (3 times)
- Site MUST be deployed before scheduling (bizserver POSTs production URL)
- Existing pattern: `app.post("/api/scheduled/woodcoreConnectorSync", handler)` with `syncAuthorized(req)` guard

## What to Build for PR #3

### Scheduled Sync Handler
- `/api/scheduled/shoplineSyncCycle` — 15-min polling fallback
  - Iterates all active SHOPLINE stores
  - Calls `runSyncCycle()` from syncOrchestrator.ts for each
  - Uses same `syncAuthorized(req)` guard as WoodCore

### Daily Batch Sync Handler
- `/api/scheduled/shoplineDailyBatch` — daily full reconciliation
  - Runs at 03:00 UTC
  - Full 24h window sync for all stores
  - Generates summary report

### Webhook Subscription Reconciler
- `/api/scheduled/shoplineWebhookReconciler` — daily check
  - Verifies webhook subscriptions are still active
  - Re-registers any missing webhooks
  - Alerts on persistent failures

### Dashboard tRPC Procedures (add to shoplineConnector router)
- `shopline.dashboard.overview` — summary stats (stores, sync status, exceptions)
- `shopline.dashboard.recentSyncs` — last N sync reports
- `shopline.dashboard.exceptionsByCategory` — grouped exception counts
- `shopline.dashboard.settlementMonitor` — payout vs expected comparison

### Dashboard Pages
- `/shopline/dashboard` — overview with key metrics
- Reuse existing Exceptions/Transactions pages with SHOPLINE channel filter

## Existing Infrastructure
- `syncOrchestrator.ts` already has `runSyncCycle()` that does the full pipeline
- `slConnectorStores` table has `status`, `lastSyncAt` fields
- `channels` table gets auto-created per store (sl_orders_X, sl_payments_X)
- Exception persistence maps retail→core categories

## Auth Pattern for Scheduled Handlers
```ts
function syncAuthorized(req: Request): boolean {
  // Check x-sync-secret header or sdk.authenticateRequest for cron
}
```

## Test Results So Far
- 741/741 tests passing
- 0 TypeScript errors
- PR #9 open on GitHub (MistaRichMan/reconcileai)
