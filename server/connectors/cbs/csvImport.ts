/**
 * CSV fallback import — every CBS connector's plan B.
 *
 * Many T24/Flexcube sites (and some Mambu/WoodCore tenants) can produce a
 * transaction export long before API credentials are approved. This module
 * ingests those exports through the exact same pipeline as the API path:
 * per-CBS default CSV mappings (registry) + per-org overrides → canonical
 * model → dedupe-insert. Because dedupe keys are namespaced the same way,
 * starting on CSV and switching to the API later never double-ingests.
 *
 * Failures per row go to the connector DLQ (source "mapping") so the health
 * dashboard and retry machinery treat CSV rows like any other failed record.
 */
import Papa from "papaparse";
import type { WcConnectorConfig } from "../../../drizzle/connector_schema";
import { enqueueDeadLetter } from "../woodcore/dlq";
import {
  createIngestBatch,
  ensureCbsChannel,
  finalizeIngestBatch,
  ingestCanonicalTransactions,
} from "../woodcore/ingest";
import { applyMapping, type MappingRule } from "../woodcore/mapping";
import type { CanonicalTransaction, WcEntity } from "../woodcore/types";
import { getActiveOverrideRules } from "../woodcore/webhooks";
import { getCbsProfile } from "./registry";

/** Parse CSV text into header-keyed rows. Pure — unit-testable without a DB. */
export function parseCsvRows(csvContent: string): {
  rows: Record<string, string>[];
  parseErrors: string[];
} {
  const parsed = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });
  const parseErrors = (parsed.errors ?? [])
    .slice(0, 10)
    .map((e) => `row ${typeof e.row === "number" ? e.row + 2 : "?"}: ${e.message}`);
  return { rows: (parsed.data ?? []) as Record<string, string>[], parseErrors };
}

/** Map parsed CSV rows to canonical transactions. Pure — unit-testable. */
export function mapCsvRows(
  cbsType: string,
  entity: WcEntity,
  rows: Record<string, string>[],
  overrides?: MappingRule[] | null,
): {
  mapped: CanonicalTransaction[];
  failures: Array<{ rowIndex: number; errors: string[]; row: Record<string, string> }>;
} {
  const profile = getCbsProfile(cbsType);
  const defaults = profile.csvMappings[entity];
  const mapped: CanonicalTransaction[] = [];
  const failures: Array<{ rowIndex: number; errors: string[]; row: Record<string, string> }> = [];
  rows.forEach((row, i) => {
    const r = applyMapping(entity, row, overrides, defaults);
    if (r.ok && r.value) mapped.push(r.value);
    else failures.push({ rowIndex: i + 2, errors: r.errors, row }); // +2: 1-based + header
  });
  return { mapped, failures };
}

export interface CsvImportResult {
  total: number;
  inserted: number;
  duplicates: number;
  failed: number;
  parseErrors: string[];
  /** First few mapping failures with row numbers, for the UI. */
  sampleFailures: Array<{ rowIndex: number; errors: string[] }>;
}

const MAX_CSV_ROWS = 200_000; // ~a heavy month at 500K/month spread over exports

export async function importCbsCsv(
  cfg: WcConnectorConfig,
  entity: WcEntity,
  csvContent: string,
  opts: { fileName?: string } = {},
): Promise<CsvImportResult> {
  const { rows, parseErrors } = parseCsvRows(csvContent);
  if (rows.length > MAX_CSV_ROWS) {
    throw new Error(`CSV has ${rows.length} rows — split files above ${MAX_CSV_ROWS.toLocaleString()} rows`);
  }

  const overrides = await getActiveOverrideRules(cfg.id, entity);
  const { mapped, failures } = mapCsvRows(cfg.cbsType, entity, rows, overrides);

  const channelId = await ensureCbsChannel(cfg.organizationId, cfg.cbsType);
  const batchId = await createIngestBatch({
    organizationId: cfg.organizationId,
    channelId,
    label: `csv:${entity}:${opts.fileName ?? "upload"}:${new Date().toISOString()}`,
  });

  let inserted = 0;
  let duplicates = 0;
  try {
    const CHUNK = 2000;
    for (let i = 0; i < mapped.length; i += CHUNK) {
      const r = await ingestCanonicalTransactions(mapped.slice(i, i + CHUNK), {
        organizationId: cfg.organizationId,
        channelId,
        batchId,
      });
      inserted += r.inserted;
      duplicates += r.duplicates;
    }
    await finalizeIngestBatch(
      batchId,
      { total: rows.length, valid: inserted, invalid: failures.length },
      true,
    );
  } catch (err) {
    await finalizeIngestBatch(
      batchId,
      { total: rows.length, valid: inserted, invalid: failures.length },
      false,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  // Dead-letter mapping failures (capped — a systematically wrong file should
  // be fixed via mapping config, not 200k DLQ rows).
  for (const f of failures.slice(0, 100)) {
    await enqueueDeadLetter({
      configId: cfg.id,
      organizationId: cfg.organizationId,
      source: "mapping",
      refType: entity,
      refId: `csv-row-${f.rowIndex}`,
      payload: f.row,
      error: `CSV row ${f.rowIndex}: ${f.errors.join("; ")}`,
    });
  }

  return {
    total: rows.length,
    inserted,
    duplicates,
    failed: failures.length,
    parseErrors,
    sampleFailures: failures.slice(0, 5).map(({ rowIndex, errors }) => ({ rowIndex, errors })),
  };
}
