# Corporate B2B Payments Go-Live — Evidence Register

**Purpose.** This register supports the Corporate B2B payments go-live assessment. It distinguishes verified market and regulatory context from customer-specific facts that must be supplied during pilot discovery.

| Source | Verified observation | Safe implication for ReconcileAI |
|---|---|---|
| Bank of Uganda, *Strengthening Uganda’s Financial Infrastructure* | Bank of Uganda states that it operates, supervises, regulates and manages key national-payment and digital-financial-service infrastructure. It identifies payment systems as critical to secure, efficient business transfers and lists MTN Mobile Money Uganda and Airtel Mobile Commerce Uganda among supervised providers. Its page also describes the National Payment Systems Act and related framework. | A Uganda FMCG/distributor pilot should treat mobile-money and bank-transfer records as controlled financial evidence, obtain the customer’s authorised data feeds, and retain source, time, amount and reference provenance. ReconcileAI should not represent itself as a payment service provider or payment system operator unless separately authorised. |
| GSMA, *State of the Industry Report on Mobile Money 2026* | GSMA reports US$2.1 trillion in mobile-money transactions in 2025, 2.3 billion registered accounts, and US$155 billion in merchant payments, with merchant payments growing by almost half. | Mobile-money payment visibility is commercially material. It supports a reconciliation and exception-control wedge, but it does not validate any ReconcileAI customer metric or promise a specific payment rail integration. |

## Explicit customer-discovery boundaries

The sources above do **not** establish a prospect’s ERP, distributor model, bank accounts, mobile-money contracts, source-system APIs, data protection obligations, or approval workflow. Each must be confirmed with the anchor distributor before solution design, data transfer, or a live reconciliation run.

## References

1. [Bank of Uganda, *Strengthening Uganda’s Financial Infrastructure*](https://bou.or.ug/financial_infrastructure_innovation)
2. [GSMA, *State of the Industry Report on Mobile Money 2026*](https://www.gsma.com/sotir/)
