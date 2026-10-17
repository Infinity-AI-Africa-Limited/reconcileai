/**
 * The storage check behind `GET /api/health`.
 *
 * It writes a probe object, makes a download URL for it, and LISTS the folder
 * it was written to. Shop redaction erases a tenant's files by listing its
 * folder (`storageListKeys`), so a credential that can write but not list
 * would leave every redaction stuck on `object_deletion_failed`. That fails
 * safe — nothing is claimed deleted — but nothing would say why until a real
 * merchant's request stalled. Listing here makes the permission visible on
 * every health read, including after a credential is rotated.
 *
 * Every network step — upload, listing, cleanup — runs under its own deadline,
 * and the deadline ABORTS the request rather than only ceasing to wait for it.
 * Health is read repeatedly; a stalled step that merely stopped being awaited
 * would leave its request and connection running, and a slow storage service
 * would accumulate them read after read.
 *
 * The endpoint is public, so the result carries timings and fixed codes only:
 * never the bucket, a key or an error's text.
 */
import crypto from "node:crypto";
import { errorSummary } from "./errorText";
import { storageDelete, storageGet, storageListKeys, storagePut } from "./storage";

/** How long any one network step of the probe may take before it is aborted. */
export const STORAGE_PROBE_STEP_TIMEOUT_MS = 5_000;

/**
 * - `ok`      — the folder listed, and the listing held the probe just written;
 * - `missing` — the folder listed, but without the probe;
 * - `denied`  — the credential may not list (HTTP 403 / AccessDenied);
 * - `failed`  — any other failure, or no answer in time.
 */
export type StorageListResult = "ok" | "missing" | "denied" | "failed";

export type StorageHealth =
  | {
      /** `degraded` when writes work but listing does not: the platform serves, redaction cannot finish. */
      status: "ok" | "degraded";
      uploadMs: number;
      downloadMs: number;
      list: StorageListResult;
      listMs?: number;
      /** For `denied` / `failed`: the error's name when it is a plain identifier, else "error". */
      listError?: string;
    }
  | { status: "error"; message: string };

type Abortable = { abortSignal: AbortSignal };

export interface StorageHealthDeps {
  put: (key: string, data: string, contentType: string, options: Abortable) => Promise<{ key: string }>;
  /** Signs a URL locally; makes no request, so it needs no deadline. */
  get: (key: string) => Promise<unknown>;
  list: (prefix: string, options: Abortable) => Promise<string[]>;
  remove: (key: string, options: Abortable) => Promise<void>;
  now: () => number;
}

const defaultDeps: StorageHealthDeps = {
  put: (key, data, contentType, options) => storagePut(key, data, contentType, options),
  get: (key) => storageGet(key),
  list: (prefix, options) => storageListKeys(prefix, options),
  remove: (key, options) => storageDelete(key, options),
  now: () => Date.now(),
};

/** An error's name when it is a bare identifier (`AccessDenied`, `TimeoutError`), else "error". */
function errorCode(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "error";
}

function isAccessDenied(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  const name = (error as { name?: unknown } | null)?.name;
  return status === 403 || name === "AccessDenied";
}

class ProbeStepTimeoutError extends Error {
  constructor() {
    super("storage probe step timed out");
    this.name = "TimeoutError";
  }
}

/**
 * Run one step with a signal that aborts it after the step timeout. The step's
 * request is cancelled through the signal; the race only guarantees the probe
 * answers on time even if a step ignored it.
 */
async function withDeadline<T>(step: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const timeout = new ProbeStepTimeoutError();
      controller.abort(timeout);
      reject(timeout);
    }, STORAGE_PROBE_STEP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([step(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkStorageHealth(deps: StorageHealthDeps = defaultDeps): Promise<StorageHealth> {
  // A folder of its own, so the listing is one small page and holds only this probe.
  const folder = `health-checks/${deps.now()}-${crypto.randomUUID().slice(0, 8)}/`;
  let written: string | null = null;
  try {
    const uploadStart = deps.now();
    const probe = `reconcileai-health-probe ${new Date().toISOString()}`;
    written = (
      await withDeadline((abortSignal) => deps.put(`${folder}probe.txt`, probe, "text/plain", { abortSignal }))
    ).key;
    const uploadMs = deps.now() - uploadStart;

    const downloadStart = deps.now();
    await deps.get(written);
    const downloadMs = deps.now() - downloadStart;

    const listStart = deps.now();
    let list: StorageListResult;
    let listError: string | undefined;
    try {
      const keys = await withDeadline((abortSignal) => deps.list(folder, { abortSignal }));
      list = keys.includes(written) ? "ok" : "missing";
    } catch (error) {
      list = isAccessDenied(error) ? "denied" : "failed";
      listError = errorCode(error);
    }
    const listMs = deps.now() - listStart;

    return {
      status: list === "ok" ? "ok" : "degraded",
      uploadMs,
      downloadMs,
      list,
      listMs,
      ...(listError ? { listError } : {}),
    };
  } catch (error) {
    return { status: "error", message: errorSummary(error) };
  } finally {
    // Never fail the health check over cleanup, and never leave it running.
    const key = written;
    if (key) withDeadline((abortSignal) => deps.remove(key, { abortSignal })).catch(() => undefined);
  }
}
