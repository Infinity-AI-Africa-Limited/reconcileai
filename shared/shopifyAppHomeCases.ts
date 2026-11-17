import { z } from "zod";

export const SHOPIFY_CASE_PAGE_SIZE = 20;
export const SHOPIFY_CASE_MAX_PAGE = 500;
export const SHOPIFY_CASE_STATUSES = ["unresolved", "all", "open", "in_review", "escalated", "resolved", "dismissed"] as const;
export const SHOPIFY_CASE_CATEGORIES = ["missing_counterparty", "amount_mismatch", "timing_difference", "duplicate_transaction", "unmatched", "reversal_unmatched", "currency_mismatch", "fx_rate_variance", "format_error"] as const;
export const SHOPIFY_CASE_SEVERITIES = ["low", "medium", "high", "critical"] as const;

/** No browser-supplied identity is accepted; page size is fixed server-side. */
export const shopifyCaseListInput = z.object({
  status: z.enum(SHOPIFY_CASE_STATUSES).default("unresolved"),
  page: z.number().int().min(1).max(SHOPIFY_CASE_MAX_PAGE).default(1),
}).strict().default({ status: "unresolved", page: 1 });
export const shopifyCaseDetailInput = z.object({
  caseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ShopifyCaseListRequest = z.input<typeof shopifyCaseListInput>;
export type ShopifyCaseStatusFilter = typeof SHOPIFY_CASE_STATUSES[number];

/**
 * caseId is the sole explicit exception to App Home's no-internal-ID policy.
 * It is a non-authority selector, never a credential: every detail read repeats
 * the verified shop/tenant/store/channel boundary. Selection stays in UI state;
 * tRPC GET transport may serialize this selector/filter, never an identity token.
 * No references, narratives, contacts, raw data, AI, or other internal IDs.
 */
export type ShopifyCase = {
  caseId: number;
  category: typeof SHOPIFY_CASE_CATEGORIES[number];
  severity: typeof SHOPIFY_CASE_SEVERITIES[number];
  status: Exclude<ShopifyCaseStatusFilter, "unresolved" | "all">;
  createdAt: string;
  /** Exact decimal primary-leg value, NOT a loss, difference or recovered amount. */
  amount: string;
  currency: string;
  evidenceDate: string;
  sourceKind: "shopify_order" | "shopify_refund" | "merchant_settlement";
};
export type ShopifyCasePage = { cases: ShopifyCase[]; total: number; page: number; pageSize: number };
