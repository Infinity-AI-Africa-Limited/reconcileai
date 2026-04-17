/**
 * Seed extra POC runs for the comparison view:
 *   - May-only (2025-05-01 → 2025-05-31)
 *   - June-only (2025-06-01 → 2025-06-30)
 *   - Apr–Jun (2025-04-01 → 2025-06-30)
 *
 * Calls the tRPC endpoint directly via HTTP so the engine runs with the
 * full server context (DB, LLM, etc.).
 */

const BASE = "http://localhost:3000";

const periods = [
  { label: "May-only",  periodStart: "2025-05-01", periodEnd: "2025-05-31" },
  { label: "June-only", periodStart: "2025-06-01", periodEnd: "2025-06-30" },
  { label: "Apr–Jun",   periodStart: "2025-04-01", periodEnd: "2025-06-30" },
];

async function runPeriod(period) {
  console.log(`\n▶ Running POC for ${period.label} (${period.periodStart} → ${period.periodEnd})…`);

  const body = {
    productId: 2,
    productType: "SAVINGS",
    currencyCode: "NGN",
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    varianceThreshold: 1.0,
  };

  const url = `${BASE}/api/trpc/woodcore.runPOC`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ json: body }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`  ✗ HTTP ${res.status}: ${text.slice(0, 200)}`);
    return;
  }

  const json = await res.json();
  if (json.error) {
    console.error(`  ✗ tRPC error: ${JSON.stringify(json.error).slice(0, 200)}`);
    return;
  }

  const result = json.result?.data?.json ?? json.result?.data;
  if (!result) {
    console.log("  ✗ Unexpected response shape:", JSON.stringify(json).slice(0, 300));
    return;
  }

  console.log(`  ✓ Run #${result.layer1?.runId ?? "?"} complete`);
  console.log(`    Status: ${result.layer1?.status}`);
  console.log(`    Expected: ₦${result.layer1?.expectedBalance?.toFixed(2)}`);
  console.log(`    Actual GL: ₦${result.layer1?.actualGlBalance?.toFixed(2)}`);
  console.log(`    Variance: ₦${Math.abs(result.layer1?.varianceAmount ?? 0).toFixed(2)} (${result.layer1?.varianceDirection})`);
  console.log(`    Exceptions: ${result.layer2Exceptions?.length ?? 0}`);
  console.log(`    Layer 3 reports: ${result.layer3Results?.length ?? 0}`);
}

(async () => {
  console.log("=== Seeding extra POC runs for Woodcore comparison view ===");
  for (const p of periods) {
    await runPeriod(p);
  }
  console.log("\n✅ Done — all extra runs seeded.");
})();
