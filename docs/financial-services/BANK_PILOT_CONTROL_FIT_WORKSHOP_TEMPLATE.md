# Bank Pilot Control-Fit Workshop Template

**Use:** First 90-minute workshop with a prospective bank.
**Output:** A bank-owned, read-only pilot hypothesis—not a deployment approval.

## 1. Attendance and decision authority

| Function | Named attendee | Decision / evidence owner | Confirmed |
|---|---|---|---|
| Executive sponsor |  | Pilot continuation and commercial owner |  |
| Technology / architecture |  | Hosting, network, interface and service account |  |
| Information security |  | Security review, egress, secrets and vulnerability acceptance |  |
| Operations / Payments |  | Process owner and exception operating model |  |
| Finance Control |  | Daily close, control totals and accounting evidence |  |
| Risk / Internal Audit |  | Control acceptance and evidence requirements |  |
| DPO / Legal |  | Data classification, lawful basis, DPA and retention |  |
| Shariah governance (if applicable) |  | NIFI control boundary; human decision authority |  |

## 2. One bounded workflow

| Field | Bank decision / evidence |
|---|---|
| Reconciliation decision | What exact question must be answered by a defined daily cut-off? |
| Business impact | What happens if this decision is late or wrong? |
| Accountable owner | Who owns the decision and exception ageing? |
| Daily cut-off | Time zone, cut-off time and handoff/escalation point. |
| In scope | Channels, products, entities and dates. |
| Out of scope | Posting, payment initiation, account changes, customer communication and other prohibited actions. |
| Human approval point | Who approves a proposed resolution and where is it recorded? |

## 3. Approved evidence sources

| Source | System owner | Route | Fields / control totals | Read-only service account | Approval status |
|---|---|---|---|---|---|
| Source A |  | API / SFTP / signed file |  |  |  |
| Source B |  | API / SFTP / signed file |  |  |  |
| Ledger/control source |  | API / signed file |  |  |  |

## 4. Pilot data and AI decision

| Decision | Options | Chosen / approver |
|---|---|---|
| Data type | Synthetic / masked historical / controlled live parallel data |  |
| Residency | Bank VPC / on-prem / other approved route |  |
| AI mode | Off / private local or VPC inference / approved processor |  |
| Retention | Minimum necessary period and deletion process |  |
| Data transfer | No external transfer unless specifically approved |  |

## 5. Baseline and success scorecard

| Measure | Current baseline | Target | Data owner | Measurement method |
|---|---:|---:|---|---|
| Time to identify a break |  |  |  |  |
| Time to resolve / prepare resolution |  |  |  |  |
| Daily control-total completion by cut-off |  |  |  |  |
| Aged unresolved exceptions |  |  |  |  |
| Evidence completeness for reviewed exceptions |  |  |  |  |

## 6. Pilot release decision

The pilot remains **read-only and parallel**. It may start only after the parties evidence the agreed source routes, data treatment, tenant/identity, environment, durable processing, recovery path, support escalation and legal/privacy conditions. A signed go/no-go is required before any approved data route is enabled.
