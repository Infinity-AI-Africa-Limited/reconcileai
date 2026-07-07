# Mobile Money Exception Taxonomy

> **Gap-closure plan WS-3 + WS-8 deliverable.** The authoritative definition of the 15 mobile
> money exception categories detected by `server/mobileMoney-engine.ts`, across two
> jurisdictions and two flow kinds (transfer/USSD settlement and provider wallets).
> Code is the source of truth (`MM_EXCEPTION_CATEGORIES` in `drizzle/mobile_money_schema.ts`,
> `REG_REFS`/`CATEGORY_INFO` in the engine); this document explains the domain reasoning
> behind each category for operations teams, sales conversations, and future engineers.

| Segment | Operators | Currency | Regulator / framework |
|---|---|---|---|
| Nigeria — transfers/USSD | NIBSS NIP (`nip`), OPay (`opay`), Palmpay (`palmpay`) | NGN | CBN Mobile Money Framework 2021; NIBSS NIP Operating Rules |
| Nigeria — wallets (WS-8) | OPay Wallet (`opay_wallet`), Palmpay Wallet (`palmpay_wallet`), Moniepoint Wallet (`moniepoint_wallet`) | NGN | CBN Consumer Protection Regulations 2019; CBN Guidelines on Operations of Electronic Payment Channels 2020 |
| Uganda | MTN MoMo (`mtn_momo_ug`), Airtel Money (`airtel_money_ug`) | UGX | Bank of Uganda — NPS Act 2020; NPS (E-Money) Regulations 2021; Excise Duty Act (2018 Amendment) |

**Priority thresholds are currency-scaled** (roughly equal purchasing power):
NGN — CRITICAL ≥ ₦500,000, HIGH ≥ ₦100,000, MEDIUM ≥ ₦10,000.
UGX — CRITICAL ≥ USh 2,000,000, HIGH ≥ USh 400,000, MEDIUM ≥ USh 40,000.

Every category ships with: detection logic in Layer 2, an AI diagnosis prompt + recommended
action in Layer 3, a regulatory rule reference, and at least one seeded resolution template
(`server/seedResolutionTemplates.ts`) — per the Intelligence Moat rubric (CLAUDE.md §9A),
never matching-only. Diagnoses are additionally enriched by the institution's own resolution
history (`applyInstitutionalLearning`).

---

## Nigeria (8 categories)

### 1. `mm_failed_ussd_debit` — Failed USSD Debit
- **What happened:** customer's account debited via USSD; institution's ledger shows no corresponding credit. The customer lost funds; the institution received no value. The most common MM exception in Nigerian MFBs.
- **Detected when:** ledger row has no settlement counterpart (default classification for unmatched ledger rows; also matched on `ussd`/`debit` in the narration).
- **Regulatory basis:** CBN Mobile Money Framework 2021 §4.3 — failed transactions must be reversed within T+1 business day.
- **Resolution path:** verify USSD session log → reverse to customer within T+1 → log in CBS, notify customer.

### 2. `mm_reversal_not_credited` — Reversal Not Credited
- **What happened:** operator processed a reversal but the credit never appeared in the institution's ledger; the customer is owed the credit.
- **Detected when:** narration contains `reversal`/`reverse`/`refund` on an unmatched row (either side).
- **Regulatory basis:** CBN Mobile Money Framework 2021 §4.3.2 — reversal credit timeline (T+1).
- **Resolution path:** confirm reversal reference in the operator portal → post credit from settlement suspense GL → escalate to operator if older than T+1.

### 3. `mm_nip_settlement_shortfall` — NIP Settlement Shortfall
- **What happened:** net NIP settlement received is below the gross sum of transactions in the settlement file — typically NIBSS fees, failed-transaction netting, or a settlement-cycle timing difference.
- **Detected when:** run-level Layer-1 variance (ledger net > settlement net by ≥ ₦1) on the `nip` operator (`detectSettlementShortfall`).
- **Regulatory basis:** NIBSS NIP Operating Rules §8 — net settlement obligations; query window of 2 business days.
- **Resolution path:** obtain the NIBSS settlement advice → reconcile against the fee schedule (₦10.75/transaction above ₦5,000) → formal NIBSS query if residual variance remains.

### 4. `mm_duplicate_credit` — Duplicate Credit
- **What happened:** the same session ID credited twice — the institution paid out twice for one transaction.
- **Detected when:** a settlement reference appears more than once in the settlement file.
- **Regulatory basis:** CBN Mobile Money Framework 2021 §5.1 — duplicate transaction controls.
- **Resolution path:** freeze the second credit immediately → verify single settlement in operator portal → reverse duplicate → root-cause the control gap.

### 5. `mm_expired_session_debit` — Expired Session Debit
- **What happened:** USSD session timed out but the customer was debited; the operator's mandatory auto-reversal has not arrived.
- **Detected when:** narration contains `timeout`/`expired`/`session` on an unmatched row.
- **Regulatory basis:** CBN Mobile Money Framework 2021 §4.3.1 — session timeout & auto-reversal.
- **Resolution path:** confirm timeout in session log → provisional credit to customer → operator escalation at 24h, CBN escalation past T+1.

### 6. `mm_amount_mismatch` — Amount Mismatch
- **What happened:** same transaction reference on both sides, different amounts — operator fees, FX, or a data-entry error.
- **Detected when:** reference matches across files but amounts differ by ≥ ₦0.01. Same-reference pairs always consume each other (one amount-level exception, never two phantom missing-transaction exceptions).
- **Regulatory basis:** NIBSS NIP Operating Rules §7.4 — amount integrity validation.
- **Resolution path:** check operator fee schedule first (legitimate deduction) → dispute with operator if not a fee → post confirmed fee variance to GL.

### 7. `mm_unmatched_nip_inflow` — Unmatched NIP Inflow
- **What happened:** funds received from NIBSS with no posting to any customer account.
- **Detected when:** settlement row has no ledger counterpart (default classification for unmatched settlement rows; also `nip`/`inflow`/`inward` narration).
- **Regulatory basis:** NIBSS NIP Operating Rules §9 — unmatched inflow resolution within T+2 days.
- **Resolution path:** search CBS by session ID → post to NIP suspense immediately → identify beneficiary from NIBSS detail and post within T+2 → report to NIBSS if unidentifiable.

### 8. `mm_operator_fee_variance` — Operator Fee Variance
- **What happened:** fee deducted differs from the contracted rate — fee revision, billing error, or contract compliance issue.
- **Detected when:** narration contains `fee`/`charge`/`commission` on an unmatched row.
- **Regulatory basis:** CBN Mobile Money Framework 2021 §6.2 — operator fee schedule compliance.
- **Resolution path:** compare against contracted schedule → formal dispute if above rate → fee dispute suspense GL pending resolution.

---

## Uganda (4 categories)

Uganda's flows differ structurally from Nigeria's: the channel is wallet↔bank transfer (not
USSD-session-based), settlement is governed by the Bank of Uganda's e-money trust-account
regime, and a **statutory 0.5% excise duty on mobile money withdrawals** appears as a
persistent deduction in operator settlements.

### 9. `mm_wallet_to_bank_failed` — Wallet-to-Bank Failed
- **What happened:** operator settled a wallet-to-bank transfer (customer's wallet debited) but the bank ledger was never credited. The Ugandan analogue of the failed USSD debit — the most common MM exception in Ugandan institutions.
- **Detected when:** settlement row has no ledger counterpart (default classification for unmatched settlement rows on UG operators).
- **Regulatory basis:** Uganda NPS Act 2020, Part VII — consumer protection: error resolution & refund obligations.
- **Resolution path:** verify the MTN Financial Transaction ID / Airtel Money ID in the merchant portal → credit customer from settlement suspense → if operator marked it failed, confirm wallet auto-refund → log for the BoU consumer-protection audit trail.

### 10. `mm_bank_to_wallet_failed` — Bank-to-Wallet Failed
- **What happened:** bank debited the customer for a push-to-wallet; the wallet was never credited and the operator has no record. The institution holds funds owed to the customer.
- **Detected when:** ledger row has no settlement counterpart (default classification for unmatched ledger rows on UG operators).
- **Regulatory basis:** Uganda NPS Act 2020, Part VII — failed transfer reversal obligations.
- **Resolution path:** check operator status (pending/failed/absent) → reverse ledger debit within T+1 if failed → escalate with transaction reference if pending beyond SLA.

### 11. `mm_withdrawal_tax_variance` — Withdrawal Tax Variance (0.5%)
- **What happened:** a variance matching the profile of Uganda's 0.5% excise duty on mobile money withdrawals. Operators remit withdrawals net of the levy; ledgers booking gross amounts show a persistent ~0.5% shortfall. **A statutory deduction, not an operator error** — misclassifying it as a dispute wastes operations time and poisons the learning flywheel.
- **Detected when:** (a) a matched-reference amount difference equals 0.5% of the gross amount within tolerance (`isWithdrawalTaxVariance`); (b) a run-level shortfall fits the 0.5% profile; (c) narration contains `tax`/`levy`/`excise`.
- **Regulatory basis:** Uganda Excise Duty Act (2018 Amendment) — 0.5% levy on mobile money withdrawals.
- **Resolution path:** confirm variance = 0.5% of gross withdrawals → post to mobile money tax GL → verify operator's tax remittance statement → treat as fee dispute only if the rate doesn't match the statute.

### 12. `mm_momo_settlement_shortfall` — MoMo Settlement Shortfall
- **What happened:** net settlement received is below the gross statement sum — operator fees, the 0.5% levy, failed-transaction netting, or timing. For e-money flows, BoU regulations require the trust-account position to be reconciled against e-money liabilities **daily**.
- **Detected when:** run-level Layer-1 variance on a non-NIP operator (`detectSettlementShortfall`); UG shortfalls matching the 0.5% profile classify as `mm_withdrawal_tax_variance` instead.
- **Regulatory basis:** BoU NPS (E-Money) Regulations 2021 — trust account & daily reconciliation requirements.
- **Resolution path:** itemise the operator's settlement advice (fees / levy / netted reversals) → post each to its GL → formal operator query within 2 business days for residual variance → update the daily trust-account reconciliation record.

---

## Nigeria wallets (3 categories — WS-8)

Wallet reconciliation differs structurally from transfer settlement: the two sides are the
**provider's wallet statement** (OPay/Palmpay/Moniepoint partner portal export) and the
institution's **internal wallet ledger**. The core risks are consumer-protection exposure
(customer paid, wallet not credited) and unbacked balances (wallet credited, no settled funds).
Operators carry `kind: "wallet"` in `OPERATOR_META`, which switches the classification
defaults below; `mm_duplicate_credit`, `mm_amount_mismatch`, and `mm_operator_fee_variance`
apply to wallet flows unchanged.

### 13. `mm_wallet_credit_failed` — Wallet Credit Failed
- **What happened (side-aware):** *settlement side* — provider collected customer funding but the internal wallet ledger shows no credit: the customer paid and the wallet balance never moved (the most common wallet exception, direct consumer-protection exposure). *Ledger side* — the institution credited a wallet with no provider settlement backing it: an unbacked balance the institution is exposed for until settlement confirms.
- **Detected when:** unmatched row on either side for a wallet operator (default classification; the Layer-3 explanation branches on `side`).
- **Regulatory basis:** CBN Consumer Protection Regulations 2019 — error resolution & refund obligations.
- **Resolution path:** establish the missing side in the provider portal → settlement-side: post wallet credit from settlement suspense, notify customer → ledger-side: freeze spend against the unbacked balance, chase or reverse.

### 14. `mm_wallet_debit_reversed` — Wallet Debit Reversed
- **What happened:** provider reversed a wallet debit (failed/disputed transaction) but the reversal credit has not reached the internal wallet ledger — the customer's balance is understated.
- **Detected when:** reversal keywords (`reversal`/`reverse`/`refund`) on an unmatched row for a wallet operator (either side).
- **Regulatory basis:** CBN Mobile Money Framework 2021 §4.3.2 — reversal credit timeline (T+1).
- **Resolution path:** confirm reversal reference in provider portal → post reversal credit to the wallet → escalate past T+1 → notify customer on restoration.

### 15. `mm_wallet_settlement_shortfall` — Wallet Settlement Shortfall
- **What happened:** net wallet settlement received is below the gross statement sum — provider fees/commissions, netted failed transactions, negative-balance recoveries, or timing.
- **Detected when:** run-level Layer-1 variance on a wallet operator (`detectSettlementShortfall`).
- **Regulatory basis:** CBN Guidelines on Operations of Electronic Payment Channels 2020 — settlement obligations & fee transparency.
- **Resolution path:** itemise the provider's settlement advice → post fees to the provider charges GL → formal query within 2 business days for residual variance → repeated unexplained shortfalls = contract-compliance signal.

---

## Category → priority mapping

Priority is **amount-driven** (currency-scaled thresholds above), not fixed per category: a
₦2,000 fee variance is LOW; a ₦2,000,000 failed USSD debit is CRITICAL. Confidence per
category is fixed in `CATEGORY_INFO` (85–92%) and rises up to +6 points with corroborating
institutional resolution history.

## Extending this taxonomy

New jurisdictions (per gap-closure plan WS-9: Ghana/GhIPSS, Kenya/Pesalink) follow this
recipe — the Moat Gate requires all five parts:
1. Operators + jurisdiction metadata in `OPERATOR_META` (currency, regulator, thresholds)
2. Exception categories in `MM_EXCEPTION_CATEGORIES` (+ enum migration for `mm_*` operators)
3. Regulatory references in `REG_REFS`, diagnosis prompts in `CATEGORY_INFO`
4. Seeded resolution templates in `seedResolutionTemplates.ts` (+ `RESOLUTION_TEMPLATE_CATEGORIES`)
5. Vitest coverage: classification defaults, jurisdiction-specific detection rules, Layer-3 output

*Prepared July 2026 as part of the Credrails gap-closure plan (docs/GAP_CLOSURE_PLAN.md, WS-3).*
