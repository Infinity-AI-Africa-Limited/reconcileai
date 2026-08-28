/**
 * Row-level security audit — as a permanent, failing-by-default ratchet.
 *
 * MySQL/TiDB has no Postgres-style RLS policies, so tenant isolation is
 * enforced in the application layer (server/_core/tenancy.ts + org-scoped
 * queries). What CAN be enforced mechanically is the audit itself:
 *
 *   - every table in every drizzle schema file must be classified below;
 *   - the classification must match the table's actual columns
 *     (tenant_required ⇒ organizationId NOT NULL, etc.);
 *   - adding a table without classifying it FAILS CI.
 *
 * That turns "we audited RLS once" into "every future table is audited at
 * the moment it is written". The prose companion (enforcement points, gaps,
 * remediation plan) lives in docs/security/RLS_AUDIT.md.
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import * as mainSchema from "../drizzle/schema";
import * as woodcoreSchema from "../drizzle/woodcore_schema";
import * as pocSchema from "../drizzle/poc_schema";
import * as mmSchema from "../drizzle/mobile_money_schema";
import * as connectorSchema from "../drizzle/connector_schema";
import * as tenantSchema from "../drizzle/tenant_schema";

type TenancyClass =
  /** organizationId NOT NULL — the standard for all new tenant data. */
  | "tenant_required"
  /** organizationId nullable — legacy prototype tables (userId-fallback era). */
  | "tenant_nullable"
  /** Scoped by userId; reached only through the authed user's own session. */
  | "user_scoped"
  /** Scoped by pocSlug/pocKey behind per-POC access tokens (public demos). */
  | "poc_scoped"
  /** Scoped through a parent row's org (jobId/configId/…); no own org column. */
  | "derived"
  /** Intentionally cross-tenant: reference data, platform ops, anonymized pool. */
  | "global"
  /** Single-tenant Fineract mirror for the Woodcore POC (known caveat). */
  | "mirror_single_tenant"
  /** Auth/share tokens — random-secret keyed. */
  | "token";

// ─── The audited classification (docs/security/RLS_AUDIT.md mirrors this) ───
const CLASSIFICATION: Record<string, TenancyClass> = {
  // Core tenancy
  organizations: "global",
  users: "tenant_nullable",
  channels: "tenant_nullable",
  upload_batches: "tenant_nullable",
  transactions: "tenant_nullable",
  reconciliation_jobs: "tenant_nullable",
  // Both carried their own organizationId as of migration 0078, backfilled from
  // the parent reconciliation job. Nullable rather than required because ~2,000
  // matches and ~42 exceptions point at a jobId with no surviving job, leaving
  // nothing to inherit — NULL there means "legacy / underivable", as it does on
  // transactions. This closes RLS finding F1.
  matches: "tenant_nullable",
  exceptions: "tenant_nullable",
  audit_logs: "tenant_nullable",
  exception_aging_settings: "tenant_nullable",
  reconciliation_reports: "tenant_nullable",
  webhooks: "tenant_nullable",
  // WS-4 delivery tracking: no own org column by design — org scope derives
  // from webhookId → webhooks.organizationId (all queries join through it).
  webhook_deliveries: "derived",
  api_keys: "tenant_nullable",
  scheduled_tasks: "tenant_nullable",
  schedule_run_history: "derived",
  email_preferences: "tenant_nullable",
  job_progress_events: "derived",
  api_ingestion_logs: "tenant_nullable",
  sftp_credentials: "tenant_nullable",
  sftp_ingestion_logs: "tenant_nullable",
  // Object-storage drop ingestion. NOT NULL organizationId — the SFTP pair is
  // "tenant_nullable" only because it predates the standard; new tables hold
  // the line.
  bucket_ingestion_sources: "tenant_required",
  bucket_ingestion_logs: "tenant_required",
  // Email-forward ingestion. The source is org-owned; the LOG is nullable by
  // design because a delivery to an unrecognised address has no organization
  // yet must still be recorded — an unattributable rejection is exactly the
  // signal that an address has leaked.
  email_ingestion_sources: "tenant_required",
  email_ingestion_logs: "tenant_nullable",
  user_role_preferences: "tenant_nullable",
  anomaly_scores: "tenant_nullable",
  detection_rules: "tenant_nullable",
  guest_sessions: "token",
  resolution_templates: "tenant_nullable",
  module_configurations: "tenant_required",
  module_overrides: "tenant_required",
  // Corporate B2B pilot controls hold customer-provided operational evidence,
  // so both tables are tenant-required from their first migration.
  corporate_b2b_pilot_configs: "tenant_required",
  corporate_b2b_pilot_sources: "tenant_required",
  // Shared workflow/pilot evidence is tenant-owned from its first migration.
  control_fit_briefs: "tenant_required",
  distributors: "tenant_nullable",
  agent_action_drafts: "tenant_nullable",
  agent_memory: "tenant_nullable",
  exception_pattern_signatures: "tenant_nullable",
  exception_intelligence_settings: "tenant_nullable",
  shared_exception_patterns: "global",
  guest_tokens: "tenant_nullable",
  demo_requests: "global",
  dashboard_stats_cache: "tenant_nullable",
  compliance_settings: "tenant_nullable",
  data_deletion_requests: "tenant_nullable",
  security_incidents: "tenant_nullable",
  compliance_assessments: "global",
  cbnReportFrameworks: "global",
  cbnReportSubmissions: "tenant_nullable",
  cbnReportFindings: "tenant_nullable",
  cbnActionPlans: "tenant_nullable",
  cbnAuditLog: "tenant_nullable",
  cbnDeadlineSubmissions: "tenant_nullable",
  cbn_report_settings: "tenant_required",
  cbn_report_runs: "tenant_nullable",
  roadmapAccessRequests: "global",
  sharedReportTokens: "tenant_nullable",
  cfo_report_schedules: "tenant_nullable",
  channel_alert_settings: "tenant_nullable",
  s3_csv_exports: "tenant_nullable",
  magic_link_tokens: "token",
  // Token-keyed like magic_link_tokens, but classified tenant_required rather
  // than "token" because it carries organizationId NOT NULL and that column is
  // load-bearing: it is the single tenant the issued session may ever see. The
  // stricter class is the accurate one, and keeps the column under the ratchet.
  reviewer_access_links: "tenant_required",
  platform_audit_logs: "global",

  // Woodcore Fineract mirror (POC) — single-tenant by design; multi-tenant
  // Woodcore clients ingest via the connector into `transactions` instead.
  wc_acc_gl_account: "mirror_single_tenant",
  wc_acc_product_mapping: "mirror_single_tenant",
  wc_acc_gl_journal_entry: "mirror_single_tenant",
  wc_acc_to_gl_journal_entry: "mirror_single_tenant",
  wc_acc_to_gl_journal_entry_savings: "mirror_single_tenant",
  wc_m_savings_product: "mirror_single_tenant",
  wc_m_product_loan: "mirror_single_tenant",
  wc_m_savings_account: "mirror_single_tenant",
  wc_m_savings_account_transaction: "mirror_single_tenant",
  wc_m_loan: "mirror_single_tenant",
  wc_m_loan_transaction: "mirror_single_tenant",
  wc_reconciliation_runs: "mirror_single_tenant",
  wc_share_tokens: "token",
  wc_exceptions: "mirror_single_tenant",

  // Public POC surface (per-POC access tokens; isolated from tenant data)
  poc_access_tokens: "poc_scoped",
  poc_uploads: "poc_scoped",
  poc_runs: "poc_scoped",
  poc_exceptions: "poc_scoped",
  poc_share_tokens: "token",
  poc_file_uploads: "poc_scoped",
  mm_runs: "poc_scoped",
  mm_exceptions: "poc_scoped",

  // CBS connector (post-hardening standard: org NOT NULL everywhere)
  wc_connector_configs: "tenant_required",
  wc_connector_sync_runs: "tenant_required",
  wc_connector_webhook_events: "tenant_required",
  wc_connector_dead_letters: "tenant_required",
  wc_connector_field_mappings: "tenant_required",

  // SHOPLINE retail connector — each row is scoped to an org (orgId NOT NULL)
  sl_connector_stores: "tenant_required",
  sl_connector_subscriptions: "tenant_required",
  sl_connector_tokens: "tenant_required",
  sl_connector_webhook_events: "tenant_required",
  // GDPR requests may arrive for a shop we can no longer resolve to a tenant
  // (already offboarded), so organizationId is nullable by design — retained
  // for audit. Queries scope by org when present.
  sl_connector_gdpr_requests: "tenant_nullable",

  // Tenant infrastructure (this hardening work)
  tenant_encryption_keys: "tenant_required",
  tenant_quotas: "tenant_required",
};

// ─── Collect every table from every schema module ────────────────────────────
function collectTables(): Array<{ name: string; hasOrg: boolean; orgNotNull: boolean }> {
  const modules: Record<string, unknown>[] = [
    mainSchema as unknown as Record<string, unknown>,
    woodcoreSchema as unknown as Record<string, unknown>,
    pocSchema as unknown as Record<string, unknown>,
    mmSchema as unknown as Record<string, unknown>,
    connectorSchema as unknown as Record<string, unknown>,
    tenantSchema as unknown as Record<string, unknown>,
  ];
  const out: Array<{ name: string; hasOrg: boolean; orgNotNull: boolean }> = [];
  const seen = new Set<string>();
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (!(value instanceof MySqlTable)) continue;
      const name = getTableName(value);
      if (seen.has(name)) continue;
      seen.add(name);
      const cols = getTableColumns(value);
      const org = cols["organizationId"];
      out.push({ name, hasOrg: Boolean(org), orgNotNull: Boolean(org?.notNull) });
    }
  }
  return out;
}

describe("RLS audit ratchet — every table classified, classification true", () => {
  const tables = collectTables();

  it("finds a sane number of tables", () => {
    expect(tables.length).toBeGreaterThan(60);
  });

  it("every table is classified (new tables must be added to the audit)", () => {
    const unclassified = tables.filter((t) => !(t.name in CLASSIFICATION)).map((t) => t.name);
    expect(
      unclassified,
      `Unclassified tables — add them to CLASSIFICATION here AND to docs/security/RLS_AUDIT.md: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("classification has no stale entries", () => {
    const names = new Set(tables.map((t) => t.name));
    const stale = Object.keys(CLASSIFICATION).filter((n) => !names.has(n));
    expect(stale, `Stale audit entries (table dropped/renamed?): ${stale.join(", ")}`).toEqual([]);
  });

  it("tenant_required tables really have organizationId NOT NULL", () => {
    const violations = tables
      .filter((t) => CLASSIFICATION[t.name] === "tenant_required")
      .filter((t) => !t.hasOrg || !t.orgNotNull)
      .map((t) => `${t.name} (hasOrg=${t.hasOrg}, notNull=${t.orgNotNull})`);
    expect(violations).toEqual([]);
  });

  it("tenant_nullable tables really have an organizationId column", () => {
    const violations = tables
      .filter((t) => CLASSIFICATION[t.name] === "tenant_nullable")
      .filter((t) => !t.hasOrg)
      .map((t) => t.name);
    expect(violations).toEqual([]);
  });

  it("non-tenant classes do not silently carry an org column (should be reclassified)", () => {
    const violations = tables
      .filter((t) =>
        ["derived", "user_scoped", "poc_scoped", "token", "mirror_single_tenant"].includes(
          CLASSIFICATION[t.name] ?? "",
        ),
      )
      .filter((t) => t.hasOrg)
      .map((t) => t.name);
    expect(
      violations,
      `These have organizationId — classify as tenant_required/tenant_nullable: ${violations.join(", ")}`,
    ).toEqual([]);
  });

  it("prints the audit summary (for docs/security/RLS_AUDIT.md upkeep)", () => {
    const byClass = new Map<string, number>();
    for (const t of tables) {
      const c = CLASSIFICATION[t.name] ?? "UNCLASSIFIED";
      byClass.set(c, (byClass.get(c) ?? 0) + 1);
    }
    // Not an assertion — a visible inventory line in test output.
    console.log(
      "[rls-audit]",
      Array.from(byClass.entries())
        .map(([c, n]) => `${c}=${n}`)
        .join(" "),
      `total=${tables.length}`,
    );
    expect(byClass.size).toBeGreaterThan(3);
  });
});
