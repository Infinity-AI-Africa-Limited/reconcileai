# ERP Journal-Entry Export Formats (Gap-Closure Plan WS-7)

> Export-first, native-later. A completed reconciliation job's **resolved
> exceptions** become balanced journal entries, rendered in each ERP's native
> import format. Engine: `server/erpExport.ts` (formatters unit-tested with
> exact column layouts). Surfaces: `erpExport.generate` (tRPC, dashboard) and
> `GET /api/v1/reconciliation/runs/{runId}/erp-export?target=…` (Developer API).

## Target ERPs (plan hypothesis — confirm with first two customers)

| Target | Segment | Import path |
|---|---|---|
| `sap_b1` — SAP Business One | banks / MFBs | Data Transfer Workbench (DTW): JournalEntries (OJDT) + JournalEntryLines (JDT1) CSV pair |
| `sage_300` — Sage 300 | banks / MFBs | G/L Journal Entry import (single CSV, signed amounts) |
| `quickbooks` — QuickBooks Online | SME fintechs / FMCG | Journal Entry CSV import (Debits/Credits columns) |

## What gets exported

One **balanced two-line entry per resolved exception**: debit to the
category-mapped adjustment account, credit to the reconciliation control
account. Dismissed exceptions export nothing (dismissal = no book impact).
Zero-amount exceptions are skipped. Entry dates = the exception's resolution
date; references = the transaction reference; memos carry category, job, and
the resolution note (audit-traceable end to end).

### Account mapping (placeholders — remap before first import)

| Exception category | Debit account (placeholder) |
|---|---|
| `amount_mismatch` | `6910-BANK-CHARGES` |
| `fx_rate_variance`, `currency_mismatch` | `7150-FX-REVALUATION` |
| everything else | `1895-RECON-SUSPENSE` |
| **Credit (all entries)** | `1890-RECON-CONTROL` |

These codes are deliberate placeholders (`DEFAULT_GL_MAPPING`): map them to the
institution's chart of accounts inside the ERP's import mapping step, or ask us
to set an org-level override. **Do not import with placeholder codes.**

### Multi-currency

Entries carry the exception's currency (WS-6). QuickBooks reads the `Currency`
column directly (multicurrency must be enabled in QBO). SAP B1 and Sage 300
exports include the currency in the Sage `CURRENCY` column / SAP memo — amounts
are exported **in transaction currency**; for foreign-currency entries confirm
the ERP company's rate setup before posting.

## Format details

### SAP Business One — DTW pair
- `…-sapb1-JournalEntries-….csv` (OJDT): `RecordKey, ReferDate, TaxDate, Memo, Reference`
- `…-sapb1-JournalEntryLines-….csv` (JDT1): `RecordKey, LineNum, AccountCode, Debit, Credit, LineMemo, Reference1`
- `RecordKey` ties lines to their header; `LineNum` is 0-based per entry.
- Import via DTW → Financials → Journal Entries; map `AccountCode` in the wizard.

### Sage 300 — G/L Journal import
- Columns: `ENTRYNUMBER, LINENUMBER, ACCOUNTID, TRANSAMOUNT, JOURNALDATE, SOURCECODE, REFERENCE, DESCRIPTION, CURRENCY`
- Signed amounts (debit positive, credit negative); dates `YYYYMMDD`; line numbers step by 20 (Sage convention); source code `GL-JE`.
- Import via G/L Transactions → Journal Entry → File/Import; verify the batch before posting.

### QuickBooks Online — Journal Entry CSV
- Columns: `JournalNo, JournalDate, Currency, Memo, AccountName, Debits, Credits, Description`
- Dates `YYYY-MM-DD` (choose that format in the QBO import dialog); one row per line, `JournalNo` repeats across an entry's lines.
- Import via Settings → Import Data → Journal Entries; map `AccountName` to existing accounts.

## Native API push (M10–14 — after export formats validate with ≥2 customers)

The canonical `JournalEntry` model is the integration contract; native pushes
serialize it instead of CSV:
- **SAP B1**: Service Layer `JournalEntries` POST — requires **SAP PartnerEdge**
  membership (start the paperwork now; lead time is months, not weeks).
- **Sage 300**: Sage 300 Web API / SDK — requires **Sage Developer Programme**
  registration (same: start early).
- **QuickBooks Online**: public REST API (`journalentry` endpoint) — OAuth2 app
  registration only, no certification gate; likely the first native target.

*July 2026 — WS-7 deliverable. Success criteria: export formats live (done,
ahead of M10) · 2 customers using them by M12 · native SAP by M14.*
