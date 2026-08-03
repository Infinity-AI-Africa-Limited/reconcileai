/**
 * Svix webhook signature verification (used by Resend inbound email).
 *
 * Implemented directly rather than via the `svix` SDK, matching the existing
 * no-SDK pattern in `server/_core/email.ts` and the hand-rolled HMAC in
 * `connectors/shopline/signature.ts`.
 *
 * ── The scheme ───────────────────────────────────────────────────────────────
 *   secret          `whsec_<base64>` — everything after the prefix is base64
 *   signed content  `${svix-id}.${svix-timestamp}.${rawBody}`
 *   signature       HMAC-SHA256(secret, signedContent), base64
 *   header          `svix-signature: v1,<sig> v1,<sig2> ...` (space separated;
 *                   several may be present during a secret rotation, so ANY
 *                   valid one is accepted)
 *
 * ── Why the timestamp check is not optional ──────────────────────────────────
 * Without it a captured request stays replayable forever. CLAUDE.md §2B.9b
 * records exactly this being got wrong on the SHOPLINE OAuth path — a
 * "signature matched, skip the clock check" shortcut that removed replay
 * protection entirely. Do not add a bypass here for convenience.
 */
import { createHmac, timingSafeEqual } from "crypto";

/** Reject anything older or newer than this. Svix's own default. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id?: string | string[];
  timestamp?: string | string[];
  signature?: string | string[];
}

export type SvixFailure =
  | "missing_headers"
  | "missing_secret"
  | "bad_timestamp"
  | "timestamp_out_of_tolerance"
  | "no_matching_signature";

export type SvixResult = { ok: true } | { ok: false; reason: SvixFailure };

function first(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Constant-time compare that tolerates differing lengths without throwing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a Svix-signed webhook.
 *
 * `rawBody` MUST be the exact bytes received. Re-serialising the parsed JSON
 * changes key order and whitespace, so the HMAC would never match — this is the
 * single most common way to "fail" a correct implementation.
 */
export function verifySvixSignature(
  rawBody: Buffer | string,
  headers: SvixHeaders,
  secret: string,
  nowMs: number = Date.now(),
): SvixResult {
  const id = first(headers.id);
  const ts = first(headers.timestamp);
  const sigHeader = first(headers.signature);
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing_headers" };
  if (!secret) return { ok: false, reason: "missing_secret" };

  const tsSeconds = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsSeconds)) return { ok: false, reason: "bad_timestamp" };
  const skew = Math.abs(nowMs / 1000 - tsSeconds);
  if (skew > SVIX_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  // `whsec_` prefix is conventional but optional in some setups.
  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(rawSecret, "base64");

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const signedContent = `${id}.${ts}.${body}`;
  const expected = createHmac("sha256", key).update(signedContent).digest("base64");

  // The header may carry several versioned signatures during rotation.
  for (const part of sigHeader.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    if (safeEqual(expected, value)) return { ok: true };
  }
  return { ok: false, reason: "no_matching_signature" };
}
