/**
 * Bidirectional leg: push reconciliation outcomes back into WoodCore.
 *
 * When ReconcileAI resolves an exception (or flags one for the bank's ops team),
 * the resolution can be written back to the source account in WoodCore as a
 * note/annotation, so branch staff see it inside their core banking screens.
 *
 * Honest scope: the exact WoodCore write API is unconfirmed. The payload and
 * path are configurable (endpoints.writeBack); this module owns formatting,
 * gating (writeBackEnabled, default OFF), and failure → DLQ. When WoodCore
 * confirms their API, only config changes.
 */
import { WoodcoreClient } from "./client";
import { getConfigRow, toConnection } from "./config";
import { enqueueDeadLetter } from "./dlq";
import type { WcClientDeps } from "./types";

export interface WriteBackNote {
  /** e.g. "savings" | "loan" | "gl" */
  accountType: string;
  /** WoodCore-side account/entry id. */
  accountId: string;
  /** ReconcileAI exception/resolution reference for the audit trail. */
  reconcileRef: string;
  note: string;
}

export interface WriteBackResult {
  ok: boolean;
  deadLettered: boolean;
  error?: string;
}

export async function pushWriteBackNote(
  configId: number,
  note: WriteBackNote,
  deps: WcClientDeps = {},
): Promise<WriteBackResult> {
  const cfg = await getConfigRow(configId);
  if (!cfg) return { ok: false, deadLettered: false, error: `connector config ${configId} not found` };
  if (!cfg.isEnabled) return { ok: false, deadLettered: false, error: "connector is disabled" };
  if (!cfg.writeBackEnabled) {
    return { ok: false, deadLettered: false, error: "write-back is disabled for this connector" };
  }

  const body = {
    resourceType: note.accountType,
    resourceId: note.accountId,
    note: `[ReconcileAI ${note.reconcileRef}] ${note.note}`.slice(0, 1000),
    source: "reconcileai",
  };

  try {
    const client = new WoodcoreClient(toConnection(cfg), deps);
    await client.postWriteBack(body);
    return { ok: true, deadLettered: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await enqueueDeadLetter({
      configId: cfg.id,
      organizationId: cfg.organizationId,
      source: "write_back",
      refType: note.accountType,
      refId: note.accountId,
      payload: body,
      error: msg,
    });
    return { ok: false, deadLettered: true, error: msg };
  }
}

/** Retry handler for write_back dead letters. */
export async function retryWriteBackDeadLetter(letter: {
  configId: number;
  payload: unknown;
}): Promise<void> {
  const cfg = await getConfigRow(letter.configId);
  if (!cfg) throw new Error(`connector config ${letter.configId} not found`);
  if (!cfg.isEnabled || !cfg.writeBackEnabled) {
    throw new Error("write-back no longer enabled; discard this item if intentional");
  }
  const client = new WoodcoreClient(toConnection(cfg));
  await client.postWriteBack(letter.payload);
}
