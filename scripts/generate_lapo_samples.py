"""
Generate realistic LAPO MFB × Interswitch card settlement sample datasets.

Outputs two files in /home/ubuntu/reconcileai/client/public/:
  lapo_cbs_ledger_sample.csv      — CBS card settlement GL entries
  lapo_interswitch_settlement_sample.csv — Interswitch processor settlement file

Exception scenarios deliberately seeded:
  1. SETTLEMENT_SHORTFALL  — Interswitch settled less than CBS posted (fee deduction / shortfall)
  2. CHARGEBACK            — CBS has a reversal the processor file doesn't show yet
  3. IN_LEDGER_NOT_IN_BANK — CBS posted a card credit, Interswitch hasn't settled it
  4. IN_BANK_NOT_IN_LEDGER — Interswitch settled an amount CBS hasn't posted
  5. AMOUNT_MISMATCH       — Amounts differ by interchange/scheme fee
  6. DUPLICATE             — Same RRN appears twice on the Interswitch file
  7. LATE_PRESENTMENT      — Settlement date is outside the CBS posting window
  8. REVERSAL              — Matched reversal pair (both sides present, nets to zero)
"""

import csv
import random
import os
from datetime import date, timedelta

random.seed(42)

SETTLEMENT_DATE = date(2025, 6, 16)   # the "T+1" settlement date in the file
CBS_DATE        = date(2025, 6, 15)   # the transaction date posted in CBS

def rand_rrn():
    return str(random.randint(100_000_000_000, 999_999_999_999))

def rand_pan():
    # Verve (5061), Mastercard (5399), Visa (4111)
    prefix = random.choice(["506100", "539900", "411111"])
    return prefix + "".join(str(random.randint(0, 9)) for _ in range(10))

def rand_terminal():
    return "TRM" + "".join(str(random.randint(0, 9)) for _ in range(8))

def rand_merchant():
    merchants = [
        "SHOPRITE IKEJA", "CHICKEN REPUBLIC ABUJA", "TOTAL FILLING STATION",
        "JUMIA ONLINE", "KONGA MARKETPLACE", "DOMINOS PIZZA LEKKI",
        "GTBANK ATM WITHDRAWAL", "ACCESS BANK POS", "ZENITH BANK ATM",
        "LAPO AGENT BANKING", "QUICKTELLER AIRTIME", "INTERSWITCH WEBPAY",
        "SLOT SYSTEMS IKEJA", "SPAR SUPERMARKET", "TANTALIZERS RESTAURANT",
    ]
    return random.choice(merchants)

def rand_card_type():
    return random.choice(["VERVE", "MASTERCARD", "VISA"])

def fmt_amount(n):
    return f"{n:.2f}"

# ── Build matched base transactions (50 clean matches) ─────────────────
base_txns = []
for i in range(50):
    rrn = rand_rrn()
    amount = round(random.uniform(500, 250_000), 2)
    pan = rand_pan()
    terminal = rand_terminal()
    merchant = rand_merchant()
    card_type = rand_card_type()
    base_txns.append({
        "rrn": rrn, "amount": amount, "pan": pan,
        "terminal": terminal, "merchant": merchant, "card_type": card_type,
    })

# ── CBS ledger rows ─────────────────────────────────────────────────────
cbs_rows = []

# 50 clean matches
for t in base_txns:
    cbs_rows.append({
        "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
        "Value Date":       CBS_DATE.strftime("%Y-%m-%d"),
        "Narration":        f"CARD SETTLEMENT/{t['card_type']}/{t['merchant']}/{t['rrn']}",
        "Reference":        t["rrn"],
        "Debit (NGN)":      "",
        "Credit (NGN)":     fmt_amount(t["amount"]),
        "Balance (NGN)":    "",
        "Channel":          "CARD",
        "Card Type":        t["card_type"],
        "Terminal ID":      t["terminal"],
        "PAN (masked)":     t["pan"][:6] + "******" + t["pan"][-4:],
    })

# Exception 1: SETTLEMENT_SHORTFALL — 5 rows CBS posted full amount, Interswitch settles less
shortfall_txns = []
for i in range(5):
    rrn = rand_rrn()
    amount = round(random.uniform(10_000, 500_000), 2)
    shortfall = round(amount * random.uniform(0.005, 0.015), 2)  # 0.5–1.5% shortfall
    pan = rand_pan(); terminal = rand_terminal(); merchant = rand_merchant(); card_type = rand_card_type()
    shortfall_txns.append({
        "rrn": rrn, "amount": amount, "shortfall": shortfall,
        "pan": pan, "terminal": terminal, "merchant": merchant, "card_type": card_type,
    })
    cbs_rows.append({
        "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
        "Value Date":       CBS_DATE.strftime("%Y-%m-%d"),
        "Narration":        f"CARD SETTLEMENT/{card_type}/{merchant}/{rrn}",
        "Reference":        rrn,
        "Debit (NGN)":      "",
        "Credit (NGN)":     fmt_amount(amount),
        "Balance (NGN)":    "",
        "Channel":          "CARD",
        "Card Type":        card_type,
        "Terminal ID":      terminal,
        "PAN (masked)":     pan[:6] + "******" + pan[-4:],
    })

# Exception 2: CHARGEBACK — 3 rows: CBS has a debit reversal, Interswitch file doesn't
chargeback_rrns = []
for i in range(3):
    rrn = rand_rrn()
    amount = round(random.uniform(5_000, 150_000), 2)
    pan = rand_pan(); terminal = rand_terminal(); merchant = rand_merchant(); card_type = rand_card_type()
    chargeback_rrns.append({
        "rrn": rrn, "amount": amount, "pan": pan,
        "terminal": terminal, "merchant": merchant, "card_type": card_type,
    })
    # Original credit in CBS
    cbs_rows.append({
        "Transaction Date": (CBS_DATE - timedelta(days=5)).strftime("%Y-%m-%d"),
        "Value Date":       (CBS_DATE - timedelta(days=5)).strftime("%Y-%m-%d"),
        "Narration":        f"CARD SETTLEMENT/{card_type}/{merchant}/{rrn}",
        "Reference":        rrn,
        "Debit (NGN)":      "",
        "Credit (NGN)":     fmt_amount(amount),
        "Balance (NGN)":    "",
        "Channel":          "CARD",
        "Card Type":        card_type,
        "Terminal ID":      terminal,
        "PAN (masked)":     pan[:6] + "******" + pan[-4:],
    })
    # Chargeback debit in CBS (reversal)
    cbs_rows.append({
        "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
        "Value Date":       CBS_DATE.strftime("%Y-%m-%d"),
        "Narration":        f"CHARGEBACK/{card_type}/{merchant}/{rrn}",
        "Reference":        "CB" + rrn,
        "Debit (NGN)":      fmt_amount(amount),
        "Credit (NGN)":     "",
        "Balance (NGN)":    "",
        "Channel":          "CARD",
        "Card Type":        card_type,
        "Terminal ID":      terminal,
        "PAN (masked)":     pan[:6] + "******" + pan[-4:],
    })

# Exception 3: IN_LEDGER_NOT_IN_BANK — 4 CBS entries with no Interswitch counterpart
missing_in_isw = []
for i in range(4):
    rrn = rand_rrn()
    amount = round(random.uniform(2_000, 80_000), 2)
    pan = rand_pan(); terminal = rand_terminal(); merchant = rand_merchant(); card_type = rand_card_type()
    missing_in_isw.append({"rrn": rrn, "amount": amount})
    cbs_rows.append({
        "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
        "Value Date":       CBS_DATE.strftime("%Y-%m-%d"),
        "Narration":        f"CARD SETTLEMENT/{card_type}/{merchant}/{rrn}",
        "Reference":        rrn,
        "Debit (NGN)":      "",
        "Credit (NGN)":     fmt_amount(amount),
        "Balance (NGN)":    "",
        "Channel":          "CARD",
        "Card Type":        card_type,
        "Terminal ID":      terminal,
        "PAN (masked)":     pan[:6] + "******" + pan[-4:],
    })

# Exception 7: LATE_PRESENTMENT — 2 CBS entries dated 3 days ago, Interswitch settles today
late_txns = []
for i in range(2):
    rrn = rand_rrn()
    amount = round(random.uniform(8_000, 200_000), 2)
    pan = rand_pan(); terminal = rand_terminal(); merchant = rand_merchant(); card_type = rand_card_type()
    late_txns.append({"rrn": rrn, "amount": amount, "pan": pan, "terminal": terminal, "merchant": merchant, "card_type": card_type})
    cbs_rows.append({
        "Transaction Date": (CBS_DATE - timedelta(days=3)).strftime("%Y-%m-%d"),
        "Value Date":       (CBS_DATE - timedelta(days=3)).strftime("%Y-%m-%d"),
        "Narration":        f"CARD SETTLEMENT/{card_type}/{merchant}/{rrn}",
        "Reference":        rrn,
        "Debit (NGN)":      "",
        "Credit (NGN)":     fmt_amount(amount),
        "Balance (NGN)":    "",
        "Channel":          "CARD",
        "Card Type":        card_type,
        "Terminal ID":      terminal,
        "PAN (masked)":     pan[:6] + "******" + pan[-4:],
    })

# ── Interswitch settlement rows ─────────────────────────────────────────
isw_rows = []

# 50 clean matches
for t in base_txns:
    isw_rows.append({
        "Settlement Date":  SETTLEMENT_DATE.strftime("%Y-%m-%d"),
        "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
        "RRN":              t["rrn"],
        "STAN":             str(random.randint(100000, 999999)),
        "Terminal ID":      t["terminal"],
        "Merchant Name":    t["merchant"],
        "Card Type":        t["card_type"],
        "PAN":              t["pan"][:6] + "******" + t["pan"][-4:],
        "Transaction Amount (NGN)": fmt_amount(t["amount"]),
        "Settlement Amount (NGN)":  fmt_amount(t["amount"]),
        "Interchange Fee (NGN)":    fmt_amount(0),
        "Scheme Fee (NGN)":         fmt_amount(0),
        "Net Settlement (NGN)":     fmt_amount(t["amount"]),
        "Response Code":    "00",
        "Transaction Type": "PURCHASE",
        "Batch Number":     str(random.randint(1000, 9999)),
    })

# Exception 1: SETTLEMENT_SHORTFALL — Interswitch deducts interchange
for t in shortfall_txns:
    net = round(t["amount"] - t["shortfall"], 2)
    isw_rows.append({
        "Settlement Date":  SETTLEMENT_DATE.strftime("%Y-%m-%d"),
        "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
        "RRN":              t["rrn"],
        "STAN":             str(random.randint(100000, 999999)),
        "Terminal ID":      t["terminal"],
        "Merchant Name":    t["merchant"],
        "Card Type":        t["card_type"],
        "PAN":              t["pan"][:6] + "******" + t["pan"][-4:],
        "Transaction Amount (NGN)": fmt_amount(t["amount"]),
        "Settlement Amount (NGN)":  fmt_amount(t["amount"]),
        "Interchange Fee (NGN)":    fmt_amount(t["shortfall"]),
        "Scheme Fee (NGN)":         fmt_amount(0),
        "Net Settlement (NGN)":     fmt_amount(net),
        "Response Code":    "00",
        "Transaction Type": "PURCHASE",
        "Batch Number":     str(random.randint(1000, 9999)),
    })

# Exception 2: CHARGEBACK — Interswitch does NOT include the chargeback debit
# (CBS has it, Interswitch file doesn't — this is the exception)
# We add the original credit on ISW side but NOT the chargeback
for t in chargeback_rrns:
    isw_rows.append({
        "Settlement Date":  (SETTLEMENT_DATE - timedelta(days=5)).strftime("%Y-%m-%d"),
        "Transaction Date": (CBS_DATE - timedelta(days=5)).strftime("%Y-%m-%d"),
        "RRN":              t["rrn"],
        "STAN":             str(random.randint(100000, 999999)),
        "Terminal ID":      t["terminal"],
        "Merchant Name":    t["merchant"],
        "Card Type":        t["card_type"],
        "PAN":              t["pan"][:6] + "******" + t["pan"][-4:],
        "Transaction Amount (NGN)": fmt_amount(t["amount"]),
        "Settlement Amount (NGN)":  fmt_amount(t["amount"]),
        "Interchange Fee (NGN)":    fmt_amount(0),
        "Scheme Fee (NGN)":         fmt_amount(0),
        "Net Settlement (NGN)":     fmt_amount(t["amount"]),
        "Response Code":    "00",
        "Transaction Type": "PURCHASE",
        "Batch Number":     str(random.randint(1000, 9999)),
    })

# Exception 4: IN_BANK_NOT_IN_LEDGER — 3 Interswitch rows with no CBS counterpart
for i in range(3):
    rrn = rand_rrn()
    amount = round(random.uniform(3_000, 120_000), 2)
    pan = rand_pan(); terminal = rand_terminal(); merchant = rand_merchant(); card_type = rand_card_type()
    isw_rows.append({
        "Settlement Date":  SETTLEMENT_DATE.strftime("%Y-%m-%d"),
        "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
        "RRN":              rrn,
        "STAN":             str(random.randint(100000, 999999)),
        "Terminal ID":      terminal,
        "Merchant Name":    merchant,
        "Card Type":        card_type,
        "PAN":              pan[:6] + "******" + pan[-4:],
        "Transaction Amount (NGN)": fmt_amount(amount),
        "Settlement Amount (NGN)":  fmt_amount(amount),
        "Interchange Fee (NGN)":    fmt_amount(0),
        "Scheme Fee (NGN)":         fmt_amount(0),
        "Net Settlement (NGN)":     fmt_amount(amount),
        "Response Code":    "00",
        "Transaction Type": "PURCHASE",
        "Batch Number":     str(random.randint(1000, 9999)),
    })

# Exception 5: AMOUNT_MISMATCH — 3 rows where ISW amount differs from CBS by scheme fee
for i in range(3):
    rrn = rand_rrn()
    amount = round(random.uniform(20_000, 300_000), 2)
    fee = round(amount * 0.015, 2)  # 1.5% scheme fee
    pan = rand_pan(); terminal = rand_terminal(); merchant = rand_merchant(); card_type = rand_card_type()
    # CBS posts full amount
    cbs_rows.append({
        "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
        "Value Date":       CBS_DATE.strftime("%Y-%m-%d"),
        "Narration":        f"CARD SETTLEMENT/{card_type}/{merchant}/{rrn}",
        "Reference":        rrn,
        "Debit (NGN)":      "",
        "Credit (NGN)":     fmt_amount(amount),
        "Balance (NGN)":    "",
        "Channel":          "CARD",
        "Card Type":        card_type,
        "Terminal ID":      terminal,
        "PAN (masked)":     pan[:6] + "******" + pan[-4:],
    })
    # ISW settles net of scheme fee
    isw_rows.append({
        "Settlement Date":  SETTLEMENT_DATE.strftime("%Y-%m-%d"),
        "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
        "RRN":              rrn,
        "STAN":             str(random.randint(100000, 999999)),
        "Terminal ID":      terminal,
        "Merchant Name":    merchant,
        "Card Type":        card_type,
        "PAN":              pan[:6] + "******" + pan[-4:],
        "Transaction Amount (NGN)": fmt_amount(amount),
        "Settlement Amount (NGN)":  fmt_amount(amount),
        "Interchange Fee (NGN)":    fmt_amount(fee),
        "Scheme Fee (NGN)":         fmt_amount(0),
        "Net Settlement (NGN)":     fmt_amount(round(amount - fee, 2)),
        "Response Code":    "00",
        "Transaction Type": "PURCHASE",
        "Batch Number":     str(random.randint(1000, 9999)),
    })

# Exception 6: DUPLICATE — 2 ISW rows with the same RRN
dup_rrn = rand_rrn()
dup_amount = round(random.uniform(15_000, 100_000), 2)
dup_pan = rand_pan(); dup_terminal = rand_terminal(); dup_merchant = rand_merchant(); dup_card = rand_card_type()
cbs_rows.append({
    "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
    "Value Date":       CBS_DATE.strftime("%Y-%m-%d"),
    "Narration":        f"CARD SETTLEMENT/{dup_card}/{dup_merchant}/{dup_rrn}",
    "Reference":        dup_rrn,
    "Debit (NGN)":      "",
    "Credit (NGN)":     fmt_amount(dup_amount),
    "Balance (NGN)":    "",
    "Channel":          "CARD",
    "Card Type":        dup_card,
    "Terminal ID":      dup_terminal,
    "PAN (masked)":     dup_pan[:6] + "******" + dup_pan[-4:],
})
for _ in range(2):  # two ISW rows for the same RRN
    isw_rows.append({
        "Settlement Date":  SETTLEMENT_DATE.strftime("%Y-%m-%d"),
        "Transaction Date": CBS_DATE.strftime("%Y-%m-%d"),
        "RRN":              dup_rrn,
        "STAN":             str(random.randint(100000, 999999)),
        "Terminal ID":      dup_terminal,
        "Merchant Name":    dup_merchant,
        "Card Type":        dup_card,
        "PAN":              dup_pan[:6] + "******" + dup_pan[-4:],
        "Transaction Amount (NGN)": fmt_amount(dup_amount),
        "Settlement Amount (NGN)":  fmt_amount(dup_amount),
        "Interchange Fee (NGN)":    fmt_amount(0),
        "Scheme Fee (NGN)":         fmt_amount(0),
        "Net Settlement (NGN)":     fmt_amount(dup_amount),
        "Response Code":    "00",
        "Transaction Type": "PURCHASE",
        "Batch Number":     str(random.randint(1000, 9999)),
    })

# Exception 7: LATE_PRESENTMENT — ISW settles today, CBS posted 3 days ago
for t in late_txns:
    isw_rows.append({
        "Settlement Date":  SETTLEMENT_DATE.strftime("%Y-%m-%d"),
        "Transaction Date": (CBS_DATE - timedelta(days=3)).strftime("%Y-%m-%d"),
        "RRN":              t["rrn"],
        "STAN":             str(random.randint(100000, 999999)),
        "Terminal ID":      t["terminal"],
        "Merchant Name":    t["merchant"],
        "Card Type":        t["card_type"],
        "PAN":              t["pan"][:6] + "******" + t["pan"][-4:],
        "Transaction Amount (NGN)": fmt_amount(t["amount"]),
        "Settlement Amount (NGN)":  fmt_amount(t["amount"]),
        "Interchange Fee (NGN)":    fmt_amount(0),
        "Scheme Fee (NGN)":         fmt_amount(0),
        "Net Settlement (NGN)":     fmt_amount(t["amount"]),
        "Response Code":    "00",
        "Transaction Type": "PURCHASE",
        "Batch Number":     str(random.randint(1000, 9999)),
    })

# Shuffle rows for realism
random.shuffle(cbs_rows)
random.shuffle(isw_rows)

# ── Write files ─────────────────────────────────────────────────────────
out_dir = os.path.join(os.path.dirname(__file__), "..", "client", "public")
os.makedirs(out_dir, exist_ok=True)

cbs_path = os.path.join(out_dir, "lapo_cbs_ledger_sample.csv")
isw_path = os.path.join(out_dir, "lapo_interswitch_settlement_sample.csv")

cbs_fields = ["Transaction Date", "Value Date", "Narration", "Reference",
              "Debit (NGN)", "Credit (NGN)", "Balance (NGN)", "Channel",
              "Card Type", "Terminal ID", "PAN (masked)"]
isw_fields = ["Settlement Date", "Transaction Date", "RRN", "STAN",
              "Terminal ID", "Merchant Name", "Card Type", "PAN",
              "Transaction Amount (NGN)", "Settlement Amount (NGN)",
              "Interchange Fee (NGN)", "Scheme Fee (NGN)", "Net Settlement (NGN)",
              "Response Code", "Transaction Type", "Batch Number"]

with open(cbs_path, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cbs_fields)
    w.writeheader()
    w.writerows(cbs_rows)

with open(isw_path, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=isw_fields)
    w.writeheader()
    w.writerows(isw_rows)

print(f"CBS ledger:          {len(cbs_rows)} rows → {cbs_path}")
print(f"Interswitch settle:  {len(isw_rows)} rows → {isw_path}")
print("Done.")
