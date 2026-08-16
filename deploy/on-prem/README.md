# ReconcileAI — On-Premise Deployment (Option 3: fully local, air-gapped)

This folder is a turnkey, **air-gapped** deployment of the ReconcileAI platform with
the LLM running **locally** — no internet, no cloud AI, transaction data never
leaves the bank's hardware. It ships in two flavours:

| Stack | File | Needs a GPU? | Best for |
|---|---|---|---|
| **CPU development** | `docker-compose.cpu.yml` | ❌ No | Controlled local development and demonstrations. Runs a small quantized Qwen model through Ollama. |
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

```bash
cd deploy/on-prem
cp .env.onprem.example .env.onprem      # edit JWT_SECRET + MYSQL_ROOT_PASSWORD

# CPU (no GPU):
docker compose -f docker-compose.cpu.yml --env-file .env.onprem up -d --build

# Private GPU profile — only after the bank has approved the model artifact,
# immutable revision, vLLM image, secrets, reverse proxy and GPU capacity.
cp .env.onprem.gpu.example .env.onprem
docker compose -f docker-compose.gpu.yml --env-file .env.onprem up -d --build
```

Then open `http://<host>:3000`. Check the residency posture in the startup logs:
`docker compose logs app | grep residency` → should read `mode=on_premise`.

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
model family; Ollama is a convenient local runtime. Keep the CPU profile on a
developer laptop or controlled internal demonstration environment. It deliberately
does not expose Ollama’s port to the host network.

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

---

## Day-1 vs. fine-tuned model

You do **not** need a trained model to stand this up:

- **Day-1 (no training):** the defaults pull a stock instruct model
  (`qwen2.5:3b-instruct-q4_K_M` on CPU, `Qwen/Qwen2.5-7B-Instruct` on GPU). The app
  works immediately because it sends its own domain system-prompts per call.
- **Fine-tuned ("robustly trained"):** follow [`../../ml/README.md`](../../ml/README.md)
  to produce a ReconcileAI-tuned model, then:
  - **CPU:** quantize to GGUF, `ollama create reconcileai -f ollama/Modelfile`, set
    `RECON_MODEL=reconcileai`.
  - **GPU:** point vLLM `--model` at your merged model dir; it's already served as
    `reconcileai`.

---

## Air-gapped install (no internet at the client)

1. **On a connected machine (ReconcileAI side):**
   - `docker build` the app image and `docker pull` `mysql:8.0`, `ollama/ollama`
     (or `vllm/vllm-openai`).
   - Pre-download the model (CPU: `ollama pull …` into a named volume; GPU:
     populate the `hf-cache` volume).
   - `docker save` every image to a tarball.
2. **Ship** the tarballs + this folder on physical media.
3. **On the air-gapped host:** `docker load` each image, then `docker compose up`.
   The `model-init` service will find the model already present.

---

## Hardware sizing (rough guide)

| Stack | Model | RAM | Disk | Latency / exception | Notes |
|---|---|---|---|---|---|
| CPU | 1.5B Q4 | 4–6 GB | ~2 GB | ~2–4 s | lowest-cost box; fine for batch recon |
| CPU | 3B Q4 | 8–12 GB | ~3 GB | ~4–8 s | recommended CPU default |
| GPU | Qwen 8B+ | Size after capacity test | Model + cache | Capacity-test dependent | private vLLM serving only |

> Reconciliation is **batch**, not real-time chat — a few seconds per exception on
> CPU is perfectly acceptable, and most exceptions are resolved by the engine's
> deterministic classifier before the LLM is even called.

---

## Security notes

- **Read-only to the core:** the engine only ever *reads* the bank's Fineract/CBS data.
- **Enforced residency:** `on_premise` mode fails closed — an accidental external
  call throws instead of leaking data.
- Put the app behind the bank's reverse proxy/TLS; do not expose port 3000 directly.
- Rotate `JWT_SECRET` and `MYSQL_ROOT_PASSWORD` per deployment.
