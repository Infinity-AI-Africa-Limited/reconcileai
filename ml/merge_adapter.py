"""Merge a verified Qwen LoRA adapter into its matching full-precision base model.

This script is intentionally limited to the packaging boundary: it accepts a local
adapter directory, loads the explicitly named base model, writes merged Safetensors
weights, and records immutable packaging provenance. GGUF conversion and quantization
must run only against this merged output.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path

import torch
from peft import PeftConfig, PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge a Qwen LoRA adapter for offline CPU packaging.")
    parser.add_argument("--base-model", required=True, help="Exact Hugging Face base model identifier or local path.")
    parser.add_argument("--adapter", required=True, type=Path, help="Directory containing adapter_config.json and adapter weights.")
    parser.add_argument("--output", required=True, type=Path, help="Empty directory for merged Safetensors output.")
    parser.add_argument("--revision", default=None, help="Optional immutable Hugging Face model revision.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    adapter_config = args.adapter / "adapter_config.json"
    adapter_weights = args.adapter / "adapter_model.safetensors"
    if not adapter_config.exists() or not adapter_weights.exists():
        raise FileNotFoundError("Adapter directory must contain adapter_config.json and adapter_model.safetensors.")

    config = PeftConfig.from_pretrained(str(args.adapter))
    if config.base_model_name_or_path != args.base_model:
        raise ValueError(
            "Adapter base model mismatch: "
            f"adapter requires {config.base_model_name_or_path!r}, received {args.base_model!r}."
        )
    if args.output.exists() and any(args.output.iterdir()):
        raise ValueError(f"Refusing to overwrite non-empty output directory: {args.output}")
    args.output.mkdir(parents=True, exist_ok=True)

    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        revision=args.revision,
        torch_dtype=torch.float16,
        low_cpu_mem_usage=True,
        device_map="auto",
    )
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, revision=args.revision)
    merged = PeftModel.from_pretrained(model, str(args.adapter)).merge_and_unload()
    merged.save_pretrained(args.output, safe_serialization=True, max_shard_size="2GB")
    tokenizer.save_pretrained(args.output)

    provenance = {
        "base_model": args.base_model,
        "requested_revision": args.revision,
        "adapter_config_sha256": sha256_file(adapter_config),
        "adapter_weights_sha256": sha256_file(adapter_weights),
        "adapter_type": config.peft_type.value if hasattr(config.peft_type, "value") else str(config.peft_type),
        "merged_with": {
            "torch": torch.__version__,
            "cuda_available": torch.cuda.is_available(),
        },
        "data_scope": "synthetic-only training adapter; no bank, customer, payment, or production data",
    }
    (args.output / "MODEL_PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
