# Investor Video Package — export to Manus

Everything needed to produce a ≤3-minute investor video covering all three
ReconcileAI verticals. Hand this whole directory over.

| File | What it is |
|---|---|
| `SCRIPT.md` | The video script: narration, timings, shot list, and what must be legible in each frame |
| `capture-shots.ts` | Regenerates all 9 frames as PNGs from the live product |
| `shots/` | Captured frames (created by the script above; not committed) |
| `../FINANCIAL_SERVICES_DEMO_RUNBOOK.md` | The longer per-screen walkthrough the FS section is cut down from |

---

## Do this in order

### 1. Confirm the data is filmable

```bash
pnpm demo:verify
```

Exit 0 means every vertical will look operated on camera. Exit 1 names the thin
ones. **Do not skip this and go straight to capture** — a screen that is correct
but empty is the single most damaging thing this video could contain, and it
looks identical to a working screen until someone reads the numbers.

### 2. Mint three read-only reviewer links

Super admin → POC Hub → *Reviewer access links*. One `tenant`-scoped link per
vertical (FS, Corporate B2B, Retail). These are read-only by construction, so a
capture run cannot alter the data it is photographing.

Revoke all three when filming is done. They are long-lived by default.

### 3. Capture

```bash
pnpm add -D playwright && npx playwright install chromium
npx tsx docs/demo/investor-video/capture-shots.ts
```

Then check each PNG against the **"What must be legible"** column in `SCRIPT.md`.
A frame where the key figure is cropped, blurred or zero is a frame to retake,
not to caption around.

### 4. Record narration and cut

`SCRIPT.md` is timed at 2:55 for ~150 wpm. If the read comes in long, cut from
the Corporate B2B section — it is the segment whose argument survives compression
best, because the Distributor Registry shot carries the point on its own.

---

## Retail before you film — read this

`pnpm demo:verify` currently reports **Retail Commerce NOT READY**:

| Measure | Actual | Wanted |
|---|---|---|
| transactions | 6 | 200 |
| reconciliation runs | 0 | 1 |
| exception cases | 1 | 5 |
| match rate | 66.7% | — meaningless at this row count |

The tenant is a **live SHOPLINE dev store**, and the six transactions are real
orders placed against it. So the connection is genuine and the OAuth, webhook and
settlement-import path all work — there simply is not enough volume for a
dashboard to read as an operating business.

**Two honest options. Pick one; do not paper over it.**

**A — Film the connection, not the volume (what `SCRIPT.md` currently does).**
Lead the retail section on the integration: an installed app on a 600k-merchant
platform, a live store, orders arriving over the API, and the retail exception
taxonomy. Keep the match rate and settlement totals off screen. This is truthful
and needs no further work.

**B — Seed the retail tenant first**, then rewrite the retail section to lead on
numbers the way FS and B2B do. Stronger on camera, but it is new work and the
seeder does not exist yet.

`SCRIPT.md` assumes **A**. If you seed retail, update the retail section and its
⚠️ note, and re-run `pnpm demo:verify` to confirm before recapturing.

---

## The line this package will not cross

Every number narrated is computed live by the engine from the tenant on screen.
None is typed into a graphic, and none is rounded up for the edit.

If the edit needs a figure that is not in a frame, the answer is to capture a
frame that shows it — not to caption it. `SCRIPT.md` closes with the specific
claims it deliberately avoids and why; check any addition against that table
before it goes into the cut.
