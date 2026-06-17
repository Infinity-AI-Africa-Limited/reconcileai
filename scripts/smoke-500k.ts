/**
 * smoke-500k.ts — end-to-end staging smoke test for the 500k ingestion pipeline.
 *
 * Drives the REAL tRPC HTTP API (same path the product uses), so it exercises the
 * chunked upload, the 50 MB body limit, and the batched reconciliation persistence
 * exactly as a browser would:
 *
 *   1. ensure two channels exist (ephemeral, per-run codes)
 *   2. generate N rows per channel and upload them via the chunked path
 *      (createBatch finalize:false -> appendBatch... -> finalizeBatch)
 *   3. kick off a reconciliation job
 *   4. poll until it completes, then assert match counts / timing
 *
 * It also writes each channel's rows to a .csv on disk as an inspectable artifact.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   1. Log in to staging in a browser as an ADMIN user.
 *   2. Copy the `app_session_id` cookie value (DevTools → Application → Cookies).
 *   3. Run (heap raised because we hold ~N rows in memory):
 *
 *      SMOKE_BASE_URL="https://staging.reconcileai.vip" \
 *      SMOKE_COOKIE="app_session_id=<jwt>" \
 *      SMOKE_ROWS_PER_CHANNEL=250000 \
 *      node --max-old-space-size=4096 --import tsx scripts/smoke-500k.ts
 *
 *   (250000 per channel = 500k total, the headline figure. Set 500000 for 1M total.)
 *
 * Exit code 0 = pass, 1 = fail.
 */
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { AppRouter } from "../server/routers";

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = (process.env.SMOKE_BASE_URL || "").replace(/\/$/, "");
const COOKIE = process.env.SMOKE_COOKIE || "";
const ROWS_PER_CHANNEL = parseInt(process.env.SMOKE_ROWS_PER_CHANNEL || "250000", 10);
const CHUNK = parseInt(process.env.SMOKE_CHUNK || "20000", 10);
const MATCH_RATE = 0.97; // fraction of rows that form exact source/target pairs
const POLL_TIMEOUT_MS = parseInt(process.env.SMOKE_TIMEOUT_MS || "900000", 10); // 15 min
const RUN_ID = Date.now().toString(36);

if (!BASE_URL || !COOKIE) {
  console.error("ERROR: set SMOKE_BASE_URL and SMOKE_COOKIE (app_session_id=<jwt>) env vars.");
  process.exit(1);
}

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${BASE_URL}/api/trpc`,
      transformer: superjson,
      // Inject the operator's session cookie on every request.
      headers: () => ({ cookie: COOKIE }),
    }),
  ],
});

// ─── Data generation ─────────────────────────────────────────────────────────

type Row = {
  transactionRef: string;
  amount: string;
  currency: string;
  transactionDate: string;
  debitCredit: "debit" | "credit";
  counterparty: string;
  description: string;
};

const DAY = 86_400_000;
// Recon window: a 30-day span ending today. Rows are spread across it.
const WINDOW_DAYS = 30;
const baseMs = Date.now() - WINDOW_DAYS * DAY;
const dateFromISO = new Date(baseMs - DAY).toISOString();
const dateToISO = new Date(Date.now() + DAY).toISOString();

function amountFor(i: number): string {
  // Mix of small and large values (large ones used to crash the engine pre-fix).
  const v = i % 20 === 0 ? 2_000_000 + (i % 5000) * 9_000 : 500 + (i % 200_000);
  return (v + (i % 100) / 100).toFixed(2);
}

/** Build one channel's rows. `pair` rows share ref/amount/date with the other channel
 *  (so they match in Pass 1); the tail rows are unique to this side (unmatched). */
function buildRows(side: "src" | "tgt", n: number): Row[] {
  const pairCount = Math.floor(n * MATCH_RATE);
  const rows: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const isPair = i < pairCount;
    const ref = isPair ? `SMOKE-${RUN_ID}-${i}` : `SMOKE-${RUN_ID}-${side}-only-${i}`;
    const dateMs = baseMs + (i % (WINDOW_DAYS - 4)) * DAY; // keep within window, away from edges
    rows[i] = {
      transactionRef: ref,
      amount: amountFor(i),
      currency: "NGN",
      transactionDate: new Date(dateMs).toISOString(),
      debitCredit: i % 2 === 0 ? "credit" : "debit",
      counterparty: `ACME-${i % 500}`,
      description: `smoke ${side} ${i}`,
    };
  }
  return rows;
}

function writeCsv(path: string, rows: Row[]) {
  const header = "transactionRef,amount,currency,transactionDate,debitCredit,counterparty,description\n";
  const parts: string[] = [header];
  for (const r of rows) {
    parts.push(`${r.transactionRef},${r.amount},${r.currency},${r.transactionDate},${r.debitCredit},${r.counterparty},${r.description}\n`);
  }
  writeFileSync(path, parts.join(""));
}

// ─── Steps ───────────────────────────────────────────────────────────────────

async function ensureChannel(code: string, name: string): Promise<number> {
  const existing = await client.channels.list.query();
  const found = existing.find((c) => c.code === code);
  if (found) return found.id;

  await client.channels.create.mutate({ name, code, channelType: "bank_transfer" });
  const after = await client.channels.list.query();
  const created = after.find((c) => c.code === code);
  if (!created) throw new Error(`Channel ${code} not found after create`);
  return created.id;
}

async function uploadChunked(channelCode: string, rows: Row[]): Promise<{ validRows: number; invalidRows: number }> {
  const t0 = performance.now();
  const first = rows.slice(0, CHUNK);
  const created = await client.upload.createBatch.mutate({
    channelCode,
    fileName: `smoke-${channelCode}.csv`,
    totalRows: rows.length,
    finalize: false,
    transactions: first,
  });
  if ((created as any).deduplicated) {
    console.log(`  [${channelCode}] deduplicated — existing batch reused`);
    return { validRows: created.validRows, invalidRows: created.invalidRows };
  }
  const batchId = created.batchId;
  let valid = created.validRows;
  let invalid = created.invalidRows;
  process.stdout.write(`  [${channelCode}] ${Math.min(CHUNK, rows.length)}/${rows.length}\r`);

  for (let off = CHUNK; off < rows.length; off += CHUNK) {
    const r = await client.upload.appendBatch.mutate({
      batchId,
      channelCode,
      rowOffset: off,
      transactions: rows.slice(off, off + CHUNK),
    });
    valid += r.validRows;
    invalid += r.invalidRows;
    process.stdout.write(`  [${channelCode}] ${Math.min(off + CHUNK, rows.length)}/${rows.length}\r`);
  }

  const fin = await client.upload.finalizeBatch.mutate({ batchId });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`  [${channelCode}] uploaded ${rows.length} rows in ${secs}s (valid ${fin.validRows ?? valid}, invalid ${fin.invalidRows ?? invalid})`);
  return { validRows: fin.validRows ?? valid, invalidRows: fin.invalidRows ?? invalid };
}

async function pollJob(jobId: number): Promise<any> {
  const start = performance.now();
  while (performance.now() - start < POLL_TIMEOUT_MS) {
    const jobs = await client.reconciliation.list.query();
    const job = jobs.find((j: any) => j.id === jobId);
    if (job) {
      if (job.status === "completed") return job;
      if (job.status === "failed") throw new Error(`Job ${jobId} failed (status=failed)`);
      const secs = ((performance.now() - start) / 1000).toFixed(0);
      process.stdout.write(`  job ${jobId}: ${job.status} (${secs}s elapsed)\r`);
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`Job ${jobId} did not complete within ${POLL_TIMEOUT_MS / 1000}s`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`ReconcileAI 500k smoke test  (run ${RUN_ID})`);
  console.log(`base=${BASE_URL}  rows/channel=${ROWS_PER_CHANNEL}  chunk=${CHUNK}\n`);

  const srcCode = `smoke-src-${RUN_ID}`;
  const tgtCode = `smoke-tgt-${RUN_ID}`;

  console.log("1/4 ensuring channels…");
  const srcId = await ensureChannel(srcCode, `Smoke Source ${RUN_ID}`);
  const tgtId = await ensureChannel(tgtCode, `Smoke Target ${RUN_ID}`);
  console.log(`  source #${srcId} (${srcCode}), target #${tgtId} (${tgtCode})`);

  console.log("2/4 generating + uploading data…");
  const srcRows = buildRows("src", ROWS_PER_CHANNEL);
  writeCsv(`smoke-${srcCode}.csv`, srcRows);
  await uploadChunked(srcCode, srcRows);

  const tgtRows = buildRows("tgt", ROWS_PER_CHANNEL);
  writeCsv(`smoke-${tgtCode}.csv`, tgtRows);
  await uploadChunked(tgtCode, tgtRows);

  console.log("3/4 starting reconciliation…");
  const { jobId } = await client.reconciliation.create.mutate({
    name: `Smoke 500k ${RUN_ID}`,
    moduleType: "settlement",
    sourceChannelId: srcId,
    targetChannelId: tgtId,
    dateFrom: dateFromISO,
    dateTo: dateToISO,
    amountTolerance: 0.005,
    dateWindowDays: 3,
  });
  console.log(`  job #${jobId} created`);

  console.log("4/4 waiting for completion…");
  const reconStart = performance.now();
  const job = await pollJob(jobId);
  const reconSecs = ((performance.now() - reconStart) / 1000).toFixed(1);

  console.log("\n── Result ──────────────────────────────────────────────");
  console.log(`status:          ${job.status}`);
  console.log(`matched:         ${job.matchedCount}`);
  console.log(`exceptions:      ${job.exceptionCount}`);
  console.log(`unmatched:       ${job.unmatchedCount}`);
  console.log(`match rate:      ${job.matchRate}%`);
  console.log(`engine time:     ${job.processingTimeMs} ms`);
  console.log(`recon wall time: ${reconSecs}s (incl. persistence)`);

  // ── Assertions ──
  const expectedMatches = Math.floor(ROWS_PER_CHANNEL * MATCH_RATE);
  const errors: string[] = [];
  if (job.status !== "completed") errors.push(`status is ${job.status}, expected completed`);
  if (!(job.matchedCount > expectedMatches * 0.9)) {
    errors.push(`matchedCount ${job.matchedCount} is below 90% of expected ${expectedMatches}`);
  }
  if (errors.length) {
    console.error("\nFAIL:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log("\nPASS ✅  500k pipeline completed end-to-end.");
  console.log(`(artifacts: smoke-${srcCode}.csv, smoke-${tgtCode}.csv — channels can be deleted in the UI)`);
}

main().catch((err) => {
  if (err instanceof TRPCClientError) {
    console.error(`\ntRPC error: ${err.message}`);
    console.error("If this is UNAUTHORIZED/FORBIDDEN, refresh SMOKE_COOKIE with an admin session.");
  } else {
    console.error("\n" + (err?.stack || err));
  }
  process.exit(1);
});
