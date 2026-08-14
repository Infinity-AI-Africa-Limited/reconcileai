/**
 * Automated tenant provisioning — the "live in hours, not weeks" baseline.
 *
 * Every path that creates an organization (direct create, any CBS-connector
 * onboarding) calls provisionTenantBaseline() so a new tenant is born with:
 *
 *   1. its own envelope-encryption key (tenant_encryption_keys)
 *   2. its rate-limit/quota row at platform defaults (tenant_quotas)
 *   3. the reconciliation modules its vertical can use, enabled
 *      (module_configurations — see shared/moduleScope)
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
import { modulesForSegment, type ModuleType } from "@shared/moduleScope";
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

/**
 * Which modules to provision, or why we could not tell.
 *
 * Split out from the step below so the failure path is provable without a
 * database: the caller passes the lookup, a test passes one that throws.
 *
 * Returning the failure rather than throwing it is the point. Every other step
 * records its own outcome and provisioning always answers with a checklist —
 * a rejection escaping here would take the encryption-key and quota results
 * with it and leave a half-provisioned tenant behind a generic error.
 */
export async function modulesToProvision(
  lookupSegment: () => Promise<string | null | undefined>,
): Promise<{ modules: readonly ModuleType[] } | { failed: string }> {
  try {
    return { modules: modulesForSegment(await lookupSegment()) };
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
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
  //
  //    The lookup is wrapped for the same reason every other step is: this
  //    function's contract is to RETURN a checklist, never to throw. A bare
  //    rejection here discards the encryption-key and quota results the operator
  //    needs, so a tenant that was two-thirds provisioned reports as a generic
  //    error with nothing to act on — and the checklist is the technical half of
  //    the 4-hour contract-to-live SLA.
  //
  //    It deliberately does NOT fall back to the default set. modulesForSegment
  //    answers an unknown segment with BOTH modules, which is correct when the
  //    segment is genuinely unset, but on a transient DB failure it would switch
  //    Account-Level back on for exactly the retail tenants this step exists to
  //    keep it away from. Recording a failed step is the honest outcome, and
  //    provisioning is idempotent, so re-running repairs it.
  const scoped = await modulesToProvision(async () => {
    const [org] = await db
      .select({ segment: organizations.segment })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return org?.segment;
  });
  if ("failed" in scoped) {
    steps.push({ step: "modules", status: "failed", detail: `segment lookup: ${scoped.failed}` });
  }

  for (const moduleType of "modules" in scoped ? scoped.modules : []) {
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
