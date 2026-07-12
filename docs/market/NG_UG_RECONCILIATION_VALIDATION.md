# Nigeria + Uganda Reconciliation Requirements — Platform Validation

*July 2026 · Auditor: Claude (acting CTO) · Scope: full codebase vs the
reconciliation pain-points and regulatory requirements of Nigeria (current
market) and Uganda (next market, per the Uganda market-entry strategy).
Focus markets: NG + UG. Ghana/Kenya are future; SmartBank AI is out of scope
for the platform build and recorded separately.*

## 1. The pain being validated against (research-grounded)

**Nigeria.** NIP processed ~11bn transactions in 2024 (electronic payments
above ₦1 quadrillion); CBN enforces ₦10,000-per-item fines for failed NIP not
reversed within 24h and inward credits not applied within minutes; an
October 2025 guideline mandates auto-reversal of failed on-us ATM
transactions (24h manual fallback; 48h not-on-us); a December 2025 circular
mandates dual connectivity (NIBSS + UPSL) for acquirers/processors; and an
**April 2026 directive requires monthly reporting of failed transactions**.
The ₦13.66bn NIBSS switching error (still unresolved after two years) is the
canonical example of reconciliation exposure at the infrastructure level.

**Uganda.** Mobile money is the economy's rail (MTN MoMo + Airtel Money);
agent banking runs on a **shared rail** — the Agent Banking Company (ABC) of
Uganda, plugging all banks into one interoperable agent network under BoU's
Financial Institutions (Agent Banking) Regulations 2017. The defining
reconciliation failure: MTN Uganda lost millions to internal fraud via the
**suspense account for disputed/erroneous/incomplete transactions** — absent
settlement/reconciliation controls let insiders mint excess e-money. The #1
operational friction (per our market-entry research): **float trapped in
24–48h inter-network settlement** across MTN/Airtel/ABC. Regulatory frame:
BoU NPS Act 2020 (PSP/PSO licensing; sandbox path available), 0.5% withdrawal
excise duty, and the **Data Protection and Privacy Act 2019 — financial data
must not leave Uganda → on-premise / in-country deployment is an entry
requirement, not an option.**

## 2. Validation matrix

| Requirement | Nigeria | Uganda | Verdict |
|---|---|---|---|
| Channel coverage (schema `channelType` + source registries) | NIP, POS, ATM, USSD, agent, cards (Interswitch/UPSL/eTranzact — matches the Dec-2025 dual-connectivity reality), NEFT/RTGS/SWIFT, wallets | `mobile_money` + agent channels exist; MTN MoMo UG + Airtel Money UG operators live in the mobile-money engine | **NG ✅ · UG ⚠️ POC-grade (G1)** |
| Exception taxonomy (the intelligence moat) | 121 exceptions / 17 channel files + 10 LAPO + core categories; CBN/NIBSS regulatory context per entry | 4 Uganda MoMo categories (incl. `mm_withdrawal_tax_variance` for the 0.5% excise) + 3 wallet categories, BoU framing | **NG ✅ · UG ⚠️ needs a channel pack (G1)** |
| Multi-currency | NGN native | **UGX first-class**: zero-decimal handling, USh symbol, UGX materiality thresholds in `server/currency.ts`; FX-variance category with NAFEM-style rate checks | **✅ both** |
| Regulator reporting | CBN module: 5 supervision reports + MFB unreconciled-aging; signed reports (Ed25519) | None for BoU | **NG ✅ (one new gap: G3) · UG ❌ (G2)** |
| Data residency / deployment | Cloud SaaS fine | **On-prem REQUIRED (DP&P Act 2019)** — platform has `DEPLOYMENT_MODE=on_premise` egress guard (fail-closed) + air-gapped deploy pack + local-LLM path | **✅ architecture · ❌ logistics (G4)** |
| Consumer-protection SLAs in taxonomy | 24h NIP reversal, ATM windows, agent float rules encoded as category SLAs | MoMo reversal/settlement SLAs encoded in mm categories | **✅ both** |
| Multi-tenancy, RLS, per-tenant keys, SSO | d01044a hardening; per-tenant DEKs; org-scoped everything | Same platform | **✅ both** |
| Timezone/locale | UTC storage everywhere; display-layer local | Same (Africa/Kampala = UTC+3, display-only) | **✅ both** |
| Sales tooling | ROI calculator (NGN default) | **UGX preset added** (this commit) | **✅ both** |

## 3. Gaps and remediation plan (priority order)

**G1 — Uganda channel pack — ✅ DONE (July 2026).** Tenant-grade Uganda pack
mirroring the LAPO pattern: `shared/ugandaSources.ts` (8 rails — CBS ledger,
MTN MoMo, Airtel Money, **ABC shared agent rail**, UNISS/RTGS, ACH/EFT, card
switch, **e-money trust account** — with 24–48h inter-network timing
tolerances in matchingConfig), `server/exceptions/uganda.ts` (12 BoU-framework
categories: trust-account backing, suspense integrity, wallet-liability
orphan, MoMo debit-no-credit, owed reversals, agent-rail settlement, agent
float trapped, interop lag, UNISS break, ACH return, excise-duty variance,
card-switch variance), `server/connectors/uganda/etl.ts` (per-rail ingestion,
file-hash idempotency, completeness watchdog, day-first date parsing).
Provisioned via DIRECT onboarding (custom-channel selector) + `uganda.provision`;
taxonomy in the cross-market `EXCEPTION_REGISTRY` + boot/per-org seeding.

**G2 — BoU report pack — ✅ DONE (July 2026), hardened round 2.**
`server/bouReports.ts` — **five** NPS-framework returns: E-Money Trust Account
& Suspense Integrity; Agent Rail & Mobile Money Settlement; Failed
Transactions & Reversals; **Suspense & Integrity Aging Schedule** (0–3/4–7/
8–30/30+ days over the fraud-adjacent classes — the MTN suspense precedent);
**Digital Nano-Lending Reconciliation** (MoKash/Wewole disbursement↔repayment
integrity + 72h CRB-window breaches). Report module regulator-parameterized
(`buildMeta` currency+regulator, `toCsv` neutral labels), picker grouped by
regulator (CBN / BoU).

**Uganda round 2 (July 2026):** the pack went from 8→**11 rails** (added
digital nano-lending MoKash/Wewole, bill/utility Yaka/NWSC/URA, aggregator
switch PayWay/EzeeMoney) and 12→**22 exception categories** (bill-debited-
no-token, airtime non-delivery, loan disbursement/repayment integrity, dormant
balances, duplicate wallet credit / excess e-money, orphan reversal,
aggregator + agent-commission + FX variance). All research-grounded; migration
0069 (additive enum).

**G3 — CBN monthly failed-transaction return — ✅ DONE (July 2026).**
`buildFailedTransactionsReturn` in the CBN module: per-channel failed
volume/value, reversal buckets against the 24h/48h windows, compliance rate,
and indicative ₦10,000-per-item sanction exposure. One-click preview + CBN-
format CSV from the Regulatory Reports tab ("Failed Transactions Monthly
Return"). Category classification and window bucketing are unit-tested.

**G4 — The on-prem deploy pack is still uncommitted (URGENT, one disk from
gone).** Uganda's data-residency law makes `deploy/on-prem` + the egress
guard the literal market-entry artifact, and it exists only on this laptop
(`deploy/`, `ml/`, `run-sync.ts` untracked since the local-deployment track).
Committing it is now Uganda-critical, not just hygiene.

**G5 — UGX in the ROI calculator (DONE in this commit).** Uganda sales
meetings can now run the before/after in shillings.

## 4. Verdict

**Nigeria: validated.** The platform's channel coverage, taxonomy depth, CBN
reporting, SLAs and card-processor reality (incl. UPSL dual-connectivity era)
match the market's actual pain; the single new item is the April-2026
failed-transaction return (G3).

**Uganda: architecture validated, depth pending.** Everything structural that
Uganda's entry requires — on-prem enforcement, UGX, MoMo operators, excise
handling, BoU framing — already exists. What's missing is deliberate depth
(G1/G2), correctly sequenced behind the first Ugandan prospect rather than
built speculatively. The one thing to do *now* is G4.

*Sources:* [CGAP — Uganda MTN internal-collusion fraud](https://www.cgap.org/blog/fraud-in-uganda-how-millions-were-lost-to-internal-collusion) ·
[Agent banking in Uganda review](https://agabamuhairwe.com/wp-content/uploads/2020/09/Agent-Banking-In-Uganda-A-Review-of-the-Opportunities-and-Challenges1.pdf) ·
[BusinessDay — ₦13.66bn NIBSS payment error](https://businessday.ng/technology/article/how-nigerias-n13-66bn-payment-error-still-haunts-nibss-nearly-two-years-later/) ·
[Punch — CBN penalties for failed e-transactions](https://punchng.com/cbn-to-penalise-banks-others-for-failed-e-transactions/) ·
[Guardian — ₦10,000 fine per failed e-transaction](https://guardian.ng/news/cbn-to-fine-banks-n10000-for-failed-e-transactions/) ·
[Blueprint — CBN ATM refund directive](https://blueprint.ng/cbn-issues-fresh-directive-to-banks-on-failed-atm-transactions/) ·
[NIBSS — CBN payment system reforms](https://nibss-plc.com.ng/how-cbn-revolutionized-payment-systems-in-nigeria/)
