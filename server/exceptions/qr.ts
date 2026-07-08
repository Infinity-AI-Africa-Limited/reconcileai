/**
 * QR Payments (NQR — NIBSS Quick Response) — exception taxonomy.
 *
 * NQR is Nigeria's interoperable QR payment scheme operated by NIBSS,
 * enabling merchants to receive payments via QR code scanning from any
 * participating bank or fintech app. Settlement follows NIP rails.
 * Exceptions are based on NIBSS NQR operating rules and CBN electronic
 * payment channel guidelines.
 */
import type { NigerianChannelException } from "./types";

export const QR_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "qr_expired_code_debit",
    label: "QR payment on expired code — customer debited",
    severity: "high",
    slaHours: 24,
    sources: ["nqr", "cbs_ledger"],
    regulatoryContext:
      "NIBSS NQR Operating Rules: Dynamic QR codes have a validity window (typically 5–15 minutes). Payments against expired QR codes should be rejected by the system. If a debit occurs despite expiry, it indicates a validation failure requiring immediate reversal per CBN 24-hour reversal mandate.",
    recommendedResolution:
      "1) Verify the QR code expiry timestamp against the payment timestamp. 2) If payment was processed after QR expiry, initiate immediate reversal to customer. 3) Check if the merchant received the credit — if yes, reverse from merchant. 4) If merchant did not receive credit, reverse from NQR suspense. 5) Report the validation failure to NIBSS for system investigation.",
    aiDiagnosisHint:
      "Customer debit with QR reference where the QR generation timestamp + validity window < payment timestamp — confirms expired QR. Check if merchant was credited (determines reversal source). Systemic if multiple expired-QR payments process in same window.",
  },
  {
    key: "qr_amount_mismatch",
    label: "QR payment amount differs from merchant expectation",
    severity: "medium",
    slaHours: 48,
    sources: ["nqr", "cbs_ledger"],
    regulatoryContext:
      "NIBSS NQR Operating Rules: Static QR codes allow customer-entered amounts; dynamic QR codes have pre-set amounts. For static QR, the customer may enter a different amount than the merchant expects. This is not a system error but creates a reconciliation gap for the merchant.",
    recommendedResolution:
      "1) Determine QR type: static (customer enters amount) vs dynamic (pre-set amount). 2) For static QR: verify the amount paid against the merchant's invoice/expected amount. 3) If underpayment, merchant must collect the balance separately. 4) If overpayment, merchant should refund the excess. 5) For dynamic QR with amount mismatch: investigate system error — the pre-set amount should have been enforced.",
    aiDiagnosisHint:
      "Payment amount ≠ merchant expected amount on QR transaction — check QR type first. Static QR mismatches are operational (customer error), not system errors. Dynamic QR mismatches indicate a genuine system bug. Match the QR reference to determine type.",
  },
  {
    key: "qr_merchant_not_settled",
    label: "QR payment successful but merchant not credited",
    severity: "high",
    slaHours: 24,
    sources: ["nqr", "cbs_ledger"],
    regulatoryContext:
      "NIBSS NQR: Settlement follows NIP rails — merchant should receive credit in near-real-time. If customer is debited and NQR confirms success but merchant account is not credited, it follows the same regulatory framework as NIP inward-not-credited (CBN 24-hour mandate, ₦10,000 penalty per item).",
    recommendedResolution:
      "1) Verify the NQR transaction status — confirmed successful by NIBSS. 2) Check the merchant's account for the credit (may be posted to wrong account due to QR-to-account mapping error). 3) If credit is missing, trace via NIP session_id underlying the QR payment. 4) Post the credit to merchant from NQR suspense GL. 5) Investigate the NIP leg failure — same resolution path as nip_inward_credit_not_applied.",
    aiDiagnosisHint:
      "NQR transaction confirmed by NIBSS but merchant account shows no credit — trace the underlying NIP session. NQR payments settle via NIP, so the failure is in the NIP credit leg. Check merchant account mapping in the NQR registry vs actual account number.",
  },
  {
    key: "qr_duplicate_scan_payment",
    label: "QR duplicate payment — customer scanned and paid twice",
    severity: "high",
    slaHours: 24,
    sources: ["nqr", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection Regulations: Double debits are a leading complaint category. QR payments may be duplicated if the customer's app doesn't receive confirmation and they scan/pay again. Each QR payment should generate a unique NQR reference for duplicate detection.",
    recommendedResolution:
      "1) Identify duplicate: same customer + same QR code + same amount + timestamps within 5 minutes. 2) Check NQR references — if different references, both are technically valid payments. 3) Verify with merchant if they expected only one payment. 4) If duplicate confirmed, reverse the second payment to customer. 5) If merchant received both credits, debit merchant for the duplicate.",
    aiDiagnosisHint:
      "Two debits from same customer to same merchant QR within 5 minutes — check if the QR was dynamic (should only accept one payment) or static (can accept multiple). Dynamic QR duplicates are system errors; static QR duplicates may be customer error or legitimate separate purchases.",
  },
  {
    key: "qr_wrong_merchant_credited",
    label: "QR payment credited to wrong merchant",
    severity: "high",
    slaHours: 24,
    sources: ["nqr", "cbs_ledger"],
    regulatoryContext:
      "NIBSS NQR Operating Rules: QR codes are mapped to specific merchant accounts in the NQR registry. If the mapping is incorrect or the QR code was fraudulently generated, payments are routed to the wrong merchant. This constitutes either a configuration error or fraud.",
    recommendedResolution:
      "1) Verify the QR code's merchant mapping in the NQR registry. 2) If mapping is incorrect, correct it immediately to prevent further misrouting. 3) Recover the misrouted funds from the incorrectly credited merchant. 4) Credit the correct merchant. 5) If the QR code was fraudulently generated (not by the legitimate merchant), escalate to fraud team and NIBSS.",
    aiDiagnosisHint:
      "Payment via QR credited to account that doesn't belong to the physical merchant location — check QR registry mapping. If the QR was recently created or modified, suspect fraud (QR overlay attack). If mapping has been wrong since creation, it's a registration error.",
  },
];

export const QR_EXCEPTION_KEYS = QR_EXCEPTIONS.map((c) => c.key);
