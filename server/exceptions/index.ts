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
import type { NigerianChannelException } from "./types";

/**
 * Complete registry of all Nigerian payment channel exceptions.
 * 93 exceptions across 14 channels — the intelligence moat.
 */
export const ALL_NIGERIAN_EXCEPTIONS: NigerianChannelException[] = [
  ...NIP_EXCEPTIONS,
  ...NEFT_EXCEPTIONS,
  ...RTGS_EXCEPTIONS,
  ...POS_EXCEPTIONS,
  ...ATM_EXCEPTIONS,
  ...QR_EXCEPTIONS,
  ...DIRECT_DEBIT_EXCEPTIONS,
  ...SWIFT_EXCEPTIONS,
  ...REMITTANCE_EXCEPTIONS,
  ...FINTECH_GATEWAY_EXCEPTIONS,
  ...BILL_PAYMENT_EXCEPTIONS,
  ...BULK_PAYMENT_EXCEPTIONS,
  ...TSA_EXCEPTIONS,
  ...MOBILE_CHANNEL_EXCEPTIONS,
];

/**
 * All exception keys as a flat array — used for enum validation
 * and resolution_templates.category type generation.
 */
export const ALL_NIGERIAN_EXCEPTION_KEYS = ALL_NIGERIAN_EXCEPTIONS.map((e) => e.key);

/**
 * Lookup map for O(1) access by exception key.
 */
export const EXCEPTION_REGISTRY = new Map<string, NigerianChannelException>(
  ALL_NIGERIAN_EXCEPTIONS.map((e) => [e.key, e])
);

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
} as const;
