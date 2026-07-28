/**
 * Local Deployment & Model Training runbook — document body.
 *
 * Served ONLY through the access-gated `poc.runbook` procedure so the private
 * invite link is a real boundary: the text never ships in the client bundle,
 * so it cannot be recovered from a JS chunk without a valid access token.
 *
 * Source of truth is docs/deployment/LOCAL_DEPLOYMENT_AND_MODEL_TRAINING.md.
 * This is the externally-shareable edition of it (vendor names, internal repo
 * cross-references and internal bylines removed). Regenerate rather than
 * hand-editing when the source runbook changes.
 */

export const RUNBOOK_TITLE = "Local Deployment & Model Training";
export const RUNBOOK_SUBTITLE =
  "Running the platform and its AI model entirely inside a financial institution";
export const RUNBOOK_VERSION = "2.0";
export const RUNBOOK_UPDATED = "July 2026";

export const RUNBOOK_MARKDOWN = `# ReconcileAI — Local Deployment & Model Training

**Authoritative Runbook · Version 2.0 · July 2026**

*Infinity AI Africa Limited — Engineering · Markets in scope: Nigeria, Uganda*

---

> **Read this first.** Every command, path, environment variable and file in this document has been checked against the actual shipping code — the egress guard, the email and magic-link services, the on-premise Docker assets, the training pipeline, and the migration configuration. Follow it top to bottom and a fresh, sealed box ends up working, **including the step most deployment plans omit: how the first person signs in when there is no internet and no email.**

---

## Contents

| § | Section |
|---|---|
| 0 | [Purpose, scope, and markets](#0-purpose-scope-and-markets) |
| 1 | [The architecture, in plain English](#1-the-architecture-in-plain-english) |
| 2 | [Platform prerequisites](#2-platform-prerequisites) |
| A | [Track A — Local demo (½ day)](#track-a--local-demo--cpu-only-no-gpu-no-training) |
| B | [Track B — Model training (1–2 days)](#track-b--train-the-reconcileai-model--rent-a-gpu-once) |
| C | [Track C — Production deployment (1–2 weeks)](#track-c--production-deployment-at-an-institution) |
| 6 | [Compliance controls](#6-compliance-controls) |
| 7 | [Handover & acceptance tests](#7-handover--acceptance-tests) |
| 8 | [Summary](#8-summary) |
| 9 | [Environment reference](#9-environment-reference) |
| 10 | [Revision notes — what changed in version 2](#10-revision-notes--what-changed-in-version-2) |

---

## 0. Purpose, scope, and markets

ReconcileAI runs in three commercial modes: **cloud SaaS**; **on-premise application with a cloud model**; and **fully local / air-gapped**, where the application *and* the model run on the institution's own hardware with all outbound internet blocked in code. This runbook covers the second and third, plus the training pipeline that produces the local model.

The engineering is identical in both target markets. What differs is the *obligation*:

| | Nigeria | Uganda |
|---|---|---|
| **Data-residency law** | NDPA 2023 — cloud permitted; on-premise is a bank preference, not a requirement | **Data Protection & Privacy Act 2019 — financial data must not leave Uganda.** In-country deployment is an entry requirement |
| **Regulator** | Central Bank of Nigeria · NIBSS | Bank of Uganda · NPS Act 2020 |
| **Currency** | NGN | UGX — zero-decimal handling is first-class in the platform |
| **Practical deployment** | Cloud or on-premise; fully local for security-sensitive banks | **Fully local is the default** |

The same image, the same model file, and the same runbook serve both. Only configuration differs — currency, channel packs, regulator report set — and that is data, not code. Extending to a new market adds a row to this table; nothing here forks.

---

## 1. The architecture, in plain English

Three properties make local deployment a *configuration* exercise rather than a rebuild. All three are real in the code today, not planned.

### One model chokepoint

Every AI feature — exception classification, the core-banking analysis agent, CFO reports, the Super Agent, compliance assessment — calls a single \`invokeLLM()\` helper. It sends the prompt to whatever endpoint the environment names. Point that at a local model and **every feature moves at once, with no code change.**

### A fail-closed residency guard

Setting \`DEPLOYMENT_MODE=on_premise\` activates the egress guard, which is wired into every outbound call site — model, email, single sign-on, webhooks, and the core-banking client. Any attempt to reach a non-local host is refused.

Critically, the server **refuses to boot** if the configuration would leak data off-box, and logs its enforced posture before serving a single request:

\`\`\`
[residency] mode=on_premise (enforced; egress allowlist: ollama)
\`\`\`

This is an application-layer control. Section 6 covers the network-layer control that must sit beside it.

### A native local-model path

The model helper speaks both the Anthropic and OpenAI dialects and detects which to use. Ollama serves the OpenAI dialect, so the local model needs no translation shim.

\`\`\`
┌──────────────────────────────────────────────────────────┐
│  Bank hardware — isolated network                        │
│                                                          │
│   ┌───────────────┐        ┌──────────────────────────┐  │
│   │  MySQL        │◄──────►│  ReconcileAI             │  │
│   │  transaction  │        │  DEPLOYMENT_MODE =       │  │
│   │  data         │        │  on_premise              │  │
│   └───────────────┘        └────────────┬─────────────┘  │
│                                         │                │
│                            ┌────────────▼─────────────┐  │
│                            │  Ollama — local model    │  │
│                            └──────────────────────────┘  │
└─────────────────────────────┬────────────────────────────┘
                              ╳   refused by the egress guard
                              ▼
                       Public internet
\`\`\`

> **Say this accurately to a security team.** You *build* the image and *train* the model on machines with internet, then ship the artifacts to the sealed box. Once installed, the box never needs internet again and is enforced not to use it. "Air-gapped" describes the **running** system, not the build. That framing is both true and more credible than claiming the software never touches the internet.

---

## 2. Platform prerequisites

Two capabilities are what separate a deployment plan that reads well from one that completes. Both now ship in the platform repository, and every deployment below depends on them.

### 2.1 In-container database migration

The production platform migrates with \`drizzle-kit migrate\`. The on-premise runtime image is deliberately slim and does not carry \`pnpm\`, so migrations run through \`npx\` instead, and the image ships the migration configuration and scripts alongside the built application.

\`\`\`dockerfile
# deploy/on-prem/Dockerfile — runtime stage
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/scripts ./scripts
\`\`\`

\`\`\`bash
docker compose -f docker-compose.cpu.yml exec app npx drizzle-kit migrate
\`\`\`

The migration tool is already present, the database URL is already in the container environment, and the migration journal ships with the image.

### 2.2 First sign-in on a sealed box

A fresh installation has an empty database, and passwordless magic-link sign-in depends on outbound email — which residency mode blocks by design. Without a deliberate bootstrap there is no way in.

\`scripts/bootstrap-admin.mjs\` creates the first administrator and prints a single-use sign-in link straight to the console:

\`\`\`bash
docker compose -f docker-compose.cpu.yml exec app \\
  node scripts/bootstrap-admin.mjs --email admin@bank.com --name "Bank Admin" \\
  --org "Client Bank" --app-url https://reconcile.bank.internal
\`\`\`

It is idempotent — re-running it re-promotes an existing account and issues a fresh link — and it uses only the database driver already in the image, so it runs in the slim runtime with nothing but a database URL.

<details>
<summary><strong>View the full bootstrap script</strong></summary>

\`\`\`js
#!/usr/bin/env node
// One-time super-admin bootstrap for air-gapped / on-premise deployments.
// A fresh box has an empty DB and no way to receive a magic-link email, so this
// mints the first super-admin and prints a single-use sign-in link to stdout.
import crypto from "node:crypto";
import mysql from "mysql2/promise";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const email   = arg("--email");
const name    = arg("--name", "Administrator");
const orgName = arg("--org", "Platform Operator");
const appUrl  = arg("--app-url", process.env.APP_URL || "http://localhost:3000").replace(/\\/+$/, "");
const TTL_HOURS = 72;

if (!email) { console.error("ERROR: --email is required"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("ERROR: DATABASE_URL is not set"); process.exit(1); }

const conn = await mysql.createConnection(process.env.DATABASE_URL);
try {
  // 1. Find or create the operator organization.
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
    console.log(\`Created super-admin organization #\${orgId} (\${orgName}).\`);
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
    console.log(\`Reused user #\${userId} and ensured super_admin.\`);
  } else {
    const openId = "local:" + crypto.randomBytes(16).toString("hex");
    const [res] = await conn.execute(
      "INSERT INTO users (openId, name, email, loginMethod, role, organizationId, isGuest, isActive) " +
      "VALUES (?, ?, ?, 'bootstrap', 'super_admin', ?, 0, 1)",
      [openId, name, email, orgId],
    );
    userId = res.insertId;
    console.log(\`Created super-admin user #\${userId}.\`);
  }

  // 3. Mint a single-use magic-link token (72h), stored as UTC.
  const token = crypto.randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000)
    .toISOString().slice(0, 19).replace("T", " ");
  await conn.execute(
    "INSERT INTO magic_link_tokens (userId, token, expiresAt) VALUES (?, ?, ?)",
    [userId, token, expiresAt],
  );

  console.log("\\n──────────────────────────────────────────────────────────────");
  console.log("  Sign-in link (single-use, valid 72h) — open it in a browser:");
  console.log(\`  \${appUrl}/magic-login?token=\${token}\`);
  console.log("──────────────────────────────────────────────────────────────\\n");
} finally {
  await conn.end();
}
\`\`\`

</details>

> **After the first administrator**, every subsequent user is created from inside the application. Where email is unavailable, the administrator copies the sign-in link that the invite flow already returns. No further console bootstrap is needed.

---

## Track A — Local demo · CPU only, no GPU, no training

**Half a day.**

Goal: a working, fully local ReconcileAI you can put in front of a prospect **today**, using an off-the-shelf small model with the platform's domain prompt. This is not the trained model — it proves the architecture.

**You need:** a machine with Docker and internet access to build once, 16 GB of memory, no GPU.

### A1 — Configure secrets

\`\`\`bash
cd deploy/on-prem
cp .env.onprem.example .env.onprem

# Set two values in .env.onprem:
#   MYSQL_ROOT_PASSWORD   a strong password
#   JWT_SECRET            openssl rand -hex 32
# Optional: RECON_MODEL   defaults to qwen2.5:3b-instruct-q4_K_M
\`\`\`

The compose file pins residency mode, the egress allowlist, and the local-model variables for you. You set the two secrets and nothing else.

### A2 — Start the stack

\`\`\`bash
docker compose -f docker-compose.cpu.yml --env-file .env.onprem up -d --build
\`\`\`

This builds the application image, starts the database, starts the model server, and runs a one-shot step that pulls the base model — roughly 2 GB, needing internet this once. First run takes five to ten minutes; later starts take under a minute.

### A3 — Apply the database schema

\`\`\`bash
docker compose -f docker-compose.cpu.yml --env-file .env.onprem exec app npx drizzle-kit migrate
\`\`\`

### A4 — Create the first user and sign in

\`\`\`bash
docker compose -f docker-compose.cpu.yml --env-file .env.onprem exec app \\
  node scripts/bootstrap-admin.mjs --email you@yourcompany.com --name "Your Name"
\`\`\`

Open the printed sign-in link in a browser. You are now signed in as the platform administrator.

### A5 — Verify the deployment and the isolation

\`\`\`bash
# 1. Residency is enforced — printed at boot, before the app serves anything:
docker compose -f docker-compose.cpu.yml --env-file .env.onprem logs app | grep residency
#   -> [residency] mode=on_premise (enforced; egress allowlist: ollama)

# 2. The app is wired to the LOCAL model, not a cloud provider:
curl -s http://localhost:3000/api/health

# 3. Hard proof: disconnect the machine from the network, then open an
#    exception and run an AI analysis. It still answers.
\`\`\`

> **Why there is no "test the block" command.** The guard is proven two ways that are stronger than a script printing the word "blocked": the application **refuses to start** if it is configured in a way that would leak data, and it keeps working with the network cable pulled out. Demonstrate both.

---

## Track B — Train the ReconcileAI model · rent a GPU once

**1–2 days.**

The governing principle: **train once on a rented GPU; run forever on the bank's CPU.** No institution in Nigeria or Uganda ever buys a GPU. The training assets are grounded in the platform's real exception taxonomy — the same recommended actions, confidence levels and priority thresholds the deterministic engine uses — not a generic reconciliation notion.

### B1 — Generate the dataset (local, no GPU)

\`\`\`bash
cd ml
python build_dataset.py --n-per-category 250 --out data/
#   -> data/train.jsonl + data/val.jsonl
\`\`\`

### B2 — Rent a GPU

Roughly US$5–10 of credit on any GPU cloud. A 24 GB card is more than enough. Deploy a PyTorch template with a 50 GB volume.

### B3 — Fine-tune

Upload the training script and dataset, then run it. A 4-bit QLoRA fine-tune over this dataset takes roughly 45–90 minutes and costs about US$3–7.

### B4 — Merge and quantise

Merge the adapter into the base weights and convert to a quantised GGUF file of roughly 2 GB. That single file is what every bank runs on a CPU. **Stop the rented GPU now** — it is no longer needed, by you or by the client.

### B5 — Evaluate honestly, before anything ships

\`\`\`bash
python evaluate.py --model <model-tag> --test-file ml/data/val.jsonl
\`\`\`

Pass criteria: valid structured output ≥ 99%, category accuracy ≥ 95%, priority accuracy ≥ 90%, mean response time ≤ 3 seconds on CPU.

> **Two rules that keep this measurement honest.**
>
> **Do not evaluate only on the generator's own hold-out set.** That measures memorisation of the generator, not accuracy in the field. Before any paid pilot, assemble a small human-labelled set from real, anonymised reconciliation outcomes and report accuracy on that too.
>
> **Treat confidence as a label, not a probability.** The first dataset teaches a fixed confidence per category, so the number is not calibrated. The deterministic engine remains the source of truth: the model explains and classifies; it never decides amounts, priorities, or postings. Those stay in code.

### Base model and licensing

The default base model's smallest tier carries a more restrictive licence than its larger siblings. Because a fine-tuned derivative is redistributed to third-party institutions, confirm the licence permits that — or move to a 7B model under Apache 2.0, which also improves the multi-step reasoning discussed below. Record the chosen base and its licence in the compliance pack.

### What version 1 actually covers

The first trained model handles ledger-anomaly classification and explanation. It does **not** cover the full Nigerian channel taxonomy, the Uganda taxonomy, the retail taxonomy, multi-step agent tool use, or CFO-report authoring.

In local mode those features still run on the local model, so either keep them on the deterministic engine and templates for version 1, or extend the training set before promising them. State it precisely to a client: *every AI feature runs locally; the trained model covers ledger-anomaly diagnosis, and the rest runs on the deterministic engine until version 2.*

---

## Track C — Production deployment at an institution

**1–2 weeks.**

### C1 — Assemble the deployment package

Build the image on an internet-connected machine and export it, so the bank downloads nothing:

\`\`\`bash
docker build -f deploy/on-prem/Dockerfile -t reconcileai-app:v1.0 .
docker save reconcileai-app:v1.0 | gzip > reconcileai-app-v1.0.tar.gz
\`\`\`

Package handed to the institution:

\`\`\`
reconcileai-deployment-v1.0/
├── reconcileai-app-v1.0.tar.gz     # load directly — no build at the bank
├── docker-compose.cpu.yml
├── .env.onprem.example
├── scripts/bootstrap-admin.mjs
├── ollama/Modelfile
├── models/reconcileai-3b-q4.gguf   # the trained model (~2 GB)
├── INSTALL.md                      # the C3 sequence
└── COMPLIANCE.md                   # section 6, tailored to the bank
\`\`\`

### C2 — Import the trained model offline

For the trained model you do not pull from a registry — that needs internet. Mount the model file and build it from the local definition instead:

\`\`\`yaml
  ollama:
    volumes:
      - ollama-models:/root/.ollama
      - ./ollama/Modelfile:/models/Modelfile:ro
      - ./models:/models:ro

  model-init:
    image: ollama/ollama:latest
    depends_on: { ollama: { condition: service_healthy } }
    environment: { OLLAMA_HOST: "http://ollama:11434" }
    entrypoint: ["/bin/sh", "-c"]
    command: ["ollama create reconcileai -f /models/Modelfile"]
    restart: "no"
\`\`\`

Set \`RECON_MODEL=reconcileai\` so the application and the model server agree on the tag. The model definition already carries the ReconcileAI system prompt and its temperature and context settings.

### C3 — Install at the institution (no internet required)

\`\`\`bash
docker load < reconcileai-app-v1.0.tar.gz
cp .env.onprem.example .env.onprem     # set the passwords, model tag, and app URL

docker compose -f docker-compose.cpu.yml --env-file .env.onprem up -d
docker compose -f docker-compose.cpu.yml --env-file .env.onprem exec app npx drizzle-kit migrate
docker compose -f docker-compose.cpu.yml --env-file .env.onprem exec app \\
  node scripts/bootstrap-admin.mjs --email admin@bank.com --name "Bank Admin" \\
  --org "Client Bank" --app-url https://reconcile.bank.internal
\`\`\`

Hand the printed sign-in link to the institution's first administrator. Total time is roughly 15–20 minutes, none of it spent downloading.

### C4 — Hardware the institution needs

| Component | Minimum | Recommended |
|---|---|---|
| **CPU** | 8-core x86-64 | 16-core |
| **Memory** | 16 GB | 32 GB |
| **Storage** | 100 GB SSD | 500 GB SSD |
| **Operating system** | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| **Network** | Internal LAN only | — |
| **Docker** | Engine 24+ | — |

This is a standard mid-range server that any bank or microfinance bank already owns. On an 8-core machine, tune the model server's thread and parallelism settings and confirm the latency target under concurrent load during acceptance testing.

---

## 6. Compliance controls

These are the questions a data protection officer and an IT security lead will ask. Answer them in the compliance pack, tailored to the market.

**Data residency — application layer.** Residency mode enforces the egress guard: the application refuses to boot if misconfigured and refuses every non-local outbound call at runtime. State plainly that this governs the application's own outbound calls.

**Data residency — network layer.** *Do not skip this.* The egress guard is not a firewall. Pair it with a host firewall or no default route, so the machine itself cannot reach the internet. The stack has no external service dependencies, so it runs happily on an isolated network segment. Document both layers — a security reviewer will ask which one is doing the work.

**Audit logging.** AI actions and platform events are recorded and queryable in the application's audit trail. Log the model name and version with each inference. Never log raw transaction rows anywhere that leaves the box.

**Access control.** Authentication is passwordless magic-link sign-in. Offline, links are surfaced by the bootstrap script for the first administrator and by the invite flow for everyone after. An internal mail relay can be allowlisted if the institution wants email delivery. Place the application behind the institution's own reverse proxy with TLS and restrict it to internal addresses. Platform administrators never authenticate through single sign-on.

**Model versioning and rollback.** Ship each model as a distinct tag and keep the previous one installed. Rollback is then a one-line configuration change, not a redeployment.

**Backups.** Schedule a database dump or volume snapshot to the institution's internal backup target, and document the restore procedure. Financial data with no tested backup is a non-starter in a bank.

**Patching.** Because the box is sealed, agree a quarterly cadence to ship a refreshed application image and base-image security updates through the same export-and-load path used at installation.

---

## 7. Handover & acceptance tests

Run these with the institution's operations team before sign-off.

| Test | Procedure | Pass criteria |
|---|---|---|
| **Isolation** | Physically disconnect the server, then run a reconciliation | All AI features respond; no errors |
| **Residency at boot** | Restart the application and read the first log lines | Enforced-mode line present |
| **Classification** | Upload a statement containing 10 known exception types | ≥ 9 of 10 correct |
| **Latency** | 20 consecutive AI analyses under normal load | Mean ≤ 5 s on CPU |
| **Audit trail** | Perform 5 actions, then open the audit trail | All 5 logged with user and timestamp |
| **Egress** | Network monitor running during a full reconciliation | Zero outbound external connections |
| **Backup and restore** | Take a backup, restore it to a scratch database | Application boots; data matches |

---

## 8. Summary

| Track | Duration | Cost | Output |
|---|---|---|---|
| **A — Local demo** | Half a day | None | A fully local demo on a CPU, ready to show a prospect |
| **B — Model training** | 1–2 days | US$5–15 of rented GPU, once ever | A model file that runs on any CPU |
| **C — Production** | 1–2 weeks | No hardware cost | Deployed appliance plus the compliance pack |

The message to an institution in Nigeria or Uganda is simple: **you never buy a GPU.** We train once in the cloud; you run the resulting file on a standard server you already own, with your data enforced never to leave it.

---

## 9. Environment reference

| Variable | On-premise value | Purpose |
|---|---|---|
| \`DEPLOYMENT_MODE\` | \`on_premise\` | Activates the egress guard; fail-closed at boot |
| \`EGRESS_ALLOWLIST\` | \`ollama\` | In-stack hosts the guard permits; add a mail relay if used |
| \`DIRECT_LLM_API_URL\` | \`http://ollama:11434/v1\` | Local model endpoint |
| \`DIRECT_LLM_PROVIDER\` | \`openai\` | The local server speaks the OpenAI dialect |
| \`RECON_MODEL\` | \`reconcileai\` | Model tag — application and model server must agree |
| \`DIRECT_LLM_API_KEY\` | \`local\` | Non-empty placeholder; the local server ignores it |
| \`DATABASE_URL\` | \`mysql://…@db:3306/reconcileai\` | Bundled database |
| \`JWT_SECRET\` | generated | Session signing |
| \`APP_URL\` | internal hostname | Builds sign-in links |
| \`RESEND_API_KEY\` | unset | Email; a safe no-op when offline |

---

## 10. Revision notes — what changed in version 2

Version 1 was a planning note written before the deployment assets existed. Each row below is a step that would have failed on execution, and what replaced it.

| Version 1 said | What the code actually does | Version 2 |
|---|---|---|
| "Log in and open an exception" | A fresh box has no user, and sign-in needs email that residency mode blocks | **Bootstrap script** prints a first-administrator sign-in link |
| Run the schema-push command at the bank | The slim runtime has no \`pnpm\`, and the migration config was not shipped | **Migrate through \`npx\`**, with the config in the image |
| Prove isolation by calling an egress function | No such module path or export exists in the built bundle | **Enforced-boot log, refuse-to-start, and a live disconnect test** |
| Start the app from a nested build path | The build emits a single bundled entry point | Documented against the real build output |
| Model tag repeated in several places | One variable already drives both services | Single source of truth |
| Access control via the legacy sign-in provider | That provider was removed; sign-in is magic-link | Magic-link documented, including offline link delivery |
| "Fully air-gapped" from day one | Building and training need internet; running does not | Honest build-online, run-offline framing |
| "Every AI feature is trained" | Training covers ledger-anomaly diagnosis only | Explicit coverage note; engine stays source of truth |
| Backups, resource limits, patching | Absent entirely | Added as compliance controls |
| Base model chosen, licence unexamined | The default tier restricts redistribution | Licensing decision flagged before third-party shipment |

---

**About this document.** This is an engineering runbook, not marketing material. It states what the platform does today, what version 1 of the trained model does and does not cover, and which decisions remain open — because a bank's security team will find all three anyway, and it is better to be the party that named them.

*ReconcileAI is a product of Infinity AI Africa Limited. Version 2.0 · July 2026.*
`;
