/**
 * Segment identity checks.
 *
 * Deliberately just comparisons — they answer "which vertical is this?", never
 * "what should the UI show?". The caller names the intent:
 *
 *     const showPilotReadiness = isCorporateB2B(segment);
 *
 * so the reason a surface is hidden reads at the place it is hidden, and these
 * stay reusable for any future decision about the same vertical.
 *
 * `null` means the segment has not resolved yet. Every check returns false for
 * it, so callers must gate on a POSITIVE match. A rule written as a negation
 * (`!isRetailCommerce(s)`) treats "still loading" as "not retail" and will show
 * the wrong thing for a frame — tolerable for navigation, not for anything that
 * asserts a regulatory status.
 */
export type Segment = "financial_services" | "corporate_b2b" | "retail_commerce" | "super_admin";

const SEGMENTS: readonly string[] = [
  "financial_services",
  "corporate_b2b",
  "retail_commerce",
  "super_admin",
];

/**
 * Narrow an unknown string to a Segment, or null.
 *
 * The segment arrives from tRPC typed as a plain string. Validating beats
 * casting: a cast would let a renamed or misspelled segment flow through as if
 * it were valid, and every check would then silently return false — which looks
 * exactly like a correctly-hidden surface.
 */
export function toSegment(value: string | null | undefined): Segment | null {
  return value && SEGMENTS.includes(value) ? (value as Segment) : null;
}

export function isFinancialServices(segment: Segment | null): boolean {
  return segment === "financial_services";
}

export function isCorporateB2B(segment: Segment | null): boolean {
  return segment === "corporate_b2b";
}

export function isRetailCommerce(segment: Segment | null): boolean {
  return segment === "retail_commerce";
}
