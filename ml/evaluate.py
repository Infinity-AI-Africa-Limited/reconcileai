#!/usr/bin/env python3
"""
ReconcileAI — model evaluation harness.

Scores a served model (Ollama or vLLM, OpenAI-compatible) on the held-out val set:
  • classification accuracy  (did it pick the right exception category?)
  • priority accuracy        (did it apply the amount thresholds correctly?)
  • JSON validity            (did it return parseable strict JSON?)

Point it at whatever endpoint is serving the model — local CPU or GPU, same call.
Uses only the standard library (urllib) so it runs anywhere, including air-gapped.

Example (CPU / Ollama):
  python evaluate.py --base-url http://localhost:11434/v1 --model reconcileai --val data/val.jsonl

Example (GPU / vLLM):
  python evaluate.py --base-url http://localhost:8000/v1 --model reconcileai --val data/val.jsonl
"""
import argparse
import json
import urllib.request


def chat(base_url, model, messages, timeout=120):
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.0,
        "max_tokens": 700,
    }).encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=body,
        headers={"content-type": "application/json", "authorization": "Bearer local"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def extract_json(text):
    """Tolerant parse: take the first {...} block if the model adds prose."""
    text = text.strip()
    start, depth = text.find("{"), 0
    if start == -1:
        return None
    for i in range(start, len(text)):
        depth += (text[i] == "{") - (text[i] == "}")
        if depth == 0:
            try:
                return json.loads(text[start:i + 1])
            except json.JSONDecodeError:
                return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--val", default="data/val.jsonl")
    ap.add_argument("--limit", type=int, default=0, help="0 = all")
    args = ap.parse_args()

    rows = [json.loads(line) for line in open(args.val, encoding="utf-8")]
    if args.limit:
        rows = rows[:args.limit]

    n = cls_ok = pri_ok = json_ok = 0
    for r in rows:
        msgs = r["messages"]
        gold = json.loads(msgs[-1]["content"])
        prompt = msgs[:-1]  # system + user
        try:
            out = chat(args.base_url, args.model, prompt)
        except Exception as e:  # noqa: BLE001
            print(f"  request failed: {e}")
            n += 1
            continue
        pred = extract_json(out)
        n += 1
        if pred is None:
            continue
        json_ok += 1
        if str(pred.get("classification", "")).upper() == gold["classification"]:
            cls_ok += 1
        if str(pred.get("priority", "")).upper() == gold["priority"]:
            pri_ok += 1

    def pct(x):
        return f"{(100.0 * x / n):.1f}%" if n else "n/a"

    print("─" * 48)
    print(f"  evaluated:              {n}")
    print(f"  valid JSON:             {pct(json_ok)}")
    print(f"  classification accuracy:{pct(cls_ok)}")
    print(f"  priority accuracy:      {pct(pri_ok)}")
    print("─" * 48)
    print("Target for production: JSON ≥ 99%, classification ≥ 95%, priority ≥ 98%.")


if __name__ == "__main__":
    main()
