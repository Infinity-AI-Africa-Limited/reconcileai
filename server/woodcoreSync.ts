/**
 * Woodcore live → mirror sync.
 *
 * Copies the live Woodcore (Fineract) tenant into the wc_* mirror tables in the
 * main ReconcileAI DB (TiDB), so the existing 3-layer engine (which reads wc_*)
 * runs on refreshed data. Full refresh: each readable table is TRUNCATEd then
 * reloaded in id-paginated batches.
 *
 * Safety:
 *  - Readability is probed BEFORE truncating, so tables the `reconcileai` user
 *    cannot SELECT (the two acc_to_gl_journal_entry* bridge tables) are skipped
 *    and keep their existing mirror data instead of being wiped.
 *  - Only columns that actually exist on the live table are copied (SHOW COLUMNS),
 *    so a renamed/absent Fineract column can't abort an entire table.
 *
 * Reads use the Woodcore pool (server/woodcoreDb). Writes use a dedicated mysql2
 * pool over DATABASE_URL (bulk `INSERT ... VALUES ?` needs query(), not execute()).
 */
import mysql from "mysql2/promise";
import { getWoodcorePool } from "./woodcoreDb";
import { createResilientPool } from "./mysqlPool";
import { ENV } from "./_core/env";

type TableSpec = { live: string; mirror: string; cols: string[]; batch: number };

// Live Fineract table -> wc_* mirror, with the columns the engine relies on.
const SPECS: TableSpec[] = [
  { live: "acc_gl_account", mirror: "wc_acc_gl_account", batch: 2000, cols: ["id", "name", "gl_code", "disabled", "manual_entries_allowed", "classification_enum", "account_usage", "parent_id", "hierarchy", "tag_id", "description", "organization_running_balance"] },
  { live: "acc_product_mapping", mirror: "wc_acc_product_mapping", batch: 2000, cols: ["id", "gl_account_id", "product_id", "product_type", "charge_id", "payment_type_id", "financial_account_type"] },
  { live: "m_savings_product", mirror: "wc_m_savings_product", batch: 2000, cols: ["id", "name", "short_name", "description", "deposit_amount", "currency_code", "nominal_annual_interest_rate"] },
  { live: "m_product_loan", mirror: "wc_m_product_loan", batch: 2000, cols: ["id", "name", "short_name", "currency_code", "nominal_interest_rate_per_period"] },
  { live: "m_savings_account", mirror: "wc_m_savings_account", batch: 2000, cols: ["id", "account_no", "client_id", "product_id", "status_enum", "currency_code", "account_balance_derived", "activated_on_date"] },
  // Sourced from Woodcore's v_all_savings_account_transaction view (the COMPLETE
  // transaction history, ~121k rows) rather than the sparse base table
  // m_savings_account_transaction (~2.5k rows). The view exposes the same columns
  // the engine relies on. NOTE: the view has a handful of duplicate ids (union
  // artifacts); the dup-safe INSERT in syncOne keeps one row per id (PK).
  { live: "v_all_savings_account_transaction", mirror: "wc_m_savings_account_transaction", batch: 5000, cols: ["id", "savings_account_id", "transaction_type_enum", "is_reversed", "transaction_date", "amount", "running_balance_derived", "is_manual", "created_date"] },
  { live: "m_loan", mirror: "wc_m_loan", batch: 2000, cols: ["id", "account_no", "client_id", "product_id", "loan_status_id", "principal_amount", "approved_principal", "currency_code"] },
  { live: "m_loan_transaction", mirror: "wc_m_loan_transaction", batch: 5000, cols: ["id", "loan_id", "transaction_type_enum", "is_reversed", "transaction_date", "amount", "principal_portion_derived", "interest_portion_derived", "created_date"] },
  // Bridge tables — currently SELECT-denied for `reconcileai`; skipped + preserved until granted.
  { live: "acc_to_gl_journal_entry", mirror: "wc_acc_to_gl_journal_entry", batch: 5000, cols: ["id", "transaction_id", "reversed_transaction_id", "reversed"] },
  // Live table is acc_to_gl_journal_entry_savings_transaction (not _savings — confirmed against tenant).
  { live: "acc_to_gl_journal_entry_savings_transaction", mirror: "wc_acc_to_gl_journal_entry_savings", batch: 5000, cols: ["id", "acc_to_gl_transaction_id", "savings_id", "savings_transaction_id", "reversed"] },
  // The heavy one — kept last so the rest refresh quickly even if this is slow.
  { live: "acc_gl_journal_entry", mirror: "wc_acc_gl_journal_entry", batch: 5000, cols: ["id", "account_id", "office_id", "reversal_id", "currency_code", "transaction_id", "loan_transaction_id", "savings_transaction_id", "reversed", "ref_num", "manual_entry", "entry_date", "type_enum", "amount", "description", "created_date", "unique_ref_key"] },
];

export type TableResult = {
  mirror: string;
  status: "ok" | "skipped" | "error";
  copied: number;
  reason?: string;
  ms?: number;
};

export type SyncState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  tables: TableResult[];
  error: string | null;
};

export const syncState: SyncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  tables: [],
  error: null,
};

let tidbPool: mysql.Pool | null = null;
function getTidbPool(): mysql.Pool {
  if (!tidbPool) {
    if (!ENV.databaseUrl) throw new Error("DATABASE_URL is not set");
    tidbPool = createResilientPool({ uri: ENV.databaseUrl });
  }
  return tidbPool;
}

async function liveColumns(live: string): Promise<Set<string>> {
  const wc = getWoodcorePool();
  const [rows] = await wc.query<mysql.RowDataPacket[]>(`SHOW COLUMNS FROM \`${live}\``);
  return new Set(rows.map((r) => String(r.Field)));
}

async function syncOne(spec: TableSpec): Promise<TableResult> {
  const started = Date.now();
  const wc = getWoodcorePool();
  const tidb = getTidbPool();

  // 1) Probe readability + actual columns BEFORE any destructive op.
  let present: string[];
  try {
    const live = await liveColumns(spec.live);
    present = spec.cols.filter((c) => live.has(c));
    if (!present.includes("id")) {
      return { mirror: spec.mirror, status: "error", copied: 0, reason: "no id column on live table" };
    }
    // Confirm we can actually SELECT (column visibility != row SELECT privilege).
    await wc.query(`SELECT ${present.map((c) => `\`${c}\``).join(",")} FROM \`${spec.live}\` LIMIT 1`);
  } catch (e) {
    // Permission-denied (bridge tables) or missing table: skip WITHOUT truncating.
    return { mirror: spec.mirror, status: "skipped", copied: 0, reason: (e as Error).message };
  }

  const colSql = present.map((c) => `\`${c}\``).join(",");

  // 2) Truncate the mirror, then reload in id-paginated batches.
  try {
    await tidb.query(`TRUNCATE TABLE \`${spec.mirror}\``);
  } catch {
    await tidb.query(`DELETE FROM \`${spec.mirror}\``);
  }

  let lastId = 0;
  let copied = 0;
  for (;;) {
    const [rows] = await wc.query<mysql.RowDataPacket[]>(
      `SELECT ${colSql} FROM \`${spec.live}\` WHERE id > ? ORDER BY id LIMIT ?`,
      [lastId, spec.batch]
    );
    if (rows.length === 0) break;
    const values = rows.map((r) => {
      const rr = r as Record<string, unknown>;
      return present.map((c) => {
        const v = rr[c];
        // The mirror's created_date is NOT NULL, but some live rows have it null.
        // It's metadata (the engine reconciles on transaction_date/entry_date),
        // so fall back to those rather than fail the insert.
        if (v == null && c === "created_date") {
          return rr["transaction_date"] ?? rr["entry_date"] ?? "2000-01-01 00:00:00";
        }
        return v ?? null;
      });
    });
    // Dup-safe: a couple of source views (e.g. v_all_savings_account_transaction)
    // expose duplicate ids. Keep one row per id (PK); a no-op on conflict. Tables
    // with unique ids never trigger this branch.
    await tidb.query(`INSERT INTO \`${spec.mirror}\` (${colSql}) VALUES ? ON DUPLICATE KEY UPDATE \`id\` = \`id\``, [values]);
    copied += rows.length;
    lastId = Number((rows[rows.length - 1] as Record<string, unknown>).id);

    const t = syncState.tables.find((x) => x.mirror === spec.mirror);
    if (t) t.copied = copied;
  }

  return { mirror: spec.mirror, status: "ok", copied, ms: Date.now() - started };
}

/**
 * Run a full mirror refresh. Resolves when complete; updates `syncState` live.
 */
export async function syncWoodcoreMirror(): Promise<SyncState> {
  if (syncState.running) return syncState;

  syncState.running = true;
  syncState.startedAt = new Date().toISOString();
  syncState.finishedAt = null;
  syncState.durationMs = null;
  syncState.error = null;
  syncState.tables = SPECS.map((s) => ({ mirror: s.mirror, status: "ok", copied: 0 }));

  const startedAt = Date.now();
  try {
    // Per-table isolation: a failure in one table must not abort the rest
    // (e.g. the heavy GL table should still sync if a smaller table errors).
    for (const spec of SPECS) {
      const idx = syncState.tables.findIndex((t) => t.mirror === spec.mirror);
      try {
        const result = await syncOne(spec);
        if (idx >= 0) syncState.tables[idx] = result;
        console.log(`[woodcoreSync] ${result.mirror}: ${result.status} copied=${result.copied}${result.reason ? ` (${result.reason})` : ""}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (idx >= 0) syncState.tables[idx] = { mirror: spec.mirror, status: "error", copied: syncState.tables[idx]?.copied ?? 0, reason: msg };
        console.error(`[woodcoreSync] ${spec.mirror} failed: ${msg}`);
      }
    }
  } catch (e) {
    syncState.error = e instanceof Error ? e.message : String(e);
    console.error("[woodcoreSync] fatal:", syncState.error);
  } finally {
    syncState.running = false;
    syncState.finishedAt = new Date().toISOString();
    syncState.durationMs = Date.now() - startedAt;
  }
  return syncState;
}
