/**
 * SHOPLINE standard API budget: four requests per second per store.
 *
 * This process-local scheduler serialises requests for an individual store at
 * 250 ms intervals before they reach fetch. It covers polling, historical
 * backfill, manual sync and webhook subscription calls because every connector
 * API request flows through `shoplineRequest`.
 *
 * Horizontal deployments need a shared limiter (for example Redis or a
 * database-backed lease) before multiple workers serve the same merchant.
 */
export const SHOPLINE_REQUEST_INTERVAL_MS = 250;

type Clock = () => number;
type Sleep = (milliseconds: number) => Promise<void>;

const nextAllowedAtByStore = new Map<string, number>();

const systemClock: Clock = () => Date.now();
const systemSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Wait until the store's next permitted API request slot, then reserve the next slot. */
export async function waitForShoplineRequestSlot(
  storeHandle: string,
  clock: Clock = systemClock,
  sleep: Sleep = systemSleep,
): Promise<void> {
  const now = clock();
  const nextAllowedAt = nextAllowedAtByStore.get(storeHandle) ?? now;
  const reservedAt = Math.max(now, nextAllowedAt);

  // Reserve before awaiting so concurrent callers cannot take the same slot.
  nextAllowedAtByStore.set(storeHandle, reservedAt + SHOPLINE_REQUEST_INTERVAL_MS);

  if (reservedAt > now) {
    await sleep(reservedAt - now);
  }
}

/** Test-only reset; production state intentionally lives for the worker lifetime. */
export function resetShoplineRequestSlotsForTest(): void {
  nextAllowedAtByStore.clear();
}
