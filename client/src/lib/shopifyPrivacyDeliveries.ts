/**
 * Shopify customer data-request exports, as the merchant's administrator sees
 * them. The decision of what to show lives here, as a pure function; the
 * component only renders it.
 */

/** A delivery as `shopifyConnector.listPrivacyDeliveries` returns it. */
export interface PrivacyDeliveryRow {
  artifactId: string;
  kind: string;
  recordsFound: number;
  generatedAt: Date | string;
  expiresAt: Date | string;
  deliveryStatus: string;
}

export interface PrivacyDeliveryView {
  artifactId: string;
  href: string;
  summary: string;
  /** Whole days left before the export is deleted; 0 on the last day. */
  expiresInDays: number;
  delivered: boolean;
}

const DAY_MS = 86_400_000;

/** The authenticated download route. The server sends the file and records delivery. */
export function privacyDeliveryHref(artifactId: string): string {
  return `/api/shopify/privacy/artifacts/${encodeURIComponent(artifactId)}`;
}

export function describePrivacyDelivery(row: PrivacyDeliveryRow, now: Date = new Date()): PrivacyDeliveryView {
  const msLeft = new Date(row.expiresAt).getTime() - now.getTime();
  return {
    artifactId: row.artifactId,
    href: privacyDeliveryHref(row.artifactId),
    summary:
      row.kind === "zero_record_attestation"
        ? "No stored order evidence — signed zero-record statement"
        : `${row.recordsFound} order record${row.recordsFound === 1 ? "" : "s"}`,
    expiresInDays: Math.max(0, Math.floor(msLeft / DAY_MS)),
    delivered: row.deliveryStatus === "acknowledged",
  };
}

/**
 * Undelivered exports first — those are what the merchant still owes the
 * customer — soonest to expire first within each group.
 */
export function privacyDeliveriesToShow(rows: PrivacyDeliveryRow[], now: Date = new Date()): PrivacyDeliveryView[] {
  return rows
    .map((row) => ({ view: describePrivacyDelivery(row, now), expiresAt: new Date(row.expiresAt).getTime() }))
    .sort((left, right) => Number(left.view.delivered) - Number(right.view.delivered) || left.expiresAt - right.expiresAt)
    .map(({ view }) => view);
}

/** How often an open page re-checks for exports that have become ready. */
export const PRIVACY_DELIVERY_REFRESH_MS = 60_000;

/**
 * Query policy for the merchant's delivery list.
 *
 * An export is prepared in the background, and it has a limited lifetime. A
 * page left open — the Settlement Monitor is a working screen — must notice one
 * becoming ready rather than wait for a remount or a focus change, so the list
 * re-checks on an interval while the page is visible. Not in the background:
 * nobody sees a hidden tab, and focus refetches it on return.
 */
export function privacyDeliveryQueryOptions(isMerchantAdmin: boolean) {
  return {
    enabled: isMerchantAdmin,
    retry: false,
    refetchInterval: isMerchantAdmin ? PRIVACY_DELIVERY_REFRESH_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  } as const;
}
