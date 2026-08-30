# Financial Services Controlled Demo — Activation Runbook

**Audience:** Manus, or whoever prepares and films the Financial Services demo.
**Script:** `scripts/verify-finserv-demo.ts`

---

## 1. What this replaces

Financial Services demo activation shipped twice with a green test suite and a
clean typecheck, and failed both times in production:

| Defect | Symptom |
|---|---|
| `upload_batches.fileHash` overflowed `varchar(64)` | 8 of 9 batches rejected; activation died on the first one |
| The match loop indexed `CORE_BANKING` as a settlement *source* | `Error: Missing source batch for CORE_BANKING`; `AGENT_BANKING` silently absent |

Neither was visible to the tests, because those exercise `buildFinServDemoPlan`
— a pure function over counts — and **nothing ran the seeder end to end**.

This script closes that gap. It calls the same seeder
`demo.activate({ segment: "finserv" })` invokes, then asserts on what actually
landed in the database. A green run means the demo is genuinely activatable, not
that a unit test agreed with itself.

---

## 2. Running it

```bash
pnpm demo:finserv:verify
```

Checks the current state and writes nothing. Use this before filming to confirm
the dataset is intact.

```bash
pnpm demo:finserv:activate --org 120001
```

Activates, then verifies. `--org` defaults to `30002`; pass the tenant you
actually want (see §4).

Exit code is `0` on pass, `1` on any failed check, so a shell or CI job can gate
on it.

### Guards

- **Verification is the default.** Writing requires `--activate`.
- **The target must be flagged `isDemo`.** A real tenant cannot be seeded by this
  script — it refuses before touching anything.
- Every other tenant's row count is printed before and after, so an unintended
  reach shows up in the output rather than having to be looked for.

---

## 3. What each step proves — and the screen to film beside it

The script's ten steps follow the same order an operator walks the product, so
the terminal output and the screen recording can run in parallel.

| # | Script step | Product screen | What the shot shows |
|---|---|---|---|
| 1 | Confirm demo tenant | — | Safety gate; not filmed |
| 2 | Activate | Demo Dashboard → Financial Services → **Activate** | The button that does this in the product |
| 3 | Source ingestion | **Upload Data** / **Multi-Channel** | 8 settlement feeds, each bound to its rail |
| 4 | Reconciliation | **Reconciliation** → the control run | 320 items, 304 matched, 95.00% |
| 5 | Exceptions | **Exceptions** | 16 cases across 4 statuses and 4 severities |
| 6 | Investigation | **Exceptions → open a case** | Description, recommended action, AI analysis on all 16 |
| 7 | Approval | **Review Queue** | 3 in review and assigned, 2 resolved with a named resolver |
| 8 | Multi-channel | **Multi-Channel** | All 8 rails carrying legs, per-rail match rates |
| 9 | Exception intelligence | **Super Agent → Memory** | Closed cases fed back as evidence |
| 10 | Tenant isolation | **All Organisations** | Only the target tenant moved |

### Reference output

A passing run ends:

```
RESULT: PASS — the controlled demo is activatable and complete.
```

with 15 checks reported. Anything else is a real failure — the script does not
report success on a partial dataset.

---

## 4. Choosing the tenant — read this before activating

**`demo.activate` seeds the CALLER'S OWN organisation.** A super admin sits in
*Infinity AI Africa Limited* (org `30002`), which is the operator's real
organisation and is correctly **not** flagged `isDemo`. Clicking Activate as
super admin therefore puts fabricated exceptions into a non-demo tenant, and the
SLA monitor will page the owner about them once they age past 24 hours.

That is exactly what happened during this verification, and it was cleaned up.

**For filming, activate against a demo tenant instead:**

| Org | Name | Suitability |
|---|---|---|
| `120001` | ReconcileAI Guest Demo | ✅ empty, `isDemo`, financial services — the default choice |
| `1` | Globus Bank Nigeria (Demo) | ⚠️ already holds a separate 79k-transaction dataset |
| `30002` | Infinity AI Africa Limited | ❌ the operator's real org; the script refuses it |

---

## 5. Things that will bite you on the day

- **Activation takes ~200 seconds.** Do it before the camera rolls, then use
  `pnpm demo:finserv:verify` on camera — it returns in seconds and produces the
  same evidence.
- **Re-activation is safe.** The seeder wipes its own prior data for that
  user and tenant first, so a second run replaces rather than doubling.
- **`DATABASE_URL` points at the shared database.** There is no separate demo
  database. The `isDemo` guard is what keeps this safe — do not remove it.
- **The script proves data, not pixels.** It verifies every view's backing query
  returns a coherent dataset. It cannot confirm a page rendered; that is what the
  screen recording is for.

---

## 6. Recording the walkthrough

The script is written to be filmed: numbered steps, one line per check, an
explicit `PASS` with the reading beside the expectation.

Suggested capture:

1. `pnpm demo:finserv:activate --org 120001` — run off camera, ~200s.
2. Start recording. `pnpm demo:finserv:verify --org 120001` — 15 checks scroll
   past in seconds, ending in `RESULT: PASS`.
3. Cut to the product and walk the screens in the §3 order. Each screen now has
   the numbers the terminal just asserted, so the two halves corroborate rather
   than merely coexist.

That order matters for the claim being made: the terminal establishes the data is
real and complete, and the UI shows an operator working it. Filming only the UI
shows a dataset; filming only the terminal shows a test.
