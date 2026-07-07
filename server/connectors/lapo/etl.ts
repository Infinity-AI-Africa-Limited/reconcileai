/**
 * LAPO custom ETL pipeline (deliverable 2).
 *
 * Two ingestion paths into the same canonical tables the reconciliation
 * engine already reads (channels → upload_batches → transactions):
 *
 *   FILE  — SFTP daily batches / manual uploads / CSV drops per source
 *           (ingestLapoFile). File-hash idempotency: re-delivering the same
 *           file is a recorded no-op, never a double-ingest.
 *   EVENT — realtime API for mobile/USSD/NIP (ingestLapoEvents), delivered
 *           through the existing HMAC-verified CBS webhook endpoint
 *           (payload: { source, events: [...] }) or the lapo tRPC router.
 *
 * Zero-data-loss accounting (the 30-day parallel-run metric): every ingest
 * returns { total = inserted + duplicates + failed } — a row can only ever be
 * counted once, failures are dead-lettered with row numbers, and
 * checkDailyCompleteness() flags any source whose expected daily batch never
 * arrived. Works identically on SaaS and on-premise (no cloud dependencies).
 */
import crypto from "crypto";
import { and, eq, gte, lt, like } from "drizzle-orm";
import Papa from "papaparse";
import {
  getLapoSource,
  lapoChannelCode,
  lapoExternalRef,
  LAPO_SOURCES,
  LAPO_SOURCE_KEYS,
  type LapoSourceKey,
  type LapoSourceProfile,
} from "@shared/lapoSources";
import { channels, uploadBatches } from "../../../drizzle/schema";
import { wcConnectorConfigs } from "../../../drizzle/connector_schema";
import { getDb } from "../../db";
import { getCbsProfile } from "../cbs/registry";
import { seedLapoResolutionTemplates } from "./exceptions";
import { enqueueDeadLetter } from "../woodcore/dlq";
import {
  createIngestBatch,
  finalizeIngestBatch,
  ingestCanonicalTransactions,
} from "../woodcore/ingest";
import { parseWcDate } from "../woodcore/mapping";
import type { CanonicalTransaction } from "../woodcore/types";
import { getConfigRowByOrg } from "../woodcore/config";

// ─── Row → canonical mapping (LAPO-aware: split debit/credit ledgers) ───────
export function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/['"]/g, "").trim().replace(/\s+/g, "_");
}

export function normalizeRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    out[normalizeKey(k)] = v == null ? "" : String(v).trim();
  }
  return out;
}

function pick(row: Record<string, string>, aliases: string[] | undefined): string {
  for (const a of aliases ?? []) {
    const v = row[a];
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

function parseAmount(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[₦,\s]/g, "").replace(/[()]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/**
 * Nigerian bank exports frequently use dd/mm/yyyy (with optional time), which
 * JS Date parses as US month-first or rejects. Try the platform parser first,
 * then the dd/mm/yyyy family explicitly.
 */
export function parseLapoDate(raw: string): Date | null {
  if (!raw) return null;
  const iso = parseWcDate(raw);
  if (iso) return iso;
  const m = raw.trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  const d = Number(dd), mo = Number(mm), y = Number(yyyy);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, Number(hh ?? 0), Number(mi ?? 0), Number(ss ?? 0)));
  return Number.isNaN(date.getTime()) ? null : date;
}

const DIRECTION_WORDS: Record<string, "debit" | "credit"> = {
  DEBIT: "debit", DR: "debit", D: "debit", WITHDRAWAL: "debit", "CASH-OUT": "debit",
  CASH_OUT: "debit", PURCHASE: "debit", OUTWARD: "debit", TRANSFER_OUT: "debit",
  CREDIT: "credit", CR: "credit", C: "credit", DEPOSIT: "credit", "CASH-IN": "credit",
  CASH_IN: "credit", INWARD: "credit", TRANSFER_IN: "credit", REFUND: "credit",
};

export interface LapoRowResult {
  ok: boolean;
  value?: CanonicalTransaction;
  errors: string[];
}

/**
 * Map one normalized row (CSV or flat JSON event) from a LAPO source to the
 * canonical transaction model. Pure — the whole parallel run's correctness
 * hangs here, so it is exhaustively unit-tested.
 */
export function mapLapoRow(profile: LapoSourceProfile, raw: Record<string, unknown>): LapoRowResult {
  const row = normalizeRow(raw);
  const a = profile.format.aliases;
  const errors: string[] = [];

  // Identity → externalRef (dedupe key across file re-delivery + realtime overlap)
  const idParts = profile.identityFields.map((f) => row[normalizeKey(f)] ?? pick(row, [normalizeKey(f)]));
  let externalRef = lapoExternalRef(profile.key, idParts);
  if (!externalRef) {
    // Fall back to the transactionRef alias set before giving up.
    const ref = pick(row, a.transactionRef);
    externalRef = lapoExternalRef(profile.key, [ref]);
  }
  if (!externalRef) errors.push(`missing identity (${profile.identityFields.join("+")})`);

  // Amount + direction: split-ledger (debit col / credit col) beats single-amount.
  let amount: number | null = null;
  let direction: "debit" | "credit" | null = null;
  const debitRaw = pick(row, a.amountDebit);
  const creditRaw = pick(row, a.amountCredit);
  if (debitRaw || creditRaw) {
    const d = parseAmount(debitRaw);
    const c = parseAmount(creditRaw);
    if (d && c) errors.push("row has BOTH debit and credit amounts");
    else if (d) { amount = d; direction = "debit"; }
    else if (c) { amount = c; direction = "credit"; }
    else errors.push("split debit/credit columns present but both empty/invalid");
  } else {
    amount = parseAmount(pick(row, a.amount));
    if (amount === null || amount <= 0) errors.push("amount missing or non-positive");
    const word = pick(row, a.debitCredit).toUpperCase().replace(/\s+/g, "_");
    direction = DIRECTION_WORDS[word] ?? profile.defaultDirection ?? null;
    if (!direction) errors.push(`cannot derive debit/credit (got "${word || "∅"}", no default for ${profile.key})`);
  }

  const txnDate = parseLapoDate(pick(row, a.transactionDate));
  if (!txnDate) errors.push("transactionDate missing/unparseable");
  const valueDate = parseLapoDate(pick(row, a.valueDate));

  if (errors.length > 0 || !externalRef || amount === null || !direction || !txnDate) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      externalRef,
      transactionRef: pick(row, a.transactionRef) || null,
      amount: amount.toFixed(2),
      currency: pick(row, a.currency) || "NGN",
      debitCredit: direction,
      transactionDate: txnDate,
      valueDate,
      description: pick(row, a.description) || null,
      counterparty: pick(row, a.counterparty) || null,
      isReversal: /reversal|reversed/i.test(pick(row, a.description)),
      sourceEntity: "journal_entry", // channel rows reconcile against the ledger
      sourceType: profile.label,
      raw,
    },
  };
}

// ─── Channels (one per source, with timing-aware matching config) ───────────
export async function ensureLapoChannel(organizationId: number, key: LapoSourceKey): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const profile = LAPO_SOURCES[key];
  const code = lapoChannelCode(key, organizationId);
  const existing = await db.select().from(channels).where(eq(channels.code, code)).limit(1);
  if (existing[0]) return existing[0].id;
  await db.insert(channels).values({
    organizationId,
    name: `LAPO — ${profile.label}`,
    code,
    description: `${profile.systemDescription} (${profile.transport}; T+${profile.settlementLagDays} settlement)`,
    channelType: profile.channelType,
    country: "NGA",
    defaultCurrency: "NGN",
    // Deliverable 3: cross-channel timing differences live HERE — the
    // reconciliation engine reads per-channel tolerances from matchingConfig.
    matchingConfig: {
      amountTolerance: profile.matching.amountTolerancePct,
      dateWindowDays: profile.matching.dateWindowDays,
      settlementLagDays: profile.settlementLagDays,
      cutoffHourLocal: profile.cutoffHourLocal,
      preferValueDate: profile.settlementLagDays > 0,
    },
    fileFormat: { detectedFormat: profile.format.id },
    isActive: true,
  });
  const created = await db.select().from(channels).where(eq(channels.code, code)).limit(1);
  if (!created[0]) throw new Error(`Failed to create LAPO channel ${code}`);
  return created[0].id;
}

/** Provision all eight source channels (idempotent). Called at onboarding. */
export async function provisionLapoChannels(organizationId: number): Promise<number[]> {
  const ids: number[] = [];
  for (const key of LAPO_SOURCE_KEYS) ids.push(await ensureLapoChannel(organizationId, key));
  return ids;
}

export interface LapoProvisionResult {
  organizationId: number;
  configId: number | null;
  channelIds: number[];
  templates: { inserted: number; existing: number };
}

/**
 * Add the LAPO custom channel pack to an organization (idempotent).
 *
 * This is the operation behind "add LAPO to a client's build" during DIRECT
 * onboarding — LAPO is a direct client, not a CBS vendor, so the pack is added
 * to a directly-onboarded org rather than acquired through the CBS picker. It:
 *   1. ensures a LAPO connector config (cbsType=lapo, disabled) — the backbone
 *      for the realtime webhook endpoint and the dead-letter queue;
 *   2. provisions the eight source channels with timing-aware matching config;
 *   3. seeds the LAPO exception taxonomy as org resolution templates.
 * Also invoked by lapo.provision (repair / re-run).
 */
export async function provisionLapoForOrg(organizationId: number): Promise<LapoProvisionResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  // 1) LAPO connector config (one per org; unique on organizationId).
  let configId: number | null = null;
  const existing = await getConfigRowByOrg(organizationId);
  if (existing) {
    configId = existing.id;
    if (existing.cbsType !== "lapo") {
      console.warn(
        `[lapo] org ${organizationId} already has a ${existing.cbsType} connector config; reusing it for LAPO DLQ/webhook.`,
      );
    }
  } else {
    const profile = getCbsProfile("lapo");
    const res = await db.insert(wcConnectorConfigs).values({
      organizationId,
      cbsType: "lapo",
      name: profile.channelName,
      baseUrl: "",
      tenantId: profile.defaultTenantId,
      authMode: profile.defaultAuthMode,
      apiKeyHeader: profile.defaultApiKeyHeader,
      isEnabled: false,
    });
    configId = Number((res as unknown as [{ insertId: number }])[0]?.insertId ?? 0) || null;
  }

  // 2) Channels + 3) taxonomy templates.
  const channelIds = await provisionLapoChannels(organizationId);
  const templates = await seedLapoResolutionTemplates(organizationId);

  return { organizationId, configId, channelIds, templates };
}

// ─── FILE path (SFTP daily batch / manual upload) ────────────────────────────
export interface LapoIngestResult {
  sourceKey: LapoSourceKey;
  batchId: number | null;
  total: number;
  inserted: number;
  duplicates: number;
  failed: number;
  /** total === inserted + duplicates + failed — the zero-data-loss invariant. */
  accountingOk: boolean;
  duplicateFile: boolean;
  sampleFailures: Array<{ rowIndex: number; errors: string[] }>;
}

export async function ingestLapoFile(
  organizationId: number,
  sourceKey: string,
  csvContent: string,
  fileName = "upload.csv",
): Promise<LapoIngestResult> {
  const profile = getLapoSource(sourceKey);
  if (!profile) throw new Error(`Unknown LAPO source "${sourceKey}"`);
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const channelId = await ensureLapoChannel(organizationId, profile.key);

  // File-hash idempotency: the SAME bytes for the same channel never ingest twice
  // (SFTP re-drops and manual re-uploads are recorded, not re-processed).
  const fileHash = crypto.createHash("sha256").update(csvContent).digest("hex");
  const [dupe] = await db
    .select({ id: uploadBatches.id })
    .from(uploadBatches)
    .where(and(eq(uploadBatches.channelId, channelId), eq(uploadBatches.fileHash, fileHash), eq(uploadBatches.status, "completed")))
    .limit(1);
  if (dupe) {
    return {
      sourceKey: profile.key, batchId: dupe.id, total: 0, inserted: 0, duplicates: 0,
      failed: 0, accountingOk: true, duplicateFile: true, sampleFailures: [],
    };
  }

  const parsed = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => normalizeKey(h),
  });
  const rows = (parsed.data ?? []) as Record<string, string>[];

  const batchId = await createIngestBatch({
    organizationId,
    channelId,
    label: `lapo:${profile.key}:${fileName}:${new Date().toISOString()}`,
  });
  await db.update(uploadBatches).set({ fileHash, detectedFormat: profile.format.id }).where(eq(uploadBatches.id, batchId));

  const mapped: CanonicalTransaction[] = [];
  const failures: Array<{ rowIndex: number; errors: string[]; row: Record<string, string> }> = [];
  rows.forEach((row, i) => {
    const r = mapLapoRow(profile, row);
    if (r.ok && r.value) mapped.push(r.value);
    else failures.push({ rowIndex: i + 2, errors: r.errors, row });
  });

  let inserted = 0;
  let duplicates = 0;
  try {
    const CHUNK = 2000;
    for (let i = 0; i < mapped.length; i += CHUNK) {
      const r = await ingestCanonicalTransactions(mapped.slice(i, i + CHUNK), { organizationId, channelId, batchId });
      inserted += r.inserted;
      duplicates += r.duplicates;
    }
    await finalizeIngestBatch(batchId, { total: rows.length, valid: inserted, invalid: failures.length }, true);
  } catch (err) {
    await finalizeIngestBatch(batchId, { total: rows.length, valid: inserted, invalid: failures.length }, false,
      err instanceof Error ? err.message : String(err));
    throw err;
  }

  // Failed rows → connector DLQ (retry/replay machinery + dashboard visibility).
  const cfg = await getConfigRowByOrg(organizationId);
  if (cfg) {
    for (const f of failures.slice(0, 100)) {
      await enqueueDeadLetter({
        configId: cfg.id, organizationId, source: "mapping",
        refType: `lapo:${profile.key}`, refId: `row-${f.rowIndex}`,
        payload: f.row, error: `LAPO ${profile.key} row ${f.rowIndex}: ${f.errors.join("; ")}`,
      });
    }
  } else if (failures.length > 0) {
    console.error(`[lapo-etl] ${failures.length} failed rows for org ${organizationId} (no connector config → not dead-lettered)`);
  }

  const total = rows.length;
  return {
    sourceKey: profile.key, batchId, total, inserted, duplicates, failed: failures.length,
    accountingOk: total === inserted + duplicates + failures.length,
    duplicateFile: false,
    sampleFailures: failures.slice(0, 5).map(({ rowIndex, errors }) => ({ rowIndex, errors })),
  };
}

// ─── EVENT path (realtime API: mobile / USSD / NIP) ──────────────────────────
export async function ingestLapoEvents(
  organizationId: number,
  sourceKey: string,
  events: Array<Record<string, unknown>>,
): Promise<LapoIngestResult> {
  const profile = getLapoSource(sourceKey);
  if (!profile) throw new Error(`Unknown LAPO source "${sourceKey}"`);
  if (profile.transport === "sftp_batch") {
    throw new Error(`LAPO source "${sourceKey}" is batch-only — send its daily file instead`);
  }
  const channelId = await ensureLapoChannel(organizationId, profile.key);
  const batchId = await createIngestBatch({
    organizationId, channelId,
    label: `lapo-rt:${profile.key}:${new Date().toISOString()}`,
  });

  const mapped: CanonicalTransaction[] = [];
  const failures: Array<{ rowIndex: number; errors: string[]; row: Record<string, unknown> }> = [];
  events.forEach((ev, i) => {
    const r = mapLapoRow(profile, ev);
    if (r.ok && r.value) mapped.push(r.value);
    else failures.push({ rowIndex: i + 1, errors: r.errors, row: ev });
  });

  const res = mapped.length > 0
    ? await ingestCanonicalTransactions(mapped, { organizationId, channelId, batchId })
    : { inserted: 0, duplicates: 0 };
  await finalizeIngestBatch(batchId, { total: events.length, valid: res.inserted, invalid: failures.length }, true);

  const cfg = await getConfigRowByOrg(organizationId);
  if (cfg) {
    for (const f of failures.slice(0, 50)) {
      await enqueueDeadLetter({
        configId: cfg.id, organizationId, source: "webhook",
        refType: `lapo:${profile.key}`, refId: `event-${f.rowIndex}`,
        payload: f.row, error: `LAPO ${profile.key} event ${f.rowIndex}: ${f.errors.join("; ")}`,
      });
    }
  }

  const total = events.length;
  return {
    sourceKey: profile.key, batchId, total,
    inserted: res.inserted, duplicates: res.duplicates, failed: failures.length,
    accountingOk: total === res.inserted + res.duplicates + failures.length,
    duplicateFile: false,
    sampleFailures: failures.slice(0, 5).map(({ rowIndex, errors }) => ({ rowIndex, errors })),
  };
}

// ─── Daily completeness (the parallel-run watchdog) ──────────────────────────
export interface SourceCompleteness {
  sourceKey: LapoSourceKey;
  label: string;
  expected: boolean;
  received: boolean;
  batches: number;
  rows: number;
  status: "ok" | "missing" | "not_expected";
}

/**
 * Did every source that owes us a daily batch deliver one for `dateISO`
 * (UTC day of ingestion)? "Zero data loss" is only provable when missing
 * files are loud — this feeds the UAT/parallel-run checklist every morning.
 */
export async function checkDailyCompleteness(
  organizationId: number,
  dateISO: string,
): Promise<SourceCompleteness[]> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const dayStart = new Date(`${dateISO}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const out: SourceCompleteness[] = [];
  for (const key of LAPO_SOURCE_KEYS) {
    const profile = LAPO_SOURCES[key];
    const code = lapoChannelCode(key, organizationId);
    const [chan] = await db.select({ id: channels.id }).from(channels).where(eq(channels.code, code)).limit(1);
    let batches = 0;
    let rows = 0;
    if (chan) {
      const found = await db
        .select({ total: uploadBatches.totalRows })
        .from(uploadBatches)
        .where(and(
          eq(uploadBatches.channelId, chan.id),
          eq(uploadBatches.status, "completed"),
          gte(uploadBatches.createdAt, dayStart),
          lt(uploadBatches.createdAt, dayEnd),
          like(uploadBatches.fileName, "lapo:%"), // batch files only, not realtime bursts
        ));
      batches = found.length;
      rows = found.reduce((s, b) => s + (b.total ?? 0), 0);
    }
    const received = batches > 0;
    out.push({
      sourceKey: key,
      label: profile.label,
      expected: profile.expectedDailyFile,
      received,
      batches,
      rows,
      status: !profile.expectedDailyFile ? "not_expected" : received ? "ok" : "missing",
    });
  }
  return out;
}
