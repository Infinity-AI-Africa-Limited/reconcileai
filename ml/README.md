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
`../deploy/on-prem/models/`. Independently verify the manifest against the signed
release record before delivery. The CPU Compose profile checks this manifest before
import. Then import into Ollama with the provided Modelfile:
```bash
cp reconcileai-recon-3b-q4_k_m.gguf ../deploy/on-prem/ollama/
cd ../deploy/on-prem/ollama && ollama create reconcileai -f Modelfile
```
Set `RECON_MODEL=reconcileai` in `.env.onprem` and restart the CPU stack.

### 3b. Package for GPU (vLLM)
No conversion needed — point vLLM at the merged dir:
```yaml
# in docker-compose.gpu.yml, vllm.command:
--model /models/reconcileai-7b-merged --served-model-name reconcileai
```
(mount the merged dir into the container as `/models`).

### 4. Evaluate (no GPU)
```bash
python evaluate.py --base-url http://localhost:11434/v1 --model reconcileai --val data/val.jsonl
```
Ship when: **JSON ≥ 99%, classification ≥ 95%, priority ≥ 98%.**

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
