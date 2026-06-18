/**
 * bench-reconcile.ts — Standalone performance benchmark for runMatchingEngine().
 *
 * Imports the REAL engine from server/reconciliationEngine.ts (no DB, no network —
 * env.ts is side-effect-free) and runs it against synthetic but realistic
 * reconciliation workloads at increasing scale.
 *
 * Config matches production defaults (routers.ts reconciliation.run):
 *   amountTolerance = 0.005 (0.5%)   dateWindowDays = 3
 *
 * Usage:
 *   tsx bench-reconcile.ts                      # default size ladder
 *   tsx bench-reconcile.ts 20000,100000,500000  # custom TOTAL txn counts
 *
 * "Total" = source + target combined (so 500000 => 250k source vs 250k target).
 */
import { performance } from "node:perf_hooks";
import { runMatchingEngine } from "./server/reconciliationEngine";
import type { Transaction } from "./drizzle/schema";

// ─── Seeded RNG (deterministic, reproducible) ────────────────────────────────
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const BASE = new Date("2026-05-01T00:00:00Z").getTime();

let rng = mulberry32(0xc0ffee);

// Realistic Nigerian-bank amount distribution: lots of small POS/USSD, fewer
// large transfers. Amount magnitude matters because Pass 2 generates candidate
// amount keys proportional to (amount * tolerance).
function randAmount(): number {
  const r = rng();
  let v: number;
  if (r < 0.7) v = 500 + rng() * 199_500; // 70%: ₦500 – ₦200k
  else if (r < 0.95) v = 200_000 + rng() * 1_800_000; // 25%: ₦200k – ₦2m
  else v = 2_000_000 + rng() * 48_000_000; // 5%: ₦2m – ₦50m
  return Math.round(v * 100) / 100;
}
function randDate(): Date {
  return new Date(BASE + Math.floor(rng() * 30) * DAY);
}

let idCounter = 1;
function mk(p: Partial<Transaction>): Transaction {
  return {
    id: idCounter++,
    batchId: 1,
    channelId: p.channelId ?? 1,
    userId: 1,
    organizationId: 1,
    transactionRef: p.transactionRef ?? null,
    externalRef: null,
    description: p.description ?? null,
    amount: (p.amount as unknown as string) ?? "0",
    currency: "NGN",
    transactionDate: p.transactionDate ?? new Date(BASE),
    valueDate: null,
    debitCredit: p.debitCredit ?? "credit",
    counterparty: p.counterparty ?? null,
    isReversal: p.isReversal ?? false,
    originalTransactionRef: p.originalTransactionRef ?? null,
    status: "unmatched",
    matchId: null,
    rawData: null,
    createdAt: new Date(BASE),
  } as unknown as Transaction;
}

interface Scenario {
  source: Transaction[];
  target: Transaction[];
}

/**
 * Build a realistic mix: ~86% clean exact matches (Pass 1), ~6% amount/date
 * tolerance matches (Pass 2), ~2% fuzzy (Pass 3), ~6% genuinely unmatched, plus
 * a sprinkle of duplicates and reversals to exercise the post-processing scans.
 */
// Source and target come from DIFFERENT systems (e.g. NIBSS settlement file vs CBS),
// so they carry different channel ids — matched pairs must not look like duplicates.
const SRC_CHANNEL = 1;
const TGT_CHANNEL = 2;

function generateScenario(total: number, mode: "realistic" | "clean"): Scenario {
  idCounter = 1;
  rng = mulberry32(0xc0ffee); // reset for determinism per size
  const n = Math.floor(total / 2);
  const source: Transaction[] = [];
  const target: Transaction[] = [];

  // Fraction that hits each pass. "clean" = a well-formed file (mostly exact-ref
  // matches); "realistic" = a messier file with more tolerance/fuzzy/unmatched residual.
  const f = mode === "clean"
    ? { exact: 0.985, tol: 0.008, fuzzy: 0.002 }
    : { exact: 0.86, tol: 0.06, fuzzy: 0.02 };

  const exact = Math.floor(n * f.exact);
  const tol = Math.floor(n * f.tol);
  const fuzzy = Math.floor(n * f.fuzzy);
  const rest = n - exact - tol - fuzzy; // split into source-only / target-only

  for (let i = 0; i < exact; i++) {
    const amt = randAmount();
    const date = randDate();
    const ref = `NIP/${i}/${Math.floor(rng() * 1e6)}`;
    source.push(mk({ channelId: SRC_CHANNEL, transactionRef: ref, amount: amt, transactionDate: date, counterparty: "ACME DISTRIBUTION LTD" }));
    target.push(mk({ channelId: TGT_CHANNEL, transactionRef: ref, amount: amt, transactionDate: date, counterparty: "ACME DISTRIBUTION LTD" }));
  }

  for (let i = 0; i < tol; i++) {
    const amt = randAmount();
    const date = randDate();
    // Different refs => Pass 1 misses; amount within 0.3% and date +1–2 days => Pass 2.
    source.push(mk({ channelId: SRC_CHANNEL, transactionRef: `SRC-TOL-${i}`, amount: amt, transactionDate: date }));
    target.push(
      mk({
        channelId: TGT_CHANNEL,
        transactionRef: `TGT-TOL-${i}`,
        amount: Math.round(amt * 1.003 * 100) / 100,
        transactionDate: new Date(date.getTime() + (1 + Math.floor(rng() * 2)) * DAY),
      })
    );
  }

  for (let i = 0; i < fuzzy; i++) {
    const amt = randAmount();
    const date = randDate();
    source.push(mk({ channelId: SRC_CHANNEL, transactionRef: `SF-${i}`, amount: amt, transactionDate: date, description: "PAYMENT ACME CORP LTD", counterparty: "ACME CORP" }));
    target.push(
      mk({
        channelId: TGT_CHANNEL,
        transactionRef: `TF-${i}`,
        amount: Math.round(amt * 1.006 * 100) / 100,
        transactionDate: new Date(date.getTime() + DAY),
        description: "PAYMENT ACME CORPORATION LIMITED",
        counterparty: "ACME CORPORATION",
      })
    );
  }

  for (let i = 0; i < rest; i++) {
    // half source-only, half target-only unmatched
    if (i % 2 === 0) source.push(mk({ channelId: SRC_CHANNEL, transactionRef: `ONLY-S-${i}`, amount: randAmount(), transactionDate: randDate() }));
    else target.push(mk({ channelId: TGT_CHANNEL, transactionRef: `ONLY-T-${i}`, amount: randAmount(), transactionDate: randDate() }));
  }

  // Sprinkle duplicates (~0.5% of source) — identical ref+amount+date+channel.
  const dupCount = Math.floor(source.length * 0.005);
  for (let i = 0; i < dupCount; i++) {
    const orig = source[Math.floor(rng() * source.length)];
    source.push(
      mk({
        transactionRef: orig.transactionRef ?? `DUP-${i}`,
        amount: orig.amount,
        transactionDate: orig.transactionDate,
        channelId: orig.channelId,
      })
    );
  }

  // Sprinkle reversals (~0.5% of target) — opposite direction, similar ref.
  const revCount = Math.floor(target.length * 0.005);
  for (let i = 0; i < revCount; i++) {
    const orig = target[Math.floor(rng() * target.length)];
    target.push(
      mk({
        transactionRef: `RVSL-${orig.transactionRef}`,
        amount: orig.amount,
        transactionDate: new Date(new Date(orig.transactionDate).getTime() + DAY),
        debitCredit: orig.debitCredit === "credit" ? "debit" : "credit",
        isReversal: true,
        originalTransactionRef: orig.transactionRef,
      })
    );
  }

  return { source, target };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

async function main() {
  const arg = process.argv[2];
  const mode = (process.argv[3] as "realistic" | "clean") === "clean" ? "clean" : "realistic";
  const sizes = arg
    ? arg.split(",").map((s) => parseInt(s.trim(), 10)).filter((x) => x > 0)
    : [20_000, 100_000, 250_000, 500_000];

  const config = { amountTolerance: 0.005, dateWindowDays: 3 };
  const WALL_GUARD_MS = 180_000; // stop escalating if a run exceeds 3 minutes

  console.log("ReconcileAI — runMatchingEngine() benchmark");
  console.log(`mode: ${mode}  config: amountTolerance=${config.amountTolerance} dateWindowDays=${config.dateWindowDays}`);
  console.log(`node ${process.version}  platform ${process.platform}`);
  console.log("");
  console.log(
    ["total", "source", "target", "wall_ms", "wall_s", "engine_ms", "matches", "match%", "p1_exact", "p2_tol", "p3_fuzzy", "dups", "revs", "heap_MB"].join("\t")
  );

  for (const total of sizes) {
    const { source, target } = generateScenario(total, mode);
    if (global.gc) global.gc();

    const t0 = performance.now();
    const res = runMatchingEngine(source, target, config);
    const t1 = performance.now();
    const wall = t1 - t0;

    const heapMB = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
    const matched = res.matches.length;
    const matchRate = Math.round((matched / Math.min(source.length, target.length)) * 1000) / 10;

    console.log(
      [
        fmt(source.length + target.length),
        fmt(source.length),
        fmt(target.length),
        Math.round(wall),
        Math.round((wall / 1000) * 100) / 100,
        res.stats.processingTimeMs,
        fmt(matched),
        matchRate + "%",
        fmt(res.stats.pass1ExactMatches),
        fmt(res.stats.pass2ToleranceMatches),
        fmt(res.stats.pass3FuzzyMatches),
        fmt(res.stats.duplicatesDetected),
        fmt(res.stats.reversalsDetected),
        heapMB,
      ].join("\t")
    );

    if (wall > WALL_GUARD_MS) {
      console.log(`\n[guard] ${Math.round(wall / 1000)}s exceeded ${WALL_GUARD_MS / 1000}s — stopping escalation.`);
      break;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
