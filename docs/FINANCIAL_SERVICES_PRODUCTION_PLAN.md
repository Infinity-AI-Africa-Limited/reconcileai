# Financial Services — Plan to Production

**Status:** active plan · **Owner:** Richard Anwanakak (Infinity AI Africa Limited)
**Engineering:** Claude Code (acting CTO) · **Created:** 2026-08-12
**Responds to:** *ReconcileAI Financial-Services Deployment Readiness Assessment*, 12 Aug 2026, assessed at `de61cec`

---

## 0. Position on the assessment

**It is accurate, and it should be accepted rather than argued with.** Every claim
that can be checked from the code was checked:

| Claim | Verified |
|---|---|
| `pnpm audit --prod` → 25 high / 36 moderate / 6 low | ✅ exact — 67 total, same split |
| `/api/monitoring/stream` leaks every tenant's job events | ✅ confirmed; `JobProgressEvent` had no tenant at all |
| Magic-link sessions issued for one year | ✅ `ONE_YEAR_MS` in `sdk.ts` |
| Presigned object URLs live six days | ✅ `PRESIGN_TTL_SECONDS = 60*60*24*6` |
| Legacy storage keys unscoped | ✅ `orgIdFromKey` returns null for them by design |
| Durable queue depends on unprovisioned Redis | ✅ `jobQueue.ts` falls back in-process |

An assessment whose checkable numbers are exact deserves to have its
process findings — BCP/DR, UAT, third-party risk — treated as equally sound.
They are not padding.

**One thing it does not cover, which is the owner's nearest need.** The
assessment answers *"can we deploy to a bank?"*. It does not answer *"what may
we truthfully say in a demo?"* — and the Taj Bank and compliance-expert meetings
come first. §1 answers that. Conflating the two is the main way this goes wrong:
a demo is a controlled presentation of a working platform, and nothing in the
assessment prevents one.

**Already closed since the assessed commit:** the P0 stream leak
(PR #78). Six cross-tenant reads, three cross-tenant writes and the demo-seeding
exposure were closed in PR #77, which `de61cec` already contains.

---

## 1. What may be said in the room — before any gate closes

The two meetings are **demonstrations**, not deployments. The distinction is
real and defensible, and it should be stated rather than skirted.

### Say this

- Live multi-tenant platform in production, healthy, with database, object
  storage and Anthropic Claude all reachable *(verified 2026-08-12)*.
- **130 catalogued exceptions across 18 Nigerian payment channels**, each with
  regulatory context, resolution procedure and AI diagnosis guidance — including
  cheque clearing, card schemes, switching and disputes.
- **A non-interest (NIFI) control catalogue**: impermissible income and
  purification, IAH/shareholder commingling, profit-distribution variance, PER/IRR
  movements, and the Murabaha, Ijara, Salam/Istisna and Wakala families.
- Tenant isolation, per-tenant envelope encryption (AES-256-GCM), HMAC-verified
  webhook ingestion with idempotency and a dead-letter queue, hash-chained audit.
- A CBN/BoU regulatory return pack and a live regulator portal.

### Do not say

- ❌ "Production-ready for your bank." It is not, and the room will contain
  people whose job is to find that out.
- ❌ "PCI/ISO compliant." No such assessment exists.
- ❌ "Certified for CBN reporting." The platform *supports* a bank's controls;
  the bank remains accountable.
- ❌ Anything implying Taj integration exists. There is no Taj connector.

### Say this about readiness — it is a stronger position than a claim

> "We have had an independent deployment-readiness assessment run against this
> codebase. It identified six P0 items for bank-grade release. One was a defect
> in our code and we closed it within a day of the report. The others are
> infrastructure, integration and governance gates that only close jointly with
> your control functions — which is exactly what we would like to scope with you."

A vendor that commissions its own adversarial review, publishes the findings and
shows the fix commit is a *better* vendor than one claiming to be finished. To a
governance and compliance audience specifically, this is the credential.

**Demo on the demo tenant, never on live client data.** Use Globus Bank
Nigeria (Demo). Do not enable Demo Mode inside any real tenant — it is now
super-admin-only for that reason.

---

## 2. The gate model

Four gates. Each closes on **objective evidence**, not on assertion. Nothing
skips.

```
G0 Demo-safe          → today (met)
G1 Pilot-safe         → read-only, segregated, non-posting
G2 Bank-production    → per-institution, with the bank's sign-off
G3 Multi-bank scale   → repeatable without bespoke work
```

### G0 — Demo-safe · **MET**

Live service healthy; demo tenant seeded; no client data present; demo apparatus
staff-gated. Nothing outstanding.

### G1 — Pilot-safe (read-only parallel reconciliation)

The assessment's recommended first deployment, and the right one.

| # | Gate | Evidence that closes it |
|---|---|---|
| G1.1 | Durable queue proven | Redis provisioned; restart / retry / duplicate-delivery / concurrent-worker behaviour demonstrated and recorded |
| G1.2 | Dependency backlog triaged | Server-reachable highs upgraded; client-bundle and build-only findings documented with reachability; risk-accepted SBOM |
| G1.3 | AI data boundary decided | Either in-VPC inference, or an approved processor with DPA + data-flow approval + per-tenant AI-off switch |
| G1.4 | Session & browser hardening | Session lifetime cut, re-auth on sensitive actions, CSRF assessed for cookie-authenticated mutations |
| G1.5 | Storage posture | Legacy keys migrated; presign TTL cut for banking artefacts; access logging on |
| G1.6 | Segregated environment | Bank VPC or on-prem with `DEPLOYMENT_MODE=on_premise` egress guard proven fail-closed |
| G1.7 | Named owners | Bank-side Technology, InfoSec, Ops, Risk, Internal Audit, DPO and (for a NIFI) Shariah governance identified by name |

### G2 — Bank-production (per institution)

| # | Gate | Evidence |
|---|---|---|
| G2.1 | Approved interface | Read-only API/file spec, least-privilege service account, HMAC/mTLS, mapping specification, replay/dedupe design, volume benchmark |
| G2.2 | Identity | Bank IdP SSO (Entra for Taj), MFA/conditional access, role matrix, JML, privileged-access logging |
| G2.3 | Independent security assurance | Penetration test, remediated dependency scan, secure-code review, KMS/secrets design |
| G2.4 | Key custody | Dedicated `TENANT_MASTER_KEY` / KMS and `CBN_SIGNING_PRIVATE_KEY`; rotation, access logging, recovery evidenced |
| G2.5 | Immutable audit | Audit evidence in WORM/append-only storage or DB-level write-deny; retention and export procedure |
| G2.6 | Resilience | Documented RTO/RPO, tested restore, DR exercise, monitoring/alerting, incident notification, support escalation |
| G2.7 | Business acceptance | Signed UAT, reconciled control totals, exception outcomes, audit-trail verification, go-live approval |

### G3 — Multi-bank scale

Onboarding is repeatable via the CBS connector registry without bespoke
engineering; horizontal scaling proven; per-tenant quotas enforced; a managed
secret store (Doppler/Vault) replaces manual copying.

---

## 3. Workstreams

Ordered by what unblocks the most. **WS-1 to WS-4 are the critical path to G1.**

### WS-1 · Durable processing *(engineering — days)*
Provision Redis on Railway. The BullMQ path activates on `REDIS_URL` with no
code change. Then *prove* it: kill a worker mid-run, restart, confirm no lost or
duplicated job. Also removes the per-process debounce caveat in the SHOPLINE
scheduler.

### WS-2 · Dependency remediation *(engineering — 1–2 weeks)*
67 findings, but they are not one problem. Triage by reachability — which is
what the assessment itself asks for:

| Class | Packages | Action |
|---|---|---|
| **Server-reachable runtime** | `axios`, `drizzle-orm`, `@trpc/server`, `express` chain (`body-parser`, `path-to-regexp`, `qs`), AWS SDK chain (`fast-xml-parser`, `@smithy/config-resolver`), `nanoid` | Upgrade. This is the real work. |
| **Client bundle** | `mermaid`, `streamdown`, `dompurify`, `react-markdown`, `recharts`, `jspdf`, `lodash` | Upgrade where clean; otherwise document — different threat model (rendered-content XSS), not server RCE |
| **Build-only** | `drizzle-kit`, `esbuild` | Not in the deployed artifact; document and move on |

Deliverable: a clean or explicitly risk-accepted SBOM. **Do not present a wall
of 67 to a bank** — present the decomposition.

### WS-3 · AI data boundary *(owner decision + engineering — 1 week)*
The live service runs `direct` LLM mode to `api.anthropic.com`. In cloud mode
the egress guard is intentionally a no-op. A bank will ask where its transaction
data goes. Three options, in order of preference for a bank pilot:

1. **In-VPC / local inference** — the `ml/` and `deploy/` on-prem pack already
   exists; strongest answer, most work.
2. **Approved external processor** — Anthropic with a DPA, data-flow approval,
   retention terms and prompt minimisation. Fastest defensible path.
3. **AI off** — a per-tenant switch. Reconciliation still works; the Super Agent
   narrative does not. Must exist regardless, as a bank control.

**Recommendation: build the per-tenant AI-off switch now** (it is small and
gates 1 and 2 both need it), then pursue option 2 for the pilot and option 1
for production.

### WS-4 · Security hardening *(engineering — 1 week)*
Session lifetime from one year to a working session with re-auth; CSRF review of
cookie-authenticated mutations; presign TTL cut; legacy storage keys migrated.

### WS-5 · Operating resilience *(process — 2–3 weeks)*
BCP/DR, tested backup/restore, RTO/RPO, monitoring and alerting, incident
response and notification, change management, vulnerability-management SLA,
support hours. Documents a bank will ask for and that do not exist today. This
is not engineering work and should not wait on engineering.

### WS-6 · Taj Bank discovery *(commercial + engineering — 4–6 weeks)*
See §4.

### WS-7 · Immutable audit + key custody *(engineering — 1 week)*
`auditChain.ts` is tamper-evident, not tamper-proof, and says so. Move audit
evidence to append-only storage or DB-level write-deny. Set dedicated
`TENANT_MASTER_KEY` and `CBN_SIGNING_PRIVATE_KEY` rather than deriving from
`JWT_SECRET` or minting ephemerally.

> **Note:** setting `TENANT_MASTER_KEY` also retires the `JWT_SECRET` derivation
> that makes the §18 leak a compound exposure. Sequence it with the rotation in
> CLAUDE.md §19.1.

---

## 4. Taj Bank path

**TAJBank is a strong fit and should not be rushed.** It holds PCI DSS and
ISO 27001/22301/20000. That raises the supplier bar — approach it as a governed
control-evidence proposal, not a SaaS signup.

Its non-interest licence is the single best fit the platform has: the NIFI
catalogue addresses impermissible income, commingling, profit-distribution
variance and product-accounting mismatches directly, and no generic
reconciliation vendor has that.

| Phase | Duration | Output |
|---|---|---|
| **P0 · Control-fit workshop** | 1 day | Joint session with Technology, InfoSec, Ops, Finance Control, Internal Audit, Risk, DPO and Shariah governance. Output: a named control domain and success scorecard. |
| **P1 · Discovery** | 2–3 weeks | Core banking interface, API contract, service account, network path, field mapping, event contract, volume profile. **Not direct production DB access.** |
| **P2 · Read-only parallel POC** | 6–8 weeks | Segregated environment, masked or historical data, bank-managed identities, auditable human approvals, **no posting, no payment initiation**. |
| **P3 · Production review** | — | G2 gates, signed UAT, formal go-live approval. |

**Shariah governance boundary — state this unprompted.** ReconcileAI surfaces
*evidence and exceptions* for human review. It does not issue Shariah opinions
and does not make financial decisions. CBN's NIFI guidelines require a
CBN-approved Shariah Advisory Committee and an internal Shariah Compliance Unit;
the platform feeds those functions, it does not substitute for them. Volunteering
this boundary will land better than being asked for it.

---

## 5. Sequencing

```
Now          Demos (G0 met) — §1 framing
Weeks 1–2    WS-1 Redis · WS-2 dependency triage · WS-3 AI-off switch
Weeks 2–4    WS-4 security hardening · WS-7 audit + keys · WS-5 BCP/DR (parallel, process)
Weeks 3–6    WS-6 Taj discovery — runs alongside, does not wait
Week 6       G1 review — pilot-safe decision
Weeks 6–14   Taj read-only parallel POC
Then         G2 per-institution production review
```

**Realistic first bank production: Q4 2026.** Anyone promising sooner has not
read the gate list.

---

## 6. Standing rules

1. **A demo is not a deployment.** Never let enthusiasm in a room turn into a
   deployment commitment.
2. **Read-only until G2.** No posting, no payment initiation, no write-back to a
   core banking system.
3. **The bank's data does not leave its approved boundary** without a decision
   recorded under WS-3.
4. **Gates close on evidence.** An artefact someone can read, not a verbal
   assurance.
5. **Findings get published, not buried.** The assessment's credibility is an
   asset; concealing the next one would destroy it.

---

*Reviewed against `de61cec` + PR #78. Update the gate table as gates close —
a stale plan asserting a closed gate is worse than no plan.*
