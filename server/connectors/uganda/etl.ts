/**
 * Uganda market pack — ETL + provisioning (validation gap G1).
 *
 * Pattern-sibling of the LAPO pipeline (server/connectors/lapo/etl.ts):
 * per-rail file ingestion into the SAME canonical tables the reconciliation
 * engine reads, with file-hash idempotency and zero-data-loss accounting
 * (total = inserted + duplicates + failed, always). Channels carry per-rail
 * timing tolerances — the 24–48h inter-network float window lives in
 * matchingConfig, so the engine treats in-window items as timing, not breaks.
 *
 * Works identically on SaaS and on-premise; Uganda's Data Protection &
 * Privacy Act 2019 makes the on-prem deployment (egress-guarded) the
 * expected posture there.
 */
import crypto from "crypto";
import { and, eq, gte, like, lt } from "drizzle-orm";
import Papa from "papaparse";
import {
  getUgandaSource,
  ugandaChannelCode,
  ugandaExternalRef,
  UGANDA_SOURCES,
  UGANDA_SOURCE_KEYS,
  type UgandaSourceKey,
  type UgandaSourceProfile,
} from "@shared/ugandaSources";
import { channels, uploadBatches } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { seedUgandaResolutionTemplates } from "../../exceptions/uganda";
import {
  createIngestBatch,
  finalizeIngestBatch,
  ingestCanonicalTransactions,
} from "../woodcore/ingest";
import { normalizeKey, normalizeRow, parseLapoDate } from "../lapo/etl";
import type { CanonicalTransaction } from "../woodcore/types";

/**
 * Day-first date parser (dd/mm/yyyy) — the Ugandan/Nigerian convention.
 *
 * Critical correctness point: a slash date like "12/07/2026" is valid under
 * BOTH day-first and month-first readings, and JS `new Date()` picks
 * month-first (US) — silently mis-dating every day-≤12 transaction, which
 * corrupts reconciliation windows. So for slash/dash dates we force day-first;
 * ISO (yyyy-mm-dd) and epoch inputs are unambiguous and handed to the shared
 * parser. Pure — unit-tested.
 */
export function parseUgandaDate(raw: string): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  // Unambiguous ISO / epoch first.
  if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{10,}$/.test(s)) {
    const iso = parseLapoDate(s);
    if (iso) return iso;
  }
  // Ambiguous slash/dash date → day-first (dd/mm/yyyy [hh:mm[:ss]]).
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    const d = Number(dd), mo = Number(mm), y = Number(yyyy);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const date = new Date(Date.UTC(y, mo - 1, d, Number(hh ?? 0), Number(mi ?? 0), Number(ss ?? 0)));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return parseLapoDate(s);
}

// ─── Row → canonical mapping ─────────────────────────────────────────────────
function pick(row: Record<string, string>, aliases: string[] | undefined): string {
  for (const a of aliases ?? []) {
    const v = row[a];
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

function parseAmount(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[USh₦,\s]/gi, "").replace(/[()]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : null;
}

const DIRECTION_WORDS: Record<string, "debit" | "credit"> = {
  DEBIT: "debit", DR: "debit", D: "debit", WITHDRAWAL: "debit", "CASH-OUT": "debit",
  CASH_OUT: "debit", CASHOUT: "debit", PAYMENT: "debit", OUTWARD: "debit", TRANSFER_OUT: "debit",
  // Nano-lending: repayment is collected FROM the wallet/account (debit).
  REPAYMENT: "debit", LOAN_REPAYMENT: "debit",
  CREDIT: "credit", CR: "credit", C: "credit", DEPOSIT: "credit", "CASH-IN": "credit",
  CASH_IN: "credit", CASHIN: "credit", INWARD: "credit", TRANSFER_IN: "credit", REFUND: "credit",
  // Nano-lending: disbursement is credited TO the wallet.
  DISBURSEMENT: "credit", LOAN_DISBURSEMENT: "credit",
};

export interface UgandaRowResult {
  ok: boolean;
  value?: CanonicalTransaction;
  errors: string[];
}

/**
 * Map one normalized row (CSV or flat JSON event) from a Ugandan rail to the
 * canonical model. Pure and exhaustively unit-tested — UGX amounts are
 * zero-decimal by convention but stored with 2dp canonically.
 */
export function mapUgandaRow(profile: UgandaSourceProfile, raw: Record<string, unknown>): UgandaRowResult {
  const row = normalizeRow(raw);
  const a = profile.format.aliases;
  const errors: string[] = [];

  const idParts = profile.identityFields.map((f) => row[normalizeKey(f)]);
  let externalRef = ugandaExternalRef(profile.key, idParts);
  if (!externalRef) {
    externalRef = ugandaExternalRef(profile.key, [pick(row, a.transactionRef)]);
  }
  if (!externalRef) errors.push(`missing identity (${profile.identityFields.join("+")})`);

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
    const word = pick(row, a.debitCredit).toUpperCase().replace(/[\s-]+/g, "_");
    direction = DIRECTION_WORDS[word] ?? profile.defaultDirection ?? null;
    if (!direction) errors.push(`cannot derive debit/credit (got "${word || "∅"}", no default for ${profile.key})`);
  }

  const txnDate = parseUgandaDate(pick(row, a.transactionDate));
  if (!txnDate) errors.push("transactionDate missing/unparseable");
  const valueDate = parseUgandaDate(pick(row, a.valueDate));

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
      currency: pick(row, a.currency) || "UGX",
      debitCredit: direction,
      transactionDate: txnDate,
      valueDate,
      description: pick(row, a.description) || null,
      counterparty: pick(row, a.counterparty) || null,
      isReversal: /reversal|reversed/i.test(pick(row, a.description)),
      sourceEntity: "journal_entry",
      sourceType: profile.label,
      raw,
    },
  };
}

// ─── Channels (per rail, timing-aware) ───────────────────────────────────────
export async function ensureUgandaChannel(organizationId: number, key: UgandaSourceKey): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const profile = UGANDA_SOURCES[key];
  const code = ugandaChannelCode(key, organizationId);
  const existing = await db.select().from(channels).where(eq(channels.code, code)).limit(1);
  if (existing[0]) return existing[0].id;
  await db.insert(channels).values({
    organizationId,
    name: `UG — ${profile.label}`,
    code,
    description: `${profile.systemDescription} (${profile.transport}; T+${profile.settlementLagDays})`,
    channelType: profile.channelType,
    country: "UGA",
    defaultCurrency: "UGX",
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
  if (!created[0]) throw new Error(`Failed to create Uganda channel ${code}`);
  return created[0].id;
}

export async function provisionUgandaChannels(organizationId: number): Promise<number[]> {
  const ids: number[] = [];
  for (const key of UGANDA_SOURCE_KEYS) ids.push(await ensureUgandaChannel(organizationId, key));
  return ids;
}

export interface UgandaProvisionResult {
  organizationId: number;
  channelIds: number[];
  templates: { inserted: number; existing: number };
}

/**
 * Add the Uganda channel pack to an organization (idempotent): the eight rail
 * channels with timing-aware matching config + the BoU-framework exception
 * taxonomy as resolution templates. Wired to DIRECT onboarding (custom
 * channel selector) and re-runnable via uganda.provision.
 */
export async function provisionUgandaForOrg(organizationId: number): Promise<UgandaProvisionResult> {
  const channelIds = await provisionUgandaChannels(organizationId);
  const templates = await seedUgandaResolutionTemplates(organizationId);
  return { organizationId, channelIds, templates };
}

// ─── FILE ingestion (SFTP daily batch / manual upload) ───────────────────────
export interface UgandaIngestResult {
  sourceKey: UgandaSourceKey;
  batchId: number | null;
  total: number;
  inserted: number;
  duplicates: number;
  failed: number;
  accountingOk: boolean;
  duplicateFile: boolean;
  sampleFailures: Array<{ rowIndex: number; errors: string[] }>;
}

export async function ingestUgandaFile(
  organizationId: number,
  sourceKey: string,
  csvContent: string,
  fileName = "upload.csv",
): Promise<UgandaIngestResult> {
  const profile = getUgandaSource(sourceKey);
  if (!profile) throw new Error(`Unknown Uganda source "${sourceKey}"`);
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const channelId = await ensureUgandaChannel(organizationId, profile.key);

  // File-hash idempotency: identical bytes never double-ingest.
  const fileHash = crypto.createHash("sha256").update(csvContent).digest("hex");
  const [dupe] = await db
    .select({ id: uploadBatches.id })
    .from(uploadBatches)
    .where(and(
      eq(uploadBatches.channelId, channelId),
      eq(uploadBatches.fileHash, fileHash),
      eq(uploadBatches.status, "completed"),
    ))
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
    label: `ug:${profile.key}:${fileName}:${new Date().toISOString()}`,
  });
  await db.update(uploadBatches).set({ fileHash, detectedFormat: profile.format.id }).where(eq(uploadBatches.id, batchId));

  const mapped: CanonicalTransaction[] = [];
  const failures: Array<{ rowIndex: number; errors: string[] }> = [];
  rows.forEach((row, i) => {
    const r = mapUgandaRow(profile, row);
    if (r.ok && r.value) mapped.push(r.value);
    else failures.push({ rowIndex: i + 2, errors: r.errors });
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

  if (failures.length > 0) {
    console.error(`[ug-etl] ${failures.length} failed rows (org ${organizationId}, ${profile.key}); first: ${JSON.stringify(failures[0])}`);
  }

  const total = rows.length;
  return {
    sourceKey: profile.key, batchId, total, inserted, duplicates, failed: failures.length,
    accountingOk: total === inserted + duplicates + failures.length,
    duplicateFile: false,
    sampleFailures: failures.slice(0, 5),
  };
}

// ─── Daily completeness (parallel-run watchdog, same as LAPO) ────────────────
export interface UgandaSourceCompleteness {
  sourceKey: UgandaSourceKey;
  label: string;
  expected: boolean;
  received: boolean;
  batches: number;
  rows: number;
  status: "ok" | "missing" | "not_expected";
}

export async function checkUgandaDailyCompleteness(
  organizationId: number,
  dateISO: string,
): Promise<UgandaSourceCompleteness[]> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const dayStart = new Date(`${dateISO}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const out: UgandaSourceCompleteness[] = [];
  for (const key of UGANDA_SOURCE_KEYS) {
    const profile = UGANDA_SOURCES[key];
    const code = ugandaChannelCode(key, organizationId);
    const [chan] = await db.select({ id: channels.id }).from(channels).where(eq(channels.code, code)).limit(1);
    let batches = 0;
    let rowsTotal = 0;
    if (chan) {
      const found = await db
        .select({ total: uploadBatches.totalRows })
        .from(uploadBatches)
        .where(and(
          eq(uploadBatches.channelId, chan.id),
          eq(uploadBatches.status, "completed"),
          gte(uploadBatches.createdAt, dayStart),
          lt(uploadBatches.createdAt, dayEnd),
          like(uploadBatches.fileName, "ug:%"),
        ));
      batches = found.length;
      rowsTotal = found.reduce((s, b) => s + (b.total ?? 0), 0);
    }
    const received = batches > 0;
    out.push({
      sourceKey: key,
      label: profile.label,
      expected: profile.expectedDailyFile,
      received,
      batches,
      rows: rowsTotal,
      status: !profile.expectedDailyFile ? "not_expected" : received ? "ok" : "missing",
    });
  }
  return out;
}
