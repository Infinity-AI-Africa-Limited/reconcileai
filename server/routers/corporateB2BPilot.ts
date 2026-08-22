/**
 * Corporate B2B controlled-pilot readiness.
 *
 * This router tracks the evidence needed for a *read-only* FMCG/distributor
 * reconciliation pilot. It never stores provider credentials, initiates a
 * payment, posts to an ERP, or represents a customer attestation as proof.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  corporateB2BPilotConfigs,
  corporateB2BPilotSources,
  distributors,
  organizations,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { logAudit } from "./shared";

const SOURCE_TYPES = ["invoice_ar", "bank_statement", "mobile_money", "psp_collection", "erp_export"] as const;
const DELIVERY_METHODS = ["manual_export", "sftp", "bucket", "api"] as const;
const SOURCE_STATUSES = ["draft", "tested", "approved", "active", "suspended"] as const;

function requireOrg(user: { organizationId?: number | null }): number {
  if (!user.organizationId) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your account is not linked to an organisation." });
  }
  return user.organizationId;
}

async function requireCorporateB2B(user: { organizationId?: number | null }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const organizationId = requireOrg(user);
  const [org] = await db.select({ segment: organizations.segment }).from(organizations)
    .where(eq(organizations.id, organizationId)).limit(1);
  if (org?.segment !== "corporate_b2b") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Corporate B2B pilot controls are only available in the Corporate B2B portal." });
  }
  return { db, organizationId };
}

function canManagePilot(role: string) {
  return role === "admin" || role === "cfo" || role === "super_admin";
}

function requirePilotManager(role: string) {
  if (!canManagePilot(role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only a CFO, administrator, or Infinity AI staff member can change pilot controls." });
  }
}

export function calculateCorporateB2BPilotReadiness(input: {
  config: any | null;
  sources: Array<any>;
  roster: { total: number; pending: number; flagged: number };
}) {
  const { config, sources } = input;
  const { total, pending, flagged } = input.roster;
  const sourceCount = sources.length;
  const testedSources = sources.filter((source) => source.status === "tested" || source.status === "approved" || source.status === "active");
  const approvedSources = sources.filter((source) => source.status === "approved" || source.status === "active");
  const safeSources = sources.every((source) => source.customerOwnedCredentials && source.controlTotalRequired);
  const hasInvoiceEvidence = approvedSources.some((source) => source.sourceType === "invoice_ar");
  const hasReceiptEvidence = approvedSources.some((source) => ["bank_statement", "mobile_money", "psp_collection"].includes(source.sourceType));
  const gates = [
    { id: "B0", label: "Read-only launch boundary", ready: Boolean(config?.noWriteAcknowledged && config?.pilotScope), detail: "No payment initiation, account access, ERP posting, customer messaging, or credit-note action." },
    { id: "B1", label: "Canonical data contract", ready: config?.dataContractStatus === "approved" && hasInvoiceEvidence && hasReceiptEvidence, detail: "Approved invoice/AR and receipt evidence with a documented source hierarchy." },
    { id: "B2", label: "Customer-authorised source route", ready: testedSources.length >= 2 && safeSources, detail: "At least two tested customer-controlled sources, each with a control total." },
    { id: "B3", label: "Distributor master-data governance", ready: config?.rosterStatus === "approved" && total > 0 && pending === 0 && flagged === 0, detail: "An approved roster with no unconfirmed or flagged distributor identities." },
    { id: "B4", label: "Allocation and daily-close policy", ready: config?.allocationPolicyStatus === "approved" && Boolean(config?.dailyCloseOwner), detail: "Human-approved allocation proposals and a named daily finance-close owner." },
    { id: "B5", label: "AI and external-data boundary", ready: config?.aiAssistanceMode === "disabled" || (config?.aiAssistanceMode === "private_approved" && Boolean(config?.aiBoundaryReference)), detail: "AI is disabled by default; a private approved route requires a recorded sign-off reference." },
    { id: "B6", label: "Foundation hardening deployment", ready: false, external: true, detail: "Requires reviewed deployment evidence for Infinity AI PR #96 and mirror PR #26, plus durable queue configuration where enabled." },
    { id: "B7", label: "Recovery and retention evidence", ready: config?.operationalRecoveryStatus === "passed" && Number(config?.retentionDays ?? 0) > 0, detail: "Successful replay/recovery evidence and a time-bound retention policy." },
    { id: "B8", label: "Commercial and data-processing terms", ready: config?.contractStatus === "approved" && config?.dataProcessingStatus === "approved" && Boolean(config?.contractReference) && Boolean(config?.dataProcessingReference), detail: "Recorded contract and data-processing references; the customer remains responsible for legal validity." },
  ];
  return { gates, sourceCount, testedSources: testedSources.length, approvedSources: approvedSources.length, canStartReadOnlyPilot: gates.every((gate) => gate.ready), blockedBy: gates.filter((gate) => !gate.ready).map((gate) => gate.id) };
}

async function loadReadiness(user: { organizationId?: number | null }) {
  const { db, organizationId } = await requireCorporateB2B(user);
  const [config] = await db.select().from(corporateB2BPilotConfigs)
    .where(eq(corporateB2BPilotConfigs.organizationId, organizationId)).limit(1);
  const sources = await db.select().from(corporateB2BPilotSources)
    .where(eq(corporateB2BPilotSources.organizationId, organizationId));
  const [roster] = await db.select({
    total: sql<number>`count(*)`,
    pending: sql<number>`sum(case when ${distributors.status} = 'pending_confirmation' then 1 else 0 end)`,
    flagged: sql<number>`sum(case when ${distributors.status} = 'flagged' then 1 else 0 end)`,
  }).from(distributors).where(eq(distributors.organizationId, organizationId));

  const total = Number(roster?.total ?? 0);
  const pending = Number(roster?.pending ?? 0);
  const flagged = Number(roster?.flagged ?? 0);
  const readiness = calculateCorporateB2BPilotReadiness({ config: config ?? null, sources, roster: { total, pending, flagged } });

  return {
    config: config ?? null,
    sources,
    roster: { total, pending, flagged },
    ...readiness,
  };
}

const configInput = z.object({
  country: z.enum(["uganda", "nigeria"]),
  pilotState: z.enum(["preparation", "data_validation", "dry_run", "parallel_run", "limited_control", "suspended"]),
  pilotScope: z.string().max(500).optional(),
  noWriteAcknowledged: z.boolean(),
  aiAssistanceMode: z.enum(["disabled", "private_approved"]),
  aiBoundaryReference: z.string().max(255).optional(),
  dataContractStatus: z.enum(["draft", "approved"]),
  rosterStatus: z.enum(["draft", "approved"]),
  allocationPolicyStatus: z.enum(["draft", "approved"]),
  dailyCloseOwner: z.string().max(255).optional(),
  operationalRecoveryStatus: z.enum(["not_tested", "passed"]),
  retentionDays: z.number().int().min(1).max(3650),
  contractStatus: z.enum(["draft", "approved"]),
  dataProcessingStatus: z.enum(["draft", "approved"]),
  contractReference: z.string().max(255).optional(),
  dataProcessingReference: z.string().max(255).optional(),
});

export const corporateB2BPilotRouter = router({
  readiness: protectedProcedure.query(({ ctx }) => loadReadiness(ctx.user)),

  updateConfig: adminProcedure.input(configInput).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role);
    const { db, organizationId } = await requireCorporateB2B(ctx.user);
    if (input.aiAssistanceMode === "private_approved" && !input.aiBoundaryReference?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "A private AI route requires an approved boundary reference." });
    }
    const values = { ...input, organizationId, updatedByUserId: ctx.user.id };
    const [existing] = await db.select({ id: corporateB2BPilotConfigs.id }).from(corporateB2BPilotConfigs)
      .where(eq(corporateB2BPilotConfigs.organizationId, organizationId)).limit(1);
    if (existing) await db.update(corporateB2BPilotConfigs).set(values).where(eq(corporateB2BPilotConfigs.id, existing.id));
    else await db.insert(corporateB2BPilotConfigs).values(values);
    await logAudit(ctx.user.id, "corporate_b2b_pilot_config_updated", "corporate_b2b_pilot", existing?.id, {
      country: input.country, pilotState: input.pilotState, noWriteAcknowledged: input.noWriteAcknowledged,
      aiAssistanceMode: input.aiAssistanceMode, dataContractStatus: input.dataContractStatus,
    });
    return loadReadiness(ctx.user);
  }),

  createSource: adminProcedure.input(z.object({
    sourceType: z.enum(SOURCE_TYPES), displayName: z.string().min(1).max(255),
    deliveryMethod: z.enum(DELIVERY_METHODS), expectedCutoff: z.string().max(64).optional(),
    sourceOwner: z.string().max(255).optional(), notes: z.string().max(2000).optional(),
  })).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role);
    const { db, organizationId } = await requireCorporateB2B(ctx.user);
    const [result] = await db.insert(corporateB2BPilotSources).values({ ...input, organizationId, createdByUserId: ctx.user.id });
    await logAudit(ctx.user.id, "corporate_b2b_pilot_source_created", "corporate_b2b_pilot_source", Number(result.insertId), { sourceType: input.sourceType, deliveryMethod: input.deliveryMethod });
    return { id: Number(result.insertId) };
  }),

  updateSourceStatus: adminProcedure.input(z.object({
    id: z.number().int().positive(), status: z.enum(SOURCE_STATUSES), customerOwnedCredentials: z.boolean(), controlTotalRequired: z.boolean(),
  })).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role);
    const { db, organizationId } = await requireCorporateB2B(ctx.user);
    const result = await db.update(corporateB2BPilotSources).set({
      status: input.status, customerOwnedCredentials: input.customerOwnedCredentials, controlTotalRequired: input.controlTotalRequired,
    }).where(and(eq(corporateB2BPilotSources.id, input.id), eq(corporateB2BPilotSources.organizationId, organizationId)));
    if (!result[0]?.affectedRows) throw new TRPCError({ code: "NOT_FOUND", message: "Pilot source not found." });
    await logAudit(ctx.user.id, "corporate_b2b_pilot_source_updated", "corporate_b2b_pilot_source", input.id, { status: input.status, customerOwnedCredentials: input.customerOwnedCredentials, controlTotalRequired: input.controlTotalRequired });
    return { success: true };
  }),

  deleteSource: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role);
    const { db, organizationId } = await requireCorporateB2B(ctx.user);
    const result = await db.delete(corporateB2BPilotSources).where(and(eq(corporateB2BPilotSources.id, input.id), eq(corporateB2BPilotSources.organizationId, organizationId)));
    if (!result[0]?.affectedRows) throw new TRPCError({ code: "NOT_FOUND", message: "Pilot source not found." });
    await logAudit(ctx.user.id, "corporate_b2b_pilot_source_deleted", "corporate_b2b_pilot_source", input.id, {});
    return { success: true };
  }),
});
