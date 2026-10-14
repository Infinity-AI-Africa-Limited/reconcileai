import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { controlPolicies, organizations } from "../drizzle/schema";
import { getDb } from "./db";
import { isDuplicateKeyError } from "./dbErrors";
import { afterCursor, page } from "./keysetPage";
import type {
  ActivateControlPolicyInput,
  ApproveControlPolicyInput,
  ControlPolicyActor,
  ControlPolicyScope,
  CreateControlPolicyInput,
  RetireControlPolicyInput,
} from "./controlPolicySchema";
import {
  CONTROL_POLICY_PAGE_DEFAULT,
  toPolicyDefinition,
} from "./controlPolicySchema";
import { logAuditStrict } from "./routers/shared";

type ClientInfo = { ip: string; ua: string };
type Transaction = Parameters<
  Parameters<NonNullable<Awaited<ReturnType<typeof getDb>>>["transaction"]>[0]
>[0];

/**
 * What a list of policies returns, named column by column.
 *
 * The definition is left out on purpose: at up to 50 KB each, a full page of
 * definitions is megabytes for a listing that needs only names, lifecycle and
 * digest. `getControlPolicy` returns one policy in full. `activeSlot` is a
 * storage device for the one-active-version constraint, not policy evidence.
 */
const POLICY_SUMMARY_FIELDS = {
  id: controlPolicies.id,
  organizationId: controlPolicies.organizationId,
  policyType: controlPolicies.policyType,
  policyKey: controlPolicies.policyKey,
  version: controlPolicies.version,
  displayName: controlPolicies.displayName,
  description: controlPolicies.description,
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

const POLICY_FIELDS = {
  ...POLICY_SUMMARY_FIELDS,
  definition: controlPolicies.definition,
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

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A definition as one canonical JSON string: object keys in UTF-16 code-unit
 * order, so the same configuration has one digest whatever order its keys
 * arrived in. Code-unit order, not `localeCompare`: a locale-aware comparison
 * depends on the host's ICU data, and a digest that can change with a Node
 * upgrade cannot identify what was approved.
 *
 * Only JSON is accepted (callers pass the output of `toPolicyDefinition`), and
 * anything else throws rather than hashing as something it is not.
 */
export function canonicalPolicyDefinition(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // Array.from turns a hole into undefined, which throws below.
    return `[${Array.from(value, item => canonicalPolicyDefinition(item)).join(",")}]`;
  }
  if (typeof value === "object" && isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort(byCodeUnit)
      .map(key => `${JSON.stringify(key)}:${canonicalPolicyDefinition(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("A policy definition can contain only JSON values.");
}

export function policyDefinitionDigest(definition: unknown): string {
  return createHash("sha256")
    .update(canonicalPolicyDefinition(definition))
    .digest("hex");
}

/**
 * One page of a tenant's policy history, newest effective date first, and the
 * cursor that continues after it. The history is immutable and grows without
 * bound, so every version must stay reachable however many share a key.
 */
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
    options.version !== undefined
      ? eq(controlPolicies.version, options.version)
      : undefined,
    options.status ? eq(controlPolicies.status, options.status) : undefined,
    options.cursor
      ? afterCursor(controlPolicies.effectiveAt, controlPolicies.id, {
          sort: options.cursor.effectiveAt,
          id: options.cursor.id,
        })
      : undefined,
  ].filter(
    (clause): clause is NonNullable<typeof clause> => clause !== undefined
  );
  const rows = await db
    .select(POLICY_SUMMARY_FIELDS)
    .from(controlPolicies)
    .where(and(...clauses))
    .orderBy(desc(controlPolicies.effectiveAt), desc(controlPolicies.id))
    .limit(limit + 1);
  const result = page(rows, limit, row => row.effectiveAt);
  return {
    organizationId,
    rows: result.rows,
    hasMore: result.hasMore,
    // An ISO string, so the cursor round-trips through plain JSON as well as superjson.
    nextCursor: result.nextCursor
      ? {
          effectiveAt: result.nextCursor.at.toISOString(),
          id: result.nextCursor.id,
        }
      : null,
  };
}

/** One policy in full, definition included. Another tenant's id is "not found". */
export async function getControlPolicy(organizationId: number, policyId: number) {
  const db = await requireDb();
  const [policy] = await db
    .select(POLICY_FIELDS)
    .from(controlPolicies)
    .where(
      and(
        eq(controlPolicies.id, policyId),
        eq(controlPolicies.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!policy) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Control policy not found" });
  }
  return policy;
}

export async function createControlPolicy(params: {
  actor: ControlPolicyActor;
  organizationId: number;
  input: CreateControlPolicyInput;
  client: ClientInfo;
}) {
  const { actor, organizationId, client, input } = params;
  // Checked here as well as at the router, so no caller can store a value
  // whose stored JSON and digest disagree.
  const checked = toPolicyDefinition(input.definition);
  if (!checked.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: checked.reason });
  }
  const definition = checked.value;
  const digest = policyDefinitionDigest(definition);
  const db = await requireDb();
  try {
    return await db.transaction(async tx => {
      await requireOrganization(tx, organizationId);
      const [inserted] = await tx.insert(controlPolicies).values({
        organizationId,
        policyType: input.policyType,
        policyKey: input.policyKey,
        version: input.version,
        displayName: input.displayName,
        description: input.description,
        definition,
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
    throw asPolicyError(
      error,
      `Version ${input.version} of this policy key already exists. A changed definition needs a new version.`
    );
  }
}

type TransitionParams<Input extends { policyId: number }> = {
  actor: ControlPolicyActor;
  organizationId: number;
  input: Input;
  client: ClientInfo;
};

export async function approveControlPolicy(
  params: TransitionParams<ApproveControlPolicyInput>
) {
  return transition(params, async (tx, policy, now) => {
    if (policy.status !== "draft") {
      lifecycleRefusal("Only a draft policy can be approved.");
    }
    const { approvalReference } = params.input;
    await tx
      .update(controlPolicies)
      .set({
        status: "approved",
        approvalReference,
        approvedByUserId: params.actor.id,
        approvedAt: now,
      })
      .where(guard(params.organizationId, policy.id, "draft"));
    await audit(tx, params.actor, params.organizationId, params.client, "control_policy_approved", policy.id, {
      policyType: policy.policyType,
      policyKey: policy.policyKey,
      version: policy.version,
      approvalReference,
    });
    return { id: policy.id, status: "approved" as const };
  });
}

export async function activateControlPolicy(
  params: TransitionParams<ActivateControlPolicyInput>
) {
  return transition(
    params,
    async (tx, policy, now) => {
      if (policy.status !== "approved") {
        lifecycleRefusal("Only an approved policy can be activated.");
      }
      if (policy.effectiveAt.getTime() > now.getTime()) {
        lifecycleRefusal("A policy cannot be activated before its effective date.");
      }
      // `activeSlot` is uniquely indexed. Unlike a read-then-write check, that
      // constraint stops two concurrent requests activating different versions
      // of one tenant policy key; the loser gets the CONFLICT below.
      await tx
        .update(controlPolicies)
        .set({ status: "active", activeSlot: policyScope(policy) })
        .where(guard(params.organizationId, policy.id, "approved"));
      await audit(tx, params.actor, params.organizationId, params.client, "control_policy_activated", policy.id, {
        policyType: policy.policyType,
        policyKey: policy.policyKey,
        version: policy.version,
        activatedAt: now.toISOString(),
      });
      return { id: policy.id, status: "active" as const };
    },
    "Another version of this policy key is already active. Retire it before activating this one."
  );
}

/**
 * Retire an active policy, or withdraw an approved one that never became
 * active, at the moment the registry changes. An approved policy whose
 * effective date has not arrived can be withdrawn too: an error found after
 * approval must not stay approved until the date it would have applied.
 */
export async function retireControlPolicy(
  params: TransitionParams<RetireControlPolicyInput>
) {
  return transition(params, async (tx, policy, now) => {
    if (policy.status !== "approved" && policy.status !== "active") {
      lifecycleRefusal("Only an approved or active policy can be retired.");
    }
    const { retirementReference } = params.input;
    await tx
      .update(controlPolicies)
      .set({
        status: "retired",
        activeSlot: null,
        retirementReference,
        retiredByUserId: params.actor.id,
        retiredAt: now,
      })
      .where(guard(params.organizationId, policy.id, policy.status));
    await audit(tx, params.actor, params.organizationId, params.client, "control_policy_retired", policy.id, {
      policyType: policy.policyType,
      policyKey: policy.policyKey,
      version: policy.version,
      previousStatus: policy.status,
      retirementReference,
      retiredAt: now.toISOString(),
    });
    return { id: policy.id, status: "retired" as const };
  });
}

/**
 * Lock the tenant's policy row, check and apply one lifecycle step, and write
 * its audit event, all in one transaction: the step and its record commit
 * together or not at all.
 */
async function transition<Input extends { policyId: number }, Result>(
  params: TransitionParams<Input>,
  apply: (tx: Transaction, policy: StoredPolicy, now: Date) => Promise<Result>,
  conflictMessage?: string
): Promise<Result> {
  const db = await requireDb();
  try {
    return await db.transaction(async tx => {
      const policy = await lockedPolicy(tx, params.organizationId, params.input.policyId);
      if (!policy) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Control policy not found" });
      }
      return apply(tx, policy, new Date());
    });
  } catch (error) {
    throw asPolicyError(error, conflictMessage);
  }
}

/** The row, in this tenant, still in the state the step was checked against. */
function guard(organizationId: number, id: number, status: StoredPolicy["status"]) {
  return and(
    eq(controlPolicies.id, id),
    eq(controlPolicies.organizationId, organizationId),
    eq(controlPolicies.status, status)
  );
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

/**
 * A policy must be filed under an organisation that exists. A super admin's
 * override reaches here unchecked (resolveOrgScope returns it as given) and the
 * table has no foreign key, so a mistyped id would otherwise create immutable
 * policy history, and an audit chain, for a tenant that does not exist.
 */
async function requireOrganization(tx: Transaction, organizationId: number) {
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Organisation not found" });
  }
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

function asPolicyError(error: unknown, conflictMessage?: string): never {
  if (isDuplicateKeyError(error)) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        conflictMessage ??
        "This policy version already exists or another version is active for this policy key.",
      cause: error,
    });
  }
  throw error;
}
