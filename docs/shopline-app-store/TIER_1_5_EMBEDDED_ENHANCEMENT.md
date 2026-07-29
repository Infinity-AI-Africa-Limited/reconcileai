# Tier 1.5 — App Bridge Embedded Enhancement (Post-Launch)

> **Status:** Planned — to be implemented after Tier 1 App Store approval and first merchants onboarded.
> **Decision Date:** July 29, 2026
> **Context:** Tier 1 launches with Redirected mode because the codebase has no App Bridge integration. This document captures the future enhancement path.

---

## What This Enhancement Delivers

After Tier 1 is live and merchants are onboarded, build a lightweight SHOPLINE App Bridge widget that renders a **summary card inside SHOPLINE Admin** — giving merchants a quick-glance view without leaving their dashboard, while the full ReconcileAI experience remains on the standalone domain.

---

## The Widget Shows

1. **Match Rate** — current reconciliation match percentage (e.g., "97.4% matched")
2. **Exception Count** — number of open exceptions requiring attention
3. **Last Sync Time** — when the most recent settlement data was ingested
4. **"Open ReconcileAI" Button** — redirects to the full dashboard at the standalone domain

---

## Technical Requirements

1. **SHOPLINE App Bridge SDK** — install and integrate `@shopline/app-bridge` JavaScript SDK
2. **Session Token Authentication** — implement App Bridge session token exchange for iframe context
3. **Embedded App Page** — a single lightweight React page (`/shopline/embedded`) that renders the summary widget
4. **Navigation Sync** — use App Bridge `Navigation` API to sync browser history
5. **Iframe Resize** — use App Bridge `resize` utility to adapt to content height
6. **Toast Notifications** — use App Bridge `Toast` for in-admin notifications (e.g., "3 new exceptions detected")

---

## Implementation Estimate

| Task | Effort |
|---|---|
| App Bridge SDK integration + session token exchange | 2–3 days |
| Summary widget React component | 1–2 days |
| Navigation sync + iframe resize handling | 1 day |
| Testing on developer store in embedded mode | 1 day |
| Portal mode switch from Redirected to Embedded | 5 minutes |
| **Total** | **5–7 days** |

---

## Why Not Now

- The full ReconcileAI dashboard has 13+ pages, charts, real-time sync status, and complex workflows that require full browser real estate
- App Bridge integration requires session token management that does not exist in the current auth flow
- Launching in Redirected mode gets us to market faster — the priority is App Store approval and first merchants
- Embedded mode can be added without breaking existing merchants (they simply see the widget appear in their SHOPLINE Admin)

---

## Trigger for Implementation

Begin this work when:
- Tier 1 is approved and listed on the SHOPLINE App Store
- At least 5 merchants have installed and are actively using ReconcileAI
- Merchant feedback indicates demand for in-admin visibility (or SHOPLINE requests it)

---

## References

- SHOPLINE App Bridge docs: https://developer.shopline.com/docs/apps/app-bridge
- Decision analysis: `/home/ubuntu/embedded_vs_redirected_analysis.md`
- One-pager context: "The merchant opens ReconcileAI (either as an embedded panel inside their SHOPLINE dashboard, or as a separate tab with their SHOPLINE identity already authenticated)"
