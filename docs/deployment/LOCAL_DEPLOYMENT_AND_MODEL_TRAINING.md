# ReconcileAI — Local Deployment & Model Training (Authoritative Runbook)

*Owner: Infinity AI Africa Limited · Prepared by: Claude (acting CTO) · Status:
executable against the current `main`. Supersedes the June-2026 Manus planning
note of the same name.*

> **Read this first.** Every command, path, environment variable and file in this
> document has been checked against the actual codebase (`server/_core/egress.ts`,
> `server/_core/email.ts`, `server/magicLinkService.ts`, `deploy/on-prem/*`,
> `ml/*`, `railway.json`, `drizzle.config.ts`, `package.json`). Where the prior
> planning note was aspirational or wrong, the correction is called out in
> **§10 — What changed from the previous plan**. Follow this document top to
> bottom and a fresh, air-gapped box ends up working — including the one thing the
> old plan never addressed: **how the first person logs in with no internet and no
> email.**

---

## 0. Purpose, scope, and markets

ReconcileAI can run in three commercial modes (see
`docs/…/project-deployment-modes`): (1) cloud SaaS, (2) on-premise app with a
cloud LLM, and (3) **fully local / air-gapped** — the app *and* the model run on
the institution's own hardware with all outbound internet blocked in code. This
runbook covers **modes 2 and 3**, and the model-training pipeline that produces
the local model.

**Markets in scope now: Nigeria and Uganda.** The doctrine is the same
everywhere; the *obligation* differs by market:

| | Nigeria | Uganda |
|---|---|---|
| Data-residency law | NDPA 2023 — cloud permitted; on-prem optional (bank preference / risk) | **Data Protection & Privacy Act 2019 — financial data must not leave Uganda.** On-prem / in-country is an **entry requirement**, not an option |
| Regulator | CBN / NIBSS | Bank of Uganda (BoU), NPS Act 2020 |
| Currency | NGN | UGX (zero-decimal; already first-class in `server/currency.ts`) |
| Practical deployment | Mode 1 or 2; Mode 3 for security-sensitive banks | **Mode 3 (fully local) is the default sales motion** |

The same image, the same model file, and the same runbook serve both. Only
configuration (currency, channel packs, regulator report set) differs, and that
is data, not code. As we extend to Ghana/Kenya the table gains rows; nothing here
forks.

---

## 1. The architecture in plain English (verified)

Three facts make local deployment a *configuration* exercise rather than a
re-build. All three are real in the code today, not planned:

1. **One LLM chokepoint.** Every AI feature — exception classification, the
   Layer-3 Woodcore agent, CFO reports, the Super Agent, compliance assessment —
   calls a single `invokeLLM()` helper (`server/_core/llm.ts`). It sends the
   prompt to whatever endpoint the environment variables name. Point those at a
   local model and **every feature moves at once, with zero code change.**

2. **A fail-closed data-residency guard.** Setting `DEPLOYMENT_MODE=on_premise`
   activates `server/_core/egress.ts`. It is wired into every outbound call site
   (LLM, email, SSO, webhooks, exception-intelligence, the WoodCore client). Any
   attempt to reach a non-local host throws `EgressBlockedError`. Critically, the
   server **refuses to boot** if the configuration would leak data off-box —
   `assertResidencyStartupConfig()` runs at startup (`server/_core/index.ts`) and
   the process logs `[residency] mode=on_premise (enforced; …)` before it serves
   a single request. This is an application-layer control (see §7 for the
   network-layer control that must sit beside it).

3. **A native local-model path.** `invokeLLM()` speaks both the Anthropic and the
   OpenAI dialects and auto-detects which to use. Ollama serves the OpenAI dialect
   on `http://ollama:11434/v1`, so the local model needs no shim.

> **Honest framing of "air-gapped."** You *build* the image and *train* the model
> on machines **with** internet, then ship the artifacts to the sealed box. Once
> installed, the box needs no internet ever again and is enforced not to use it.
> "Air-gapped" describes the *running* system, not the *build*. Say it that way to
> a bank's security team — it is both true and more credible than "never touches
> the internet."

---

## 2. Repo changes this runbook depends on (land these once)

The on-prem assets in `deploy/` and `ml/` are strong, but three small additions
are required before an air-gapped install can succeed end-to-end. **These are the
difference between a document that reads well and one that works.** They are a
single ~30-minute change set; land them once and every future deployment uses
them.

### 2.1 In-container database migration

Production migrates with `pnpm db:migrate` (Railway `preDeployCommand` →
`drizzle-kit migrate`). The on-prem **runtime** image is `node:22-bookworm-slim`
and does **not** enable corepack, so `pnpm` is unavailable inside the container —
and `drizzle-kit` needs `drizzle.config.ts`, which the runtime stage does not
currently copy. Two fixes:

**(a)** Add one line to the runtime stage of `deploy/on-prem/Dockerfile` (the
schema files it references already ship, because they live under `drizzle/`):

```dockerfile
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/scripts ./scripts
```

**(b)** Run migrations inside the container with `npx` (not `pnpm`):

```bash
docker compose -f docker-compose.cpu.yml exec app npx drizzle-kit migrate
```

`drizzle-kit` is present (it is a dev dependency and the runtime copies
`node_modules` wholesale from the builder); `DATABASE_URL` is already in the
container env; the migration journal is in the copied `drizzle/` folder.

### 2.2 Air-gapped first-login bootstrap (the P0 the old plan missed)

On a fresh box the database is empty and magic-link auth depends on outbound
email — which residency mode blocks. `sendLoginLinkEmail()` even discards the
link when email is skipped, so self-service login is a dead end offline. There
must be a way to mint the **first** super-admin and print a sign-in link to the
console. Create `scripts/bootstrap-admin.mjs`:

```js
#!/usr/bin/env node
// scripts/bootstrap-admin.mjs
// One-time super-admin bootstrap for air-gapped / on-premise deployments.
// A fresh box has an empty DB and no way to receive a magic-link email, so this
// mints the first super-admin and prints a single-use sign-in link to stdout.
// Idempotent: if a user with --email exists it is (re)promoted to super_admin and
// a fresh link is minted. Uses only mysql2 (already a dependency) + DATABASE_URL.
//
//   docker compose -f docker-compose.cpu.yml exec app \
//     node scripts/bootstrap-admin.mjs --email you@bank.com --name "Ada Admin" \
//     --org "Client Bank" --app-url https://reconcile.bank.internal
import crypto from "node:crypto";
import mysql from "mysql2/promise";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const email = arg("--email");
const name = arg("--name", "Administrator");
const orgName = arg("--org", "Platform Operator");
const appUrl = arg("--app-url", process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const TTL_HOURS = 72;

if (!email) { console.error("ERROR: --email is required"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("ERROR: DATABASE_URL is not set"); process.exit(1); }

const conn = await mysql.createConnection(process.env.DATABASE_URL);
try {
  // 1. Find or create an org for the super-admin (segment = super_admin).
  const [orgRows] = await conn.execute(
    "SELECT id FROM organizations WHERE segment = 'super_admin' ORDER BY id LIMIT 1",
  );
  let orgId;
  if (orgRows.length) {
    orgId = orgRows[0].id;
  } else {
    const code = "ops-" + crypto.randomBytes(4).toString("hex");
    const [res] = await conn.execute(
      "INSERT INTO organizations (name, code, country, baseCurrency, segment, onboardingChannel, ssoProvider, isActive) " +
      "VALUES (?, ?, 'NGA', 'NGN', 'super_admin', 'direct', 'none', 1)",
      [orgName, code],
    );
    orgId = res.insertId;
    console.log(`Created super-admin organization #${orgId} (${orgName}).`);
  }

  // 2. Find or create the super-admin user.
  const [userRows] = await conn.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
  let userId;
  if (userRows.length) {
    userId = userRows[0].id;
    await conn.execute(
      "UPDATE users SET role='super_admin', isActive=1, isGuest=0, organizationId=? WHERE id=?",
      [orgId, userId],
    );
    console.log(`Reused user #${userId} <${email}> and ensured super_admin.`);
  } else {
    const openId = "local:" + crypto.randomBytes(16).toString("hex");
    const [res] = await conn.execute(
      "INSERT INTO users (openId, name, email, loginMethod, role, organizationId, isGuest, isActive) " +
      "VALUES (?, ?, ?, 'bootstrap', 'super_admin', ?, 0, 1)",
      [openId, name, email, orgId],
    );
    userId = res.insertId;
    console.log(`Created super-admin user #${userId} <${email}>.`);
  }

  // 3. Mint a single-use magic-link token (72h), stored as UTC.
  const token = crypto.randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000)
    .toISOString().slice(0, 19).replace("T", " ");
  await conn.execute(
    "INSERT INTO magic_link_tokens (userId, token, expiresAt) VALUES (?, ?, ?)",
    [userId, token, expiresAt],
  );

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("  Sign-in link (single-use, valid 72h) — open it in a browser:");
  console.log(`  ${appUrl}/magic-login?token=${token}`);
  console.log("──────────────────────────────────────────────────────────────\n");
} finally {
  await conn.end();
}
```

> Column names above match `drizzle/schema.ts` exactly (`organizations`, `users`,
> `magic_link_tokens`). These three tables are on the project's "do not change"
> list, so the raw-SQL approach is safe and version-stable. After the first admin
> exists, every subsequent user is created from inside the app; when email is
> unavailable the admin copies the `magicLink` that `sendWelcomeEmail()` already
> returns in its result. No further console bootstrap is needed.

### 2.3 (Optional) convenience script

Add to `package.json` `scripts` so operators can run it by name:

```json
"bootstrap:admin": "node scripts/bootstrap-admin.mjs"
```

---

## 3. Track A — Local demo on a CPU, no GPU, no training (½ day)

Goal: a working, air-gapped ReconcileAI you can put in front of Woodcore, LAPO, or
a Ugandan bank **today**, using an off-the-shelf small model with ReconcileAI's
domain system prompt. This is not the trained model — it proves the architecture.

**You need:** a machine with Docker + internet (to build once), 16 GB RAM, no GPU.

### Step A1 — Configure secrets

```bash
cd deploy/on-prem
cp .env.onprem.example .env.onprem
# Edit .env.onprem and set:
#   MYSQL_ROOT_PASSWORD   — a strong password
#   JWT_SECRET            — openssl rand -hex 32
# Optional: RECON_MODEL   — defaults to qwen2.5:3b-instruct-q4_K_M
```

The compose file pins `DEPLOYMENT_MODE=on_premise`, `EGRESS_ALLOWLIST=ollama`,
and the local-LLM variables for you. You only set the two secrets.

### Step A2 — Start the stack

```bash
docker compose -f docker-compose.cpu.yml --env-file .env.onprem up -d --build
```

This builds the app image, starts MySQL, starts Ollama, and runs a one-shot
`model-init` that pulls the base model (~2 GB, internet needed **this once**).
First run: 5–10 min. Later starts: under a minute.

### Step A3 — Apply the database schema

```bash
docker compose -f docker-compose.cpu.yml --env-file .env.onprem exec app npx drizzle-kit migrate
```

(Requires §2.1. Do **not** use `pnpm db:push` — it needs corepack + a full
generate step that the slim runtime doesn't have.)

### Step A4 — Create the first user and sign in

```bash
docker compose -f docker-compose.cpu.yml --env-file .env.onprem exec app \
  node scripts/bootstrap-admin.mjs --email you@yourco.com --name "Your Name"
```

Copy the printed `…/magic-login?token=…` URL into a browser. You are now signed
in as super-admin. (Requires §2.2.)

### Step A5 — Verify the deployment and the air-gap

```bash
# 1. Residency is enforced (printed at boot, before serving):
docker compose -f docker-compose.cpu.yml --env-file .env.onprem logs app | grep residency
#   → [residency] mode=on_premise (enforced; egress allowlist: ollama)

# 2. The app is wired to the LOCAL model (not Anthropic):
curl -s http://localhost:3000/api/health | grep -o '"llm":{[^}]*}'
#   → provider/model reflect the local Ollama endpoint

# 3. Hard proof: pull the machine's network cable / detach the docker network,
#    then open an exception and click "Analyse with AI". It still answers.
```

There is no `checkEgress(...)` CLI — the guard is proven by (1) the enforced-boot
log line and the fact that the process *refuses to start* if misconfigured, and
(2) the live disconnect test. That is a stronger demonstration than a script that
prints "blocked".

Track A done: a fully local, air-gapped ReconcileAI on a CPU.

---

## 4. Track B — Train the ReconcileAI model (rent a GPU once) (1–2 days)

Principle: **train once on a rented GPU; run forever on the bank's CPU.** No
Nigerian or Ugandan institution ever buys a GPU. The real training assets live in
`ml/` (`build_dataset.py`, `finetune.py`, `evaluate.py`, `requirements.txt`) and
are grounded in the **actual** Woodcore engine taxonomy (verbatim recommended
actions, confidence, and priority thresholds from `server/woodcore-engine.ts`) —
not a generic toy taxonomy.

### Step B1 — Generate the dataset (local, no GPU)

```bash
cd ml
python build_dataset.py --n-per-category 250 --out data/
#   → data/train.jsonl + data/val.jsonl, grounded in the 10 real engine categories
```

### Step B2 — Rent a GPU

RunPod or Modal, ~US$5–10 of credit, an RTX 4090 (24 GB) or A40 is plenty. Deploy
a PyTorch template, 50 GB volume.

### Step B3 — Fine-tune (QLoRA)

Upload `ml/finetune.py` and `data/`, then run it on the pod. It applies a 4-bit
QLoRA fine-tune of the base model over the dataset (~45–90 min, ~US$3–7).

### Step B4 — Merge + quantise to GGUF

Merge the LoRA adapter into the base weights and convert to `q4_K_M` GGUF
(~2 GB). This single file is what every bank runs on a CPU. **Stop the pod now** —
the GPU is no longer needed.

### Step B5 — Evaluate honestly (before any deployment)

```bash
python evaluate.py --model <gguf-or-ollama-tag> --test-file ml/data/val.jsonl
```

Pass criteria: valid-JSON ≥ 99%, category accuracy ≥ 95%, priority accuracy
≥ 90%, mean CPU latency ≤ 3 s.

> **Two integrity rules that keep this from being self-congratulatory:**
> 1. **Do not evaluate only on the synthetic generator's own hold-out.** That
>    measures memorisation of the generator, not field accuracy. Before a paid
>    pilot, assemble a small **human-labelled** set from real reconciliation
>    outcomes (anonymised) and report accuracy on *that* too.
> 2. **Confidence must not be a memorised constant.** The v1 dataset teaches a
>    fixed confidence per category. Treat the model's confidence as a label, not a
>    calibrated probability, and keep the **deterministic engine as the source of
>    truth** — the model explains and classifies; it does not decide amounts,
>    priorities, or postings. Those remain code.

### Base-model & licensing note (decide before you ship to third parties)

The compose default is Qwen2.5-**3B**, whose licence tier is more restrictive
than the Apache-2.0 sizes. Since we redistribute a fine-tuned derivative to
*third-party banks*, confirm the licence permits it, or — recommended — base the
model on **Qwen2.5-7B-Instruct (Apache-2.0)**, which also improves the multi-step
reasoning that the Super Agent needs (see coverage note below). Record the chosen
base + licence in `COMPLIANCE.md`.

### Coverage note (set expectations correctly)

The v1 model is trained on GL-anomaly **classification + explanation** for the
Woodcore engine's categories. It does **not** cover, out of the box, the full
121-category Nigerian taxonomy, the 22 Uganda categories, the 25 retail
categories, multi-step Super-Agent tool use, or CFO-report authoring. In local
mode those features still call the local model, so either (a) keep them on the
deterministic engine + templates for v1, or (b) extend the dataset to those tasks
before promising them air-gapped. Do not tell a bank "every AI feature is trained"
— tell them "every AI feature runs locally; the trained model covers GL-anomaly
diagnosis, and the rest runs on the deterministic engine until v2."

Track B done: a trained, quantised, CPU-only model file with an honest eval.

---

## 5. Track C — Production deployment at an institution (1–2 weeks)

### Step C1 — Assemble the deployment package

Build the app image on an internet-connected machine and export it, so the bank
downloads nothing:

```bash
docker build -f deploy/on-prem/Dockerfile -t reconcileai-app:v1.0 .
docker save reconcileai-app:v1.0 | gzip > reconcileai-app-v1.0.tar.gz
```

Package layout to hand to the bank:

```
reconcileai-deployment-v1.0/
├── reconcileai-app-v1.0.tar.gz     # docker load — no build at the bank
├── docker-compose.cpu.yml          # (or .gpu.yml)
├── .env.onprem.example
├── scripts/bootstrap-admin.mjs
├── ollama/Modelfile                # FROM /models/reconcileai.gguf
├── models/reconcileai-3b-q4.gguf   # the trained model (~2 GB)
├── INSTALL.md                      # the Step C3 sequence
└── COMPLIANCE.md                   # §7, tailored to the bank + market
```

### Step C2 — Import the trained model into Ollama (offline)

For the **trained** model you do not `ollama pull` (that needs the internet).
Mount the GGUF and create the model from the local Modelfile. Add to the `ollama`
service in the compose file:

```yaml
    volumes:
      - ollama-models:/root/.ollama
      - ./ollama/Modelfile:/models/Modelfile:ro
      - ./models:/models:ro
```

and replace the `model-init` command so it builds from the local file instead of
pulling:

```yaml
  model-init:
    image: ollama/ollama:latest
    depends_on: { ollama: { condition: service_healthy } }
    environment: { OLLAMA_HOST: "http://ollama:11434" }
    entrypoint: ["/bin/sh", "-c"]
    command: ["ollama create reconcileai -f /models/Modelfile && echo 'model ready: reconcileai'"]
    restart: "no"
```

Set `RECON_MODEL=reconcileai` in `.env.onprem` so the app and Ollama agree on the
tag. (The `Modelfile` already carries the ReconcileAI system prompt +
temperature/context parameters.)

### Step C3 — Install at the bank (no internet required)

```bash
# On the bank server (Ubuntu 22.04, Docker 24+):
docker load  < reconcileai-app-v1.0.tar.gz
cp .env.onprem.example .env.onprem      # set MYSQL_ROOT_PASSWORD, JWT_SECRET, RECON_MODEL, APP_URL
docker compose -f docker-compose.cpu.yml --env-file .env.onprem up -d
docker compose -f docker-compose.cpu.yml --env-file .env.onprem exec app npx drizzle-kit migrate
docker compose -f docker-compose.cpu.yml --env-file .env.onprem exec app \
  node scripts/bootstrap-admin.mjs --email admin@bank.com --name "Bank Admin" \
  --org "Client Bank" --app-url https://reconcile.bank.internal
```

Hand the printed sign-in link to the bank's first admin. Total time ~15–20 min,
none of it an internet download.

### Step C4 — Hardware for the bank (CPU-only; no GPU purchase)

| Component | Minimum | Recommended |
|---|---|---|
| CPU | 8-core x86-64 | 16-core |
| RAM | 16 GB | 32 GB |
| Storage | 100 GB SSD | 500 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Network | Internal LAN only | — |

A standard mid-range server any bank already owns. On an 8-core box, set
`OLLAMA_NUM_PARALLEL`/threads and verify the ≤3 s target under concurrent load
during acceptance (Step C6).

---

## 6. Step C5 — Compliance controls to configure at the bank

These are the questions a DPO and IT-security lead will ask. Answer them in
`COMPLIANCE.md`, tailored per market (Uganda DP&P Act vs Nigeria NDPA).

- **Data residency (application layer):** `DEPLOYMENT_MODE=on_premise` enforces
  the egress guard; the app refuses to boot if misconfigured and blocks any
  non-local outbound call at runtime. State plainly that this governs the
  *application's own* outbound calls.
- **Data residency (network layer) — do not skip:** the egress guard is not a
  firewall. Pair it with a host firewall / no default route so the *container host
  itself* cannot reach the internet. The compose stack has no external service
  dependencies, so a bank can run it on an isolated VLAN. Document both layers.
- **Audit logging:** AI actions and platform events are recorded (see
  `platform_audit_logs` and the in-app Audit Trail). Log the model name + version
  with each inference; never log raw transaction rows off-box.
- **Access control:** authentication is passwordless **magic-link** (not Manus
  OAuth — that was removed). Offline, links are surfaced via the bootstrap script
  (first admin) and via the admin "create user" flow (which returns the link when
  email is unavailable). Optionally enable in-VPC SMTP by allowlisting the relay
  host in `EGRESS_ALLOWLIST`. Place the app behind the bank's reverse proxy (TLS)
  and restrict to the internal IP range. **Super-admins never use SSO** (policy).
- **Model versioning & rollback:** ship each model as a distinct Ollama tag
  (`reconcileai-v1.0`, `-v1.1`); keep the previous tag for one-line rollback via
  `RECON_MODEL`.
- **Backups (add this — the old plan omitted it):** schedule `mysqldump` (or a
  volume snapshot) of `db-data` to the bank's internal backup target; document
  restore. Financial data with no backup is a non-starter for a bank.
- **Patching:** because the box is sealed, define a quarterly cadence to ship a
  refreshed app image + base-image security updates via the same `docker save` /
  `docker load` path.

---

## 7. Step C6 — Handover & acceptance tests

| Test | Procedure | Pass criteria |
|---|---|---|
| Air-gap | Physically disconnect the server; run a reconciliation | All AI features respond; zero errors |
| Residency at boot | Restart the app; read the first log lines | `[residency] mode=on_premise (enforced; …)` present |
| Classification | Upload a statement with 10 known exception types | ≥ 9/10 correctly classified |
| Latency | 20 consecutive AI analyses under normal load | mean ≤ 5 s on CPU |
| Audit trail | Perform 5 actions; open the Audit Trail | all 5 logged with user + timestamp |
| Egress | Network monitor during a full run | zero outbound connections to external hosts |
| Backup/restore | Take a backup, restore to a scratch DB | app boots and data matches |

---

## 8. Summary

| Track | Duration | Cost | Output |
|---|---|---|---|
| A — Local demo | ½ day | $0 (existing Docker) | Air-gapped demo on a CPU |
| B — Model training | 1–2 days | $5–15 (GPU rental, once) | Trained GGUF; runs on any CPU |
| C — Production | 1–2 weeks | $0 (bank's own hardware) | Deployed appliance + compliance pack |

The message to a Nigerian or Ugandan institution: **you never buy a GPU.** We
train once in the cloud; you run the resulting file on a standard server you
already own, with your data enforced to never leave it.

---

## 9. Appendix — Environment variables (verified)

| Variable | On-prem value | Purpose |
|---|---|---|
| `DEPLOYMENT_MODE` | `on_premise` | Activates the egress guard; fail-closed at boot |
| `EGRESS_ALLOWLIST` | `ollama` (+ SMTP relay if used) | In-stack hosts the guard permits |
| `DIRECT_LLM_API_URL` | `http://ollama:11434/v1` | Local model endpoint |
| `DIRECT_LLM_PROVIDER` | `openai` | Ollama speaks the OpenAI dialect |
| `DIRECT_LLM_MODEL` / `RECON_MODEL` | `reconcileai` (trained) or `qwen2.5:3b-instruct-q4_K_M` (demo) | Model tag — app and Ollama must match |
| `DIRECT_LLM_API_KEY` | `local` | Non-empty placeholder; Ollama ignores it |
| `DATABASE_URL` | `mysql://root:…@db:3306/reconcileai` | Bundled MySQL |
| `JWT_SECRET` | (generated) | Session signing |
| `APP_URL` | `https://reconcile.bank.internal` | Builds magic-link URLs |
| `RESEND_API_KEY` / `EMAIL_FROM` | unset (or in-VPC relay) | Email; safe no-op offline |

---

## 10. What changed from the previous plan (why this one works)

| Prior planning note | Reality in the code | This runbook |
|---|---|---|
| "Log in and navigate to an exception" | Fresh box has no user; magic-link needs email; offline the link is discarded | **§2.2 + Step A4/C3 bootstrap** prints a first-admin sign-in link — the missing P0 |
| `pnpm db:push` at the bank | Slim runtime has no corepack/`pnpm`; `db:push` needs generate + `drizzle.config.ts` (not shipped) | **`npx drizzle-kit migrate`** + copy `drizzle.config.ts` (§2.1) |
| Air-gap proof: `require('./dist/server/_core/egress').checkEgress(...)` | No such path (bundle is `dist/index.js`), no `checkEgress` export, not async | **Boot log + refuse-to-start + live disconnect test** (Step A5) |
| Dockerfile `CMD dist/server/index.js` | Build output is `dist/index.js` | Real Dockerfile already correct (`dist/index.js`); documented as-is |
| Model tag hard-coded, drift-prone | Real compose uses one `RECON_MODEL` var | Single source of truth documented (§5, §9) |
| "Access control: Manus OAuth" | Manus OAuth removed; auth is magic-link | **Magic-link** documented, incl. offline link surfacing (§6) |
| "Fully air-gapped" from day one | Build/train need internet; run does not | Honest **build-online / run-offline** framing (§1) |
| "Every AI feature is trained" | Model trained on GL classify+explain only | **Coverage note** (§4): local ≠ trained-for-all; engine stays source of truth |
| Backups, resource limits, patching | Absent | Added (§6) |
| Base model 3B, no licence check | 3B licence tier is restrictive for redistribution | **Licensing note** (§4): confirm, or move to 7B Apache-2.0 |

---

*Cross-references: `deploy/on-prem/` (assets), `ml/` (training), `server/_core/egress.ts`
(guard), `server/magicLinkService.ts` (auth), `docs/market/NG_UG_RECONCILIATION_VALIDATION.md`
(market fit). The §2 repo changes (`deploy/on-prem/Dockerfile` COPY lines,
`scripts/bootstrap-admin.mjs`, `pnpm bootstrap:admin`) are landed and committed alongside
this document, so Tracks A–C are executable as written.*
