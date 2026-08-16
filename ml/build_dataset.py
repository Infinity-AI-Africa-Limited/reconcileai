#!/usr/bin/env python3
"""
ReconcileAI — training-dataset builder.

Generates an instruction-tuning dataset (chat format, JSONL) that teaches a base
LLM the ReconcileAI reconciliation task: given a GL journal-entry anomaly, output
a strict-JSON analysis with {classification, priority, confidence, explanation,
recommended_action}.

The taxonomy, recommended actions, confidence levels and priority thresholds below
are taken DIRECTLY from server/woodcore-engine.ts so the model learns the engine's
real behaviour and voice (not a generic reconciliation notion).

Pure standard library — no dependencies, runs anywhere Python 3.9+ is available:

    python build_dataset.py --n-per-category 250 --out data/

Produces data/train.jsonl and data/val.jsonl in the chat format trl/transformers
expect:  {"messages": [{"role": "system", ...}, {"role": "user", ...}, {"role": "assistant", ...}]}
"""
import argparse
import json
import os
import random
import sys
from datetime import date, timedelta

# The CPU tier is delivered onto Windows hosts, where the console defaults to
# cp1252 and any non-ASCII character in a print() aborts the script — after it
# has already written some of its output files. Force UTF-8 rather than trading
# the arrows for ASCII, so the same failure cannot come back with a new glyph.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# ── System prompt: the production framing used by the Layer-3 agent ──────────
SYSTEM_PROMPT = (
    "You are the ReconcileAI reconciliation analyst for a Nigerian core banking "
    "system (Apache Fineract / Woodcore CBS). You are given a single General "
    "Ledger journal-entry anomaly detected during GL-vs-subledger reconciliation. "
    "Classify it, explain it in plain English for a finance officer, assign a "
    "priority by financial impact, and recommend a specific corrective action. "
    "Respond with strict JSON only, matching this schema: "
    '{"classification": string, "priority": "CRITICAL|HIGH|MEDIUM|LOW", '
    '"confidence": integer 0-100, "explanation": string, "recommended_action": string}.'
)

# ── Recommended actions — verbatim from EXCEPTION_ACTIONS in woodcore-engine.ts ─
RECOMMENDED_ACTION = {
    "DISBURSEMENT_MISPOSTING": "Raise with the CBS administrator to investigate the disbursement posting rule for the SME Loan product. The disbursement was posted to the wrong GL account — it should debit the loan portfolio account but was posted elsewhere. Raise a correcting journal entry to move the debit to the correct account. Verify the product-to-ledger mapping in the CBS configuration.",
    "DISBURSEMENT_NOT_POSTED": "The loan disbursement was recorded in the CBS loan transaction table but no corresponding GL debit was posted to the Loan Portfolio Account. This is a critical control failure — the GL balance understates outstanding principal. Raise with the CBS DBA immediately to investigate the posting engine failure and post the missing GL entry.",
    "REPAYMENT_NOT_POSTED": "A loan repayment principal portion was recorded in the CBS loan transaction table but no corresponding GL credit was posted to the Loan Portfolio Account. The GL balance overstates outstanding principal. Raise with the CBS DBA to investigate the posting engine and post the missing GL credit entry.",
    "PRINCIPAL_ADJUSTMENT_ANOMALY": "A manual entry was posted directly to the Loan Portfolio Account without a corresponding loan transaction record. Manual adjustments to the principal balance require dual authorisation and a supporting loan transaction. Obtain the authorisation documentation, verify the business justification, and raise a correcting entry if the adjustment was not properly approved.",
    "ORPHANED_LOAN_ENTRY": "This GL entry references a loan transaction ID that does not exist in the CBS loan transaction table. This could indicate a deleted transaction, a direct GL insert bypassing the CBS posting engine, or a data migration artefact. Raise with the CBS DBA to investigate and either link the entry to a valid loan transaction or reverse it.",
    "CROSS_PRODUCT_MISPOSTING": "Raise with CBS administrator to investigate product-to-ledger mapping. Verify whether the originating transaction should have been posted to a different product's ledger. If confirmed, raise a correcting journal entry via the CBS workflow.",
    "MANUAL_POSTING": "Obtain supporting documentation for the manual entry from the originating user. Verify the approval chain. If the entry is unauthorised, escalate to the compliance team immediately.",
    "ORPHANED_ENTRY": "Raise with the CBS DBA to investigate whether the linked transaction was deleted or never created. If this is a data migration artefact, document and exclude from future reconciliation runs.",
    "REVERSAL_ANOMALY": "Raise with the CBS administrator to complete the reversal in acc_gl_journal_entry. Verify that the reversal was intentional and that the corresponding transaction was correctly reversed.",
    "MANUAL_POSTING_ANOMALY": "Obtain supporting documentation for the amount or date discrepancy. Verify whether the difference represents a legitimate adjustment or a data entry error.",
}

# Per-category confidence the engine assigns (woodcore-engine.ts runLayer3).
CONFIDENCE = {
    "DISBURSEMENT_MISPOSTING": 95, "DISBURSEMENT_NOT_POSTED": 97,
    "REPAYMENT_NOT_POSTED": 97, "PRINCIPAL_ADJUSTMENT_ANOMALY": 90,
    "ORPHANED_LOAN_ENTRY": 88, "CROSS_PRODUCT_MISPOSTING": 95,
    "MANUAL_POSTING": 90, "ORPHANED_ENTRY": 88, "REVERSAL_ANOMALY": 92,
    "MANUAL_POSTING_ANOMALY": 80,
}

LOAN_CATEGORIES = [
    "DISBURSEMENT_MISPOSTING", "DISBURSEMENT_NOT_POSTED", "REPAYMENT_NOT_POSTED",
    "PRINCIPAL_ADJUSTMENT_ANOMALY", "ORPHANED_LOAN_ENTRY",
]
SAVINGS_CATEGORIES = [
    "CROSS_PRODUCT_MISPOSTING", "MANUAL_POSTING", "ORPHANED_ENTRY",
    "REVERSAL_ANOMALY", "MANUAL_POSTING_ANOMALY",
]

LOAN_PORTFOLIO = ("117083", "SME Loan Portfolio")
SAVINGS_CONTROL = ("100001", "Savings Control Account")
OTHER_PRODUCTS = ["Premium Savings", "Target Savings", "Kids Save", "Current Account", "Agric Loan", "Asset Finance"]


def ngn(x: float) -> str:
    return "₦" + f"{x:,.2f}"


def priority_for(amount: float) -> str:
    """Mirrors getPriorityLevel() in woodcore-engine.ts."""
    a = abs(amount)
    if a >= 500_000:
        return "CRITICAL"
    if a >= 100_000:
        return "HIGH"
    if a >= 10_000:
        return "MEDIUM"
    return "LOW"


def explanation_for(cat, amount, gtype, dt, ref, txn_id, other_product):
    """Parametrised versions of the agentExplanation templates in the engine."""
    a = ngn(amount)
    if cat == "DISBURSEMENT_MISPOSTING":
        return (f"A loan disbursement of {a} recorded on {dt} was not debited to the "
                f"{LOAN_PORTFOLIO[1]} (GL {LOAN_PORTFOLIO[0]}). The disbursement exists in the CBS loan "
                f"transaction table (ref: {ref}) but the GL debit was posted to a different account, so "
                f"the portfolio balance understates outstanding principal by {a}. Raise a correcting journal entry.")
    if cat == "DISBURSEMENT_NOT_POSTED":
        return (f"A loan disbursement of {a} was recorded in the CBS loan transaction table on {dt} "
                f"(ref: {ref}) but no GL entry was posted to the Loan Portfolio Account. This is a critical "
                f"posting-engine failure — outstanding principal in the GL is understated by {a}.")
    if cat == "REPAYMENT_NOT_POSTED":
        return (f"A loan repayment principal portion of {a} was recorded in the CBS on {dt} (ref: {ref}) "
                f"but no corresponding GL credit was posted to the {LOAN_PORTFOLIO[1]} (GL {LOAN_PORTFOLIO[0]}). "
                f"The GL overstates outstanding principal by {a}. Post the missing credit and investigate the engine.")
    if cat == "PRINCIPAL_ADJUSTMENT_ANOMALY":
        return (f"A manual journal entry of {a} ({gtype}) was posted directly to the Loan Portfolio Account on {dt} "
                f"with no linked loan transaction — it bypassed the CBS posting engine. Manual principal adjustments are "
                f"a high-risk control failure; obtain authorisation documentation and verify the justification immediately.")
    if cat == "ORPHANED_LOAN_ENTRY":
        return (f"This GL entry of {a} ({gtype}) on {dt} references loan transaction ID {txn_id}, which does not exist "
                f"in the CBS loan transaction table. Possible causes: a deleted transaction, a direct GL insert bypassing "
                f"the posting engine, or a migration artefact. Investigate and either re-link or reverse it.")
    if cat == "CROSS_PRODUCT_MISPOSTING":
        return (f"This GL entry of {a} ({gtype}) was posted to the {SAVINGS_CONTROL[1]} ledger on {dt}, but it traces back "
                f"to a savings account belonging to the \"{other_product}\" product, not the product being reconciled. "
                f"A transaction from one product has been posted to another product's ledger — a direct cause of the variance.")
    if cat == "MANUAL_POSTING":
        return (f"This GL entry of {a} ({gtype}) on {dt} is flagged as a manual entry (manual_entry = 1), ref \"{ref}\". "
                f"Manual entries bypass the CBS automated posting engine and have no linked transaction in the bridge table, "
                f"confirming it was posted directly to the GL — a common source of reconciliation variance.")
    if cat == "ORPHANED_ENTRY":
        return (f"This GL entry of {a} ({gtype}) on {dt} has no record in the CBS transaction bridge table "
                f"(acc_to_gl_journal_entry); transaction \"{ref}\" cannot be traced to any savings transaction. "
                f"Likely a deleted transaction, a direct GL insert, or a migration artefact. It cannot be auto-validated.")
    if cat == "REVERSAL_ANOMALY":
        return (f"This GL entry of {a} ({gtype}) on {dt} is linked to a savings transaction marked reversed "
                f"(is_reversed = 1), but the GL entry itself was never reversed. This incomplete reversal leaves a "
                f"phantom balance in the ledger.")
    if cat == "MANUAL_POSTING_ANOMALY":
        return (f"This GL entry of {a} ({gtype}) on {dt} is linked to a valid savings transaction, but the amounts do not "
                f"match within tolerance. This may be a partial posting, a manual override of an automated entry, or a "
                f"rounding difference beyond tolerance. Review both records to decide if a correcting entry is required.")
    return f"Anomaly of {a} ({gtype}) on {dt} requires manual investigation."


def random_date(rng):
    start = date(2025, 1, 1)
    return (start + timedelta(days=rng.randint(0, 240))).isoformat()


def make_example(cat, rng):
    is_loan = cat in LOAN_CATEGORIES
    gl_code, gl_name = LOAN_PORTFOLIO if is_loan else SAVINGS_CONTROL
    # Spread amounts across all four priority bands so the model learns the thresholds.
    band = rng.choice(["low", "med", "high", "crit"])
    amount = {
        "low": rng.uniform(500, 9_999),
        "med": rng.uniform(10_000, 99_999),
        "high": rng.uniform(100_000, 499_999),
        "crit": rng.uniform(500_000, 8_000_000),
    }[band]
    amount = round(amount, 2)
    gtype = rng.choice(["DEBIT", "CREDIT"])
    dt = random_date(rng)
    gl_id = rng.randint(100000, 999999)
    txn_id = rng.randint(200000, 900000)
    ref = f"{'LOAN' if is_loan else 'SAV'}-TXN-{txn_id}"
    manual = cat in ("MANUAL_POSTING", "PRINCIPAL_ADJUSTMENT_ANOMALY")
    bridged = cat in ("REVERSAL_ANOMALY", "MANUAL_POSTING_ANOMALY", "CROSS_PRODUCT_MISPOSTING")
    other_product = rng.choice(OTHER_PRODUCTS)
    desc = rng.choice(["", "Adjustment", "Reclassification", "Month-end posting", "Correction", "Batch upload"])

    user = (
        "Analyse this GL journal entry anomaly:\n"
        f"- GL Entry ID: {gl_id}\n"
        f"- Amount: {ngn(amount)} ({gtype})\n"
        f"- Date: {dt}\n"
        f"- Account: {gl_name} (GL {gl_code})\n"
        f"- Description: {desc or 'None'}\n"
        f"- Reference: {ref}\n"
        f"- Manual Entry: {'Yes' if manual else 'No'}\n"
        f"- Bridge Table Linkage: {'Yes' if bridged else 'No'}\n"
        f"- Product Match: {'No' if cat == 'CROSS_PRODUCT_MISPOSTING' else 'Yes' if bridged else 'Unknown'}\n"
        f"- Category assigned by classifier: {cat}\n\n"
        "Explain what likely caused this anomaly and what the finance team should do."
    )

    assistant = {
        "classification": cat,
        "priority": priority_for(amount),
        "confidence": CONFIDENCE[cat],
        "explanation": explanation_for(cat, amount, gtype, dt, ref, txn_id, other_product),
        "recommended_action": RECOMMENDED_ACTION[cat],
    }

    return {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
            {"role": "assistant", "content": json.dumps(assistant, ensure_ascii=False)},
        ]
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-per-category", type=int, default=250,
                    help="examples per exception category (10 categories total)")
    ap.add_argument("--val-frac", type=float, default=0.12, help="held-out fraction")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="data", help="output directory")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    categories = LOAN_CATEGORIES + SAVINGS_CATEGORIES
    rows = [make_example(cat, rng) for cat in categories for _ in range(args.n_per_category)]
    rng.shuffle(rows)

    os.makedirs(args.out, exist_ok=True)
    n_val = int(len(rows) * args.val_frac)
    val, train = rows[:n_val], rows[n_val:]

    for name, data in (("train", train), ("val", val)):
        path = os.path.join(args.out, f"{name}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for r in data:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"wrote {len(data):>5} examples → {path}")
    print(f"categories: {len(categories)} | total: {len(rows)}")


if __name__ == "__main__":
    main()
