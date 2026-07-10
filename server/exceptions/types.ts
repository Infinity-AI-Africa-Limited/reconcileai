/**
 * Shared types for Nigerian payment channel exception definitions.
 *
 * Each channel-specific exception file exports an array of
 * NigerianChannelException objects following the same pattern as
 * server/connectors/lapo/exceptions.ts — the intelligence moat.
 */
import type { ResolutionTemplateCategory } from "../../drizzle/schema";  // relative from server/exceptions/

/** Channel source keys used across Nigerian payment infrastructure. */
export type NigerianChannelSource =
  | "nibss_nip"
  | "nibss_neft"
  | "cbn_rtgs"
  | "pos_terminal"
  | "atm"
  | "nqr"
  | "direct_debit"
  | "swift"
  | "imto_remittance"
  | "fintech_gateway"
  | "ebillspay"
  | "bulk_payment"
  | "cbn_tsa"
  | "cbs_ledger"
  | "card_switch"
  | "mobile_banking"
  | "ussd"
  | "agent_banking"
  // Card processors & schemes (server/exceptions/card-*.ts)
  | "interswitch_switch"
  | "up_switch"
  | "etranzact_switch"
  | "verve_scheme"
  | "afrigo_scheme"
  | "visa_scheme"
  | "mastercard_scheme";

export interface NigerianChannelException {
  /** Unique key — also a resolution_templates.category enum value. */
  key: ResolutionTemplateCategory;
  /** Human-readable label for the exception. */
  label: string;
  /** Severity based on regulatory/financial impact. */
  severity: "critical" | "high" | "medium" | "low";
  /** Hours before SLA breach per CBN/NIBSS regulations. */
  slaHours: number;
  /** Which channel sources this exception applies to. */
  sources: NigerianChannelSource[] | "all";
  /** Specific CBN/NIBSS rule references that make this urgent. */
  regulatoryContext: string;
  /** Step-by-step resolution procedure. */
  recommendedResolution: string;
  /** Guidance for the AI agent when diagnosing this exception. */
  aiDiagnosisHint: string;
}
