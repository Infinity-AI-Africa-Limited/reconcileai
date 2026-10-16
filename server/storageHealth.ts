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
 * The endpoint is public, so the result carries timings and fixed codes only:
 * never the bucket, a key or an error's text.
 */
import crypto from "node:crypto";
import { errorSummary } from "./errorText";
import { storageDelete, storageGet, storageListKeys, storagePut } from "./storage";

/** A listing that has not answered by now is reported as failed, not waited for. */
export const STORAGE_LIST_PROBE_TIMEOUT_MS = 5_000;

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

export interface StorageHealthDeps {
  put: (key: string, data: string, contentType: string) => Promise<{ key: string }>;
  get: (key: string) => Promise<unknown>;
  list: (prefix: string) => Promise<string[]>;
  remove: (key: string) => Promise<void>;
  now: () => number;
}

const defaultDeps: StorageHealthDeps = {
  put: (key, data, contentType) => storagePut(key, data, contentType),
  get: (key) => storageGet(key),
  list: storageListKeys,
  remove: storageDelete,
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

class ListProbeTimeoutError extends Error {
  constructor() {
    super("storage list probe timed out");
    this.name = "TimeoutError";
  }
}

async function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ListProbeTimeoutError()), STORAGE_LIST_PROBE_TIMEOUT_MS);
      }),
    ]);
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
    written = (await deps.put(`${folder}probe.txt`, `reconcileai-health-probe ${new Date().toISOString()}`, "text/plain")).key;
    const uploadMs = deps.now() - uploadStart;

    const downloadStart = deps.now();
    await deps.get(written);
    const downloadMs = deps.now() - downloadStart;

    const listStart = deps.now();
    let list: StorageListResult;
    let listError: string | undefined;
    try {
      const keys = await withinDeadline(deps.list(folder));
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
    // Never fail the health check over cleanup.
    if (written) deps.remove(written).catch(() => undefined);
  }
}
