/**
 * trigger-loan-poc-runs.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggers multiple Loan POC runs via the tRPC HTTP endpoint to build up
 * the variance trend sparkline in the Loan POC panel.
 *
 * Runs:
 *   1. Apr-only    : 2025-04-01 → 2025-04-30
 *   2. May-only    : 2025-05-01 → 2025-05-31
 *   3. Jun-only    : 2025-06-01 → 2025-06-30
 *   4. Jul-only    : 2025-07-01 → 2025-07-31
 *   5. Apr–May     : 2025-04-01 → 2025-05-31
 *   6. Apr–Jun     : 2025-04-01 → 2025-06-30
 *   7. Apr–Jul     : 2025-04-01 → 2025-07-31  (already exists, will add another)
 */

const BASE_URL = "http://localhost:3000";

const runs = [
  { label: "Apr-only",  periodStart: "2025-04-01", periodEnd: "2025-04-30" },
  { label: "May-only",  periodStart: "2025-05-01", periodEnd: "2025-05-31" },
  { label: "Jun-only",  periodStart: "2025-06-01", periodEnd: "2025-06-30" },
  { label: "Jul-only",  periodStart: "2025-07-01", periodEnd: "2025-07-31" },
  { label: "Apr–May",   periodStart: "2025-04-01", periodEnd: "2025-05-31" },
  { label: "Apr–Jun",   periodStart: "2025-04-01", periodEnd: "2025-06-30" },
];

async function runPOC(run) {
  const body = {
    "0": {
      json: {
        productId: 1,
        productType: "LOAN",
        currencyCode: "NGN",
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        varianceThreshold: 1.0,
      }
    }
  };

  console.log(`\n→ Running Loan POC: ${run.label} (${run.periodStart} → ${run.periodEnd})...`);
  const start = Date.now();

  try {
    const res = await fetch(`${BASE_URL}/api/trpc/woodcore.runPOC?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`  ✗ HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const result = data?.[0]?.result?.data?.json;

    if (!result) {
      console.error(`  ✗ Unexpected response:`, JSON.stringify(data).slice(0, 300));
      return null;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const variance = result.layer1?.varianceAmount ?? "N/A";
    const exceptions = result.layer2Exceptions?.length ?? 0;
    console.log(`  ✓ Done in ${elapsed}s | Variance: ${variance} | Exceptions: ${exceptions}`);
    return result;
  } catch (err) {
    console.error(`  ✗ Error: ${err.message}`);
    return null;
  }
}

console.log("=== Triggering Loan POC Runs ===");
console.log(`Target: ${BASE_URL}`);

for (const run of runs) {
  await runPOC(run);
  // Brief pause between runs to avoid overwhelming the engine
  await new Promise(r => setTimeout(r, 2000));
}

console.log("\n✓ All Loan POC runs complete.");
