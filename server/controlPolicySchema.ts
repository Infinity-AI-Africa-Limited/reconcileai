import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { resolveOrgScope } from "./_core/tenancy";
import type { ControlEvidenceActor } from "./controlEvidenceSchema";
import { storableDateInput } from "./storableTimestamp";

const nonEmptyText = (max: number) => z.string().trim().min(1).max(max);
// Bounded to what the TIMESTAMP columns can hold (server/storableTimestamp.ts).
const dateInput = storableDateInput;
/**
 * A cursor's position, as either form a caller can hold it in: `list` hands
 * `nextCursor` back as an ISO string, while a superjson caller building a
 * cursor from a returned row holds a real `Date`. Both arrive as a Date.
 */
const cursorPosition = z.union([z.date(), dateInput]);

export const CONTROL_POLICY_TYPES = ["mapping", "reconciliation"] as const;
export const CONTROL_POLICY_STATUSES = [
  "draft",
  "approved",
  "active",
  "retired",
] as const;
export const CONTROL_POLICY_PAGE_MAX = 200;
export const CONTROL_POLICY_PAGE_DEFAULT = 50;
export const POLICY_DEFINITION_MAX_BYTES = 50_000;
export const POLICY_DEFINITION_MAX_DEPTH = 32;
const POLICY_DEFINITION_KEY_MAX = 120;

export const controlPolicyType = z.enum(CONTROL_POLICY_TYPES);
export const controlPolicyStatus = z.enum(CONTROL_POLICY_STATUSES);

/**
 * A policy key names one policy across all its versions, so it must compare
 * the way people read it. The column's collation is case- and
 * accent-insensitive: free text would let `Settlement` and `settlement` collide
 * as one key (and share one active slot) while reading as two. A lowercase slug
 * means the stored key and the key the database compares are the same string.
 */
const policyKey = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/,
    "Policy key must be 1-100 lowercase letters, digits, '.', '_' or '-', starting and ending with a letter or digit."
  );

/** JSON as stored in the definition column. */
export type PolicyJson =
  | null
  | boolean
  | number
  | string
  | PolicyJson[]
  | { [key: string]: PolicyJson };
export type PolicyDefinition = { [key: string]: PolicyJson };

/** A definition that is not plain JSON; `reason` is our own text, safe to return to the caller. */
class NotPolicyJson extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "NotPolicyJson";
  }
}

/** Half of a UTF-16 surrogate pair with no partner: not text MySQL's JSON type will store. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return String(value);
  if (typeof value !== "object" || value === null) return typeof value;
  return Object.getPrototypeOf(value)?.constructor?.name ?? "object";
}

function at(path: string): string {
  return path.length > 160 ? `…${path.slice(-160)}` : path;
}

function copyJson(value: unknown, path: string, depth: number): PolicyJson {
  if (depth > POLICY_DEFINITION_MAX_DEPTH) {
    throw new NotPolicyJson(
      `Policy definition is nested more than ${POLICY_DEFINITION_MAX_DEPTH} levels deep at ${at(path)}.`
    );
  }
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) {
      throw new NotPolicyJson(`Policy definition text at ${at(path)} is not well-formed Unicode.`);
    }
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const copy: PolicyJson[] = [];
    for (let index = 0; index < value.length; index++) {
      // A hole serialises as null but hashes as nothing: refuse it.
      if (!(index in value)) {
        throw new NotPolicyJson(`Policy definition has an empty array slot at ${at(`${path}[${index}]`)}.`);
      }
      copy.push(copyJson(value[index], `${path}[${index}]`, depth + 1));
    }
    return copy;
  }
  if (isPlainObject(value)) {
    const copy: PolicyDefinition = {};
    for (const key of Object.keys(value)) {
      if (
        key.length === 0 ||
        key.length > POLICY_DEFINITION_KEY_MAX ||
        key !== key.trim() ||
        LONE_SURROGATE.test(key) ||
        // Assigning it would set the copy's prototype, not a key: the value
        // would vanish from both the digest and the stored JSON.
        key === "__proto__"
      ) {
        throw new NotPolicyJson(
          `Policy definition key at ${at(path)} must be 1-${POLICY_DEFINITION_KEY_MAX} characters of well-formed text with no surrounding spaces, and not "__proto__".`
        );
      }
      copy[key] = copyJson(value[key], `${path}.${key}`, depth + 1);
    }
    return copy;
  }
  throw new NotPolicyJson(
    `Policy definition must contain only JSON values (objects, arrays, strings, finite numbers, booleans, null); ${at(path)} is ${describeValue(value)}.`
  );
}

/**
 * A definition as plain JSON, or the reason it is not.
 *
 * The digest identifies exactly what was approved, so the value hashed and the
 * value stored must be the same JSON. tRPC's superjson transformer restores
 * Date, Map, Set, BigInt, undefined and class instances, and each of those
 * either hashes differently from how it is stored (a Date hashed as `{}` but
 * written as its ISO string, so two different dates shared one digest) or
 * cannot be stored at all. They are refused, not coerced: what an approved
 * definition means stays the caller's decision.
 */
export function toPolicyDefinition(
  value: unknown
): { ok: true; value: PolicyDefinition } | { ok: false; reason: string } {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "Policy definition must be a JSON object." };
  }
  let copy: PolicyDefinition;
  try {
    copy = copyJson(value, "definition", 0) as PolicyDefinition;
  } catch (error) {
    if (error instanceof NotPolicyJson) return { ok: false, reason: error.reason };
    throw error;
  }
  if (Buffer.byteLength(JSON.stringify(copy), "utf8") > POLICY_DEFINITION_MAX_BYTES) {
    return {
      ok: false,
      reason: `Policy definition must be at most ${POLICY_DEFINITION_MAX_BYTES / 1000} KB when serialized.`,
    };
  }
  return { ok: true, value: copy };
}

/**
 * A policy definition is configuration, not source evidence: it must never
 * contain source-file rows, customer identities, access credentials, or raw
 * webhook payloads. It stays tenant-scoped so approved customer configuration
 * never becomes platform-wide reference data.
 */
const policyDefinition = z.unknown().transform((value, ctx) => {
  const checked = toPolicyDefinition(value);
  if (!checked.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: checked.reason });
    return z.NEVER;
  }
  return checked.value;
});

export const createControlPolicyInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyType: controlPolicyType,
    policyKey,
    version: z.number().int().positive(),
    displayName: nonEmptyText(255),
    description: nonEmptyText(2_000),
    definition: policyDefinition,
    effectiveAt: dateInput,
  })
  .strict();

export const approveControlPolicyInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyId: z.number().int().positive(),
    approvalReference: nonEmptyText(255),
  })
  .strict();

export const activateControlPolicyInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyId: z.number().int().positive(),
  })
  .strict();

/**
 * Retirement takes effect when it is recorded, like approval and activation.
 * There is no caller-supplied date: a future one would record a retirement the
 * registry had already applied, and a past one would say the policy stopped
 * applying during a period the registry still showed it active.
 */
export const retireControlPolicyInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyId: z.number().int().positive(),
    retirementReference: nonEmptyText(255),
  })
  .strict();

export const getControlPolicyInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyId: z.number().int().positive(),
  })
  .strict();

export const controlPolicyScopeInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyType: controlPolicyType.optional(),
    policyKey: policyKey.optional(),
    version: z.number().int().positive().optional(),
    status: controlPolicyStatus.optional(),
    limit: z.number().int().min(1).max(CONTROL_POLICY_PAGE_MAX).optional(),
    /** The `nextCursor` of the previous page, to continue after it. */
    cursor: z
      .object({ effectiveAt: cursorPosition, id: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();

export type ControlPolicyActor = ControlEvidenceActor;
export type ControlPolicyScope = z.infer<typeof controlPolicyScopeInput>;
export type CreateControlPolicyInput = z.infer<typeof createControlPolicyInput>;
export type ApproveControlPolicyInput = z.infer<
  typeof approveControlPolicyInput
>;
export type ActivateControlPolicyInput = z.infer<
  typeof activateControlPolicyInput
>;
export type RetireControlPolicyInput = z.infer<typeof retireControlPolicyInput>;

/**
 * Who may change the policy registry: an allow-list, so a role added later is
 * refused until someone decides otherwise. CFO and compliance are read-only
 * across the platform (`operationsProcedure` refuses them before this runs);
 * they are deliberately not listed, so the two checks cannot disagree.
 */
const CONTROL_POLICY_WRITER_ROLES = ["super_admin", "admin", "operations"];

export function assertControlPolicyWriter(actor: ControlPolicyActor): void {
  if (actor.isGuest || !CONTROL_POLICY_WRITER_ROLES.includes(actor.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only an administrator or operations owner can manage control policies.",
    });
  }
}

export function resolveControlPolicyScope(
  actor: ControlPolicyActor,
  requested?: number
): number {
  return resolveOrgScope(actor, requested);
}
