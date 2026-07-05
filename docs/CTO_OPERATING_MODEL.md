# CTO Operating Model — Local Deployment & Model Training Track

> Governs how Claude (acting CTO), Richard (Founder/CEO), and the Junior AI Engineer
> execute the plan in *ReconcileAI_Local_Deployment_&_Model_Training.pdf*.
> The engineering artifacts it governs: [`deploy/on-prem/`](../deploy/on-prem/README.md)
> and [`ml/`](../ml/README.md).

---

## 1. Mandate

Deliver **Option 3 — fully local, air-gapped ReconcileAI** as a sellable, repeatable
product: a Docker stack any Nigerian bank/MFB can run on a CPU box, powered by a
ReconcileAI-fine-tuned local model, with data residency enforced in code
(fail-closed egress guard).

**Definition of done for the track:**
1. All artifacts committed and dual-pushed (origin + mirror).
2. A fine-tuned model that passes the ship gates (§5).
3. One complete air-gap install kit (image tarballs + model + runbook) proven on a
   clean machine.
4. A junior-engineer-executable runbook for every step Claude cannot physically do.

---

## 2. Roles and decision rights

| Decision / action | Richard (CEO) | Claude (CTO) | Junior AI Engineer |
|---|---|---|---|
| Spend money, create accounts (RunPod/Lambda/Vast, HF) | **Decides & does** | Recommends spec + budget | May hold the account if delegated |
| Client commitments, pricing, deployment dates | **Decides** | Advises feasibility | — |
| Architecture, model choice, stack design | Informed | **Decides** | — |
| Code: write, review, harden, commit, push | Informed | **Owns** | Never commits without Claude review |
| Quality gates: ship / no-ship on the model | Informed | **Decides** (gates in §5) | Runs evals, reports numbers |
| GPU training run execution | — | Drives it if given SSH access | **Executes runbook** otherwise |
| Physical/air-gap steps, on-site bank work | Approves visit | Prepares kit + runbook | **Executes on site** |
| Deviating from a runbook | — | **Only Claude approves** | Stops and reports; never improvises |

**Three irreducibly human steps:** paying for things, creating accounts, being
physically present at a client site. Everything else defaults to Claude.

---

## 3. Delegation protocol — task packets

Every task handed to the Junior AI Engineer is a **task packet** written by Claude:

1. **Objective** — one sentence, plus the definition of done.
2. **Exact commands** — copy-pasteable, in order, with expected output after each.
3. **Failure modes** — the 2–4 most likely errors and what they mean.
4. **Hard stop rule** — "if anything deviates from expected output, stop and report;
   do not debug live."
5. **Report-back format** — what to capture (logs, eval numbers, screenshots) and
   where to put it.

The engineer executes packets; they do not make architecture or parameter decisions.
Their report-backs are inputs to Claude's next session. Packets live in
`docs/task-packets/` and are versioned like code.

---

## 4. Execution phases

| Phase | What | Owner | Gate to pass |
|---|---|---|---|
| **0. Secure the work** | Review, test, commit, dual-push `deploy/`, `ml/`, `run-sync.ts` | Claude | `tsc` 0 errors, tests pass, both remotes at par |
| **1. Local validation** | `build_dataset.py`; smoke-test CPU stack with stock model (`qwen2.5:3b-instruct-q4_K_M`); dry-run `evaluate.py` | Claude | Stack boots, residency log shows `mode=on_premise`, eval harness produces numbers |
| **2. Training run** | Rent GPU (~$2–10, ~1 hr); run `finetune.py` (QLoRA, `--merge`) | Richard/Jr: account + payment; Claude via SSH **or** Jr via packet | Training completes; loss curve sane |
| **3. Model gate** | `evaluate.py` against the fine-tuned model | Claude decides; Jr may run | **JSON ≥ 99%, classification ≥ 95%, priority ≥ 98%** |
| **4. Packaging** | GGUF convert + Q4_K_M quantize; `ollama create reconcileai`; vLLM config for GPU tier | Claude (local) or Jr (packet) | Model answers correctly via `invokeLLM()` path in the stack |
| **5. Air-gap kit** | `docker save` all images + model volume + `.env.onprem` template + install runbook | Claude prepares; Jr assembles media | Kit installs clean on a machine with no internet |
| **6. Client deployment** | On-site install, bank reverse-proxy/TLS, migration, UAT | Jr on site, Claude on call, Richard owns relationship | Bank signs off UAT; residency posture verified on their hardware |

Phases 1–4 do not block on a client. Phase 2 is **not** a launch blocker — Day-1
deployments run the stock model.

---

## 5. Standing engineering rules

- **Ship gates are non-negotiable:** JSON ≥ 99%, classification ≥ 95%, priority ≥ 98%
  on `data/val.jsonl`. A model that misses any gate does not ship, period.
- **Training data:** only synthetic (from `build_dataset.py`) or **de-identified**
  historical exceptions. Raw client transaction data never enters a training set and
  never leaves client premises.
- **Residency is enforced, not promised:** `DEPLOYMENT_MODE=on_premise` +
  `EGRESS_ALLOWLIST` must fail closed. Any change touching `server/_core/egress.ts`
  gets a test proving the fail-closed behaviour.
- **Train once on rented GPU, run forever on CPU.** The client never buys a GPU;
  ReconcileAI never runs recurring GPU costs for inference.
- **No secrets in the repo.** `.env.onprem` is per-deployment; `JWT_SECRET` and DB
  passwords rotate per client.
- **Dual-push always:** every commit goes to both `Infinity-AI-Africa-Limited` and
  `MistaRichMan` remotes, same day.
- All existing CLAUDE.md conventions (strict TS, Vitest for new engine functions,
  Drizzle-only DB access) apply to this track unchanged.

---

## 6. Cadence and reporting

Claude works in **sessions**, not continuously. Practical implications:

- **Kickoff:** Richard invokes Claude with the phase to advance (or "continue the
  track" — Claude picks up from this doc + repo state).
- **Long-running jobs** (training, big docker builds): either the Jr engineer
  babysits, or Richard schedules a check-in; Claude does not watch between sessions.
- **Status report at end of every working session**, in this shape:
  *Done → Verified how → Blocked on → Next single action.*
- **Weekly written status** (on request): phase table from §4 with a green/yellow/red
  per phase and spend to date.

Single source of truth for "where are we": this document's phase table plus git
history. If they disagree, git wins and this doc gets corrected.

---

## 7. Escalation triggers — when Claude stops and asks Richard

1. Any spend beyond an already-approved budget line (GPU hours count).
2. Anything touching a client commitment, date, or contract.
3. A ship gate failing twice after one retraining iteration (signals a data or
   scope problem, not a tuning problem — needs a strategy call).
4. Any request to weaken the residency guard or put client data in a training set.
5. Destructive/irreversible operations outside the repo (client DBs, prod infra).

Everything else: Claude decides, acts, and reports.

---

## 8. Top risks

| Risk | Mitigation |
|---|---|
| Uncommitted work lost (currently `deploy/`, `ml/` exist only on one laptop) | Phase 0 is first, before anything else |
| Fine-tuned model underperforms stock | Day-1 = stock model; fine-tune is an upgrade, never a dependency |
| GPU-hour flakiness (spot instances, OOM) | Runbook includes checkpointing + resume; 3B model fits comfortably in QLoRA on one card |
| Jr engineer improvises on site | Hard-stop rule in every packet; Claude on call during install windows |
| Bank IT blocks Docker / non-standard host | Pre-deployment questionnaire in the air-gap runbook (OS, Docker availability, RAM, proxy) before media is cut |

---

*Owner: Richard Anwanakak. Maintained by: Claude (acting CTO). Update this file
whenever a decision here is overridden — the doc must always reflect the real
operating model, not the aspirational one.*
