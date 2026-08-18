#!/usr/bin/env python3
"""
ReconcileAI — LoRA/QLoRA supervised fine-tune.

Runs on a GPU host (rent one for ~1 hour: RunPod / Lambda / Vast). It is a ONE-TIME
job — the resulting small model then runs on CPU at the client (see ml/README.md).

Two target sizes:
  • CPU-target  : --base Qwen/Qwen2.5-3B-Instruct   (then quantize to GGUF Q4 → Ollama)
  • GPU-target  : --base Qwen/Qwen2.5-7B-Instruct   (serve merged dir with vLLM)

Example:
  python finetune.py \
      --base Qwen/Qwen2.5-3B-Instruct \
      --train data/train.jsonl --val data/val.jsonl \
      --out out/reconcileai-3b --epochs 3 --qlora

Requires: see requirements.txt. NOTE: not runnable on CPU-only machines.
"""
import argparse

import torch
from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen2.5-3B-Instruct")
    ap.add_argument("--train", default="data/train.jsonl")
    ap.add_argument("--val", default="data/val.jsonl")
    ap.add_argument("--out", default="out/reconcileai")
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    # `warmup_ratio` was NOT removed by TRL: SFTConfig -> _BaseConfig ->
    # transformers.TrainingArguments, which still defines it (verified against
    # trl 1.10.0). So the ratio stays the default, because it tracks dataset
    # size — a fixed step count silently under-warms a larger run and
    # over-warms a small one. --warmup-steps is an explicit override, and
    # TrainingArguments prefers it whenever it is greater than zero.
    ap.add_argument("--warmup-ratio", type=float, default=0.03,
                    help="fraction of total steps spent warming up (used unless --warmup-steps is set)")
    ap.add_argument("--warmup-steps", type=int, default=0,
                    help="absolute warm-up steps; overrides --warmup-ratio when > 0")
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--max-seq-len", type=int, default=2048)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--qlora", action="store_true", help="4-bit base (less VRAM)")
    ap.add_argument("--merge", action="store_true", help="merge adapter into base and save full model")
    return ap.parse_args()


def main():
    args = parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    quant = None
    if args.qlora:
        quant = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        quantization_config=quant,
        torch_dtype=torch.bfloat16,
        device_map="auto",
    )

    peft_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    )

    ds = load_dataset(
        "json",
        data_files={"train": args.train, "validation": args.val},
    )

    def format_chat(example):
        # The dataset stores {"messages": [...]}; render with the model's chat template.
        return {"text": tokenizer.apply_chat_template(
            example["messages"], tokenize=False, add_generation_prompt=False)}

    ds = ds.map(format_chat, remove_columns=ds["train"].column_names)

    cfg = SFTConfig(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=args.warmup_ratio,
        warmup_steps=args.warmup_steps,
        logging_steps=10,
        eval_strategy="epoch",
        save_strategy="epoch",
        bf16=True,
        max_length=args.max_seq_len,
        packing=False,
        dataset_text_field="text",
        report_to="none",
    )

    trainer = SFTTrainer(
        model=model,
        args=cfg,
        train_dataset=ds["train"],
        eval_dataset=ds["validation"],
        peft_config=peft_config,
        processing_class=tokenizer,
    )

    trainer.train()
    trainer.save_model(args.out)
    tokenizer.save_pretrained(args.out)
    print(f"adapter saved → {args.out}")

    if args.merge:
        from peft import AutoPeftModelForCausalLM
        merged = AutoPeftModelForCausalLM.from_pretrained(args.out, torch_dtype=torch.bfloat16)
        merged = merged.merge_and_unload()
        merged_dir = args.out + "-merged"
        merged.save_pretrained(merged_dir)
        tokenizer.save_pretrained(merged_dir)
        print(f"merged full model saved → {merged_dir}  (use for vLLM, or convert to GGUF)")


if __name__ == "__main__":
    main()
