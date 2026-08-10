/**
 * Automated tenant provisioning — the "live in hours, not weeks" baseline.
 *
 * Every path that creates an organization (direct create, any CBS-connector
 * onboarding) calls provisionTenantBaseline() so a new tenant is born with:
 *
 *   1. its own envelope-encryption key (tenant_encryption_keys)
 *   2. its rate-limit/quota row at platform defaults (tenant_quotas)
 *   3. both reconciliation modules enabled (module_configurations)
 *
 * Idempotent: safe to re-run on an existing org (unique keys make each step
 * a no-op the second time), which is also the "repair" tool when a step
 * failed the first time. Returns a checklist so the operator sees exactly
 * what was provisioned — that checklist is the technical half of the 4-hour
 * contract-to-live SLA (the human half: credentials + DNS/email are ready).
 */
import { tenantQuotas } from "../drizzle/tenant_schema";
import { moduleConfigurations, organizations } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { modulesForSegment } from "@shared/moduleScope";
import { getDb } from "./db";
import { provisionTenantKey } from "./_core/tenantKeys";

export interface ProvisionStep {
  step: "encryption_key" | "quotas" | "modules";
  status: "created" | "already_present" | "failed";
  detail?: string;
}

export interface ProvisionResult {
  organizationId: number;
  ok: boolean;
  steps: ProvisionStep[];
}

function isDuplicate(err: unknown): boolean {
  return /duplicate/i.test(err instanceof Error ? err.message : String(err));
}

export async function provisionTenantBaseline(organizationId: number): Promise<ProvisionResult> {
  const steps: ProvisionStep[] = [];
  const db = await getDb();
  if (!db) {
    return {
      organizationId,
      ok: false,
      steps: [{ step: "encryption_key", status: "failed", detail: "database unavailable" }],
    };
  }

  // 1) Per-tenant encryption key (envelope DEK, wrapped by KMS/local master).
  try {
    await provisionTenantKey(organizationId);
    steps.push({ step: "encryption_key", status: "created" });
  } catch (err) {
    if (isDuplicate(err)) steps.push({ step: "encryption_key", status: "already_present" });
    else steps.push({ step: "encryption_key", status: "failed", detail: err instanceof Error ? err.message : String(err) });
  }

  // 2) Quota row at platform defaults (super admins tune per tenant later).
  try {
    await db.insert(tenantQuotas).values({ organizationId });
    steps.push({ step: "quotas", status: "created" });
  } catch (err) {
    if (isDuplicate(err)) steps.push({ step: "quotas", status: "already_present" });
    else steps.push({ step: "quotas", status: "failed", detail: err instanceof Error ? err.message : String(err) });
  }

  // 3) Reconciliation modules on by default — but only the ones the tenant's
  //    vertical can actually use. This previously enabled BOTH for everyone, so
  //    every SHOPLINE merchant was provisioned with Account-Level (GL-to-CBS)
  //    reconciliation switched on, a module presupposing a general ledger wired
  //    to a core banking system. See shared/moduleScope.
  const [org] = await db
    .select({ segment: organizations.segment })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  for (const moduleType of modulesForSegment(org?.segment)) {
    try {
      await db.insert(moduleConfigurations).values({ organizationId, moduleType, isEnabled: true });
    } catch (err) {
      if (!isDuplicate(err)) {
        steps.push({ step: "modules", status: "failed", detail: `${moduleType}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }
  if (!steps.some((s) => s.step === "modules")) {
    steps.push({ step: "modules", status: "created" });
  }

  return { organizationId, ok: steps.every((s) => s.status !== "failed"), steps };
}
