# ReconcileAI — Local Model Training Toolkit

This folder produces the **ReconcileAI-tuned model** used by the on-premise
deployment ([`../deploy/on-prem`](../deploy/on-prem)). It teaches a small open base
model the platform's exact reconciliation behaviour — the exception taxonomy,
recommended actions, confidence levels and priority thresholds taken straight from
[`server/woodcore-engine.ts`](../server/woodcore-engine.ts).

## The core doctrine: train once on a rented GPU, run forever on CPU

> **Training needs a GPU. Running does not.**
>
> - **Training** (`finetune.py`) is a **one-time** job. Rent a GPU for ~1 hour
>   (RunPod / Lambda / Vast, roughly $2–10). ReconcileAI does this — **never the
>   client**.
> - **Running** the resulting small, quantized model happens on an **ordinary CPU
>   server** at the bank. No GPU purchase, ever.

This is the answer to "Nigerian institutions can't buy GPUs": they don't need to.

## Two model options

| | CPU option (no GPU at client) | GPU option (client has/rents a GPU) |
|---|---|---|
| Base model | Qwen2.5-3B-Instruct (or 1.5B for low RAM) | Qwen2.5-7B-Instruct |
| Served by | **Ollama** (GGUF Q4) | **vLLM** |
| Client hardware | 8–12 GB RAM CPU box | 1× NVIDIA, ~16 GB VRAM |
| Latency / exception | ~4–8 s | <1 s |
| Quality | Strong on this narrow task | Highest |

Both are fine-tuned with the **same** dataset and `finetune.py`; they differ only in
base size and how they're served.

## Pipeline (4 steps)

### 1. Build the dataset (no GPU, no dependencies)
```bash
python build_dataset.py --n-per-category 300 --out data/
# → data/train.jsonl, data/val.jsonl  (chat format)
```
Every example is grounded in the real engine taxonomy, so the model learns
ReconcileAI's voice and logic — not a generic notion of reconciliation. Add real,
de-identified historical exceptions to `data/train.jsonl` to sharpen it further.

### 2. Fine-tune (rented GPU, ~1 hour)
```bash
pip install -r requirements.txt
# CPU-target model:
python finetune.py --base Qwen/Qwen2.5-3B-Instruct \
    --train data/train.jsonl --val data/val.jsonl \
    --out out/reconcileai-3b --epochs 3 --qlora --merge
# GPU-target model: swap --base Qwen/Qwen2.5-7B-Instruct --out out/reconcileai-7b
```
Produces a LoRA adapter and (with `--merge`) a full merged model dir.

### 3a. Package for CPU (Ollama / GGUF)
First merge the adapter with its **exact** full-precision base model. The merge step
writes `MODEL_PROVENANCE.json`, including adapter hashes and the declared synthetic-only
data scope. It must never be pointed at a different Qwen variant.
```bash
python merge_adapter.py \
  --base-model Qwen/Qwen2.5-3B-Instruct \
  --adapter /path/to/reconcileai-adapter \
  --output out/reconcileai-3b-merged
```

Convert the resulting merged model to GGUF and quantize to 4-bit, using `llama.cpp`:
```bash
# one-time, on any machine with llama.cpp built:
python llama.cpp/convert_hf_to_gguf.py out/reconcileai-3b-merged \
    --outfile reconcileai-recon-3b-f16.gguf
./llama.cpp/llama-quantize reconcileai-recon-3b-f16.gguf \
    reconcileai-recon-3b-q4_k_m.gguf Q4_K_M
```
Place the resulting GGUF and a `SHA256SUMS` manifest in
`../deploy/on-prem/models/`, beside the supplied `Modelfile`:
```bash
cp reconcileai-recon-3b-q4_k_m.gguf ../deploy/on-prem/models/
cd ../deploy/on-prem/models && sha256sum reconcileai-recon-3b-q4_k_m.gguf Modelfile > SHA256SUMS
```

Record **both** digests in the **signed release record** — the Modelfile is an
approved artifact too, since it holds the system prompt and the `FROM` that
picks the weights and deliver it to the
institution separately from the media — it becomes `RECON_MODEL_SHA256`.

Then set in `.env.onprem`:
```bash
OLLAMA_MODEL_MODE=import
RECON_MODEL=reconcileai
RECON_MODEL_FILE=reconcileai-recon-3b-q4_k_m.gguf
RECON_MODEL_SHA256=<the GGUF digest from the signed release record>
RECON_MODELFILE_SHA256=<the Modelfile digest from the signed release record>
```

**Do not run `ollama create` yourself.** The CPU Compose profile's `model-init`
service does it, after checking the artifact against both the shipped manifest
and the out-of-band digest. Running it by hand skips both checks — which is the
one thing the packaging process exists to prevent.

### 3b. Package for GPU (vLLM)
No conversion needed. Stage the merged model in the `hf-cache` volume the GPU
profile mounts, and point the profile at it through `.env.onprem`:
```bash
RECON_MODEL=/root/.cache/huggingface/reconcileai-7b-merged
MODEL_REVISION=<the 40-char commit SHA the institution reviewed — NOT a tag or branch>
HF_HUB_OFFLINE=1
```
`--served-model-name reconcileai` is already set in the compose file, so the
application's `DIRECT_LLM_MODEL` needs no change. Staging the weights rather
than letting vLLM fetch them is what keeps start-up offline.

> `MODEL_REVISION` must be an immutable commit SHA, and both the preflight and
> the start-up gate reject anything else. A tag is a mutable pointer: `refs/<tag>`
> can be repointed at different weights after the institution approved the
> artifact, and every check downstream would still pass while vLLM served the
> substitute. For a local merged-model path there is no revision to resolve and
> the field is documentation only.

### 4. Evaluate (no GPU)
```bash
# CPU / Ollama — the endpoint ignores the bearer token
python evaluate.py --base-url http://localhost:11434/v1 --model reconcileai --val data/val.jsonl

# GPU / vLLM — the hardened serving profile REQUIRES the key
VLLM_API_KEY=... python evaluate.py --base-url http://vllm:8000/v1 --model reconcileai --val data/val.jsonl
```
The harness exits non-zero and prints no scorecard if any request failed. A
transport failure and a bad model both drive accuracy to zero, and an acceptance
gate must never confuse the two.

Ship when: **JSON ≥ 99%, classification ≥ 95%, priority ≥ 98%.**

### First measured run (2026-08-18, reference laptop, CPU)

`reconcileai-cpu:synthetic-v1` against a 36-case held-out **synthetic** split:

| Measure | Result | 95% CI | Gate |
|---|---|---|---|
| valid JSON | 36/36 — 100% | [90.4, 100] | ≥99% |
| classification | 36/36 — 100% | [90.4, 100] | ≥95% |
| priority | 35/36 — 97.2% | [85.8, 99.5] | ≥98% |

**None of these gates is resolved by this run, including the two it appears to
pass.** At n=36 the confidence interval on a perfect score still reaches down to
90%, so "100%" and "97.2%" are not distinguishable from each other or from the
thresholds. Resolving a 98% gate needs a few hundred cases, not 36.

**And the 100% is the least reassuring number here.** The held-out split comes
from the same generator (`build_dataset.py`) as the training data, so the model
is being asked to reproduce a distribution it was fitted to. A near-perfect
score is the *expected* outcome and evidence of memorising the generator — it
says nothing about a bank's real exceptions, which is the only question that
matters for a pilot.

What the run does establish: the model emits schema-valid strict JSON reliably,
terminates cleanly on every case (36/36 `finish_reason=stop`, 136–214 tokens),
and is not degenerate. That is a smoke test worth having, and it is not an
acceptance measurement.

> ⚠️ These are product gates measured against the **synthetic** held-out split,
> which is drawn from the same generator as the training data. A strong score
> there says the model learned the generator, not that it generalises to a
> bank's real exceptions. No institution pilot may rely on it: re-measure on the
> bank's own human-labelled set inside its environment, per
> [`../docs/deployment/ACCELERATED_DUAL_TIER_EXECUTION.md`](../docs/deployment/ACCELERATED_DUAL_TIER_EXECUTION.md)
> week 4.

## Why a small model is enough here

The reconciliation task is narrow and structured, and most exceptions are already
resolved by the engine's **deterministic** classifier before the LLM is called. The
model mainly handles novel ("UNKNOWN") cases and natural-language polish — well
within reach of a fine-tuned 3B model on CPU.

## Honest scope note

This toolkit is the full pipeline; the actual model **weights are produced by running
`finetune.py` on a GPU host** — that step cannot run on a CPU-only machine and is not
included as a binary artifact. Everything needed to produce, package, deploy and
evaluate the model is here.
