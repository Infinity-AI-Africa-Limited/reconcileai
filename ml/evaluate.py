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

Example (GPU / vLLM — the serving profile requires a key):
  VLLM_API_KEY=... python evaluate.py --base-url http://localhost:8000/v1 --model reconcileai --val data/val.jsonl

Exits non-zero if any request failed, so a broken endpoint can never be recorded
as a quality score.
"""
import argparse
import json
import os
import sys
import urllib.request

# See build_dataset.py: Windows consoles default to cp1252 and would crash on the
# box-drawing characters in the scorecard below.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def chat(base_url, model, messages, api_key, timeout=120):
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.0,
        "max_tokens": 700,
    }).encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
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
    # The hardened GPU profile requires VLLM_API_KEY, so a fixed "Bearer local"
    # gets a 401 from every request and reports 0% on a model that is fine.
    # Ollama ignores the header, so "local" remains the right CPU default.
    ap.add_argument("--api-key", default=os.environ.get("VLLM_API_KEY", "local"),
                    help="bearer token for the serving endpoint (default: $VLLM_API_KEY, else 'local')")
    # A 3B Q4 model on a laptop CPU exceeded 120s on ~8% of held-out cases during
    # local validation, so the CPU tier needs headroom the GPU tier does not.
    ap.add_argument("--timeout", type=int, default=300,
                    help="per-request timeout in seconds (CPU serving is far slower than GPU)")
    args = ap.parse_args()

    rows = [json.loads(line) for line in open(args.val, encoding="utf-8")]
    if args.limit:
        rows = rows[:args.limit]

    n = cls_ok = pri_ok = json_ok = failed = 0
    first_error = None
    for r in rows:
        msgs = r["messages"]
        gold = json.loads(msgs[-1]["content"])
        prompt = msgs[:-1]  # system + user
        n += 1
        try:
            out = chat(args.base_url, args.model, prompt, args.api_key, args.timeout)
        except Exception as e:  # noqa: BLE001
            failed += 1
            if first_error is None:
                first_error = repr(e)
            print(f"  request failed: {e}")
            continue
        pred = extract_json(out)
        if pred is None:
            continue
        json_ok += 1
        if str(pred.get("classification", "")).upper() == gold["classification"]:
            cls_ok += 1
        if str(pred.get("priority", "")).upper() == gold["priority"]:
            pri_ok += 1

    # A transport failure and a bad model both drive these percentages to zero.
    # Reporting them identically invites a wrong verdict at an acceptance gate,
    # so a run with ANY failed request is not scored at all.
    if failed:
        print("─" * 48)
        print(f"  RUN INVALID — {failed} of {n} requests failed to reach the model.")
        print(f"  first error: {first_error}")
        print("  Check --base-url, --api-key (vLLM requires VLLM_API_KEY), and --model.")
        print("  No scorecard is produced: a connection failure is not a quality measurement.")
        print("─" * 48)
        return 1

    def pct(x):
        return f"{(100.0 * x / n):.1f}%" if n else "n/a"

    print("─" * 48)
    print(f"  evaluated:              {n}")
    print(f"  valid JSON:             {pct(json_ok)}")
    print(f"  classification accuracy:{pct(cls_ok)}")
    print(f"  priority accuracy:      {pct(pri_ok)}")
    print("─" * 48)
    print("Target for production: JSON ≥ 99%, classification ≥ 95%, priority ≥ 98%.")
    print("These are product gates on a synthetic-derived model. An institution")
    print("must re-measure on its own human-labelled set before any pilot.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
