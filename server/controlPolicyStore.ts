import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { controlPolicies } from "../drizzle/schema";
import { getDb } from "./db";
import { isDuplicateKeyError } from "./dbErrors";
import type {
  ActivateControlPolicyInput,
  ApproveControlPolicyInput,
  ControlPolicyActor,
  ControlPolicyScope,
  CreateControlPolicyInput,
  RetireControlPolicyInput,
} from "./controlPolicySchema";
import { CONTROL_POLICY_PAGE_DEFAULT } from "./controlPolicySchema";
import { logAuditStrict } from "./routers/shared";

type ClientInfo = { ip: string; ua: string };
type Transaction = Parameters<
  Parameters<NonNullable<Awaited<ReturnType<typeof getDb>>>["transaction"]>[0]
>[0];

const POLICY_FIELDS = {
  id: controlPolicies.id,
  organizationId: controlPolicies.organizationId,
  policyType: controlPolicies.policyType,
  policyKey: controlPolicies.policyKey,
  version: controlPolicies.version,
  displayName: controlPolicies.displayName,
  description: controlPolicies.description,
  definition: controlPolicies.definition,
  definitionDigest: controlPolicies.definitionDigest,
  status: controlPolicies.status,
  approvalReference: controlPolicies.approvalReference,
  approvedByUserId: controlPolicies.approvedByUserId,
  approvedAt: controlPolicies.approvedAt,
  effectiveAt: controlPolicies.effectiveAt,
  retirementReference: controlPolicies.retirementReference,
  retiredByUserId: controlPolicies.retiredByUserId,
  retiredAt: controlPolicies.retiredAt,
  createdByUserId: controlPolicies.createdByUserId,
  createdAt: controlPolicies.createdAt,
} as const;

type StoredPolicy = {
  id: number;
  organizationId: number;
  policyType: "mapping" | "reconciliation";
  policyKey: string;
  version: number;
  status: "draft" | "approved" | "active" | "retired";
  effectiveAt: Date;
};

function policyScope(
  policy: Pick<StoredPolicy, "organizationId" | "policyType" | "policyKey">
): string {
  return `${policy.organizationId}:${policy.policyType}:${policy.policyKey}`;
}

/** Stable serialization means the same configuration receives the same digest regardless of key order. */
export function canonicalPolicyDefinition(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalPolicyDefinition).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalPolicyDefinition(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function policyDefinitionDigest(definition: unknown): string {
  return createHash("sha256")
    .update(canonicalPolicyDefinition(definition))
    .digest("hex");
}

export async function listControlPolicies(
  organizationId: number,
  options: ControlPolicyScope
) {
  const db = await requireDb();
  const limit = options.limit ?? CONTROL_POLICY_PAGE_DEFAULT;
  const clauses = [
    eq(controlPolicies.organizationId, organizationId),
    options.policyType
      ? eq(controlPolicies.policyType, options.policyType)
      : undefined,
    options.policyKey
      ? eq(controlPolicies.policyKey, options.policyKey)
      : undefined,
    options.status ? eq(controlPolicies.status, options.status) : undefined,
  ].filter(
    (clause): clause is NonNullable<typeof clause> => clause !== undefined
  );
  const rows = await db
    .select(POLICY_FIELDS)
    .from(controlPolicies)
    .where(and(...clauses))
    .orderBy(desc(controlPolicies.effectiveAt), desc(controlPolicies.id))
    .limit(limit + 1);
  return {
    organizationId,
    rows: rows.slice(0, limit),
    hasMore: rows.length > limit,
  };
}

export async function createControlPolicy(params: {
  actor: ControlPolicyActor;
  organizationId: number;
  input: CreateControlPolicyInput;
  client: ClientInfo;
}) {
  const db = await requireDb();
  const { actor, organizationId, client, input } = params;
  const digest = policyDefinitionDigest(input.definition);
  try {
    return await db.transaction(async tx => {
      const [inserted] = await tx.insert(controlPolicies).values({
        organizationId,
        policyType: input.policyType,
        policyKey: input.policyKey,
        version: input.version,
        displayName: input.displayName,
        description: input.description,
        definition: input.definition,
        definitionDigest: digest,
        status: "draft",
        effectiveAt: input.effectiveAt,
        createdByUserId: actor.id,
      });
      const id = insertedId(inserted);
      await audit(
        tx,
        actor,
        organizationId,
        client,
        "control_policy_drafted",
        id,
        {
          policyType: input.policyType,
          policyKey: input.policyKey,
          version: input.version,
          definitionDigest: digest,
          effectiveAt: input.effectiveAt.toISOString(),
        }
      );
      return { id, status: "draft" as const, definitionDigest: digest };
    });
  } catch (error) {
    throw asPolicyError(error);
  }
}

export async function approveControlPolicy(params: {
  actor: ControlPolicyActor;
  organizationId: number;
  input: ApproveControlPolicyInput;
  client: ClientInfo;
}) {
  return transitionControlPolicy(params, "approve");
}

export async function activateControlPolicy(params: {
  actor: ControlPolicyActor;
  organizationId: number;
  input: ActivateControlPolicyInput;
  client: ClientInfo;
}) {
  return transitionControlPolicy(params, "activate");
}

export async function retireControlPolicy(params: {
  actor: ControlPolicyActor;
  organizationId: number;
  input: RetireControlPolicyInput;
  client: ClientInfo;
}) {
  return transitionControlPolicy(params, "retire");
}

type Transition = "approve" | "activate" | "retire";
type TransitionParams = {
  actor: ControlPolicyActor;
  organizationId: number;
  input:
    | ApproveControlPolicyInput
    | ActivateControlPolicyInput
    | RetireControlPolicyInput;
  client: ClientInfo;
};

async function transitionControlPolicy(
  params: TransitionParams,
  transition: Transition
) {
  const db = await requireDb();
  try {
    return await db.transaction(async tx => {
      const policy = await lockedPolicy(
        tx,
        params.organizationId,
        params.input.policyId
      );
      if (!policy) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Control policy not found",
        });
      }
      const now = new Date();
      if (transition === "approve") {
        if (policy.status !== "draft")
          lifecycleRefusal("Only a draft policy can be approved.");
        const approvalReference = (params.input as ApproveControlPolicyInput)
          .approvalReference;
        await tx
          .update(controlPolicies)
          .set({
            status: "approved",
            approvalReference,
            approvedByUserId: params.actor.id,
            approvedAt: now,
          })
          .where(
            and(
              eq(controlPolicies.id, policy.id),
              eq(controlPolicies.organizationId, params.organizationId),
              eq(controlPolicies.status, "draft")
            )
          );
        await audit(
          tx,
          params.actor,
          params.organizationId,
          params.client,
          "control_policy_approved",
          policy.id,
          {
            policyType: policy.policyType,
            policyKey: policy.policyKey,
            version: policy.version,
            approvalReference,
          }
        );
        return { id: policy.id, status: "approved" as const };
      }
      if (transition === "activate") {
        if (policy.status !== "approved")
          lifecycleRefusal("Only an approved policy can be activated.");
        if (policy.effectiveAt.getTime() > now.getTime())
          lifecycleRefusal(
            "A policy cannot be activated before its effective date."
          );
        // `activeSlot` is uniquely indexed. Unlike a read-then-write check, that
        // database constraint prevents two concurrent requests from activating
        // different versions of the same tenant policy key.
        await tx
          .update(controlPolicies)
          .set({
            status: "active",
            activeSlot: policyScope(policy),
          })
          .where(
            and(
              eq(controlPolicies.id, policy.id),
              eq(controlPolicies.organizationId, params.organizationId),
              eq(controlPolicies.status, "approved")
            )
          );
        await audit(
          tx,
          params.actor,
          params.organizationId,
          params.client,
          "control_policy_activated",
          policy.id,
          {
            policyType: policy.policyType,
            policyKey: policy.policyKey,
            version: policy.version,
          }
        );
        return { id: policy.id, status: "active" as const };
      }
      if (policy.status !== "approved" && policy.status !== "active") {
        lifecycleRefusal("Only an approved or active policy can be retired.");
      }
      const { retiredAt, retirementReference } =
        params.input as RetireControlPolicyInput;
      if (retiredAt.getTime() < policy.effectiveAt.getTime())
        lifecycleRefusal("A policy cannot retire before its effective date.");
      await tx
        .update(controlPolicies)
        .set({
          status: "retired",
          activeSlot: null,
          retirementReference,
          retiredByUserId: params.actor.id,
          retiredAt,
        })
        .where(
          and(
            eq(controlPolicies.id, policy.id),
            eq(controlPolicies.organizationId, params.organizationId),
            eq(controlPolicies.status, policy.status)
          )
        );
      await audit(
        tx,
        params.actor,
        params.organizationId,
        params.client,
        "control_policy_retired",
        policy.id,
        {
          policyType: policy.policyType,
          policyKey: policy.policyKey,
          version: policy.version,
          retirementReference,
          retiredAt: retiredAt.toISOString(),
        }
      );
      return { id: policy.id, status: "retired" as const };
    });
  } catch (error) {
    throw asPolicyError(error);
  }
}

async function lockedPolicy(
  tx: Transaction,
  organizationId: number,
  id: number
): Promise<StoredPolicy | undefined> {
  const [policy] = await tx
    .select({
      id: controlPolicies.id,
      organizationId: controlPolicies.organizationId,
      policyType: controlPolicies.policyType,
      policyKey: controlPolicies.policyKey,
      version: controlPolicies.version,
      status: controlPolicies.status,
      effectiveAt: controlPolicies.effectiveAt,
    })
    .from(controlPolicies)
    .where(
      and(
        eq(controlPolicies.id, id),
        eq(controlPolicies.organizationId, organizationId)
      )
    )
    .limit(1)
    .for("update");
  return policy as StoredPolicy | undefined;
}

async function audit(
  tx: Transaction,
  actor: ControlPolicyActor,
  organizationId: number,
  client: ClientInfo,
  action: string,
  id: number,
  details: Record<string, unknown>
) {
  await logAuditStrict({
    userId: actor.id,
    organizationId,
    action,
    entityType: "control_policy",
    entityId: id,
    details,
    ipAddress: client.ip,
    userAgent: client.ua,
    executor: tx,
  });
}

async function requireDb() {
  const db = await getDb();
  if (!db)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database unavailable",
    });
  return db;
}

function insertedId(inserted: { insertId?: number | string }): number {
  const id = Number(inserted?.insertId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database unavailable",
    });
  }
  return id;
}

function lifecycleRefusal(message: string): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message });
}

function asPolicyError(error: unknown): never {
  if (isDuplicateKeyError(error)) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This policy version already exists or another version is active for this policy key.",
      cause: error,
    });
  }
  throw error;
}
