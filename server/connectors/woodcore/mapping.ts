/**
 * Field mapping layer: WoodCore (Fineract-shaped) payloads → the ReconcileAI
 * canonical transaction model.
 *
 * Default mappings are defined in code, grounded in the live tenant schema
 * (see server/woodcoreDb.ts enum maps and drizzle/woodcore_schema.ts). Each
 * organization can override individual rules via wc_connector_field_mappings;
 * overrides merge by `target` field on top of the defaults, so a compliance
 * officer only ever edits the fields that differ.
 *
 * A mapping rule is deliberately declarative (source path + named transform),
 * never code, so the config UI can render and edit it safely.
 */
import { LOAN_TXN_TYPE, SAVINGS_TXN_TYPE } from "../../woodcoreDb";
import type { CanonicalTransaction, WcEntity } from "./types";

// ─── Rule shape ──────────────────────────────────────────────────────────────
export interface MappingRule {
  /** Canonical field this rule populates. */
  target:
    | "externalId"
    | "transactionRef"
    | "amount"
    | "currency"
    | "debitCredit"
    | "transactionDate"
    | "valueDate"
    | "description"
    | "counterparty"
    | "isReversal"
    | "typeEnum" // numeric type id (WoodCore/Fineract)
    | "typeLabel"; // string type label (T24/Mambu/Flexcube — used as sourceType)
  /** Dot-path into the source payload, e.g. "transaction.amount". */
  source: string;
  /** Optional named transform applied after extraction. */
  transform?: TransformName;
  /** Fallback when the source path is absent/null. */
  default?: string | number | boolean;
}

export type TransformName =
  | "string"
  | "number"
  | "absAmount"
  | "boolean"
  | "presentAsBool" // any non-empty value → true (e.g. Mambu adjustmentTransactionKey)
  | "wcDate" // Fineract date: [y,m,d] array | "yyyy-MM-dd" | epoch ms | ISO string
  | "savingsTxnType" // enum id → label (WoodCore)
  | "loanTxnType"
  | "glEntryType" // 1 → DEBIT, 2 → CREDIT (WoodCore)
  | "directionWord" // CREDIT/CR/C → credit, DEBIT/DR/D → debit (T24/Flexcube/GL)
  | "typeWordDirection"; // transaction-type word → direction (Mambu DEPOSIT/WITHDRAWAL/…)

export interface MappingResult {
  ok: boolean;
  value?: CanonicalTransaction;
  errors: string[];
}

// ─── Direction tables (CBS ledger perspective; overridable per org) ─────────
// Savings account: money in → credit, money out → debit.
export const SAVINGS_TXN_DIRECTION: Record<number, "debit" | "credit"> = {
  1: "credit", // Deposit
  2: "debit", // Withdrawal
  3: "credit", // Interest Posting
  4: "debit", // Withdrawal Fee
  5: "debit", // Annual Fee
  6: "credit", // Waive Charge
  7: "debit", // Pay Charge
  8: "credit", // Dividend Payout
  12: "debit", // Initiate Transfer (out)
  13: "credit", // Approve Transfer (in)
  14: "credit", // Withdraw Transfer (returned)
  15: "credit", // Reject Transfer (returned)
  16: "debit", // Written-Off
  17: "debit", // Overdraft Interest
  19: "debit", // Withhold Tax
};

// Loan account (asset ledger): disbursement grows the asset → debit;
// repayments/waivers reduce it → credit.
export const LOAN_TXN_DIRECTION: Record<number, "debit" | "credit"> = {
  1: "debit", // Disbursement
  2: "credit", // Repayment
  3: "debit", // Contra
  4: "credit", // Waive Interest
  5: "credit", // Repayment at Disbursement
  6: "credit", // Write-Off
  8: "credit", // Recovery Repayment
  9: "credit", // Waive Charges
  10: "debit", // Accrual
  12: "debit", // Initiate Transfer
  13: "credit", // Approve Transfer
  14: "credit", // Withdraw Transfer
  15: "credit", // Reject Transfer
  16: "credit", // Refund
  17: "debit", // Charge Payment
  18: "credit", // Refund for Active Loan
  19: "credit", // Income Posting
  20: "debit", // Accrual
  21: "credit", // Charge-Off
  22: "debit", // Accrual Activity
};

// ─── Default rules per entity ────────────────────────────────────────────────
export const DEFAULT_MAPPINGS: Record<WcEntity, MappingRule[]> = {
  savings_transaction: [
    { target: "externalId", source: "id", transform: "string" },
    { target: "typeEnum", source: "transactionType.id", transform: "number" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "currency.code", default: "NGN" },
    { target: "transactionDate", source: "date", transform: "wcDate" },
    { target: "valueDate", source: "submittedOnDate", transform: "wcDate" },
    { target: "transactionRef", source: "receiptNumber", transform: "string" },
    { target: "counterparty", source: "accountNo", transform: "string" },
    { target: "description", source: "transactionType.value", transform: "string" },
    { target: "isReversal", source: "reversed", transform: "boolean", default: false },
  ],
  loan_transaction: [
    { target: "externalId", source: "id", transform: "string" },
    { target: "typeEnum", source: "type.id", transform: "number" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "currency.code", default: "NGN" },
    { target: "transactionDate", source: "date", transform: "wcDate" },
    { target: "valueDate", source: "submittedOnDate", transform: "wcDate" },
    { target: "transactionRef", source: "externalId", transform: "string" },
    { target: "counterparty", source: "loanAccountNo", transform: "string" },
    { target: "description", source: "type.value", transform: "string" },
    { target: "isReversal", source: "manuallyReversed", transform: "boolean", default: false },
  ],
  journal_entry: [
    { target: "externalId", source: "id", transform: "string" },
    { target: "typeEnum", source: "entryType.id", transform: "number" },
    { target: "amount", source: "amount", transform: "absAmount" },
    { target: "currency", source: "currencyCode", default: "NGN" },
    { target: "transactionDate", source: "transactionDate", transform: "wcDate" },
    { target: "transactionRef", source: "transactionId", transform: "string" },
    { target: "counterparty", source: "glAccountCode", transform: "string" },
    { target: "description", source: "comments", transform: "string" },
    { target: "isReversal", source: "reversed", transform: "boolean", default: false },
  ],
};

// ─── Extraction + transforms ─────────────────────────────────────────────────
export function getByPath(obj: unknown, path: string): unknown {
  // Literal flat key wins over dot-traversal: CSV exports (e.g. T24's
  // "TRANS.ID", "DR.CR.MARKER") produce flat keys that contain dots.
  if (obj != null && typeof obj === "object" && path in (obj as Record<string, unknown>)) {
    return (obj as Record<string, unknown>)[path];
  }
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Fineract dates arrive as [y,m,d] arrays, "yyyy-MM-dd" strings, or epoch ms. */
export function parseWcDate(v: unknown): Date | null {
  if (v == null) return null;
  if (Array.isArray(v) && v.length >= 3) {
    const [y, m, d] = v as number[];
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    return new Date(Date.UTC(y, m - 1, d));
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const dt = new Date(v);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  if (typeof v === "string" && v.trim()) {
    // Date-only strings are pinned to UTC midnight (project rule: UTC everywhere).
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
    const dt = new Date(dateOnly ? `${v.trim()}T00:00:00Z` : v);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

/** Word → direction, for CBSs that state debit/credit explicitly. */
const DIRECTION_WORDS: Record<string, "debit" | "credit"> = {
  CREDIT: "credit", CR: "credit", C: "credit",
  DEBIT: "debit", DR: "debit", D: "debit",
};

/** Transaction-type word → direction (account-holder ledger perspective). */
const TYPE_WORD_DIRECTION: Record<string, "debit" | "credit"> = {
  // money in
  DEPOSIT: "credit", INTEREST_APPLIED: "credit", DIVIDEND: "credit",
  REPAYMENT: "credit", LOAN_REPAYMENT: "credit", RECOVERY_REPAYMENT: "credit",
  TRANSFER_IN: "credit", PAYMENT_RECEIVED: "credit", REFUND: "credit",
  // money out
  WITHDRAWAL: "debit", FEE: "debit", FEE_APPLIED: "debit", FEE_CHARGED: "debit",
  DISBURSEMENT: "debit", LOAN_DISBURSEMENT: "debit", TRANSFER_OUT: "debit",
  WITHHOLDING_TAX: "debit", PENALTY: "debit", PENALTY_APPLIED: "debit", CHARGE: "debit",
};

function applyTransform(value: unknown, transform: TransformName | undefined): unknown {
  if (transform === undefined) return value;
  switch (transform) {
    case "string":
      return value == null ? null : String(value);
    case "number": {
      if (value == null || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case "absAmount": {
      if (value == null || value === "") return null;
      const n = Number(String(value).replace(/[^0-9.eE+-]/g, ""));
      return Number.isFinite(n) ? Math.abs(n).toFixed(2) : null;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value == null) return null;
      return ["true", "1", "yes"].includes(String(value).toLowerCase());
    case "presentAsBool":
      return value !== null && value !== undefined && value !== "" && value !== false && value !== 0;
    case "wcDate":
      return parseWcDate(value);
    case "directionWord":
      return DIRECTION_WORDS[String(value ?? "").trim().toUpperCase()] ?? null;
    case "typeWordDirection":
      return TYPE_WORD_DIRECTION[String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_")] ?? null;
    case "savingsTxnType":
      return SAVINGS_TXN_TYPE[Number(value)] ?? `Unknown(${String(value)})`;
    case "loanTxnType":
      return LOAN_TXN_TYPE[Number(value)] ?? `Unknown(${String(value)})`;
    case "glEntryType":
      return Number(value) === 1 ? "DEBIT" : Number(value) === 2 ? "CREDIT" : null;
    default: {
      const exhaustive: never = transform;
      return exhaustive;
    }
  }
}

/** Merge per-org override rules on top of the defaults, keyed by target. */
export function mergeRules(defaults: MappingRule[], overrides: MappingRule[] | null | undefined): MappingRule[] {
  if (!overrides || overrides.length === 0) return defaults;
  const byTarget = new Map<string, MappingRule>(defaults.map((r) => [r.target, r]));
  for (const o of overrides) byTarget.set(o.target, o);
  return Array.from(byTarget.values());
}

function typeLabel(entity: WcEntity, typeEnum: number | null): string {
  if (typeEnum == null) return "Unknown";
  if (entity === "savings_transaction") return SAVINGS_TXN_TYPE[typeEnum] ?? `Unknown(${typeEnum})`;
  if (entity === "loan_transaction") return LOAN_TXN_TYPE[typeEnum] ?? `Unknown(${typeEnum})`;
  return typeEnum === 1 ? "DEBIT" : typeEnum === 2 ? "CREDIT" : `Unknown(${typeEnum})`;
}

function deriveDirection(entity: WcEntity, typeEnum: number | null): "debit" | "credit" | null {
  if (typeEnum == null) return null;
  if (entity === "savings_transaction") return SAVINGS_TXN_DIRECTION[typeEnum] ?? null;
  if (entity === "loan_transaction") return LOAN_TXN_DIRECTION[typeEnum] ?? null;
  return typeEnum === 1 ? "debit" : typeEnum === 2 ? "credit" : null;
}

/** Namespaced dedupe key, stable across webhook + batch delivery of the same txn. */
export function externalRefFor(entity: WcEntity, externalId: string): string {
  const ns =
    entity === "savings_transaction" ? "savings" : entity === "loan_transaction" ? "loan" : "gl";
  return `wc:${ns}:${externalId}`;
}

// ─── The mapper ──────────────────────────────────────────────────────────────
/**
 * `defaultRules` selects the CBS profile's defaults (from the registry);
 * omitted → WoodCore defaults, so all pre-registry call sites keep working.
 */
export function applyMapping(
  entity: WcEntity,
  payload: unknown,
  overrideRules?: MappingRule[] | null,
  defaultRules?: MappingRule[],
): MappingResult {
  const rules = mergeRules(defaultRules ?? DEFAULT_MAPPINGS[entity], overrideRules);
  const errors: string[] = [];
  const acc: Record<string, unknown> = {};

  for (const rule of rules) {
    let raw = getByPath(payload, rule.source);
    if ((raw === undefined || raw === null || raw === "") && rule.default !== undefined) {
      raw = rule.default;
    }
    acc[rule.target] = applyTransform(raw, rule.transform);
  }

  const externalId = acc.externalId == null ? null : String(acc.externalId);
  if (!externalId) errors.push("externalId is missing (rule target 'externalId')");

  const amount = typeof acc.amount === "string" ? acc.amount : null;
  if (!amount || Number(amount) <= 0) errors.push(`amount is missing or non-positive (got ${String(acc.amount)})`);

  const transactionDate = acc.transactionDate instanceof Date ? acc.transactionDate : null;
  if (!transactionDate) errors.push("transactionDate is missing or unparseable");

  const typeEnum = typeof acc.typeEnum === "number" ? acc.typeEnum : null;
  const typeLabelValue = acc.typeLabel == null ? null : String(acc.typeLabel);

  // debitCredit: explicit rule wins (directionWord/typeWordDirection transforms
  // yield 'debit'/'credit' directly); otherwise derived from the numeric type
  // enum via the WoodCore direction tables.
  let debitCredit: "debit" | "credit" | null = null;
  if (acc.debitCredit === "debit" || acc.debitCredit === "credit") {
    debitCredit = acc.debitCredit;
  } else {
    debitCredit = deriveDirection(entity, typeEnum);
  }
  if (!debitCredit) {
    errors.push(
      `debitCredit could not be derived (entity=${entity}, typeEnum=${String(typeEnum)}); add an override rule for 'debitCredit'`,
    );
  }

  if (errors.length > 0 || !externalId || !amount || !transactionDate || !debitCredit) {
    return { ok: false, errors };
  }

  const value: CanonicalTransaction = {
    externalRef: externalRefFor(entity, externalId),
    transactionRef: acc.transactionRef == null ? null : String(acc.transactionRef),
    amount,
    currency: typeof acc.currency === "string" && acc.currency ? acc.currency : "NGN",
    debitCredit,
    transactionDate,
    valueDate: acc.valueDate instanceof Date ? acc.valueDate : null,
    description: acc.description == null ? null : String(acc.description),
    counterparty: acc.counterparty == null ? null : String(acc.counterparty),
    isReversal: acc.isReversal === true,
    sourceEntity: entity,
    sourceType: typeLabelValue ?? typeLabel(entity, typeEnum),
    raw: payload,
  };

  return { ok: true, value, errors: [] };
}

/** Validate a set of override rules before persisting (config UI + router). */
export function validateRules(rules: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(rules)) return { ok: false, errors: ["rules must be an array"] };
  const validTargets = new Set([
    "externalId", "transactionRef", "amount", "currency", "debitCredit",
    "transactionDate", "valueDate", "description", "counterparty", "isReversal",
    "typeEnum", "typeLabel",
  ]);
  const validTransforms = new Set([
    "string", "number", "absAmount", "boolean", "presentAsBool", "wcDate",
    "savingsTxnType", "loanTxnType", "glEntryType", "directionWord", "typeWordDirection",
  ]);
  rules.forEach((r, i) => {
    if (typeof r !== "object" || r === null) {
      errors.push(`rule ${i}: not an object`);
      return;
    }
    const rule = r as Record<string, unknown>;
    if (!validTargets.has(String(rule.target))) errors.push(`rule ${i}: invalid target "${String(rule.target)}"`);
    if (typeof rule.source !== "string" || !rule.source.trim()) errors.push(`rule ${i}: source path is required`);
    if (rule.transform !== undefined && !validTransforms.has(String(rule.transform))) {
      errors.push(`rule ${i}: unknown transform "${String(rule.transform)}"`);
    }
  });
  return { ok: errors.length === 0, errors };
}
