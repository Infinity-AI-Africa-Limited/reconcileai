/** Evidence-led workflow framing shared by Financial Services, Retail Commerce and Corporate B2B. */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { controlFitBriefs, organizations } from "../../drizzle/schema";
import { getDb } from "../db";
import { resolveOrgScope } from "../_core/tenancy";
import { protectedProcedure, router } from "../_core/trpc";
import { getClientInfo, logAuditStrict } from "./shared";

const evidence = z.array(z.string().trim().min(2).max(120)).min(1).max(8);
const briefInput = z.object({
  organizationId: z.number().int().positive().optional(),
  workflowName: z.string().trim().min(3).max(255),
  operationalProblem: z.string().trim().min(12).max(2000),
  accountableOwner: z.string().trim().min(2).max(255),
  decisionDeadline: z.string().trim().min(2).max(128),
  approvedEvidence: evidence,
  baseline: z.string().trim().min(3).max(2000),
  successMeasure: z.string().trim().min(3).max(2000),
  status: z.enum(["draft", "baseline_confirmed", "parallel_run", "accepted", "stopped"]),
});

const scopeInput = z.object({ organizationId: z.number().int().positive().optional() });
const defaults: Record<string, Omit<z.infer<typeof briefInput>, "organizationId" | "status">> = {
  financial_services: { workflowName: "Settlement break to reviewed resolution", operationalProblem: "A settlement break takes too long to investigate and is difficult to evidence at close.", accountableOwner: "Settlement operations owner", decisionDeadline: "Before the agreed operational cut-off", approvedEvidence: ["Core-banking extract", "Payment or settlement file", "Ledger evidence"], baseline: "To be confirmed from an approved historical sample.", successMeasure: "Customer-agreed reduction in unresolved break ageing with complete reviewer evidence." },
  retail_commerce: { workflowName: "Order to payout settlement control", operationalProblem: "Merchant operations cannot quickly explain whether an order was paid, included in a payout or requires follow-up.", accountableOwner: "Merchant finance or operations owner", decisionDeadline: "Before the merchant payout review cut-off", approvedEvidence: ["SHOPLINE order data", "Payment evidence", "Payout or settlement export"], baseline: "To be confirmed from an approved store settlement period.", successMeasure: "Customer-agreed reduction in unexplained payout exceptions with evidence for every open item." },
  corporate_b2b: { workflowName: "Distributor receipt to invoice allocation", operationalProblem: "Finance cannot reliably connect distributor receipts, deductions and references to the commercial position before daily close.", accountableOwner: "Daily finance-close owner", decisionDeadline: "Before the agreed daily close", approvedEvidence: ["Approved invoice or AR export", "Authorised receipt evidence", "Signed distributor roster"], baseline: "To be confirmed from an approved customer sample.", successMeasure: "Customer-agreed reduction in unallocated receipts and exception ageing, with reviewer-ready evidence." },
};

async function load(user: { role: string; organizationId?: number | null }, requested?: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const organizationId = resolveOrgScope(user, requested);
  const [org] = await db.select({ segment: organizations.segment }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!org || org.segment === "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Control Fit Briefs are available only inside a client portal." });
  const [brief] = await db.select().from(controlFitBriefs).where(eq(controlFitBriefs.organizationId, organizationId)).limit(1);
  return { organizationId, segment: org.segment, brief: brief ?? null, template: defaults[org.segment] };
}

function canEdit(role: string) { return ["super_admin", "admin", "cfo", "operations"].includes(role); }

export const controlFitRouter = router({
  get: protectedProcedure.input(scopeInput).query(({ ctx, input }) => load(ctx.user, input.organizationId)),
  save: protectedProcedure.input(briefInput).mutation(async ({ ctx, input }) => {
    if (!canEdit(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Only an administrator, CFO, operations owner, or Infinity AI staff member can save a Control Fit Brief." });
    const { organizationId } = await load(ctx.user, input.organizationId);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const values = { ...input, organizationId, updatedByUserId: ctx.user.id };
    const { ip, ua } = getClientInfo(ctx);
    // The brief and its audit record commit or roll back together.
    //
    // Propagating the audit failure is not sufficient on its own: without the
    // transaction the brief is already committed when the audit insert fails, so
    // the caller is told the save failed over a change that DID happen and left
    // no trace of itself. Either outcome alone is defensible; the combination is
    // the one a bank examiner cannot be shown.
    await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: controlFitBriefs.id }).from(controlFitBriefs).where(eq(controlFitBriefs.organizationId, organizationId)).limit(1);
      // The FIRST save has no `existing`, so the insert result is the only place
      // the id exists. Reaching for `existing?.id` there recorded a null entity
      // id, and an audit row that cannot be found by the entity it describes is
      // missing from exactly the query an examiner would run.
      let briefId: number;
      if (existing) {
        await tx.update(controlFitBriefs).set(values).where(eq(controlFitBriefs.id, existing.id));
        briefId = existing.id;
      } else {
        const [inserted] = await tx.insert(controlFitBriefs).values(values);
        briefId = Number(inserted.insertId);
      }
      // Scoped to the tenant the brief belongs to, NOT to the caller's own org —
      // a super admin saving from inside a portal is acting on that tenant, and
      // the record has to land in that tenant's chain to be worth anything. The
      // id stays in `details` too, but details is JSON and cannot be filtered,
      // exported, or chain-verified.
      await logAuditStrict({
        userId: ctx.user.id,
        organizationId,
        action: "control_fit_brief_saved",
        entityType: "control_fit_brief",
        entityId: briefId,
        details: {
          targetOrganizationId: organizationId,
          status: input.status,
          workflowName: input.workflowName,
          evidenceCount: input.approvedEvidence.length,
        },
        ipAddress: ip,
        userAgent: ua,
        executor: tx,
      });
    });
    return load(ctx.user, organizationId);
  }),
});
