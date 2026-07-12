/**
 * Failed Transactions Monthly Return (CBN April-2026 directive) — tests for
 * the pure core: which exception categories count as failed customer
 * transactions, and how each buckets against the 24h/48h reversal windows.
 * These numbers land in front of a regulator, so the edges are locked here.
 */
import { describe, expect, it } from "vitest";
import {
  bucketFailedTransaction,
  isFailedTransactionCategory,
  CBN_FAILED_TXN_SANCTION_NGN,
} from "./cbnReports";

describe("isFailedTransactionCategory — what counts as a failed transaction", () => {
  it("matches failed-transaction classes across every taxonomy family", () => {
    const shouldMatch = [
      // Nigerian channels
      "nip_timeout_debit_no_credit",
      "nip_inward_credit_not_applied",
      "nip_dry_posting",
      "ussd_timeout_debit",
      "pos_declined_but_debited",
      "atm_dispense_error_on_us",
      "atm_dispense_error_not_on_us",
      "atm_short_dispense",
      "atm_biometric_fallback_debit",
      "qr_expired_code_debit",
      "bill_customer_debited_biller_not_credited",
      "card_switch_timeout_reversal_missing",
      "agent_cash_in_not_credited",
      "mobile_app_transaction_not_posted",
      // Mobile money (NG + UG)
      "mm_failed_ussd_debit",
      "mm_expired_session_debit",
      "mm_reversal_not_credited",
      "mm_wallet_to_bank_failed",
      "mm_bank_to_wallet_failed",
      // LAPO
      "lapo_ussd_debit_no_value",
      "lapo_nip_inward_not_credited",
      "lapo_nip_outward_debit_unsettled",
      // Core
      "reversal_unmatched",
    ];
    for (const k of shouldMatch) {
      expect(isFailedTransactionCategory(k), `${k} should be a failed txn`).toBe(true);
    }
  });

  it("does NOT match fee variances, aging, settlement analytics or duplicates", () => {
    const shouldNotMatch = [
      "pos_interchange_fee_variance",
      "gateway_fee_discrepancy",
      "retail_gateway_fee_variance",
      "amount_mismatch",
      "timing_difference",
      "duplicate_transaction",
      "nip_duplicate_transfer",
      "scheme_net_settlement_variance",
      "lapo_fee_commission_variance",
      "retail_settlement_batch_missing",
      "mm_operator_fee_variance",
    ];
    for (const k of shouldNotMatch) {
      expect(isFailedTransactionCategory(k), `${k} should NOT be a failed txn`).toBe(false);
    }
  });
});

describe("bucketFailedTransaction — CBN reversal windows", () => {
  const asOf = new Date("2026-07-31T23:59:59Z");

  it("resolved within 24h → compliant bucket", () => {
    const r = bucketFailedTransaction(
      { createdAt: "2026-07-10T08:00:00Z", resolvedAt: "2026-07-10T20:00:00Z" },
      asOf,
    );
    expect(r.bucket).toBe("reversed_within_24h");
    expect(r.resolutionHours).toBeCloseTo(12, 5);
  });

  it("exactly 24h is still compliant (boundary inclusive)", () => {
    const r = bucketFailedTransaction(
      { createdAt: "2026-07-10T08:00:00Z", resolvedAt: "2026-07-11T08:00:00Z" },
      asOf,
    );
    expect(r.bucket).toBe("reversed_within_24h");
  });

  it("24–48h → the ATM not-on-us window bucket", () => {
    const r = bucketFailedTransaction(
      { createdAt: "2026-07-10T08:00:00Z", resolvedAt: "2026-07-11T20:00:00Z" },
      asOf,
    );
    expect(r.bucket).toBe("reversed_within_48h");
    expect(r.resolutionHours).toBeCloseTo(36, 5);
  });

  it("beyond 48h → late", () => {
    const r = bucketFailedTransaction(
      { createdAt: "2026-07-10T08:00:00Z", resolvedAt: "2026-07-15T08:00:00Z" },
      asOf,
    );
    expect(r.bucket).toBe("reversed_late");
  });

  it("unresolved → clock runs to the as-of date, not to now()", () => {
    const r = bucketFailedTransaction({ createdAt: "2026-07-01T00:00:00Z", resolvedAt: null }, asOf);
    expect(r.bucket).toBe("unresolved");
    expect(r.resolutionHours).toBeCloseTo(31 * 24 - 0.0002777, 1); // ~744h to period end
  });

  it("clock skew (resolvedAt before createdAt) clamps to 0, never negative", () => {
    const r = bucketFailedTransaction(
      { createdAt: "2026-07-10T08:00:00Z", resolvedAt: "2026-07-10T07:00:00Z" },
      asOf,
    );
    expect(r.bucket).toBe("reversed_within_24h");
    expect(r.resolutionHours).toBe(0);
  });

  it("sanction constant matches the CBN Instant-EFT figure", () => {
    expect(CBN_FAILED_TXN_SANCTION_NGN).toBe(10_000);
  });
});
