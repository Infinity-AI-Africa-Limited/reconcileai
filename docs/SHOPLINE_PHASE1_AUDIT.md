# SHOPLINE Phase 1 Connector — Spec Compliance Audit

> Audited 2026-07-18 by comparing the built connector modules against
> `docs/SHOPLINE_PHASE1_API_EXTRACT.md` (the verified spec) and the
> partnership proposal (`shopline_implementation_roadmap.md`,
> `shopline_tier1_technical_integration_plan.md`).

## Summary of Findings

| # | Module | Issue | Severity | Fix |
|---|---|---|---|---|
| 1 | `apiClient.ts` | Base URL uses `/openapi/{version}/` — spec says `/admin/openapi/{version}/` | HIGH | Fix base URL |
| 2 | `apiClient.ts` | Payment transactions endpoint is `/payments/transactions.json` — spec says `/payments/store/transactions.json` | HIGH | Fix path |
| 3 | `apiClient.ts` | Payouts endpoint is `/payouts.json` — spec says `/payments/store/payouts.json` | HIGH | Fix path |
| 4 | `apiClient.ts` | Store info endpoint is `/shop.json` — spec says `/store.json` | MEDIUM | Fix path |
| 5 | `apiClient.ts` | Webhook registration missing `api_version` field in body | MEDIUM | Add field |
| 6 | `apiClient.ts` | Pagination uses `next_page_info` in JSON body — spec uses `link` header with `page_info` cursor | MEDIUM | Fix pagination to parse `link` header |
| 7 | `auth.ts` | Authorize URL uses `/admin/oauth/authorize` with `app_key` — spec says `/admin/oauth-web/#/oauth/authorize` with `appKey` and `responseType=code` | HIGH | Fix URL and params |
| 8 | `auth.ts` | Token exchange endpoint is `/admin/oauth/token` with body `{app_key, app_secret, code}` — spec says `POST /admin/oauth/token/create` with headers `appkey`, `timestamp`, `sign` and body `{"code": "..."}` | HIGH | Fix endpoint and auth method |
| 9 | `auth.ts` | Token refresh uses body `{app_key, access_token, timestamp, signature}` — spec says `POST /admin/oauth/token/refresh` with headers `appkey`, `timestamp`, `sign` (POST signature mode) | MEDIUM | Fix to use header-based auth |
| 10 | `signature.ts` | OAuth mode uses `hmac` param name — spec uses `sign` param name | HIGH | Rename `hmac` → `sign` |
| 11 | `signature.ts` | Webhook verification only accepts base64 — spec says implement tolerant verifier (accept hex OR base64) | MEDIUM | Add dual-encoding tolerance |
| 12 | `signature.ts` | Missing timestamp window enforcement (±10 min) for OAuth/callback signatures | MEDIUM | Add timestamp validation |
| 13 | `webhookHandler.ts` | Handles `payouts/paid`, `payouts/failed`, `app/uninstalled` — NONE of these exist in SHOPLINE's verified webhook catalogue | HIGH | Replace with verified topics |
| 14 | `webhookHandler.ts` | Synchronous processing inside the webhook handler — spec requires ack within 5 seconds | MEDIUM | Already returns 200 quickly, but processing should be deferred |
| 15 | `webhookHandler.ts` | Missing GDPR handlers (`customers/redact`, `merchants/redact`) — mandatory for App Store review | HIGH | Add GDPR topic handling |
| 16 | Missing | `types.ts` — build spec calls for canonical SHOPLINE record types | LOW | Add types file |
| 17 | Missing | No `subscriptions.ts` — build spec calls for desired-state webhook subscriber | LOW | Deferred (registerWebhooks in router covers basic case) |
| 18 | Missing | No `gdpr.ts` — build spec calls for GDPR endpoint handlers | MEDIUM | Fold into webhookHandler |
| 19 | Missing | No `onboarding.ts` — build spec calls for self-serve tenant provisioning | LOW | Phase 1 scope is backend connector; UI onboarding is Phase 2 |

## Disposition

**Must fix (HIGH):** Items 1–5, 7–8, 10, 13, 15 — protocol correctness issues that would cause the connector to fail against the real SHOPLINE API.

**Should fix (MEDIUM):** Items 6, 9, 11, 12, 14 — robustness/compliance issues that could cause intermittent failures or App Store review rejection.

**Defer (LOW):** Items 16, 17, 19 — structural improvements that don't affect functionality; Claude Code can add during hardening.

## Action Plan

1. Rewrite `signature.ts` — rename `hmac` → `sign`, add tolerant webhook verification, add timestamp window
2. Rewrite `auth.ts` — fix authorize URL, token create endpoint (header-based auth), token refresh endpoint
3. Rewrite `apiClient.ts` — fix base URL, all endpoint paths, pagination (link header), webhook registration body
4. Rewrite `webhookHandler.ts` — replace fake topics with verified ones, add GDPR handlers, add `merchants/redact` → uninstall
5. Add `types.ts` — canonical SHOPLINE record types from the spec
6. Update tests to match new signatures/behavior
7. Run full test suite, commit, push, update PR
