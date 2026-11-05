/**
 * close-duplicate-retail-exceptions.ts: measure, and with --commit dismiss,
 * duplicate copies of retail exceptions that SHOPLINE and Shopify syncs filed
 * before #209. What counts as a duplicate, and what is never touched, is in
 * server/duplicateRetailExceptions.ts.
 *
 *   DATABASE_URL=... npx tsx scripts/close-duplicate-retail-exceptions.ts             # measure (default)
 *   DATABASE_URL=... npx tsx scripts/close-duplicate-retail-exceptions.ts --org 42    # one tenant
 *   DATABASE_URL=... npx tsx scripts/close-duplicate-retail-exceptions.ts --commit    # dismiss
 *
 * CLASS (CLAUDE.md §12): deliberate production maintenance. Its controls:
 *
 * - **Measuring is the default**, and it only reads.
 * - **`--commit` refuses while duplicates are still being filed.** If any copy
 *   it would dismiss is under 24 hours old, the fix (#209) is not live yet,
 *   and the next sync would file the copies again. The refusal covers the
 *   whole run, before any tenant is changed.
 * - **It never deletes.**
 *   - It dismisses untouched copies, with a note naming the copy kept.
 *   - It records each batch in the tenant's audit trail, in the same
 *     transaction.
 *   - A dismissed copy can be reopened.
 * - **It does not read `.env`** (which in a developer checkout names
 *   production). `DATABASE_URL` must be exported, and the target host is
 *   printed before anything runs.
 * - **A second run is a no-op**: it finds nothing left to dismiss.
 * - **Unknown arguments are refused.** A misspelt `--org` must not widen a
 *   commit to every tenant.
 */
import { loggableError } from "../server/dbErrors";
import { classifyDatabaseTarget } from "../server/dbTarget";

const USAGE = "Usage: npx tsx scripts/close-duplicate-retail-exceptions.ts [--org <id>] [--commit]";

interface Options {
  commit: boolean;
  organizationId: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { commit: false, organizationId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--commit") options.commit = true;
    else if (arg === "--org") {
      const value = argv[(index += 1)];
      if (!value || !/^[1-9]\d{0,9}$/.test(value)) throw new UsageError(`--org needs a tenant id, got "${value ?? ""}"`);
      options.organizationId = Number(value);
    } else throw new UsageError(`Unknown argument "${arg}"`);
  }
  return options;
}

class UsageError extends Error {}

function age(from: Date, now: Date): string {
  const hours = Math.floor((now.getTime() - from.getTime()) / 3_600_000);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }

  const url = process.env.DATABASE_URL;
  const target = classifyDatabaseTarget(url);
  if (!url || !target.host) {
    console.error(`DATABASE_URL is not set (or cannot be read). Export it explicitly; this script does not read .env.\n${USAGE}`);
    return 2;
  }
  const database = new URL(url).pathname.replace(/^\//, "") || "(none)";
  console.log(`Target: ${target.host} / ${database}${target.local ? " (local)" : " (REMOTE)"}`);
  console.log(options.commit ? "Mode:   COMMIT (dismisses untouched duplicate copies)" : "Mode:   measure only (reads only)");

  // Loaded only now, so a usage error or a missing URL never opens a pool.
  const { closeAppPools } = await import("../server/dbSession");
  const { getDb } = await import("../server/db");
  const duplicates = await import("../server/duplicateRetailExceptions");
  const db = await getDb();
  if (!db) {
    console.error("No database connection.");
    return 1;
  }

  try {
    const now = new Date();
    const tenants = options.organizationId !== null
      ? [options.organizationId]
      : await duplicates.tenantsWithDuplicateRetailExceptions(db);
    const codes = await duplicates.organizationCodes(db, tenants);
    const measured = [];
    for (const organizationId of tenants) {
      const { summary } = await duplicates.measureTenantDuplicates(db, organizationId);
      // A tenant whose every group is already handled has nothing left to show.
      if (summary.groups > 0) measured.push(summary);
    }

    console.log("\norg       code                      groups  to dismiss  need a person  decided+open  newest to dismiss");
    for (const row of measured) {
      console.log(
        `${String(row.organizationId).padEnd(9)} ${String(codes.get(row.organizationId) ?? "?").padEnd(25)} ` +
          `${String(row.groups).padStart(6)}  ${String(row.toClose).padStart(10)}  ${String(row.needPerson).padStart(13)}  ` +
          `${String(row.decidedBesideOpen).padStart(12)}  ${row.newestToClose ? `${age(row.newestToClose, now)} ago` : "-"}`,
      );
    }
    const toClose = measured.reduce((sum, row) => sum + row.toClose, 0);
    console.log(
      `\n${tenants.length} tenant(s) checked, ${measured.length} with duplicate groups; ` +
        `${toClose} untouched cop(ies) to dismiss.` +
        "\n'need a person': groups where more than one copy carries work. Never dismissed here." +
        "\n'decided+open': a decided copy beside one still open. A settlement file may raise a case again" +
        "\n  after a person closed it, so these are reported, never dismissed.",
    );

    if (!options.commit) {
      console.log(`\nMEASURE ONLY: nothing was changed.${toClose > 0 ? " Re-run with --commit to dismiss." : ""}`);
      return 0;
    }

    const stillFiling = measured.filter(
      (row) => row.newestToClose && now.getTime() - row.newestToClose.getTime() < duplicates.STILL_FILING_WINDOW_MS,
    );
    if (stillFiling.length > 0) {
      console.error(
        `\nREFUSING: ${stillFiling.length} tenant(s) gained a duplicate in the last 24 hours, so the source is still` +
          " filing them and the next sync would undo this. Deploy the fix (#209), wait 24 hours, then run again." +
          " Nothing was changed.",
      );
      return 1;
    }

    let closed = 0;
    for (const row of measured.filter((entry) => entry.toClose > 0)) {
      const result = await duplicates.closeTenantDuplicates(db, row.organizationId);
      closed += result.closed;
      console.log(`org ${result.organizationId}: dismissed ${result.closed}, skipped ${result.skipped} (changed since measured)`);
    }
    console.log(`\nDone: ${closed} duplicate cop(ies) dismissed. Each batch is in its tenant's audit trail.`);
    return 0;
  } finally {
    await closeAppPools();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Never the raw error: a failed query's message carries its parameters.
    console.error("Failed:", loggableError(error));
    process.exit(1);
  },
);
