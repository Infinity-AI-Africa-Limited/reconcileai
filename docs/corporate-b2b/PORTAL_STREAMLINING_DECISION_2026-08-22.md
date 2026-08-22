# Corporate B2B Pilot Portal — Streamlining Decision

**Effective scope:** First controlled FMCG/distributor reconciliation pilot  
**Operating boundary:** Read-only reconciliation; no payment initiation, account access, ERP posting, customer messaging, credit-note action, or unapproved external AI assistance.

## Decision

The Corporate B2B portal is a **pilot operating workspace**, not a general-purpose product catalogue. Its navigation and direct-route guard now offer only the screens needed to prepare authorised evidence, reconcile distributor receipts, govern exceptions, preserve proof, and administer the controlled pilot.

| Retained surface | Why it remains available in the pilot |
|---|---|
| Dashboard | Provides the minimum daily overview for a finance operator. |
| Distributor Registry | Supports approved distributor identity, roster status and master-data governance. |
| Pilot Controls | Records B0–B8 evidence, authorised source contracts, no-write attestation, AI boundary, recovery evidence and contractual references. |
| Upload Data | Supports the initial approved manual-evidence route. |
| Reconciliation | Runs deterministic matching against the defined invoice and receipt evidence. |
| Reports | Produces an operational and compliance record for the customer team. |
| Payment Exceptions | Shows unresolved allocation, receipt and timing breaks. |
| Review Queue | Keeps human review and approval explicit. |
| Audit Trail | Preserves the evidence trail for decisions made during the pilot. |
| Data Protection | Supports the privacy and data-processing controls required in Uganda and Nigeria. |
| Team Access | Lets the customer administer authorised pilot users. |

| Suppressed surface | Reason it is unavailable for the first controlled pilot |
|---|---|
| Super Agent and Exception Intelligence | Corporate B2B AI assistance is disabled by default. A private approved AI boundary must be recorded before it can be considered. |
| Schedules, Monitor and generic ingestion connectors | The pilot begins with approved manual evidence. Automated collection requires B2 source-route and B7 recovery evidence. |
| Multi-Channel, raw Orders & Payments and Age Tracker | These are broader platform tools, not required to prove the bounded distributor-payment reconciliation workflow. |
| Module Configuration, Email Settings, Sample Data and Integrations | These are configuration, demonstration or expansion tools outside the pilot’s operating boundary. |
| API Ingestion, SFTP Config, Bucket Drops and Email Forwarding | Each creates a broader ingestion route and remains unavailable until the customer authorises and tests that specific route. |
| Anomaly Detection | It is not required for the first reconciliation control case and would broaden the pilot without improving the core acceptance evidence. |

## Guarding model

The reduction is not cosmetic. The shared navigation metadata removes suppressed paths from the Corporate B2B sidebar, and the same metadata is consumed by `canReachPath` to refuse direct URL access for a Corporate B2B viewer. Server-side feature and procedure controls remain the authoritative data boundary.

## Re-expansion rule

A suppressed feature is not permanently deleted. It may be proposed for a later Corporate B2B release only when its relevant Pilot Controls gate is evidenced, the customer approves its operational use, and the capability is reviewed through the normal dual-repository production workflow.
