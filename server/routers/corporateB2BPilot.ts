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
import { getDb, type DbExecutor } from "../db";
import { resolveOrgScope } from "../_core/tenancy";
import { protectedProcedure, router } from "../_core/trpc";
import { getClientInfo, logAuditStrict } from "./shared";
import {
  calculateCorporateB2BPilotReadiness,
  pilotStateTransitionRefusal,
  type PilotState,
  type QueueDurability,
} from "../corporateB2BPilotReadiness";

// The B0-B8 gate rule is business logic, not routing: it decides whether a
// regulated pilot may start, so it lives on its own and is tested without a
// database or a tRPC context. Re-exported because it is imported from here.
export { calculateCorporateB2BPilotReadiness } from "../corporateB2BPilotReadiness";

const SOURCE_TYPES = ["invoice_ar", "bank_statement", "mobile_money", "psp_collection", "erp_export"] as const;
const DELIVERY_METHODS = ["manual_export", "sftp", "bucket", "api"] as const;
const SOURCE_STATUSES = ["draft", "tested", "approved", "active", "suspended"] as const;
const PILOT_STATES = ["preparation", "data_validation", "dry_run", "parallel_run", "limited_control", "suspended"] as const;

/**
 * Which job-queue backend this deployment is actually running, in the same
 * three states `/api/health` reports.
 *
 * `configured_unverified` is deliberately NOT treated as durable: a wrong or
 * unreachable REDIS_URL is indistinguishable from a correct one until a queue
 * has been built and connected. B6 asks for deployment evidence, and a set
 * environment variable is configuration, not evidence.
 */
async function queueDurability(): Promise<QueueDurability> {
  try {
    const { allQueueStats } = await import("../jobQueue");
    const queues = await allQueueStats();
    const names = Object.keys(queues);
    if (names.length === 0) {
      return process.env.REDIS_URL?.trim() ? "configured_unverified" : "fallback";
    }
    return names.every((name) => queues[name].durable) ? "confirmed" : "fallback";
  } catch {
    // An unreadable queue is not evidence of a durable one.
    return "fallback";
  }
}

/**
 * Which organisation this call operates on.
 *
 * Super admins may pass an explicit `organizationId` so Infinity AI staff can
 * operate a client's pilot controls from inside that client's portal — the same
 * override the CBS connector and Control Fit Brief routers use. Without it,
 * `canManagePilot` listed `super_admin` as an allowed role while this function
 * read the super admin's OWN organisation, whose segment is `super_admin`, and
 * refused them every time: a permission that could never be exercised.
 */
async function requireCorporateB2B(
  user: { role: string; organizationId?: number | null },
  requestedOrganizationId?: number,
) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const organizationId = resolveOrgScope(user, requestedOrganizationId);
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

export function requirePilotManager(role: string) {
  if (!canManagePilot(role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only a CFO, administrator, or Infinity AI staff member can change pilot controls." });
  }
}

/** The rows every gate is computed from, read through one executor. */
type GateState = {
  config: typeof corporateB2BPilotConfigs.$inferSelect | null;
  sources: (typeof corporateB2BPilotSources.$inferSelect)[];
  roster: { total: number; active: number; pending: number; flagged: number; duplicateNames: number };
};

/**
 * Read the gate inputs.
 *
 * `lock` takes a `FOR UPDATE` read on the source contracts and the roster.
 * Without it the readiness snapshot races the state write: a source or roster
 * mutation committing between the check and the upsert lets an advanced pilot
 * state be persisted against gates that have since reopened. The locking read
 * serialises the advance against exactly the two tables the gates depend on;
 * a pilot roster is 10-30 distributors by design, so the lock is small.
 *
 * Only taken when the pilot state is ADVANCING. An ordinary save that leaves
 * the state alone has nothing to serialise against, and should not hold a lock
 * on the roster while it writes.
 */
async function loadGateState(
  executor: DbExecutor,
  organizationId: number,
  lock = false,
): Promise<GateState> {
  const configQuery = executor.select().from(corporateB2BPilotConfigs)
    .where(eq(corporateB2BPilotConfigs.organizationId, organizationId)).limit(1);
  const [config] = await (lock ? configQuery.for("update") : configQuery);

  const sourcesQuery = executor.select().from(corporateB2BPilotSources)
    .where(eq(corporateB2BPilotSources.organizationId, organizationId));
  const sources = await (lock ? sourcesQuery.for("update") : sourcesQuery);

  // A locking read has to be on ROWS, so under `lock` the roster is counted in
  // application code from the locked rows rather than by an aggregate query —
  // `SELECT count(*) ... FOR UPDATE` locks nothing useful.
  let roster: GateState["roster"];
  if (lock) {
    const rows = await executor.select({ status: distributors.status, canonicalName: distributors.canonicalName })
      .from(distributors).where(eq(distributors.organizationId, organizationId)).for("update");
    const seen = new Map<string, number>();
    for (const row of rows) seen.set(row.canonicalName, (seen.get(row.canonicalName) ?? 0) + 1);
    roster = {
      total: rows.length,
      active: rows.filter((r: { status: string }) => r.status === "active").length,
      pending: rows.filter((r: { status: string }) => r.status === "pending_confirmation").length,
      flagged: rows.filter((r: { status: string }) => r.status === "flagged").length,
      duplicateNames: [...seen.values()].filter((count) => count > 1).length,
    };
  } else {
    const [counts] = await executor.select({
      total: sql<number>`count(*)`,
      // "Active" is counted separately from "not pending and not flagged": a
      // roster of entirely inactive distributors satisfies both of those and
      // still has nobody to reconcile against.
      active: sql<number>`sum(case when ${distributors.status} = 'active' then 1 else 0 end)`,
      pending: sql<number>`sum(case when ${distributors.status} = 'pending_confirmation' then 1 else 0 end)`,
      flagged: sql<number>`sum(case when ${distributors.status} = 'flagged' then 1 else 0 end)`,
    }).from(distributors).where(eq(distributors.organizationId, organizationId));

    // Duplicate canonical names, counted as NAMES rather than rows: two rows
    // sharing one name is one governance defect, not two. B3 exists because
    // ungoverned aliases produce false match candidates, and a duplicated
    // identity is the most direct way to get one.
    const duplicateNameRows = await executor.select({ name: distributors.canonicalName })
      .from(distributors)
      .where(eq(distributors.organizationId, organizationId))
      .groupBy(distributors.canonicalName)
      .having(sql`count(*) > 1`);

    roster = {
      total: Number(counts?.total ?? 0),
      active: Number(counts?.active ?? 0),
      pending: Number(counts?.pending ?? 0),
      flagged: Number(counts?.flagged ?? 0),
      duplicateNames: duplicateNameRows.length,
    };
  }

  return { config: config ?? null, sources, roster };
}

async function loadReadiness(
  user: { role: string; organizationId?: number | null },
  requestedOrganizationId?: number,
) {
  const { db, organizationId } = await requireCorporateB2B(user, requestedOrganizationId);
  const state = await loadGateState(db, organizationId);
  const readiness = calculateCorporateB2BPilotReadiness({
    config: state.config,
    sources: state.sources,
    roster: state.roster,
    queueDurability: await queueDurability(),
  });

  return {
    organizationId,
    config: state.config,
    sources: state.sources,
    roster: state.roster,
    ...readiness,
    /**
     * The recorded state claims more than the gates currently support.
     *
     * Serialising the write closes the race at the moment of the advance; it
     * cannot keep the claim true afterwards. A distributor flagged the next
     * morning reopens B3 under a pilot already recorded as `parallel_run`,
     * and that is a real operating condition, not a bug to be prevented — the
     * closure register's answer is to stop or stay in parallel, which is a
     * human decision. So it is REPORTED rather than silently tolerated.
     */
    stateContradictsGates:
      !readiness.canStartReadOnlyPilot &&
      (state.config?.pilotState === "parallel_run" || state.config?.pilotState === "limited_control"),
  };
}

const configInput = z.object({
  organizationId: z.number().int().positive().optional(),
  country: z.enum(["uganda", "nigeria"]),
  pilotState: z.enum(PILOT_STATES),
  pilotScope: z.string().trim().max(500).optional(),
  noWriteAcknowledged: z.boolean(),
  aiAssistanceMode: z.enum(["disabled", "private_approved"]),
  aiBoundaryReference: z.string().trim().max(255).optional(),
  dataContractStatus: z.enum(["draft", "approved"]),
  rosterStatus: z.enum(["draft", "approved"]),
  allocationPolicyStatus: z.enum(["draft", "approved"]),
  dailyCloseOwner: z.string().trim().max(255).optional(),
  operationalRecoveryStatus: z.enum(["not_tested", "passed"]),
  retentionDays: z.number().int().min(1).max(3650),
  contractStatus: z.enum(["draft", "approved"]),
  dataProcessingStatus: z.enum(["draft", "approved"]),
  contractReference: z.string().trim().max(255).optional(),
  dataProcessingReference: z.string().trim().max(255).optional(),
});

const scopeInput = z.object({ organizationId: z.number().int().positive().optional() });

export const corporateB2BPilotRouter = router({
  readiness: protectedProcedure.input(scopeInput.optional())
    .query(({ ctx, input }) => loadReadiness(ctx.user, input?.organizationId)),

  // Pilot Controls intentionally permits CFOs as well as admins. `adminProcedure`
  // rejects CFOs before requirePilotManager can apply that approved policy, so use
  // the authenticated procedure and enforce the explicit role boundary here.
  updateConfig: protectedProcedure.input(configInput).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role);
    const { organizationId: _requested, ...submitted } = input;
    const { db, organizationId } = await requireCorporateB2B(ctx.user, input.organizationId);
    if (submitted.aiAssistanceMode === "private_approved" && !submitted.aiBoundaryReference?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "A private AI route requires an approved boundary reference." });
    }

    // This input is a whole-register replace, not a patch — every status enum
    // is required — so an omitted free-text field means "no evidence recorded",
    // and is normalised to null rather than left `undefined`. Drizzle drops
    // undefined keys from an UPDATE, so without this the stored evidence would
    // silently survive a save that the readiness projection below had already
    // treated as clearing it: the register and the gate would disagree.
    const fields = {
      ...submitted,
      pilotScope: submitted.pilotScope ?? null,
      aiBoundaryReference: submitted.aiBoundaryReference ?? null,
      dailyCloseOwner: submitted.dailyCloseOwner ?? null,
      contractReference: submitted.contractReference ?? null,
      dataProcessingReference: submitted.dataProcessingReference ?? null,
    };

    const values = { ...fields, organizationId, updatedByUserId: ctx.user.id };
    const { ip, ua } = getClientInfo(ctx);
    const durability = await queueDurability();
    // The register change, its gate check and its audit record all commit or
    // roll back together — the same reason the Control Fit Brief save does.
    //
    // The gate check reads INSIDE this transaction, with a locking read on the
    // source contracts and the roster. Reading it outside raced the write: a
    // source or roster mutation committing between the check and the upsert let
    // an advanced pilot state be persisted against gates that had since
    // reopened, which is precisely the invariant this check exists to hold.
    await db.transaction(async (tx) => {
      const before = await loadGateState(tx, organizationId, true);

      // The pilot STATE is the claim a customer, an auditor or a regulator
      // reads first, and until now it could be set to "parallel run" while
      // eight of the gates printed directly above it were red. The closure
      // register is explicit that a live parallel run is not permitted until
      // every gate is closed with evidence, and that failure "never means
      // silently widen scope".
      //
      // Evaluated against the state the save WOULD produce, not the state on
      // disk: a single save can approve the last outstanding gate and advance
      // the pilot, and refusing that would make an operator save twice for no
      // reason. Sources and roster are not touched by this mutation.
      const projected = calculateCorporateB2BPilotReadiness({
        config: { ...(before.config ?? {}), ...fields } as Parameters<typeof calculateCorporateB2BPilotReadiness>[0]["config"],
        sources: before.sources,
        roster: before.roster,
        queueDurability: durability,
      });
      const refusal = pilotStateTransitionRefusal(
        fields.pilotState as PilotState,
        (before.config?.pilotState ?? null) as PilotState | null,
        projected,
      );
      if (refusal) throw new TRPCError({ code: "PRECONDITION_FAILED", message: refusal });

      // One statement rather than select-then-insert-or-update. `organizationId`
      // is UNIQUE on this table, so two concurrent saves through the read-then-
      // write form raced into a duplicate-key 500 for whichever lost. The tenant
      // key is excluded from the UPDATE half: it identifies the row, and an
      // update must never be able to move a register between tenants.
      await tx.insert(corporateB2BPilotConfigs).values(values)
        .onDuplicateKeyUpdate({ set: { ...fields, updatedByUserId: ctx.user.id } });
      const [saved] = await tx.select({ id: corporateB2BPilotConfigs.id }).from(corporateB2BPilotConfigs)
        .where(eq(corporateB2BPilotConfigs.organizationId, organizationId)).limit(1);
      // Two corrections in one call. The entity id used to be read BEFORE the
      // write, so creating a pilot register — the event that establishes it
      // exists at all — was logged against no entity. And `logAudit` carries no
      // organizationId, which puts the event on the GLOBAL hash chain: the
      // tenant the register belongs to could not see its own configuration
      // history in their audit listing, export, or chain verification. B8 says
      // every configuration change is audit logged; it has to be logged where
      // the customer and their examiner will look.
      await logAuditStrict({
        userId: ctx.user.id,
        organizationId,
        action: "corporate_b2b_pilot_config_updated",
        entityType: "corporate_b2b_pilot",
        entityId: saved?.id,
        details: {
          targetOrganizationId: organizationId,
          country: fields.country,
          pilotState: fields.pilotState,
          noWriteAcknowledged: fields.noWriteAcknowledged,
          aiAssistanceMode: fields.aiAssistanceMode,
          dataContractStatus: fields.dataContractStatus,
        },
        ipAddress: ip,
        userAgent: ua,
        executor: tx,
      });
    });
    return loadReadiness(ctx.user, input.organizationId);
  }),

  createSource: protectedProcedure.input(z.object({
    organizationId: z.number().int().positive().optional(),
    sourceType: z.enum(SOURCE_TYPES), displayName: z.string().trim().min(1).max(255),
    deliveryMethod: z.enum(DELIVERY_METHODS), expectedCutoff: z.string().trim().max(64).optional(),
    sourceOwner: z.string().trim().max(255).optional(), notes: z.string().max(2000).optional(),
  })).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role);
    const { organizationId: _requested, ...fields } = input;
    const { db, organizationId } = await requireCorporateB2B(ctx.user, input.organizationId);
    const { ip, ua } = getClientInfo(ctx);
    let sourceId = 0;
    await db.transaction(async (tx) => {
      const [result] = await tx.insert(corporateB2BPilotSources).values({ ...fields, organizationId, createdByUserId: ctx.user.id });
      sourceId = Number(result.insertId);
      await logAuditStrict({
        userId: ctx.user.id, organizationId,
        action: "corporate_b2b_pilot_source_created", entityType: "corporate_b2b_pilot_source", entityId: sourceId,
        details: { targetOrganizationId: organizationId, sourceType: fields.sourceType, deliveryMethod: fields.deliveryMethod },
        ipAddress: ip, userAgent: ua, executor: tx,
      });
    });
    return { id: sourceId };
  }),

  updateSourceStatus: protectedProcedure.input(z.object({
    organizationId: z.number().int().positive().optional(),
    id: z.number().int().positive(), status: z.enum(SOURCE_STATUSES), customerOwnedCredentials: z.boolean(), controlTotalRequired: z.boolean(),
  })).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role);
    const { db, organizationId } = await requireCorporateB2B(ctx.user, input.organizationId);
    const { ip, ua } = getClientInfo(ctx);
    await db.transaction(async (tx) => {
      const result = await tx.update(corporateB2BPilotSources).set({
        status: input.status, customerOwnedCredentials: input.customerOwnedCredentials, controlTotalRequired: input.controlTotalRequired,
      }).where(and(eq(corporateB2BPilotSources.id, input.id), eq(corporateB2BPilotSources.organizationId, organizationId)));
      if (!result[0]?.affectedRows) throw new TRPCError({ code: "NOT_FOUND", message: "Pilot source not found." });
      await logAuditStrict({
        userId: ctx.user.id, organizationId,
        action: "corporate_b2b_pilot_source_updated", entityType: "corporate_b2b_pilot_source", entityId: input.id,
        details: { targetOrganizationId: organizationId, status: input.status, customerOwnedCredentials: input.customerOwnedCredentials, controlTotalRequired: input.controlTotalRequired },
        ipAddress: ip, userAgent: ua, executor: tx,
      });
    });
    return { success: true };
  }),

  deleteSource: protectedProcedure.input(z.object({
    organizationId: z.number().int().positive().optional(),
    id: z.number().int().positive(),
  })).mutation(async ({ ctx, input }) => {
    requirePilotManager(ctx.user.role);
    const { db, organizationId } = await requireCorporateB2B(ctx.user, input.organizationId);
    const { ip, ua } = getClientInfo(ctx);
    await db.transaction(async (tx) => {
      const result = await tx.delete(corporateB2BPilotSources).where(and(eq(corporateB2BPilotSources.id, input.id), eq(corporateB2BPilotSources.organizationId, organizationId)));
      if (!result[0]?.affectedRows) throw new TRPCError({ code: "NOT_FOUND", message: "Pilot source not found." });
      await logAuditStrict({
        userId: ctx.user.id, organizationId,
        action: "corporate_b2b_pilot_source_deleted", entityType: "corporate_b2b_pilot_source", entityId: input.id,
        details: { targetOrganizationId: organizationId },
        ipAddress: ip, userAgent: ua, executor: tx,
      });
    });
    return { success: true };
  }),
});
