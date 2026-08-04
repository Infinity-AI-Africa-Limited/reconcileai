/**
 * Shared-secret auth for the scheduler endpoints (`x-sync-secret`).
 *
 * These routes let GitHub Actions and Railway Cron trigger work without a
 * session — the Woodcore mirror refresh, the SHOPLINE sync cycle, the webhook
 * reconciler. They are internet-facing and unauthenticated apart from this
 * header, so the comparison matters.
 *
 * Extracted from the request handler in `_core/index.ts` for two reasons: the
 * comparison there was `provided === secret`, a non-constant-time compare on an
 * exposed endpoint, out of step with every other verifier in this codebase
 * (`ingest/svixSignature.ts`, `connectors/shopline/signature.ts`); and a closure
 * inside `startServer()` cannot be tested.
 *
 * Fails closed. An unset secret rejects everything rather than accepting
 * anything — the same rule as the inbound-email verifier, and the opposite of
 * the SHOPLINE install outage where a missing secret was treated as "nothing to
 * check".
 */
import { timingSafeEqual } from "crypto";
import { ENV } from "./env";

/**
 * The expected secret: `CRON_SECRET`, falling back to `JWT_SECRET`.
 *
 * The fallback is a convenience that should be retired. While it is in place,
 * rotating `JWT_SECRET` silently invalidates every scheduler caller that has
 * not also been updated — which is exactly what happened on 2026-08-02 and left
 * the Woodcore mirror sync failing for three days.
 */
export function expectedSyncSecret(): string {
  return ENV.cronSecret || ENV.cookieSecret;
}

/** Why a sync request was refused. Never leaves the server; for logs only. */
export type SyncAuthFailure = "no_secret_configured" | "missing_header" | "mismatch";

export type SyncAuthResult =
  | { ok: true }
  | { ok: false; reason: SyncAuthFailure };

/**
 * Constant-time comparison of the supplied header against the expected secret.
 *
 * The three failure reasons are distinguished for the LOG, not the response —
 * the HTTP layer answers a uniform 403 either way. That distinction is the
 * difference between "the GitHub secret drifted" and "the server has no secret
 * configured at all", which from a bare 403 are indistinguishable, and which
 * cost three days of silent failure to tell apart by hand.
 */
export function checkSyncSecret(provided: string | undefined | null): SyncAuthResult {
  const expected = expectedSyncSecret();
  if (!expected) return { ok: false, reason: "no_secret_configured" };
  if (!provided) return { ok: false, reason: "missing_header" };

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on differing lengths, so the length check has to come
  // first. It leaks only the length of a secret the caller already supplied.
  if (a.length !== b.length) return { ok: false, reason: "mismatch" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Human-readable remedy for a refusal, for the server log. Never includes the secret. */
export function describeSyncAuthFailure(reason: SyncAuthFailure): string {
  switch (reason) {
    case "no_secret_configured":
      return "neither CRON_SECRET nor JWT_SECRET is set on this deployment — every scheduler call will be refused";
    case "missing_header":
      return "request carried no x-sync-secret header";
    case "mismatch":
      return "x-sync-secret did not match; the caller's stored secret has probably drifted from CRON_SECRET (see the rotation runbook in CLAUDE.md §18)";
  }
}
