/**
 * Bill Payments (NIBSS eBillsPay / Biller Aggregators) — exception taxonomy.
 *
 * eBillsPay is NIBSS's centralized bill payment platform enabling
 * customers to pay bills (utilities, taxes, subscriptions) through
 * their bank accounts. Settlement uses NIP rails. Exceptions cover
 * the full bill payment lifecycle from customer debit to biller credit.
 * Based on NIBSS eBillsPay operating rules and CBN e-payment guidelines.
 */
import type { NigerianChannelException } from "./types";

export const BILL_PAYMENT_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "bill_customer_debited_biller_not_credited",
    label: "Bill payment — customer debited but biller not credited",
    severity: "critical",
    slaHours: 24,
    sources: ["ebillspay", "nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN E-Payment Guidelines: Failed bill payments must be resolved within 48 hours. NIBSS eBillsPay uses NIP for the credit leg to billers. If the NIP credit to the biller fails (biller account issue, NIP timeout), the customer's debit must be reversed within 24 hours. The biller should not provide service until payment is confirmed.",
    recommendedResolution:
      "1) Check eBillsPay transaction status — determine if the NIP credit leg to biller succeeded or failed. 2) If NIP credit failed: reverse customer debit immediately (within 24 hours). 3) If NIP credit succeeded but biller claims not received: raise dispute with biller's bank via NIBSS. 4) Notify customer of status and expected resolution timeline. 5) If biller has already provided service despite payment failure, coordinate with biller for service reversal or payment retry.",
    aiDiagnosisHint:
      "Customer CBS debit for bill payment but biller's bank shows no credit — trace the eBillsPay transaction through to its NIP session. If NIP session failed (timeout, beneficiary bank offline), the customer debit should auto-reverse. If NIP succeeded but biller's bank didn't post, it's a biller-bank issue.",
  },
  {
    key: "bill_duplicate_payment",
    label: "Bill payment duplicate — same bill paid twice",
    severity: "high",
    slaHours: 48,
    sources: ["ebillspay", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection Regulations: Duplicate bill payments are a common complaint. eBillsPay should have duplicate detection based on biller code + customer reference + amount within a window. If duplicates pass through, the customer is entitled to a refund of the excess payment within 48 hours.",
    recommendedResolution:
      "1) Confirm duplicate: same biller code + same customer reference (e.g., meter number, account number) + same amount within 24 hours. 2) Verify both payments were successful (both debited customer, both credited biller). 3) If duplicate confirmed, initiate refund request to biller for the excess payment. 4) If biller refund is slow (>48 hours), credit customer from suspense and recover from biller. 5) Investigate why duplicate detection didn't catch it (different channels, slight timing difference).",
    aiDiagnosisHint:
      "Two bill payments with same biller_code + customer_reference + amount within 24 hours — check if they came from different channels (mobile app vs USSD vs internet banking) which may bypass cross-channel duplicate detection. Also check if the biller's system accepted both (some billers reject duplicates on their end).",
  },
  {
    key: "bill_wrong_biller_code",
    label: "Bill payment routed to wrong biller",
    severity: "high",
    slaHours: 48,
    sources: ["ebillspay", "cbs_ledger"],
    regulatoryContext:
      "NIBSS eBillsPay: Biller codes are centrally managed by NIBSS. If a customer selects the wrong biller or if the biller code mapping is incorrect in the bank's system, payment is routed to the wrong entity. Recovery requires cooperation from the incorrectly credited biller.",
    recommendedResolution:
      "1) Identify the biller that received the payment vs the intended biller. 2) Contact the incorrectly credited biller (via NIBSS or directly) to request return of funds. 3) If biller returns funds, re-route to correct biller. 4) If biller refuses or is unresponsive, escalate to NIBSS for mediation. 5) If customer needs immediate service, credit the correct biller from suspense and recover from wrong biller. 6) Fix the biller code mapping if it was a system error.",
    aiDiagnosisHint:
      "Payment credited to biller A but customer intended biller B — check if the biller code in the transaction matches what the customer selected. If customer selected correctly but code maps to wrong biller, it's a system/mapping error. If customer selected wrong biller, it's user error but still requires resolution assistance.",
  },
  {
    key: "bill_amount_mismatch",
    label: "Bill payment amount differs from bill amount",
    severity: "medium",
    slaHours: 72,
    sources: ["ebillspay", "cbs_ledger"],
    regulatoryContext:
      "NIBSS eBillsPay: Some billers require exact amounts (e.g., tax payments), others accept any amount (e.g., utility top-ups). If a customer pays less than the bill amount for an exact-amount biller, the payment may be rejected by the biller. If overpaid, the excess should be credited to the customer's biller account or refunded.",
    recommendedResolution:
      "1) Determine biller type: exact-amount (must match bill) vs flexible-amount (any amount accepted). 2) For underpayment on exact-amount biller: if biller rejected, refund customer. If biller accepted partial, notify customer of remaining balance. 3) For overpayment: verify with biller if excess was credited to customer's account with them. If not, request refund of excess. 4) For flexible-amount billers: any amount is valid, no exception needed.",
    aiDiagnosisHint:
      "Bill payment amount ≠ expected bill amount — check biller type first. Utility prepaid (electricity, airtime) = flexible amount, no issue. Postpaid bills, taxes, subscriptions = typically exact amount required. If biller rejected the payment, it should auto-refund; if accepted, the biller handles the balance internally.",
  },
  {
    key: "bill_expired_bill_payment",
    label: "Payment for expired or cancelled bill",
    severity: "medium",
    slaHours: 72,
    sources: ["ebillspay", "cbs_ledger"],
    regulatoryContext:
      "NIBSS eBillsPay: Bills have validity periods. Payments against expired bills should be rejected by the biller's validation API. If the validation check fails or is bypassed, payment may be processed for an expired bill. Customer is entitled to a full refund.",
    recommendedResolution:
      "1) Verify the bill status with the biller: expired, cancelled, or already paid. 2) If biller confirms bill is no longer valid, request return of funds. 3) If biller has already applied the payment (e.g., credited to customer's account with biller), confirm with customer if this is acceptable. 4) If customer wants refund, coordinate with biller for return. 5) Investigate why the bill validation API didn't reject the payment (stale validation, API timeout defaulting to accept).",
    aiDiagnosisHint:
      "Payment processed for a bill that the biller says is expired/invalid — check the bill validation response at time of payment. If validation returned 'valid' but bill was actually expired, the biller's API has a bug. If validation was skipped (timeout/error), the bank's system should have rejected rather than defaulting to accept.",
  },
  {
    key: "bill_biller_rejection_refund_delay",
    label: "Biller rejected payment but customer refund delayed",
    severity: "high",
    slaHours: 48,
    sources: ["ebillspay", "cbs_ledger"],
    regulatoryContext:
      "CBN E-Payment Guidelines: Refunds on failed bill payments must be treated within 48 hours. If a biller rejects a payment (invalid reference, service unavailable, amount mismatch), the funds must be returned to the customer promptly. Delays in processing biller rejections create customer complaints and regulatory risk.",
    recommendedResolution:
      "1) Receive biller rejection notification (via eBillsPay callback or reconciliation). 2) Verify the rejection is legitimate (not a biller system error). 3) Initiate customer refund within 24 hours of receiving rejection. 4) If rejection notification was delayed (biller took days to reject), still refund customer within 48 hours of notification receipt. 5) Track biller rejection rates — high rejection rates suggest integration issues or stale biller data.",
    aiDiagnosisHint:
      "Biller rejection received but customer not yet refunded — check the time gap between payment, rejection notification, and current time. If rejection notification was delayed (biller's fault), the bank's SLA clock starts from notification receipt, not from original payment. Prioritize refunds where total elapsed time from customer's perspective exceeds 48 hours.",
  },
];

export const BILL_PAYMENT_EXCEPTION_KEYS = BILL_PAYMENT_EXCEPTIONS.map((c) => c.key);
