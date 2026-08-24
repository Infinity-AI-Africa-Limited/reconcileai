# Storage-Link and Retention Decision Record

**Problem:** Current presigned object URLs are valid for six days. That is unsuitable as the default delivery mechanism for bank artefacts, but reducing the TTL without a replacement would break existing emailed report links.

## Decision required

For bank deployments, confidential reports and audit exports must use a **token-gated application download route** that rechecks authentication, tenant membership, authorisation, retention state and export purpose at request time. Direct presigned object URLs may be used only for explicitly approved short-lived service-to-service transfers.

## Proposed migration sequence

| Phase | Change | Safety condition |
|---|---|---|
| 1. Inventory | Identify every presigned URL path, recipient type and current retention/link expectation. | No link lifetime is shortened during discovery. |
| 2. Proxy route | Implement a tenant-scoped authenticated download route with audit logging and purpose-bound export tokens. | No raw bank object key is revealed to an unauthorised caller. |
| 3. Short TTL | Restrict direct presigned URLs to minutes, with explicit non-bank compatibility migration. | Existing report recipients are migrated before the prior path is removed. |
| 4. Retention | Apply bank-approved retention/deletion schedules to object metadata, backups and audit evidence. | Legal hold and evidence preservation override routine deletion. |
| 5. Verify | Test authorised download, rejected cross-tenant request, expired token, revoked user and audit export. | Results are retained in the pilot evidence pack. |

## Bank decision inputs

- Who may export which classes of report or evidence?
- Which recipients require a recipient-specific secure link versus an in-portal download?
- What link lifetime, re-authentication and watermarking rules apply?
- What retention, legal-hold and deletion evidence does the bank require?

## Boundary

This decision record does not change the existing six-day setting. It makes clear that the setting is **not acceptable by default for bank artefacts** and specifies the safe migration required before live bank data is processed.
