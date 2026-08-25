# Bank Pilot Resilience, Key Custody and Immutable-Audit Evidence Template

## Key custody

| Control | Required evidence |
|---|---|
| Tenant encryption root | Bank KMS/HSM or dedicated local master-key design; no JWT-derived wrapping. |
| Access control | Named key administrators, least privilege and access logs. |
| Rotation / recovery | Rotation frequency, dual control/escrow where required, recovery drill and evidence. |
| Secrets | Bank-approved secret store, deployment injection and revocation process. |

## Immutable audit evidence

| Control | Required evidence |
|---|---|
| Storage mode | Object-lock/WORM or database role that denies the application `UPDATE` and `DELETE` on audit evidence. |
| Configuration | Applied policy/role/grant, retention period and legal-hold process. |
| Negative test | Evidence that the application identity cannot alter or delete retained audit records. |
| Export | Tested export of a bounded audit period, integrity verification and authorised recipient process. |

## Resilience and operations

| Control | Required evidence |
|---|---|
| RTO / RPO | Bank-approved values for the selected pilot workflow. |
| Backup / restore | Backup target, encryption, restore drill and control-total verification. |
| Monitoring | Queue, source ingestion, reconciliation lag, exception ageing, audit-write and security-alert dashboards. |
| Incident response | Severity model, contacts, notification timing, decision log and post-incident review. |
| Support | Hours, escalation route, on-call contacts and change-management procedure. |

> A configuration variable such as `AUDIT_IMMUTABILITY_MODE=worm_s3` is not evidence of immutable storage. The environment must prove the property with its configured account, grants or object-lock policy.
