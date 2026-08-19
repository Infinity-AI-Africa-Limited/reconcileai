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
from peft import __version__ as peft_version
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers import __version__ as transformers_version


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

    # Merge on CPU, deliberately. `device_map="auto"` shards the model across
    # GPU/CPU/disk, and merge_and_unload() on offloaded or meta tensors either
    # raises or — worse — writes a checkpoint in which some layers never
    # received the adapter delta. That produces a model that loads, serves, and
    # is quietly part-tuned. Merging is memory-bound, not compute-bound, so the
    # only cost of forcing CPU is a few minutes.
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        revision=args.revision,
        torch_dtype=torch.float16,
        low_cpu_mem_usage=True,
        device_map=None,
    )
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, revision=args.revision)
    peft_model = PeftModel.from_pretrained(model, str(args.adapter))
    merged = peft_model.merge_and_unload()

    # merge_and_unload() returns the base architecture once the LoRA layers are
    # folded in. If any remain, the merge silently did not happen.
    leftover = [name for name, _ in merged.named_modules() if "lora" in name.lower()]
    if leftover:
        raise RuntimeError(
            f"Merge incomplete: {len(leftover)} LoRA module(s) survived merge_and_unload, "
            f"first is {leftover[0]!r}. Refusing to write a part-tuned checkpoint."
        )

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
            "transformers": transformers_version,
            "peft": peft_version,
            "cuda_available": torch.cuda.is_available(),
        },
        "merged_files_sha256": {
            path.name: sha256_file(path)
            for path in sorted(args.output.glob("*.safetensors"))
        },
        "data_scope": "synthetic-only training adapter; no bank, customer, payment, or production data",
    }
    (args.output / "MODEL_PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
