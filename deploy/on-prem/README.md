# ReconcileAI — On-Premise Deployment (Option 3: fully local, air-gapped)

This folder is a turnkey, **air-gapped** deployment of the ReconcileAI platform with
the LLM running **locally** — no internet, no cloud AI, transaction data never
leaves the bank's hardware. It ships in two flavours:

| Stack | File | Needs a GPU? | Best for |
|---|---|---|---|
| **Private CPU serving** | `docker-compose.cpu.yml` | ❌ No | Financial institutions without GPU infrastructure. Runs a verified quantized Qwen model through internal-only Ollama. |
| **Private GPU serving** | `docker-compose.gpu.yml` | ✅ Yes (institution-controlled NVIDIA host) | Bank pilot or production serving. Runs an approved Qwen artifact through authenticated vLLM. |

Both stacks set `DEPLOYMENT_MODE=on_premise`, which turns on the [data-residency
egress guard](../../server/_core/egress.ts): every outbound call is blocked unless
its host is loopback/private **or** on `EGRESS_ALLOWLIST`. The in-stack model host
(`ollama` / `vllm`) is allowlisted; nothing else can reach the internet. If you
misconfigure the LLM URL to a public host, the app **refuses to start**.

---

## How the LLM gets selected (no code changes — just env)

Every AI feature in the app calls the single `invokeLLM()` switchboard, which reads
these variables (already set for you by the compose files):

```
DEPLOYMENT_MODE = on_premise
DIRECT_LLM_API_KEY = local                       # non-empty placeholder
DIRECT_LLM_API_URL = http://ollama:11434/v1      # (CPU)  or  http://vllm:8000/v1 (GPU)
DIRECT_LLM_PROVIDER = openai                      # Ollama & vLLM speak the OpenAI dialect
DIRECT_LLM_MODEL = <model name>
EGRESS_ALLOWLIST = ollama                         # (CPU)  or  vllm (GPU)
```

---

## Quick start

Pick **one** profile. Each has its own env template; there is no shared one.

```bash
cd deploy/on-prem

# CPU (no GPU):
cp .env.onprem.cpu.example .env.onprem
# …fill in every `replace-with-…` value, then:
pnpm onprem:preflight -- --profile cpu --env-file deploy/on-prem/.env.onprem
docker compose -f docker-compose.cpu.yml --env-file .env.onprem up -d --build

# Private GPU profile — only after the bank has approved the model artifact,
# immutable revision, vLLM image, secrets, reverse proxy and GPU capacity.
cp .env.onprem.gpu.example .env.onprem
pnpm onprem:preflight -- --profile gpu --env-file deploy/on-prem/.env.onprem
docker compose -f docker-compose.gpu.yml --env-file .env.onprem up -d --build
```

**Run the preflight first.** It reads the env file only — it starts nothing and
contacts nothing — and refuses a configuration that still holds template
placeholders, reuses one secret across roles, pins an image to a floating tag,
or would publish the gateway beyond loopback. Compose itself will refuse to
start without the required secrets, but it cannot tell a real password from
`replace-with-a-strong-database-password`.

Then open `http://127.0.0.1:3000`. Check the residency posture in the startup
logs: `docker compose logs app | grep residency` → should read `mode=on_premise`.

> The app refuses to boot in `on_premise` mode if `JWT_SECRET` is missing, too
> short, or still a template value. That is deliberate: a placeholder signing key
> forges a session as any user, including `super_admin`, and nothing downstream
> would notice.

### Database migrations
The bundled MySQL starts empty — apply the schema once before first use. Pick one:

- **Option A — migrate from a build machine** (simplest). Temporarily expose the DB
  port, then from a checkout of the repo on a machine with `pnpm`:
  ```bash
  DATABASE_URL='mysql://root:<password>@<host>:3306/reconcileai' pnpm db:migrate
  ```
- **Option B — point at an existing bank MySQL** that already has the ReconcileAI
  schema, by setting `DATABASE_URL` in `.env.onprem` (and drop the bundled `db`
  service from the compose file).

> `pnpm db:migrate` runs `drizzle-kit migrate` against `drizzle/` (the migration
> files shipped in the image). For a fully offline rollout, run the migration as a
> release step in your packaging pipeline before shipping the stack.

---

## Serving boundary: local development versus bank deployment

**Ollama and Qwen are complementary, not alternative model families.** Qwen is the
model family; Ollama is the CPU runtime used for local development, controlled
demonstrations, and first-class bank deployment where GPU infrastructure is not
available. The CPU profile deliberately does not expose Ollama’s port to the host
network and supports an offline import of a verified Qwen GGUF artifact.

For a bank-facing pilot or production deployment, use the GPU profile. It keeps
vLLM on an internal Docker network, requires an API key for the
application-to-vLLM hop, suppresses request-content logging at the serving layer,
and binds the app to host loopback. The bank must put its approved reverse proxy or
API gateway in front of the app for TLS, OIDC or SSO, RBAC, rate limiting,
monitoring and immutable audit logging. This Compose profile is a technical
baseline, not a substitute for the bank's model-risk, security, legal, or
change-control approval.

Before the GPU profile is started, the institution must provide an approved model
artifact and immutable revision, a scanned and pinned vLLM container image, a
deployment-specific `VLLM_API_KEY` from its secret manager, capacity-test evidence,
and a rollback plan. The model must remain advisory: deterministic ReconcileAI
rules remain the source of truth for balances, matching, postings and settlement
finality.

For a CPU-only bank deployment, set `OLLAMA_MODEL_MODE=import` and
`RECON_MODEL=reconcileai` in `.env.onprem`, place the verified
`reconcileai-recon-3b-q4_k_m.gguf` artifact and its `SHA256SUMS` manifest under
`deploy/on-prem/models/`, together with the supplied `models/Modelfile`. Before shipping the
package, independently compare the manifest digest with the signed release record.
The bootstrap checks the artifact **twice**, and the second check is the one that
matters:

1. `sha256sum -c SHA256SUMS` — the shipped bytes match the shipped manifest.
   This proves the media survived the journey.
2. the bytes also match `RECON_MODEL_SHA256`, supplied **out of band** from the
   signed release record. `SHA256SUMS` travels with the GGUF, so anyone who can
   swap the model can regenerate the manifest to match it; a manifest cannot
   authorise its own import. The approved digest must reach the institution on a
   different path than the media — the release record, or its secret manager.

If either check fails, `model-init` exits non-zero. Because the application
declares `model-init: service_completed_successfully`, **the app never starts**.
A verification failure stops the deployment visibly instead of leaving a stack
running against a model that was never imported.

Do not run `ollama create` by hand: it bypasses both checks.

The import runs inside the private network and does not call the internet. A
stock-model pull is retained solely for development or controlled demonstrations
before the deployment is air-gapped, and the preflight rejects it for an
institution deployment.

### Private evidence and report storage

Both profiles include an internal-only MinIO service and a one-shot
`storage-init` service. MinIO has no host port, and the application reaches
`http://minio:9000` only on the internal Docker network.

`storage-init` creates the bucket **and a bucket-scoped service account**, then
proves that account works before the app is allowed to start. The application
holds `MINIO_APP_ACCESS_KEY` / `MINIO_APP_SECRET_KEY`, never the MinIO root
credentials: root can delete every bucket and mint new users, which is not a
privilege a reconciliation web app needs. Verified against a live MinIO — the
app credential can read and write its own bucket, and is denied bucket creation,
user administration, and any access to another bucket.

`.env.onprem` is **not** loaded into the application container. It is the Compose
interpolation source and holds infrastructure secrets; the compose files
enumerate the app's environment explicitly so those secrets stay out of the web
app's process environment. Add new application variables to that list.

A bank that operates an approved internal S3-compatible service can replace the
MinIO service only after matching the same private-network, bucket-bootstrap,
least-privilege, backup, and recovery evidence.

### Local dashboard access boundary

Both profiles publish exactly one host port: the `gateway`, on `127.0.0.1:3000`
by default. Nginx forwards that loopback-only endpoint to the internal app
network. The app, MySQL, the model runtime and MinIO have no host-published
port. For an institution-managed TLS or LAN endpoint, retain the local gateway
binding and place the bank-approved reverse proxy in front of it.

> The gateway is not decoration. A container attached only to an
> `internal: true` network **cannot** serve a published host port — the
> connection is refused. Publishing the app directly produces a stack that
> starts cleanly and is unreachable. `tools/onPremServingProfile.test.ts`
> asserts that the gateway is the only publishing service in both profiles.

---

## Day-1 vs. fine-tuned model

You do **not** need a trained model to stand this up:

- **Day-1 (no training):** the defaults pull a stock instruct model
  (`qwen2.5:3b-instruct-q4_K_M` on CPU, `Qwen/Qwen2.5-7B-Instruct` on GPU). The app
  works immediately because it sends its own domain system-prompts per call.
- **Fine-tuned ("robustly trained"):** follow [`../../ml/README.md`](../../ml/README.md)
  to produce a ReconcileAI-tuned model, then:
  - **CPU:** quantize to GGUF, place it and its `SHA256SUMS` in `models/` beside
    the supplied `models/Modelfile`, and set `OLLAMA_MODEL_MODE=import` plus
    `RECON_MODEL`, `RECON_MODEL_FILE` and `RECON_MODEL_SHA256`. The compose
    bootstrap does the `ollama create` after verifying the artifact.
  - **GPU:** stage the merged model in the `hf-cache` volume and set
    `RECON_MODEL` + `MODEL_REVISION`; it is served as `reconcileai`.

> **Day-1 is a demonstration posture, not a deployment one.** The stock-model
> path pulls from the internet and skips artifact verification entirely, so
> `pnpm onprem:preflight` fails a `pull`-mode configuration. Use it to show the
> product; ship the verified import.

---

## Air-gapped install (no internet at the client)

1. **On a connected machine (ReconcileAI side):**
   - `docker build` the app image, and `docker pull` every image **by the digest
     recorded in the env template** — not by tag, so the bytes the institution
     scanned are the bytes it runs.
   - Produce the model artifact: GGUF + `SHA256SUMS` + `Modelfile` in `models/`
     (CPU), or a populated `hf-cache` volume (GPU).
   - `docker save` every image to a tarball.
2. **Ship** the tarballs + this folder on physical media. Send the approved
   `RECON_MODEL_SHA256` **separately** — it is the control that makes the media
   tamper-evident, so it must not travel on the media.
3. **On the air-gapped host:** `docker load` each image, fill in `.env.onprem`,
   run `pnpm onprem:preflight`, then `docker compose up`. `model-init` verifies
   the artifact and imports it; the app starts only if that succeeded.

---

## Hardware sizing (rough guide)

| Stack | Model | RAM | Disk | Latency / exception | Notes |
|---|---|---|---|---|---|
| CPU | 1.5B Q4 | 4–6 GB | ~2 GB | **not measured** | lowest-cost box |
| CPU | 3B Q4 | 8–12 GB | ~3 GB | **not measured — see below** | recommended CPU default |
| GPU | Qwen 8B+ | Size after capacity test | Model + cache | **not measured** | private vLLM serving only |

> ⚠️ **The latency column previously read "~2–4 s" and "~4–8 s". Those were
> estimates, not measurements, and the first real measurement contradicts them.**
> Running the held-out evaluation against the trained 3B Q4 model on the
> reference laptop (Docker Desktop, CPU only), **3 of 36 cases produced no
> response within 600 seconds**; the rest averaged roughly a minute. A bank
> sizing its hardware from the old figures would have been wrong by two orders
> of magnitude.
>
> Whether that tail is the model, the host, or the serving configuration is not
> yet established — a laptop under Docker Desktop is not a capacity benchmark.
> What *is* established is that no latency figure here can be relied upon until
> the institution measures it on its own hardware, which is week 4 of
> [`ACCELERATED_DUAL_TIER_EXECUTION.md`](../../docs/deployment/ACCELERATED_DUAL_TIER_EXECUTION.md).
> Leaving a plausible-looking estimate in this column is worse than leaving it
> blank, so it is blank.

> Reconciliation is **batch**, not real-time chat, and most exceptions are
> resolved by the engine's deterministic classifier before the LLM is called at
> all — so a slow tail matters far less here than it would in a chat product.
> That is a reason to measure it rather than a reason not to.

---

## Security notes

- **Read-only to the core:** the engine only ever *reads* the bank's Fineract/CBS data.
- **Enforced residency:** `on_premise` mode fails closed — an accidental external
  call throws instead of leaking data.
- **No default credentials.** Every secret is a required variable with no
  fallback, so the stack cannot start on a password published in this repository.
- **Least privilege for storage:** the app holds a bucket-scoped MinIO service
  account, not the root credential.
- **Digest-pinned images.** A tag can be repointed after the institution scans
  it; `repo@sha256:…` cannot. The preflight rejects floating tags.
- **No privilege escalation:** every container sets `no-new-privileges:true`.
- **Secrets stay out of argv.** The vLLM key is passed as an environment
  variable, and the MySQL health check uses `MYSQL_PWD` — a password on a
  command line is readable via `docker inspect` and `docker top`.
- Put the app behind the bank's reverse proxy/TLS; do not expose port 3000 directly.
- Rotate `JWT_SECRET` and `MYSQL_ROOT_PASSWORD` per deployment.

### What this profile does NOT provide

The Compose stack is a technical baseline. The institution still owns TLS
termination, SSO/OIDC and RBAC at the edge, WAF and rate limiting, SIEM
forwarding and immutable audit retention, certificate rotation, backup
encryption and restore rehearsal, network segmentation, and the model-risk,
legal and change-control approvals. Nothing here substitutes for those.
