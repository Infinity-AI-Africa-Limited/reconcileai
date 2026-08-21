# YC Application Response Pack — ReconcileAI

**Applicant:** Richard Anwanakak  
**Company:** ReconcileAI (operated by Infinity AI Africa Limited)  
**Target batch:** Fall 2026  
**Status:** Copy-ready draft, subject to the final verification checklist below.

> **Application principle.** YC explicitly asks applicants to be clear, concise, specific, and matter-of-fact—not promotional. This pack follows that approach. It cannot guarantee an interview; no application can. It is designed to make ReconcileAI’s founder quality, customer insight, working product, and early commercial evidence legible quickly. [1]

## Submission controls

| Claim category | Use in the application | Do not say |
| --- | --- | --- |
| WoodCore | “Signed LOI and completed POC on WoodCore core-banking data.” | “Customer,” “production deployment,” or “revenue.” |
| Other pipeline | “Active conversations with Taj Bank, LAPO MFB, and Salad Africa; two MFB POC discussions, one NDA.” | “Signed pilot/SOW” unless separately signed. |
| Product | “Working product” with the stated workflows. | “Bank-ready production system” or “autonomous resolution engine.” |
| AI | “AI-assisted investigation; human approval for every resolution.” | “AI automatically resolves financial exceptions.” |
| Capital | “Raising a US$500k pre-seed round.” | “Raised US$500k,” unless it has actually closed. |

## Founders

### Who writes code, or does other technical work on the product? Was any of it done by a non-founder? Please explain.

I am the sole founder. I define the product architecture, workflows, data requirements, customer use cases, acceptance criteria, and security/deployment requirements from my payments and bank-operations experience. I build and iterate with Claude Code and Manus as AI coding tools. No human contractor, employee, or non-founder has written core production code. Samuel Obinna reviews the local model and provides technical guidance in some client discussions, but has not written product code. I am actively looking for an exceptional technical cofounder to deepen ReconcileAI’s AI, deployment, and engineering capability.

### Are you looking for a cofounder?

Yes. I am looking for an exceptional technical cofounder who wants to build AI-native financial infrastructure for emerging markets. I bring payments, product, and bank-operating-domain experience; I want a partner who can compound the intelligence, deployment, and engineering advantage of ReconcileAI.

### Founder video — one-minute bullet guide

YC asks for a one-minute video with founders talking, without a demo or promotional montage. Use these bullets naturally rather than reading a script. [2]

1. Introduce yourself: Richard Anwanakak, founder of Infinity AI Africa and ReconcileAI; eight years in payments/product at Interswitch.
2. State the problem: African institutions reconcile core-banking, instant-payment, card, POS, mobile-money, settlement, and ledger records in spreadsheets; when a break occurs, it can take days to investigate and is hard to audit.
3. State the product: ReconcileAI matches the routine records, routes difficult items to a governed exception workflow, and uses AI to help investigators while humans approve every resolution.
4. State real progress: working product; 12 discovery interviews; signed WoodCore LOI and completed POC; active conversations with banks, MFBs, and fintechs.
5. State the ask: I am seeking a technical cofounder and want to turn the strongest design-partner conversations into the first paid deployment.

**Recording instruction:** Speak directly to camera, alone, for 55–60 seconds. Do not use slides, product footage, music, or a teleprompter. Keep it conversational and factual.

## Company

### Company name

**ReconcileAI**

### Describe what your company does in 50 characters or less.

**AI reconciliation software for African payments**

This is 47 characters including spaces.

### Company URL, if any

**https://www.reconcileaiafrica.com**

### Product link, if any

**https://www.reconcileaiafrica.com/dashboard**

### What is your company going to make? Please describe your product and what it does or will do.

ReconcileAI is software for African banks and fintechs that matches payment, settlement, and ledger records; sends unresolved breaks through a human review workflow; and keeps audit evidence for every decision. It ingests data from approved sources, uses deterministic rules for routine matching, uses AI to help investigate ambiguous exceptions, and leaves approval with the institution’s operators. We sell a control workflow around reconciliation, not an autonomous payment or ledger-posting system.

### Where do you live now, and where would the company be based after YC?

I live in Lagos, Nigeria. ReconcileAI would remain operationally based in Lagos after YC, where our first customers and payment-domain access are concentrated. I would attend the in-person San Francisco batch. If accepted, I intend to form a US holding company for the existing Nigerian entity to support global investment and shareholder participation.

### Explain your decision regarding location.

Our initial customers are Nigerian banks, MFBs, fintechs, and payment businesses. Being in Lagos gives me direct access to the people who operate payment and reconciliation processes, as well as the local integrations and regulatory context that shape the product. The operating insight and first paid deployments should be built where the problem is most visible. A US parent would make global fundraising and hiring easier without moving the customer-development centre away from Lagos.

## Progress

### How far along are you?

We have a working product with multi-channel data onboarding, deterministic matching, settlement and account-level reconciliation, an exception queue with review, ageing and escalation, transaction drill-down, audit logs, reporting, role-aware operational views, and a human-in-the-loop AI investigation layer.

Commercially, we have completed 12 structured discovery interviews across banks, MFBs, and payment processors; recorded pre-build willingness-to-pay signals; signed an LOI with WoodCore, a core-banking provider; and completed a POC on WoodCore core-banking data. The POC completed seven reconciliation runs and WoodCore has provided test-tenant access for pilot work. We are pre-revenue and are converting the strongest institutional design-partner discussions into a first paid deployment.

### How long have each of you been working on this? How much of that has been full-time?

I began ReconcileAI customer discovery and product work in February 2026. I currently spend approximately 28 hours per week on it while employed full-time. I will leave my current employment and work full-time on ReconcileAI if accepted into YC.

### What tech stack are you using, or planning to use, to build this product? Include all models and AI coding tools you use.

The application is TypeScript end to end: React 19 on the frontend; Node.js 22, Express, and tRPC on the backend; Drizzle ORM with a MySQL-compatible TiDB database; and Railway/Cloudflare for the hosted environment. For regulated institutions, we are building a private/on-premise deployment profile with Docker, local Ollama for CPU-only environments, and a private vLLM option for GPU-capable institutions. The product uses deterministic reconciliation rules alongside an LLM-assisted investigation layer; humans approve every outcome. I use Claude Code and Manus as AI coding tools.

### Are people using your product?

Not as paid production users yet. We have active proof-of-concept and design-partner engagement: a signed LOI and completed POC with WoodCore, active conversations with Taj Bank, LAPO MFB, and Salad Africa, and two MFB POC discussions, one under NDA. We also have an operating SHOPLINE reconciliation connector in developer-store scope. Our immediate goal is to turn the strongest validated engagement into a paid, controlled institutional deployment.

### Do you have revenue?

No. We are pre-revenue.

### If you previously applied with the same idea, what changed? If you applied with a different idea, why did you pivot and what did you learn from the earlier idea?

**If this is your first YC application, enter:** `This is my first YC application.`

**If you have applied before, replace with the accurate prior-batch details.**

### If you have already participated in or committed to participate in an incubator, accelerator, or pre-accelerator programme, please tell us about it.

I attended the Founders Institute Foundation programme, Lagos chapter, in 2025. It helped me move from broad AI ideas toward a sharper company-creation process. ReconcileAI was developed after that programme through direct financial-institution discovery and has not received capital from Founders Institute.

## Idea

### Why did you pick this idea to work on? Do you have domain expertise in this area? How do you know people need what you are making?

I spent eight years at Interswitch building payment and mobile-banking products across African financial institutions. I was product owner and lead for more than 40 mobile banking applications deployed across more than 30 institutions, including products for Zenith Bank, FirstBank, Providus Bank, Access Bank Ghana, First Atlantic Bank Ghana, and First Capital Bank Group. I also led the mobile workstream for a compressed-timeline Android contactless-payment launch involving Interswitch, Mastercard, Mastercard Global, and a Nigerian bank.

That experience taught me that financial infrastructure fails at the seams: data, controls, integrations, and accountable operating teams do not line up. I considered broader AI ideas first, but a conversation with a LAPO MFB executive and subsequent discovery interviews made the problem clearer. Reconciliation was recurring, operationally painful, tied to real financial exposure, and had an identifiable buyer.

We have now completed 12 structured discovery interviews across banks, MFBs, and payment processors. Multiple institutions confirmed willingness to pay before product requirements were written. One Interswitch operations lead cited a ₦5–10 million monthly budget range for reconciliation tooling; a fintech operations lead cited ₦2–3 million monthly willingness to pay. These are discovery signals—not revenue. WoodCore then signed an LOI and completed a POC with us, which confirmed that the product can be evaluated against real core-banking data.

### Who are your competitors? What do you understand about your business that they do not?

Our immediate competitor is the existing operating model: Excel, downloaded portal reports, internal scripts, manual matching, and experienced finance staff holding reconciliation together.

At the enterprise end, buyers can also compare us with BlackLine, AutoRek, and SmartStream. Those companies validate that reconciliation and financial control are important categories. Our initial wedge is narrower: African financial institutions with fragmented payment rails, local source formats, emerging-market integration constraints, and a need to begin with a bank-controlled pilot.

What we understand is that the hard part is not only matching transactions. It is creating a governed sequence for incomplete data: what matched, what did not, who owns the exception, what evidence supports the resolution, and how the institution can defend that outcome to management and auditors. We pair deterministic matching with human-approved AI assistance and an evidence trail, then expand across additional rails and entities once we earn trust.

### How do or will you make money? How much could you make?

We will sell annual B2B software subscriptions to banks, MFBs, and fintechs. The first engagement will usually be a paid POC or implementation that scopes the institution’s data sources and controls; successful deployments convert to annual contracts. Regulated institutions can deploy on-premise or in a private managed environment, while corporate B2B customers can use a SaaS deployment.

We are pre-revenue, so pricing is still being validated through design-partner work. Our current planning anchor is approximately US$30,000 per annual institutional contract. At 100 such customers, that is US$3 million in ARR; at 1,000, US$30 million in ARR. Those are illustrative milestones, not current bookings or a forecast.

### If you had any other ideas you considered applying with, please list them.

I considered two ideas before ReconcileAI. **Smart Bank AI** was an AI layer between core-banking systems and mobile apps. It was ambitious, but it needed too much integration work before proving a narrow customer pain. **Clarity AI** was a natural-language interface to organisational data, motivated by waiting more than six months for a dashboard.

I chose ReconcileAI because customers pulled me toward it. Reconciliation is immediate, frequent, tied to real financial exposure, and has a clear buyer.

## Equity

### Have you formed ANY legal entity yet?

Yes. Infinity AI Africa Limited is incorporated in Nigeria. I currently own 100% of the company. I intend to establish a US holding company if accepted into YC; that parent would hold the Nigerian entity. I have a founder-agreement framework that contemplates future equity for a technical cofounder, other stakeholders, and investors, but no such shares have been issued today.

### Have you taken any investment yet?

No. We have not taken external equity, SAFE, grant, or debt capital.

### Are you currently fundraising?

Yes. We are raising a US$500,000 pre-seed round to convert design-partner traction into paid deployments, strengthen the founding technical team, complete integration and security work for the first production customer, and build a repeatable financial-services go-to-market motion.

## Curious

### What convinced you to apply to Y Combinator? Did someone encourage you to apply? Have you been to any YC events?

YC is the right fit because ReconcileAI needs speed and focus more than another strategy process. We have a working product, direct customer pull, and a narrow first market, but we need to convert those into the first paid deployment, build a stronger technical founding team, and establish a repeatable sales motion. YC’s founder community, customer and talent network, and bias toward building are unusually relevant to that next step.

No individual specifically encouraged me to apply. I have followed YC online and consumed its founder and Startup School content. **Replace the final sentence if you have attended a YC event or received a specific recommendation.**

### How did you hear about Y Combinator?

I first learned about YC online and have followed its founder content, Startup School material, and portfolio companies for several years.

## Optional founder-profile material

### “What have you done that is exceptional?”

Over eight years at Interswitch, I led product work on more than 40 mobile-banking applications across 30+ African financial institutions. I also led the mobile workstream for an Android contactless-payment launch that required Interswitch, Mastercard, Mastercard Global, a Nigerian bank, and mobile-product teams to align around one live customer experience under a compressed COVID-era timeline.

Separately, I recognised that a custom-build mobile product was nearing the ceiling of its addressable market. I designed a white-label version that used the same core platform but opened the product to smaller institutions that could not afford custom builds. That segment became the division’s primary growth engine.

### “What is something weird or niche you were obsessed with?”

Boxing. I started in 2021 and became interested in how complex sequences are built from disciplined repetition. I began able to execute only two-punch combinations; through training, coaching, and studying technique, I progressed to longer sequences. I think about boxing as a systems problem: small errors compound, timing matters, and apparent complexity becomes manageable once the underlying sequence is visible. That informs how I think about reconciliation—break a complex operating problem into observable states, learn from failures, and make the next correct action easier for the human in the loop.

**Before submission, add only your true training frequency or hours per week if asked.**

## Product-demo submission guidance

If you upload a demo, use a controlled demonstration tenant. State aloud that the data is synthetic, approved, or masked. Show, in this order: data ingestion; a completed reconciliation; one unresolved exception with its owner and ageing; the AI-assisted investigation; human approval; and the audit record. Do not use invented customer metrics or faux screenshots.

## Final verification checklist

| Item | Required action before clicking Submit |
| --- | --- |
| Company incorporation | Insert the correct month of 2025 if the form asks. |
| Prior YC applications | Confirm whether this is your first application and replace the conditional answer if not. |
| Founder achievements | Verify the contactless-launch bank, dates, delivery timeline, app count, institution count, and award wording. |
| Funding | Reconfirm the US$500,000 target, current round instrument, and whether fundraising status has changed. |
| POC labels | Reconfirm no claims imply that a POC, LOI, or pipeline discussion is a paid customer or production deployment. |
| Video | Record a new 55–60 second YC-specific founder video; do not reuse a product-demo recording. |
| Attendance | Confirm that you can attend the Fall 2026 in-person San Francisco batch. |

## References

[1] [Y Combinator, “How to Apply to Y Combinator”](https://www.ycombinator.com/howtoapply)  
[2] [Y Combinator, “The Application Video”](https://www.ycombinator.com/video)  
[3] [Y Combinator, “Frequently Asked Questions”](https://www.ycombinator.com/faq)  
[4] [Y Combinator, “Apply to YC”](https://www.ycombinator.com/apply)  
[5] [Richard Anwanakak, “Embed Application — Recommended Responses”](https://docs.google.com/document/d/1jZZy_s5x2CX4JUkOZso76Z3cqbMhjcBkiwgC31sN5rE/edit)
