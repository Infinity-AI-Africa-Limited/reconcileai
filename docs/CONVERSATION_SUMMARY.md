# ReconcileAI — Conversation Summary & Decisions Log

**Purpose:** Captures all key decisions, rationale, and context from the Manus prototype build session. This document preserves the institutional knowledge that exists in the conversation history, which is ephemeral and not portable to Rocket.new.

**Date range:** February 2026 – May 2026  
**Author:** Richard Anwanakak, Infinity AI Africa Limited  

---

## 1. Product Strategy Decisions

### 1.1 Pivot from POC to Pilot (Lapo MFB)

**Decision:** The engagement model with Lapo Microfinance Bank was changed from a Proof of Concept (POC) to a Pilot.

**Rationale:** A pilot is a more effective path to a signed contract than a POC. A POC demonstrates capability; a pilot demonstrates value in the client's actual operating environment with real data. The pilot model makes the decision to move to production and sign a contract significantly easier for Lapo's leadership.

**Implication:** The platform must be production-grade (not prototype-grade) before the Lapo pilot begins. This is the primary driver for the Manus → Rocket.new migration.

### 1.2 Financial Services First (FY1), Corporate B2B Second (FY2)

**Decision:** FY1 (July 2026 – June 2027) focuses exclusively on the financial services segment. Corporate B2B activities commence in FY2 (July 2027 – June 2028).

**Rationale:** Financial services (banks, MFBs, fintechs) have an acute, well-understood reconciliation pain point and the budget to pay for a solution. Corporate B2B requires a different sales motion and longer sales cycles. Sequencing the segments allows the team to build deep expertise and reference customers in financial services before expanding.

**Implication:** The Lapo pilot is the FY1 flagship engagement. All product and engineering effort in Q1 FY1 should be focused on making the financial services portal production-ready.

### 1.3 Module Consolidation (Transaction Integrity → Settlement Reconciliation)

**Decision:** The three-module architecture (Transaction Integrity, Settlement Reconciliation, Account-Level Reconciliation) was reduced to two modules (Settlement Reconciliation, Account-Level Reconciliation).

**Rationale:** Transaction Integrity's capabilities (multi-source ingestion, duplicate detection, timestamp normalisation, false positive classification) are not a separate product — they are table-stakes features of any reconciliation engine. Presenting them as a separate module created confusion in client conversations. Merging them into Settlement Reconciliation simplifies the product story and makes the value proposition clearer.

**Implication:** The `module_configurations` and `module_overrides` tables use `settlement` and `account_level` as the two module type enum values. The `transaction_integrity` enum value is retained in the `reconciliation_jobs` table for backward compatibility but should be migrated to `settlement` in production.

### 1.4 Three-Segment Architecture (Financial Services, Corporate B2B, Super Admin)

**Decision:** The platform is architected around three tenant segments, each with a distinct portal experience.

**Rationale:** Financial services and corporate B2B clients have fundamentally different workflows, terminology, and feature requirements. A single undifferentiated portal would create a confusing UX for both segments. The super admin segment (Infinity AI staff) requires a cross-tenant control plane that is completely separate from client-facing features.

**Implication:** The `organizations.segment` enum (`financial_services | corporate_b2b | super_admin`) is the primary discriminator. The `PortalContext` in the frontend and the `superAdminProcedure` middleware in the backend enforce this separation.

---

## 2. Technical Decisions

### 2.1 Stack Selection

**Decision:** React 19 + Express 4 + tRPC 11 + Drizzle ORM + TiDB.

**Rationale:** This stack was selected by the Manus WebDev platform as the default for full-stack TypeScript applications. It provides end-to-end type safety (tRPC + Drizzle), a modern frontend (React 19 with React Query), and a scalable database (TiDB is MySQL-compatible and distributed).

**Implication for Rocket.new:** Keep the stack. Do not rewrite in a different framework. The codebase is clean and well-structured; the value is in the business logic and data model, not the framework.

### 2.2 GitHub as the Bridge

**Decision:** All code and documentation is committed to two GitHub repositories simultaneously: `Infinity-AI-Africa-Limited/reconcileai` (primary) and `MistaRichMan/reconcileai` (secondary).

**Rationale:** GitHub is the universal handoff layer between Manus and Rocket.new. Both platforms can read from and write to GitHub repositories, making it the natural connective tissue for the migration.

**Implication:** Rocket.new should import the project from `github.com/Infinity-AI-Africa-Limited/reconcileai`. All subsequent production work should be committed to this repository.

### 2.3 LLM Gateway Strategy

**Decision:** The `invokeLLM()` helper in `server/_core/llm.ts` uses a dual-mode provider resolution: Manus Forge (prototype) or direct provider (production). The switch is controlled entirely by environment variables — no code changes required.

**Rationale:** This design decouples the application code from the LLM provider. The same codebase works in both the Manus prototype environment and the Rocket.new production environment. The only change needed is setting `DIRECT_LLM_API_KEY` and `DIRECT_LLM_API_URL` in the production environment.

**Implication:** Set `DIRECT_LLM_API_KEY=<openai_key>` and `DIRECT_LLM_API_URL=https://api.openai.com/v1/chat/completions` in Rocket.new environment variables. The Manus Forge gateway will no longer be used.

### 2.4 Portal Context Switcher

**Decision:** The super admin can "enter" any tenant's portal and see the application exactly as that tenant's admin would see it, using a `viewAsOrg` context stored in sessionStorage.

**Rationale:** This is essential for quality assurance and support. Without this feature, Infinity AI staff would need to create separate accounts in each tenant's organisation to verify that the portal is working correctly. The context switcher eliminates this friction.

**Implication:** The `PortalContext` in `client/src/contexts/PortalContext.tsx` manages the `viewAsOrg` state. The `DashboardLayout` reads this context to render segment-specific navigation. The `viewAsOrgId` is passed as an optional parameter to data queries to scope results to the viewed organisation.

### 2.5 Module Override Architecture

**Decision:** Two separate tables manage module state: `module_configurations` (org-controlled) and `module_overrides` (Infinity AI super admin-controlled).

**Rationale:** This separation of concerns ensures that Infinity AI can enforce module state for compliance, pricing, or pilot reasons without overwriting the organisation's own preference. When the override is cleared, the organisation's own setting is automatically restored.

**Implication:** The effective module state is computed as: `override.state ?? org_config.isEnabled`. This logic lives in the `modules.getConfig` procedure.

### 2.6 Woodcore Integration (Blocked)

**Decision:** The Woodcore core banking integration was implemented in the prototype but is blocked by IP whitelisting on Woodcore's side.

**Rationale:** The integration was built to demonstrate the capability to connect to a live core banking system. The IP whitelist request has been submitted to Woodcore.

**Implication:** The `woodcore` router in `server/routers.ts` is complete. Once Woodcore whitelists the production server's IP, the integration can be activated by setting `WOODCORE_API_URL`, `WOODCORE_CLIENT_ID`, and `WOODCORE_CLIENT_SECRET` in the production environment. Note: Lapo MFB does not use Woodcore; a separate connector will be needed for Lapo.

---

## 3. Feature Decisions

### 3.1 Advanced Tools in Financial Services Portal

**Decision:** The Financial Services portal sidebar includes Email Settings and the full Advanced Tools dropdown (Sample Data, Integrations, API Ingestion, SFTP Config, Anomaly Detection).

**Rationale:** Financial services clients need access to all integration and configuration tools. These tools were previously only accessible in the default admin view. Making them available in the portal context ensures that financial services admins have a complete, self-contained experience.

### 3.2 Visual Alert Badge on Advanced Tools

**Decision:** The Advanced Tools dropdown in the Financial Services portal sidebar shows a visual alert badge when active anomalies or integration errors are detected.

**Rationale:** Operations staff need to be immediately aware of system health issues without having to navigate to the Anomaly Detection or Integrations pages. The badge provides a passive, always-visible signal.

### 3.3 Per-Institution Module Toggle

**Decision:** Infinity AI can enable or disable modules for specific institutions independently of the institution's own admin toggle.

**Rationale:** This is a critical commercial control. During pilots, Infinity AI may need to restrict access to certain modules (e.g., disable Account-Level Reconciliation for a client on the Starter tier). The override mechanism provides this control without requiring code changes or database migrations.

### 3.4 CBN Compliance Module

**Decision:** A dedicated CBN (Central Bank of Nigeria) compliance module was built, tracking report frameworks, submissions, findings, and action plans.

**Rationale:** Nigerian financial institutions are subject to CBN reporting requirements. Providing a built-in CBN compliance tracker differentiates ReconcileAI from generic reconciliation tools and creates additional stickiness with Nigerian bank clients.

### 3.5 Shared Report Tokens

**Decision:** Reports can be shared via a signed token that provides time-limited, read-only access without requiring a login.

**Rationale:** CFOs and board members who need to review reconciliation reports should not be required to create platform accounts. The shared token mechanism allows reports to be shared via email or messaging apps while maintaining security (tokens expire and can be revoked).

### 3.6 Guest Demo Mode

**Decision:** A guest access system allows prospective clients to explore the platform without creating an account.

**Rationale:** Reducing friction in the sales process is critical. Requiring a prospect to create an account before seeing the product creates unnecessary drop-off. The guest demo mode allows Infinity AI to send a demo link to a prospect and have them explore the platform immediately.

---

## 4. Scope Decisions (Deliberately Left Out)

### 4.1 Mobile Application

**Decision:** No mobile application was built.

**Rationale:** Reconciliation is a desktop-first workflow. Operations staff work at computers with large screens and multiple data sources open simultaneously. A mobile app is not a priority for FY1.

### 4.2 Open Banking Integration

**Decision:** No open banking (NIBSS, NIP) integration was built.

**Rationale:** Open banking integration requires regulatory approval and API access agreements that are beyond the scope of the prototype. The SFTP and API ingestion modules provide a sufficient path to ingest data from any source.

### 4.3 Blockchain / Immutable Ledger

**Decision:** The audit trail uses a standard database table, not a blockchain or immutable ledger.

**Rationale:** The audit trail is append-only in practice (no update or delete operations are exposed), which provides sufficient immutability for the pilot. A blockchain-based audit trail would add significant complexity without proportionate benefit at this stage.

### 4.4 Multi-Currency

**Decision:** All amounts are treated as NGN. No multi-currency support.

**Rationale:** The Lapo pilot is NGN-only. Multi-currency adds significant complexity to the matching algorithm and reporting. It is deferred to a future release.

---

## 5. Demo Organisations in the Database

The following organisations were created in the prototype database for testing and demonstration:

| ID | Name | Segment | Purpose |
|---|---|---|---|
| 1 | Globus Bank Nigeria (Demo) | `financial_services` | Financial Services portal demo |
| 30001 | BrightGoods Nigeria Ltd (Demo) | `corporate_b2b` | Corporate B2B portal demo |
| 30002 | Infinity AI Africa Limited | `super_admin` | Super admin org (Richard's account) |

**Note:** These are demo organisations with no real data. For the Lapo pilot, create a new organisation with `segment = financial_services` and assign Lapo's users to it.

---

## 6. Environment Variables Reference

See `.env.example` in the repository root for the full list. The following are the most critical variables that differ between the prototype (Manus) and production (Rocket.new):

| Variable | Prototype Value | Production Value |
|---|---|---|
| `DATABASE_URL` | Manus TiDB (auto-injected) | Production MySQL/TiDB connection string |
| `JWT_SECRET` | Manus auto-injected | 32+ character random string |
| `VITE_APP_ID` | Manus OAuth app ID | Remove (not needed without Manus OAuth) |
| `OAUTH_SERVER_URL` | `https://api.manus.im` | Remove (not needed without Manus OAuth) |
| `VITE_OAUTH_PORTAL_URL` | Manus login portal URL | Remove (not needed without Manus OAuth) |
| `BUILT_IN_FORGE_API_KEY` | Manus auto-injected | Remove (use `DIRECT_LLM_API_KEY` instead) |
| `BUILT_IN_FORGE_API_URL` | Manus auto-injected | Remove |
| `DIRECT_LLM_API_KEY` | Not set (uses Forge) | OpenAI or Anthropic API key |
| `DIRECT_LLM_API_URL` | Not set | `https://api.openai.com/v1/chat/completions` |
| `DIRECT_LLM_MODEL` | Not set | `gpt-4o-mini` |
| `AWS_ACCESS_KEY_ID` | Manus auto-injected | Production AWS/R2 key |
| `AWS_SECRET_ACCESS_KEY` | Manus auto-injected | Production AWS/R2 secret |
| `AWS_REGION` | Manus default | `af-south-1` |
| `AWS_S3_BUCKET` | Manus default | `reconcileai-prod` |
| `RESEND_API_KEY` | Not set (email mocked) | Resend API key |
| `WOODCORE_API_URL` | Not set | Woodcore API base URL (when whitelisted) |
| `WOODCORE_CLIENT_ID` | Not set | Woodcore client ID |
| `WOODCORE_CLIENT_SECRET` | Not set | Woodcore client secret |
