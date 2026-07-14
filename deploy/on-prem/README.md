# ReconcileAI — On-Premise Deployment (Option 3: fully local, air-gapped)

This folder is a turnkey, **air-gapped** deployment of the ReconcileAI platform with
the LLM running **locally** — no internet, no cloud AI, transaction data never
leaves the bank's hardware. It ships in two flavours:

| Stack | File | Needs a GPU? | Best for |
|---|---|---|---|
| **CPU** | `docker-compose.cpu.yml` | ❌ No | Nigerian banks/MFBs with no GPU. Runs a small quantized model on Ollama. |
| **GPU** | `docker-compose.gpu.yml` | ✅ Yes (1× NVIDIA) | Institutions with (or renting) a GPU box. Runs a 7–8B model on vLLM. |

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

# GPU:
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
| GPU | 7–8B | 16 GB VRAM | ~16 GB | <1 s | full quality, high throughput |

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
