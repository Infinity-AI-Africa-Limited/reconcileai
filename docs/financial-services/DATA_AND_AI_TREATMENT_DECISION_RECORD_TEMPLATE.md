# Bank Pilot Data and AI Treatment Decision Record

**Purpose:** Document the approved handling of data and AI for one named, read-only pilot workflow.

| Decision area | Required evidence / decision |
|---|---|
| Workflow and data classification | Exact reconciliation workflow; data categories; customer/employee/payment data; sensitivity classification. |
| Source and route | Named read-only source route, network path, allowed destinations and egress enforcement. |
| Pilot data | Synthetic, masked historical, or controlled live parallel data; approval for each. |
| AI mode | **Off**, private on-prem/VPC inference, or approved external processor. No default is assumed. |
| AI data minimisation | Fields excluded, redaction/tokenisation rules, prompt budget, retrieval scope and retention. |
| Processor assessment | If external, DPA, subprocessor/transfer assessment, retention/deletion terms and bank approval. |
| Retention and deletion | Minimum necessary duration, backup handling, legal hold and deletion verification. |
| Incident route | Security/DPO notification points and timeframe. |

> The per-tenant AI-off control is a technical guardrail. It does **not** replace the bank’s data-flow, privacy, legal or model-use approval.

## Approval signatures

| Role | Name | Approval date | Conditions / expiry |
|---|---|---|---|
| Bank DPO / Legal |  |  |  |
| Bank InfoSec |  |  |  |
| Bank Risk / Operations |  |  |  |
| ReconcileAI security owner |  |  |  |
| ReconcileAI product owner |  |  |  |
