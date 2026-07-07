# routers.ts Split Plan (Gap-Closure Plan WS-4 Pre-work)

> `server/routers.ts` is ~6,900 lines. The split is **started** (July 2026):
> the shared building blocks every domain needs are extracted to
> `server/routers/shared.ts`, so each subsequent domain extraction is a
> mechanical move. This document sequences the rest.

## Why the API layer didn't wait for the full split

The REST gateway (`server/api/gateway.ts`) executes procedures via
`appRouter.createCaller(...)` — it depends on the router's *type surface*, not
its file layout. Splitting improves maintainability but was not a correctness
prerequisite; doing the full ~6,900-line reorganisation in one change while
Manus works on the same file would have been a merge catastrophe. Hence:
shared-blocks first, domains incrementally.

## Done

- `server/routers/shared.ts` — role procedure builders (`superAdminProcedure`,
  `adminProcedure`, `operationsProcedure`, `guestProtectedProcedure`,
  `woodcoreProcedure`), `assertCanManageUsers`, `logAudit`, `getClientInfo`,
  `sanitizeInput`. routers.ts imports them; zero call-site changes.
- Already-split domains (established pattern): `routers/poc.ts`,
  `routers/pocKpi.ts`, `routers/mobileMoney.ts`, `routers/cbnCompliance.ts`.

## Extraction rules

1. **One domain per commit**, `npx tsc --noEmit` + full test suite green before merge.
2. Move the `<domain>: router({...})` literal verbatim into
   `server/routers/<domain>.ts`; import building blocks from `./shared`.
3. Domain-local helpers move with the domain; anything used by 2+ domains goes
   to `shared.ts` (or `server/db.ts` if it's a query).
4. `routers.ts` keeps the `appRouter` composition — it shrinks to imports + the
   router map. The `AppRouter` type export must not move (client binding).
5. **Coordinate with Manus**: never extract a domain Manus has in-flight
   changes on; check open branches first.

## Sequence (lowest coupling → highest)

| Order | Domain | Approx. lines | Notes |
|---|---|---|---|
| 1 | `resolutionTemplates` | ~150 | Self-contained; templates CRUD |
| 2 | `ageTracker` | ~120 | Reads `server/ageTracker.ts` |
| 3 | `webhooks` + `apiKeys` | ~200 | Integration settings |
| 4 | `exceptionIntelligence` | ~150 | Wraps `server/exceptionIntelligence.ts` |
| 5 | `channels` | ~250 | |
| 6 | `distributor` | ~200 | Already a named local router |
| 7 | `schedules` | ~300 | |
| 8 | `anomalies` | ~300 | |
| 9 | `reports` | ~400 | |
| 10 | `exceptions` | ~450 | Flywheel write-path lives here — extra test care |
| 11 | `transactions` / `uploads` | ~500 | CSV parsing helpers move too |
| 12 | `reconciliation` | ~600 | `runReconciliation` + deferred-AI pass move to `server/reconciliationRunner.ts` |
| 13 | `superAgent` | ~500 | |
| 14 | `admin` / `superAdmin` | ~800 | Largest; do last |
| 15 | `dashboard`, `compliance`, `documentation`, `demo`, misc | remainder | |

End state: `routers.ts` < 300 lines (imports + appRouter composition).

*July 2026 — maintained alongside the quarterly gap-closure review.*
