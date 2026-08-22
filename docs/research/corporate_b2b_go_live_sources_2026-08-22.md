# Corporate B2B Payments Go-Live — Evidence Register

**Purpose.** This register supports the Corporate B2B payments go-live assessment. It distinguishes verified market and regulatory context from customer-specific facts that must be supplied during pilot discovery.

| Source | Verified observation | Safe implication for ReconcileAI |
|---|---|---|
| Bank of Uganda, *Strengthening Uganda’s Financial Infrastructure* | Bank of Uganda states that it operates, supervises, regulates and manages key national-payment and digital-financial-service infrastructure. It identifies payment systems as critical to secure, efficient business transfers and lists MTN Mobile Money Uganda and Airtel Mobile Commerce Uganda among supervised providers. Its page also describes the National Payment Systems Act and related framework. | A Uganda FMCG/distributor pilot should treat mobile-money and bank-transfer records as controlled financial evidence, obtain the customer’s authorised data feeds, and retain source, time, amount and reference provenance. ReconcileAI should not represent itself as a payment service provider or payment system operator unless separately authorised. |
| GSMA, *State of the Industry Report on Mobile Money 2026* | GSMA reports US$2.1 trillion in mobile-money transactions in 2025, 2.3 billion registered accounts, and US$155 billion in merchant payments, with merchant payments growing by almost half. | Mobile-money payment visibility is commercially material. It supports a reconciliation and exception-control wedge, but it does not validate any ReconcileAI customer metric or promise a specific payment rail integration. |
| Central Bank of Nigeria, *Payments System Supervision* | CBN describes its role as the principal regulator of the Nigerian payments system and identifies NIBSS, banks, payment service providers and switching companies as key participants. It frames payment-system objectives around availability, interruption resistance and minimum risk. | In Nigeria, ReconcileAI should remain a reconciliation-control software provider in the first launch. Any move into payment initiation, account access, collections, settlement or payment-service operation needs a separate legal and regulatory analysis. |
| NIBSS, *NIBSS Instant Payment* | NIP supports account-number-based, real-time electronic funds transfers and identifies person-to-business and business-to-business use cases. NIBSS describes Transaction Status Query as a capability offered to participating licensed institutions. | A Nigerian distributor pilot should ingest customer-authorised bank statement and payment evidence. ReconcileAI must not claim direct NIP access, name enquiry or TSQ capability unless it has an approved connection through the customer or an authorised provider. |
| Nigeria Data Protection Commission, *Nigeria Data Protection Act, 2023* | The NDPC hosts the Act and its data-controller/processor, breach-reporting and audit services. | The Nigerian rollout needs a documented controller/processor allocation, lawful-basis analysis, data-processing terms, security review, retention schedule, breach procedure and approval of any cross-border or external-model route. |

## Explicit customer-discovery boundaries

The sources above do **not** establish a prospect’s ERP, distributor model, bank accounts, mobile-money contracts, source-system APIs, data protection obligations, or approval workflow. Each must be confirmed with the anchor distributor before solution design, data transfer, or a live reconciliation run.

## References

1. [Bank of Uganda, *Strengthening Uganda’s Financial Infrastructure*](https://bou.or.ug/financial_infrastructure_innovation)
2. [GSMA, *State of the Industry Report on Mobile Money 2026*](https://www.gsma.com/sotir/)
3. [Central Bank of Nigeria, *Payments System Supervision*](https://www.cbn.gov.ng/PaymentsSystem/)
4. [NIBSS, *NIBSS Instant Payment*](https://nibss-plc.com.ng/nibss-instant-payment/)
5. [Nigeria Data Protection Commission, *Nigeria Data Protection Act, 2023*](https://ndpc.gov.ng/download/nigeria-data-protection-act-2023)
