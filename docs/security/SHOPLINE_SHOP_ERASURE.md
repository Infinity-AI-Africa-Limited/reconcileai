# SHOPLINE shop erasure (`shop/redact`)

**Status, 2026-11-04: NOT BUILT.** SHOPLINE's `shop/redact` is acknowledged,
the store is uninstalled and its subscription cancelled, but **none of the
shop's data is erased.** This is a compliance gap to close before the first
real SHOPLINE merchant installs (CLAUDE.md §19.5).

## What is true today

SHOPLINE sends `shop/redact` about 48 hours after a merchant uninstalls the app
(CLAUDE.md §2B.1). There is no separate uninstall webhook, so this request is
also how we learn about the uninstall. App Store review expects GDPR requests
to be met within 30 days (§2B.11).

`processGdprRequest` (`server/connectors/shopline/gdpr.ts`) handles it as
follows:

1. It marks the store `uninstalled` and cancels its subscription
   (`handleShoplineUninstall`). This stops its syncs.
2. It records the request in `sl_connector_gdpr_requests` with status
   **`received`**, the status of an open obligation, and a note saying the data
   has NOT been erased.
3. It logs `shopline_shop_redact_erasure_pending`, with the organisation and
   store ids only.
4. It emails the owner through `gdprDeadlines.ts`. The daily SHOPLINE batch
   repeats the email while any request stays open, and the subject says OVERDUE
   once the oldest request is more than 30 days old. The email holds counts and
   dates only.

> ⚠️ **Until 2026-11-04 these requests were recorded as `completed`**, with the
> note *"Store marked uninstalled; data scheduled for purge within retention
> window."* No purge existed. Any such row is an unmet erasure that the daily
> reminder cannot see, because it is not `received`. Measure them read-only:
>
> ```sql
> SELECT id, organizationId, slStoreId, topic, receivedAt
> FROM sl_connector_gdpr_requests
> WHERE status = 'completed'
>   AND note = 'Store marked uninstalled; data scheduled for purge within retention window.';
> ```
>
> Reopening them (status back to `received`) is a production write, so it
> needs the owner's approval. The only SHOPLINE tenants so far are demo and
> dev stores, so any rows found should hold our own test data.

## What a SHOPLINE shop leaves behind

Onboarding creates one organisation per store handle, and a reinstall reuses
it (`onboardShoplineMerchant`). So erasing a shop means erasing a tenant:

- **The organisation and its users**, including the merchant's admin, whose
  email address is personal data.
- **Connector rows**: `sl_connector_stores`, `sl_connector_tokens` (encrypted
  OAuth tokens), `sl_connector_subscriptions`, `sl_connector_gdpr_requests`,
  and `sl_connector_webhook_events`. Its `payloadJson` holds raw order payloads
  with the merchant's customers' names, emails and addresses, so it is **the
  most sensitive table here**.
- **Reconciliation data**: channels, transactions (including imported
  settlement files), matches, exceptions, jobs, reports, upload batches,
  audit logs, `agentMemory`, resolution templates and reviewer links.
- **Stored files** under `org/<organizationId>/`, plus any legacy user-keyed
  files.
- **Queued work**, such as the `shopline-realtime-sync` job for the store.

This list does not need rebuilding. `eraseTenantWorkspace`
(`server/connectors/shopify/shopRedaction.ts`) already deletes every
tenant-scoped table, including the `sl_connector_*` ones. The SHOPLINE work is
to reach that erasure safely, not to write a second one.

## Design

Reuse Shopify's guarded erasure; do not fork it.

1. **Make the erasure connector-neutral.** Move the tenant erasure core out of
   `shopRedaction.ts`:
   - the fence check;
   - the storage inventory, delete and straggler sweep;
   - the upload-settle wait;
   - the one-transaction row erasure.

   It is parameterised by:
   - how the claiming job proves it still holds its lease;
   - how the surviving receipt is written.

   Shopify's behaviour must not change. Its existing tests, including the
   real-MySQL ones, are the check.
2. **A SHOPLINE job and receipt** (one migration):
   - `sl_connector_shop_redaction_jobs` has the same lease, attempt and
     checkpoint columns as `shopify_shop_redaction_jobs`, linked to the GDPR
     request row.
   - A receipt table outside the tenant holds the request's hash, when it
     was received and met, and the manifest's counts. It holds no shop domain
     or other identifier.
   - **The receipt is the completion record.** The erasure deletes the
     tenant's `sl_connector_gdpr_requests` rows with everything else
     (`eraseTenantWorkspace` lists the table), so the request row cannot be
     marked `completed` afterwards. The row disappearing is also what takes
     the request off the deadline report.
3. **Admission when the request arrives**, in one transaction:
   1. Lock the organisation row.
   2. Refuse unless the store is provably uninstalled (see the first open
      question below).
   3. Set `organizations.deletionState = 'redacting'`. This fences the tenant:
      `putTenantObject` already refuses a fenced tenant. **No SHOPLINE path
      reads the fence yet**, so the sync cycle, webhook processing and
      settlement-file import must each be taught to refuse it. Otherwise they
      write rows into a tenant mid-erasure.
   4. Insert the job.
   5. Write a durable outbox row.

   Then enqueue on a `requireDurable` queue, like `shopify-privacy`. A sweep
   re-dispatches the outbox if the enqueue is lost.
4. **The worker**:
   1. Claim the job with a lease.
   2. Count a manifest.
   3. Wait for in-flight uploads to settle (`TENANT_UPLOAD_DEADLINE_MS` plus a
      margin from the first claim).
   4. Delete the tenant's stored files.
   5. In one transaction, under the organisation lock, after re-checking the
      fence: erase the tenant's rows, including its GDPR request rows, and
      write the receipt with the manifest's counts. Both commit, or neither
      does.

   Failures are retried with backoff, then parked for a person.
5. **The deadline report already exists.** `gdprDeadlines.ts` reports open
   requests. Extend it to report jobs that are parked or stuck.

### Tests

- Unit tests with the scripted database cover every guard: an unfenced tenant,
  a lost lease, files that appear mid-erasure, and a reinstalled store.
- A real-MySQL test erases a synthetic SHOPLINE tenant and proves that:
  - a second tenant's rows are untouched;
  - the receipt survives;
  - a re-delivered `shop/redact` is a no-op.
- Shopify's existing shop-redaction suites must pass unchanged after the
  extraction.

## Open questions before the erasure ships

1. **Reinstall inside the 48-hour window.** A reinstall reuses the
   organisation. If SHOPLINE still sends `shop/redact` after a reinstall,
   erasing on receipt would destroy a live, re-installed tenant. The same
   question already applies to today's code, which marks the store uninstalled
   and cancels its subscription on any `shop/redact`, whether or not the store
   has been reinstalled since.
   - The public docs do not say what SHOPLINE does here.
   - **Recommendation:** test it on `reconcileai-dev`. Uninstall, reinstall
     within 48 hours, and watch for a `shop/redact`.
   - Until it is known, admission should ask SHOPLINE whether the app is
     installed: a token refresh answers `STORE_NOT_INSTALL_APP` once it is not.
     Erasure must refuse if the app is still installed.
2. **The dev tenants are not exempt.** Once erasure ships, uninstalling the app
   from `reconcileai-dev` erases `SL_RECONCILEAI_DEV` about 48 hours later. The
   reviewer link (§2B.13) and `/shopline-review` both point at that tenant.
   - **Recommendation:** keep the behaviour uniform. A demo exemption is a
     flag that real data could escape erasure through.
   - Instead, adopt an operating rule: do not uninstall from `reconcileai-dev`
     while a review is pending.
3. **Customer erasure is narrower than it looks.** `customers/redact` scrubs
   only the stored webhook payloads (`scrubCustomerFromWebhookPayloads`), and
   only five top-level fields plus `customer`. Check the full payload shape for
   other personal fields, such as the addresses inside `payment_details` and
   fulfilments, while doing this work.

## If a real `shop/redact` arrives before this ships

The 30 days run from `receivedAt` on the request row, and the owner's email
gives the due date. Either ship the erasure above before then, or erase the
tenant by hand under review: a reviewed, dry-run-first script, never ad-hoc
SQL.

Until the receipt table exists, the hand-run script keeps the request row as
the record, and does so in the same transaction as the erasure:
- it erases everything else;
- it marks the row `completed`, with `recordsAffected` and a note naming what
  was erased;
- it clears the row's `shopDomain`, keeping only `subjectHash`.

Both routes are production data changes, and both need the owner's approval.
