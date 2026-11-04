/** Non-secret process controls. These are not authorisation to freeze/export a database. */
export type StartupMode = "normal" | "maintenance";

export function readStartupMode(value: string | undefined): StartupMode {
  if (value === undefined || value === "normal") return "normal";
  if (value === "maintenance") return "maintenance";
  // Never echo the input: configuration errors must not log arbitrary values.
  throw new Error("invalid_startup_mode");
}

export const DEFAULT_DRAIN_TIMEOUT_MS = 90_000;

export function readDrainTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DRAIN_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) throw new Error("invalid_drain_timeout");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
    throw new Error("invalid_drain_timeout");
  }
  return parsed;
}

/** The loader must remain lazy: normal application imports start background writers. */
export async function selectStartup(
  mode: StartupMode,
  handlers: { normal: () => Promise<unknown>; maintenance: () => Promise<unknown> },
): Promise<void> {
  if (mode === "maintenance") await handlers.maintenance();
  else await handlers.normal();
}
