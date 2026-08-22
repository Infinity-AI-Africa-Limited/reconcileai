/** Corporate B2B no-write pilot control router. */
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { corporateB2BPilotConfigs, corporateB2BPilotSources, distributors, organizations } from "../../drizzle/schema";
import { createAuditLogRequired, getDb } from "../db";
import {
  calculateCorporateB2BPilotReadiness,
  CORPORATE_B2B_DELIVERY_METHODS,
  CORPORATE_B2B_SOURCE_STATUSES,
  CORPORATE_B2B_SOURCE_TYPES,
  type CorporateB2BPilotReadinessConfig,
  type CorporateB2BPilotReadinessSource,
} from "../corporateB2BPilotReadiness";
import { protectedProcedure, router } from "../_core/trpc";

function requireOrg(user: { organizationId?: number | null }): number {
  if (!user.organizationId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your account is not linked to an organisation." });
  return user.organizationId;
}

async function requireCorporateB2B(user: { organizationId?: number | null }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const organizationId = requireOrg(user);
  const [org] = await db.select({ segment: organizations.segment }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (org?.segment !== "corporate_b2b") throw new TRPCError({ code: "FORBIDDEN", message: "Corporate B2B pilot controls are only available in the Corporate B2B portal." });
  return { db, organizationId };
}

export function requirePilotManager(role: string): void {
  if (!(["admin", "cfo", "super_admin"] as const).includes(role as "admin" | "cfo" | "super_admin")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only a CFO, administrator, or Infinity AI staff member can change pilot controls." });
  }
}

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((value) => value || undefined);
const requiredText = (max: number) => z.string().trim().min(1).max(max);
export const corporateB2BPilotConfigInput = z.object({
  country: z.enum(["uganda", "nigeria"]),
  pilotState: z.enum(["preparation", "data_validation", "dry_run", "parallel_run", "limited_control", "suspended"]),
  pilotScope: optionalText(500), noWriteAcknowledged: z.boolean(), aiAssistanceMode: z.enum(["disabled", "private_approved"]), aiBoundaryReference: optionalText(255),
  dataContractStatus: z.enum(["draft", "approved"]), rosterStatus: z.enum(["draft", "approved"]), allocationPolicyStatus: z.enum(["draft", "approved"]), dailyCloseOwner: optionalText(255),
  operationalRecoveryStatus: z.enum(["not_tested", "passed"]), retentionDays: z.number().int().min(1).max(3650),
  contractStatus: z.enum(["draft", "approved"]), dataProcessingStatus: z.enum(["draft", "approved"]), contractReference: optionalText(255), dataProcessingReference: optionalText(255),
}).superRefine((value, ctx) => {
  if (value.noWriteAcknowledged && !value.pilotScope) ctx.addIssue({ code: "custom", path: ["pilotScope"], message: "A bounded pilot scope is required before acknowledging the no-write boundary." });
  if (value.allocationPolicyStatus === "approved" && !value.dailyCloseOwner) ctx.addIssue({ code: "custom", path: ["dailyCloseOwner"], message: "An approved allocation policy requires a daily close owner." });
  if (value.aiAssistanceMode === "private_approved" && !value.aiBoundaryReference) ctx.addIssue({ code: "custom", path: ["aiBoundaryReference"], message: "A private AI route requires an approved boundary reference." });
  if (value.contractStatus === "approved" && !value.contractReference) ctx.addIssue({ code: "custom", path: ["contractReference"], message: "Approved commercial terms require a reference." });
  if (value.dataProcessingStatus === "approved" && !value.dataProcessingReference) ctx.addIssue({ code: "custom", path: ["dataProcessingReference"], message: "Approved data-processing terms require a reference." });
});

const sourceInput = z.object({ sourceType: z.enum(CORPORATE_B2B_SOURCE_TYPES), displayName: requiredText(255), deliveryMethod: z.enum(CORPORATE_B2B_DELIVERY_METHODS), expectedCutoff: optionalText(64), sourceOwner: optionalText(255), notes: optionalText(2000) });
const sourceStatusInput = z.object({ id: z.number().int().positive(), status: z.enum(CORPORATE_B2B_SOURCE_STATUSES), customerOwnedCredentials: z.boolean(), controlTotalRequired: z.boolean() });

async function loadReadiness(user: { organizationId?: number | null }) {
  const { db, organizationId } = await requireCorporateB2B(user);
  const [config] = await db.select().from(corporateB2BPilotConfigs).where(eq(corporateB2BPilotConfigs.organizationId, organizationId)).limit(1);
  const sources = await db.select().from(corporateB2BPilotSources).where(eq(corporateB2BPilotSources.organizationId, organizationId));
  const [roster] = await db.select({ total: sql<number>`count(*)`, pending: sql<number>`sum(case when ${distributors.status} = 'pending_confirmation' then 1 else 0 end)`, flagged: sql<number>`sum(case when ${distributors.status} = 'flagged' then 1 else 0 end)` }).from(distributors).where(eq(distributors.organizationId, organizationId));
  const rosterState = { total: Number(roster?.total ?? 0), pending: Number(roster?.pending ?? 0), flagged: Number(roster?.flagged ?? 0) };
  const readiness = calculateCorporateB2BPilotReadiness({ config: (config ?? null) as CorporateB2BPilotReadinessConfig | null, sources: sources as CorporateB2BPilotReadinessSource[], roster: rosterState });
  return { config: config ?? null, sources, roster: rosterState, ...readiness };
}

export const corporateB2BPilotRouter = router({
  readiness: protectedProcedure.query(({ ctx }) => loadReadiness(ctx.user)),
  updateConfig: protectedProcedure.input(corporateB2BPilotConfigInput).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role); const { db, organizationId } = await requireCorporateB2B(ctx.user);
    await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: corporateB2BPilotConfigs.id }).from(corporateB2BPilotConfigs).where(eq(corporateB2BPilotConfigs.organizationId, organizationId)).limit(1);
      const values = { ...input, organizationId, updatedByUserId: ctx.user.id };
      if (existing) await tx.update(corporateB2BPilotConfigs).set(values).where(eq(corporateB2BPilotConfigs.id, existing.id)); else await tx.insert(corporateB2BPilotConfigs).values(values);
      await createAuditLogRequired(tx, { userId: ctx.user.id, organizationId, action: "corporate_b2b_pilot_config_updated", entityType: "corporate_b2b_pilot", entityId: existing?.id, details: JSON.stringify({ country: input.country, pilotState: input.pilotState, noWriteAcknowledged: input.noWriteAcknowledged, aiAssistanceMode: input.aiAssistanceMode, dataContractStatus: input.dataContractStatus }) });
    });
    return loadReadiness(ctx.user);
  }),
  createSource: protectedProcedure.input(sourceInput).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role); const { db, organizationId } = await requireCorporateB2B(ctx.user); let id = 0;
    await db.transaction(async (tx) => { const [result] = await tx.insert(corporateB2BPilotSources).values({ ...input, organizationId, createdByUserId: ctx.user.id }); id = Number(result.insertId); await createAuditLogRequired(tx, { userId: ctx.user.id, organizationId, action: "corporate_b2b_pilot_source_created", entityType: "corporate_b2b_pilot_source", entityId: id, details: JSON.stringify({ sourceType: input.sourceType, deliveryMethod: input.deliveryMethod }) }); });
    return { id };
  }),
  updateSourceStatus: protectedProcedure.input(sourceStatusInput).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role); const { db, organizationId } = await requireCorporateB2B(ctx.user);
    await db.transaction(async (tx) => { const result = await tx.update(corporateB2BPilotSources).set({ status: input.status, customerOwnedCredentials: input.customerOwnedCredentials, controlTotalRequired: input.controlTotalRequired }).where(and(eq(corporateB2BPilotSources.id, input.id), eq(corporateB2BPilotSources.organizationId, organizationId))); if (!result[0]?.affectedRows) throw new TRPCError({ code: "NOT_FOUND", message: "Pilot source not found." }); await createAuditLogRequired(tx, { userId: ctx.user.id, organizationId, action: "corporate_b2b_pilot_source_updated", entityType: "corporate_b2b_pilot_source", entityId: input.id, details: JSON.stringify({ status: input.status, customerOwnedCredentials: input.customerOwnedCredentials, controlTotalRequired: input.controlTotalRequired }) }); });
    return { success: true };
  }),
  deleteSource: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role); const { db, organizationId } = await requireCorporateB2B(ctx.user);
    await db.transaction(async (tx) => { const result = await tx.delete(corporateB2BPilotSources).where(and(eq(corporateB2BPilotSources.id, input.id), eq(corporateB2BPilotSources.organizationId, organizationId))); if (!result[0]?.affectedRows) throw new TRPCError({ code: "NOT_FOUND", message: "Pilot source not found." }); await createAuditLogRequired(tx, { userId: ctx.user.id, organizationId, action: "corporate_b2b_pilot_source_deleted", entityType: "corporate_b2b_pilot_source", entityId: input.id, details: "{}" }); });
    return { success: true };
  }),
});
