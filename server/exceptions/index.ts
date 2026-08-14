/**
 * Nigerian Payment Channel Exceptions — Master Index
 *
 * This module aggregates all channel-specific exception definitions into
 * a single registry. Each channel file defines exceptions following the
 * NigerianChannelException interface with full regulatory context,
 * resolution procedures, and AI diagnosis hints.
 *
 * Architecture mirrors server/connectors/lapo/exceptions.ts but extends
 * coverage to ALL Nigerian payment channels that a bank or MFB deals with.
 */

// Channel-specific exception arrays
export { NIP_EXCEPTIONS, NIP_EXCEPTION_KEYS } from "./nip";
export { NEFT_EXCEPTIONS, NEFT_EXCEPTION_KEYS } from "./neft";
export { RTGS_EXCEPTIONS, RTGS_EXCEPTION_KEYS } from "./rtgs";
export { POS_EXCEPTIONS, POS_EXCEPTION_KEYS } from "./pos";
export { ATM_EXCEPTIONS, ATM_EXCEPTION_KEYS } from "./atm";
export { QR_EXCEPTIONS, QR_EXCEPTION_KEYS } from "./qr";
export { DIRECT_DEBIT_EXCEPTIONS, DIRECT_DEBIT_EXCEPTION_KEYS } from "./direct-debit";
export { SWIFT_EXCEPTIONS, SWIFT_EXCEPTION_KEYS } from "./swift";
export { REMITTANCE_EXCEPTIONS, REMITTANCE_EXCEPTION_KEYS } from "./remittance";
export { FINTECH_GATEWAY_EXCEPTIONS, FINTECH_GATEWAY_EXCEPTION_KEYS } from "./fintech-gateway";
export { BILL_PAYMENT_EXCEPTIONS, BILL_PAYMENT_EXCEPTION_KEYS } from "./bills";
export { BULK_PAYMENT_EXCEPTIONS, BULK_PAYMENT_EXCEPTION_KEYS } from "./bulk-payment";
export { TSA_EXCEPTIONS, TSA_EXCEPTION_KEYS } from "./tsa";
export { MOBILE_CHANNEL_EXCEPTIONS, MOBILE_CHANNEL_EXCEPTION_KEYS } from "./mobile-channels";
export { CARD_SWITCHING_EXCEPTIONS, CARD_SWITCHING_EXCEPTION_KEYS } from "./card-switching";
export { CARD_SCHEME_EXCEPTIONS, CARD_SCHEME_EXCEPTION_KEYS } from "./card-schemes";
export { CARD_DISPUTE_EXCEPTIONS, CARD_DISPUTE_EXCEPTION_KEYS } from "./card-disputes";
export { CHEQUE_EXCEPTIONS, CHEQUE_EXCEPTION_KEYS } from "./cheque";

// Shared types
export type { NigerianChannelException, NigerianChannelSource } from "./types";

// Re-import for the combined registry
import { NIP_EXCEPTIONS } from "./nip";
import { NEFT_EXCEPTIONS } from "./neft";
import { RTGS_EXCEPTIONS } from "./rtgs";
import { POS_EXCEPTIONS } from "./pos";
import { ATM_EXCEPTIONS } from "./atm";
import { QR_EXCEPTIONS } from "./qr";
import { DIRECT_DEBIT_EXCEPTIONS } from "./direct-debit";
import { SWIFT_EXCEPTIONS } from "./swift";
import { REMITTANCE_EXCEPTIONS } from "./remittance";
import { FINTECH_GATEWAY_EXCEPTIONS } from "./fintech-gateway";
import { BILL_PAYMENT_EXCEPTIONS } from "./bills";
import { BULK_PAYMENT_EXCEPTIONS } from "./bulk-payment";
import { TSA_EXCEPTIONS } from "./tsa";
import { MOBILE_CHANNEL_EXCEPTIONS } from "./mobile-channels";
import { CARD_SWITCHING_EXCEPTIONS } from "./card-switching";
import { CARD_SCHEME_EXCEPTIONS } from "./card-schemes";
import { CARD_DISPUTE_EXCEPTIONS } from "./card-disputes";
import { CHEQUE_EXCEPTIONS } from "./cheque";
import { NON_INTEREST_EXCEPTIONS } from "./non-interest";
import { RETAIL_COMMERCE_EXCEPTIONS } from "./retail-commerce";
import { UGANDA_EXCEPTIONS } from "./uganda";
import type { NigerianChannelException } from "./types";

/**
 * Structural supertype shared by the Nigerian and retail taxonomies — the
 * fields every vertical exposes. Lets a single registry span verticals without
 * coupling their source-type unions.
 */
export interface TaxonomyExceptionEntry {
  key: string;
  label: string;
  severity: "critical" | "high" | "medium" | "low";
  slaHours: number;
  sources: readonly string[] | "all";
  regulatoryContext: string;
  recommendedResolution: string;
  aiDiagnosisHint: string;
}

/**
 * Channel groupings of the exception registry, keyed by channel id. Used by
 * the taxonomy prompt block to inject only the channels relevant to a given
 * transaction into the Super Agent's context (token-efficient read-path).
 */
export const CHANNEL_EXCEPTION_GROUPS = {
  nip: NIP_EXCEPTIONS,
  neft: NEFT_EXCEPTIONS,
  rtgs: RTGS_EXCEPTIONS,
  pos: POS_EXCEPTIONS,
  atm: ATM_EXCEPTIONS,
  qr: QR_EXCEPTIONS,
  direct_debit: DIRECT_DEBIT_EXCEPTIONS,
  swift: SWIFT_EXCEPTIONS,
  remittance: REMITTANCE_EXCEPTIONS,
  fintech_gateway: FINTECH_GATEWAY_EXCEPTIONS,
  bills: BILL_PAYMENT_EXCEPTIONS,
  bulk_payment: BULK_PAYMENT_EXCEPTIONS,
  tsa: TSA_EXCEPTIONS,
  mobile_channels: MOBILE_CHANNEL_EXCEPTIONS,
  card_switching: CARD_SWITCHING_EXCEPTIONS,
  card_schemes: CARD_SCHEME_EXCEPTIONS,
  card_disputes: CARD_DISPUTE_EXCEPTIONS,
  cheque: CHEQUE_EXCEPTIONS,
} as const;

export type NigerianChannelKey = keyof typeof CHANNEL_EXCEPTION_GROUPS;

/**
 * Complete registry of all Nigerian payment channel exceptions.
 * 130 exceptions across 18 channels — the intelligence moat.
 */
export const ALL_NIGERIAN_EXCEPTIONS: NigerianChannelException[] =
  Object.values(CHANNEL_EXCEPTION_GROUPS).flat();

/**
 * All exception keys as a flat array — used for enum validation
 * and resolution_templates.category type generation.
 */
export const ALL_NIGERIAN_EXCEPTION_KEYS = ALL_NIGERIAN_EXCEPTIONS.map((e) => e.key);

/**
 * Cross-vertical lookup map for O(1) access by exception key. Spans BOTH the
 * Nigerian channel taxonomy and the retail/e-commerce taxonomy, so any code
 * resolving an exception's regulatory context / AI hint by key works for a
 * retail_commerce org exactly as it does for a bank (keys are unique across
 * verticals via the `retail_` prefix). Without this, retail keys were orphaned
 * — the O(1) lookup and any registry-driven prompt injection silently missed
 * every retail exception.
 */
export const EXCEPTION_REGISTRY = new Map<string, TaxonomyExceptionEntry>([
  ...ALL_NIGERIAN_EXCEPTIONS.map((e) => [e.key, e] as [string, TaxonomyExceptionEntry]),
  ...RETAIL_COMMERCE_EXCEPTIONS.map((e) => [e.key, e] as [string, TaxonomyExceptionEntry]),
  ...UGANDA_EXCEPTIONS.map((e) => [e.key, e] as [string, TaxonomyExceptionEntry]),
  ...NON_INTEREST_EXCEPTIONS.map((e) => [e.key, e] as [string, TaxonomyExceptionEntry]),
]);

/**
 * Every exception across all markets/verticals (Nigeria + retail + Uganda +
 * non-interest).
 *
 * NON_INTEREST_EXCEPTIONS are included here and in the registry, but NOT in
 * CHANNEL_EXCEPTION_GROUPS, and that asymmetry is deliberate. They belong to an
 * INSTITUTION, not to a rail: a non-interest bank runs the same NIP, POS and
 * cheque clearing as anyone else, and what differs is how income may be earned
 * and shared across all of them. They are selected by
 * `organizations.bankingModel` — see nonInterestTaxonomyPromptBlock in ./seed —
 * so putting them in the channel map would inject them for a conventional bank
 * on the strength of a channel type, which is exactly wrong.
 */
export const ALL_EXCEPTIONS: TaxonomyExceptionEntry[] = [
  ...ALL_NIGERIAN_EXCEPTIONS,
  ...RETAIL_COMMERCE_EXCEPTIONS,
  ...UGANDA_EXCEPTIONS,
  ...NON_INTEREST_EXCEPTIONS,
];

/**
 * Channel groupings for UI/reporting purposes.
 */
export const EXCEPTION_CHANNELS = {
  nip: { label: "NIBSS Instant Payment (NIP)", count: NIP_EXCEPTIONS.length },
  neft: { label: "NIBSS Electronic Funds Transfer (NEFT)", count: NEFT_EXCEPTIONS.length },
  rtgs: { label: "Real-Time Gross Settlement (RTGS)", count: RTGS_EXCEPTIONS.length },
  pos: { label: "Point of Sale (POS)", count: POS_EXCEPTIONS.length },
  atm: { label: "Automated Teller Machine (ATM)", count: ATM_EXCEPTIONS.length },
  qr: { label: "QR Payments (NQR)", count: QR_EXCEPTIONS.length },
  direct_debit: { label: "Direct Debit / Standing Order", count: DIRECT_DEBIT_EXCEPTIONS.length },
  swift: { label: "SWIFT / Correspondent Banking", count: SWIFT_EXCEPTIONS.length },
  remittance: { label: "IMTO / Remittance", count: REMITTANCE_EXCEPTIONS.length },
  fintech_gateway: { label: "Fintech Payment Gateways", count: FINTECH_GATEWAY_EXCEPTIONS.length },
  bills: { label: "Bill Payments (eBillsPay)", count: BILL_PAYMENT_EXCEPTIONS.length },
  bulk_payment: { label: "Bulk / Salary Payments", count: BULK_PAYMENT_EXCEPTIONS.length },
  tsa: { label: "CBN eTreasury / TSA", count: TSA_EXCEPTIONS.length },
  mobile_channels: { label: "Mobile / USSD / Agent Banking", count: MOBILE_CHANNEL_EXCEPTIONS.length },
  card_switching: { label: "Card Switching & Processors (Interswitch / UP / eTranzact)", count: CARD_SWITCHING_EXCEPTIONS.length },
  card_schemes: { label: "Card Schemes (Verve / AfriGO / Visa / Mastercard)", count: CARD_SCHEME_EXCEPTIONS.length },
  card_disputes: { label: "Card Disputes & Chargebacks", count: CARD_DISPUTE_EXCEPTIONS.length },
  cheque: { label: "Cheque Clearing (NIBSS NACS / Truncation)", count: CHEQUE_EXCEPTIONS.length },
} as const;

// Retail / E-Commerce (SHOPLINE vertical)
export { RETAIL_COMMERCE_EXCEPTIONS, RETAIL_COMMERCE_EXCEPTION_KEYS } from "./retail-commerce";
export type { RetailCommerceException, RetailChannelSource } from "./retail-commerce";

// Uganda market pack (BoU NPS framework)
export { UGANDA_EXCEPTIONS, UGANDA_EXCEPTION_KEYS } from "./uganda";
export type { UgandaChannelException } from "./uganda";

// Non-interest (NIFI) banking — institution-scoped, not channel-scoped.
export { NON_INTEREST_EXCEPTIONS, NON_INTEREST_EXCEPTION_KEYS } from "./non-interest";
