/**
 * WoodCore connector — module entry point.
 *
 * `runConnectorTick()` is the single scheduled entry (wired to
 * POST /api/scheduled/woodcoreConnectorSync): it runs due daily batch syncs
 * for every enabled connector, then drains due dead-letter retries.
 */
import { listEnabledConfigs } from "./config";
import { processDueDeadLetters, type DlqHandler } from "./dlq";
import { retryApiCallDeadLetter, runDueScheduledSyncs } from "./sync";
import { retryWebhookDeadLetter } from "./webhooks";
import { retryWriteBackDeadLetter } from "./writeback";

export const dlqHandlers: Partial<Record<"webhook" | "batch_sync" | "mapping" | "api_call" | "write_back", DlqHandler>> = {
  webhook: (l) => retryWebhookDeadLetter(l),
  // batch_sync letters are individual records that failed mapping — same replay
  // path as webhook letters (payload → mapping → ingest).
  batch_sync: (l) => retryWebhookDeadLetter(l),
  mapping: (l) => retryWebhookDeadLetter(l),
  api_call: (l) => retryApiCallDeadLetter(l),
  write_back: (l) => retryWriteBackDeadLetter(l),
};

export interface ConnectorTickResult {
  syncs: Array<{ configId: number; ran: boolean; reason?: string }>;
  dlq: { processed: number; resolved: number; failedAgain: number; exhausted: number };
}

export async function runConnectorTick(): Promise<ConnectorTickResult> {
  const configs = await listEnabledConfigs();
  const syncs = await runDueScheduledSyncs(configs);
  const dlq = await processDueDeadLetters(dlqHandlers);
  return {
    syncs: syncs.map(({ configId, ran, reason }) => ({ configId, ran, reason })),
    dlq,
  };
}
